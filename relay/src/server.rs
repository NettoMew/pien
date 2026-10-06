//! WebSockets in, sessions out. Each connection opens the channel (channel.rs)
//! first; only a page with the relay's key, or the site's login, gets a session. Behind a TLS
//! terminator, any path will do — the terminator decides which reach us.

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::{self, Message};

use crate::Shared;
use crate::channel::{self, HELLO, WELCOME};
use crate::session::{self, End};

const HANDSHAKE: Duration = Duration::from_secs(10);
const KEEPALIVE: Duration = Duration::from_secs(25);
/// How long to wait for the page to close after we did.
const LINGER: Duration = Duration::from_secs(2);

/// Binds the configured address; the second half serves until dropped.
pub async fn bind(shared: Arc<Shared>) -> std::io::Result<(SocketAddr, impl Future<Output = ()>)> {
    let listener = TcpListener::bind(shared.config.listen).await?;
    let address = listener.local_addr()?;
    Ok((address, serve(shared, listener)))
}

/// Pages in, each to a session of its own; and, beside them, answers for
/// the sessions' addresses wherever the upstream asks (addresses.rs).
async fn serve(shared: Arc<Shared>, listener: TcpListener) {
    let accepting = async {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                continue;
            };
            let _ = stream.set_nodelay(true);
            tokio::spawn(connection(shared.clone(), stream));
        }
    };
    tokio::join!(accepting, shared.addresses.answer());
}

async fn connection(shared: Arc<Shared>, stream: TcpStream) {
    let Ok(ws) = tokio_tungstenite::accept_async(stream).await else {
        return;
    };
    let (mut sink, mut source) = ws.split();

    // The channel: a hello, our reply, then a sealed "hello" proves the key.
    let opened = tokio::time::timeout(HANDSHAKE, async {
        let hello = next(&mut source).await?;
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |since| since.as_secs());
        let (reply, mut opener, sealer) = channel::accept(&shared.keys, &hello, now)?;
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

    // Frames both ways, sealed and paced, while the session runs.
    let rate = shared.config.limits.rate;
    let (to_session, from_page) = mpsc::channel::<Vec<u8>>(256);
    let (to_page, mut from_session) = mpsc::channel::<Vec<u8>>(256);
    let mut reader = tokio::spawn(async move {
        let mut bucket = Bucket::new(rate);
        while let Some(sealed) = next(&mut source).await {
            let Some(frame) = opener.open(&sealed) else { break }; // tampered with, or out of step
            // Once the session is over, keep reading until the page closes too:
            // closing with its frames unread would reset the connection, and
            // take our close frame — and its reason — down with it.
            if !to_session.is_closed() {
                bucket.take(frame.len()).await;
                let _ = to_session.send(frame).await;
            }
        }
    });
    let writer = tokio::spawn(async move {
        let mut bucket = Bucket::new(rate);
        let mut keepalive = tokio::time::interval(KEEPALIVE);
        loop {
            tokio::select! {
                frame = from_session.recv() => match frame {
                    Some(frame) => {
                        bucket.take(frame.len()).await;
                        if sink.send(Message::binary(sealer.seal(&frame))).await.is_err() { break }
                    }
                    None => break,
                },
                _ = keepalive.tick() => if sink.send(Message::Ping(Default::default())).await.is_err() { break },
            }
        }
        sink
    });

    let started = Instant::now();
    let summary = session::run(shared.clone(), from_page, to_page).await;
    if let Ok(mut sink) = writer.await {
        let (code, reason) = match summary.end {
            End::Left => (CloseCode::Normal, ""),
            End::Quota => (CloseCode::Library(4001), "quota"),
            End::Idle => (CloseCode::Library(4002), "idle"),
        };
        close(&mut sink, code, reason).await;
    }
    if tokio::time::timeout(LINGER, &mut reader).await.is_err() {
        reader.abort();
    }
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

/// Paces bytes to `rate` a second, with a second's worth of burst; 0: no limit.
struct Bucket {
    rate: f64,
    tokens: f64,
    last: Instant,
}

impl Bucket {
    fn new(rate: u64) -> Self {
        Self {
            rate: rate as f64,
            tokens: rate as f64,
            last: Instant::now(),
        }
    }

    async fn take(&mut self, n: usize) {
        if self.rate == 0.0 {
            return;
        }
        let now = Instant::now();
        self.tokens = (self.tokens + now.duration_since(self.last).as_secs_f64() * self.rate).min(self.rate);
        self.last = now;
        self.tokens -= n as f64;
        if self.tokens < 0.0 {
            tokio::time::sleep(Duration::from_secs_f64(-self.tokens / self.rate)).await;
        }
    }
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
