//! relay [relay.toml]    serve, with the given configuration (see config.rs)
//! relay key             print a new random key for relay.toml: `key` for a
//!                       relay of one's own (pasted into the page once, at
//!                       `net relay`), or the site's `session_key`

use std::sync::atomic::Ordering;

use relay::server::{self, bytes};
use relay::uplink::{self, Uplink};
use relay::{Config, Shared};

fn main() {
    let arg = std::env::args().nth(1);
    if arg.as_deref() == Some("key") {
        let mut key = [0u8; 32];
        getrandom::fill(&mut key).expect("the OS has randomness");
        return println!("{}", key.iter().map(|b| format!("{b:02x}")).collect::<String>());
    }

    let path = arg.unwrap_or_else(|| "relay.toml".into());
    let config = std::fs::read_to_string(&path)
        .map_err(|e| format!("{path}: {e}"))
        .and_then(|text| Config::parse(&text).map_err(|e| format!("{path}: {e}")));
    let config = config.unwrap_or_else(|error| fail(2, error));

    // The one step that takes a privilege, while the relay is still a single
    // thread: the uplink's socket, if there is one. Then none at all, for
    // every thread to come (uplink.rs).
    let uplink = config.egress.uplink.as_deref().map(|name| {
        Uplink::open(name).unwrap_or_else(|error| fail(1, format!("egress.uplink {name}: {error}")))
    });
    uplink::renounce().unwrap_or_else(|error| fail(1, format!("giving up capabilities: {error}")));

    let runtime = tokio::runtime::Runtime::new().expect("a runtime");
    runtime.block_on(serve(config, uplink));
}

async fn serve(config: Config, uplink: Option<Uplink>) {
    let shared = Shared::new(config, uplink).unwrap_or_else(|error| fail(2, error));
    let (address, serving) = match server::bind(shared.clone()).await {
        Ok(bound) => bound,
        Err(error) => fail(1, format!("{}: {error}", shared.config.listen)),
    };
    eprintln!("relay: listening on {address}; {}", shared.addresses());
    tokio::select! {
        _ = serving => {}
        _ = stopped() => {}
    }
    let stats = &shared.stats;
    eprintln!(
        "relay: stopping. {} sessions, {} turned away, up {}, down {}",
        stats.sessions.load(Ordering::Relaxed),
        stats.turned_away.load(Ordering::Relaxed),
        bytes(stats.up.load(Ordering::Relaxed)),
        bytes(stats.down.load(Ordering::Relaxed))
    );
}

fn fail(code: i32, error: impl std::fmt::Display) -> ! {
    eprintln!("relay: {error}");
    std::process::exit(code);
}

/// Ctrl-C, or the SIGTERM that `docker stop` and systemd send. As a
/// container's first process, the relay would otherwise ignore it, and be
/// killed ten seconds later.
async fn stopped() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut terminate = signal(SignalKind::terminate()).expect("a handler for SIGTERM");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = terminate.recv() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}
