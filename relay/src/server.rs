//! WebSockets in, sessions out. Each connection opens the channel (channel.rs)
//! first; only a page that knows the key gets a session. Behind a TLS
//! terminator, any path will do — the terminator decides which reach us.

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::{self, Message};

use crate::Shared;
use crate::channel::{self, HELLO, WELCOME};
use crate::session;

const HANDSHAKE: Duration = Duration::from_secs(10);
const KEEPALIVE: Duration = Duration::from_secs(25);

/// Binds the configured address; the second half serves until dropped.
pub async fn bind(shared: Arc<Shared>) -> std::io::Result<(SocketAddr, impl Future<Output = ()>)> {
    let listener = TcpListener::bind(shared.config.listen).await?;
    let address = listener.local_addr()?;
    Ok((address, serve(shared, listener)))
}

async fn serve(shared: Arc<Shared>, listener: TcpListener) {
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            continue;
        };
        let _ = stream.set_nodelay(true);
        tokio::spawn(connection(shared.clone(), stream));
    }
}

async fn connection(shared: Arc<Shared>, stream: TcpStream) {
    let Ok(ws) = tokio_tungstenite::accept_async(stream).await else {
        return;
    };
    let (mut sink, mut source) = ws.split();

    // The channel: a hello, our reply, then a sealed "hello" proves the key.
    let opened = tokio::time::timeout(HANDSHAKE, async {
        let hello = next(&mut source).await?;
        let (reply, mut opener, sealer) = channel::accept(&shared.key, &hello)?;
        sink.send(Message::binary(reply)).await.ok()?;
        let proof = next(&mut source).await?;
        (opener.open(&proof)? == HELLO).then_some((opener, sealer))
    })
    .await
    .ok()
    .flatten();
    let Some((mut opener, mut sealer)) = opened else {
        shared.stats.turned_away.fetch_add(1, Ordering::Relaxed);
        tokio::time::sleep(Duration::from_secs(1)).await; // no fast guessing
        return close(&mut sink, CloseCode::Policy, "").await;
    };
    let limit = shared.config.limits.sessions;
    if shared.stats.active.fetch_add(1, Ordering::SeqCst) >= limit {
        shared.stats.active.fetch_sub(1, Ordering::SeqCst);
        return close(&mut sink, CloseCode::Again, "busy").await;
    }
    if sink.send(Message::binary(sealer.seal(WELCOME))).await.is_err() {
        shared.stats.active.fetch_sub(1, Ordering::SeqCst);
        return;
    }
    shared.stats.sessions.fetch_add(1, Ordering::Relaxed);

    // Frames both ways, sealed, while the session runs.
    let (to_session, from_page) = mpsc::channel::<Vec<u8>>(256);
    let (to_page, mut from_session) = mpsc::channel::<Vec<u8>>(256);
    let reader = tokio::spawn(async move {
        while let Some(sealed) = next(&mut source).await {
            let Some(frame) = opener.open(&sealed) else { break }; // tampered with, or out of step
            if to_session.send(frame).await.is_err() {
                break;
            }
        }
    });
    let writer = tokio::spawn(async move {
        let mut keepalive = tokio::time::interval(KEEPALIVE);
        loop {
            tokio::select! {
                frame = from_session.recv() => match frame {
                    Some(frame) => if sink.send(Message::binary(sealer.seal(&frame))).await.is_err() { break },
                    None => break,
                },
                _ = keepalive.tick() => if sink.send(Message::Ping(Default::default())).await.is_err() { break },
            }
        }
        close(&mut sink, CloseCode::Normal, "").await;
    });

    let started = Instant::now();
    let summary = session::run(shared.clone(), from_page, to_page).await;
    reader.abort();
    let _ = writer.await;
    shared.stats.active.fetch_sub(1, Ordering::SeqCst);
    shared.stats.up.fetch_add(summary.up, Ordering::Relaxed);
    shared.stats.down.fetch_add(summary.down, Ordering::Relaxed);
    eprintln!(
        "relay: session ended ({:?}) after {}s: up {}, down {}, {} connections",
        summary.end,
        started.elapsed().as_secs(),
        bytes(summary.up),
        bytes(summary.down),
        summary.connections
    );
}

/// The next binary message; `None` once the page has gone.
async fn next<S: StreamExt<Item = Result<Message, tungstenite::Error>> + Unpin>(source: &mut S) -> Option<Bytes> {
    loop {
        match source.next().await? {
            Ok(Message::Binary(data)) => return Some(data),
            Ok(Message::Close(_)) | Err(_) => return None,
            Ok(_) => {}
        }
    }
}

async fn close<S: SinkExt<Message> + Unpin>(sink: &mut S, code: CloseCode, reason: &str) {
    let frame = CloseFrame {
        code,
        reason: reason.to_owned().into(),
    };
    let _ = sink.send(Message::Close(Some(frame))).await;
    let _ = sink.close().await;
}

pub fn bytes(n: u64) -> String {
    match n {
        0..1024 => format!("{n} B"),
        1024..1_048_576 => format!("{:.1} KB", n as f64 / 1024.0),
        _ => format!("{:.1} MB", n as f64 / 1_048_576.0),
    }
}
