//! relay [relay.toml]    serve, with the given configuration (see config.rs)
//! relay key             read a password on stdin, print the key it makes —
//!                       for relay.toml; the guest's `net login` derives the same

use std::sync::atomic::Ordering;

use relay::server::{self, bytes};
use relay::{Config, Shared, channel};

#[tokio::main]
async fn main() {
    let arg = std::env::args().nth(1);
    if arg.as_deref() == Some("key") {
        let mut password = String::new();
        std::io::stdin().read_line(&mut password).expect("a password on stdin");
        let key = channel::key(password.trim_end_matches(['\r', '\n']));
        return println!("{}", key.iter().map(|b| format!("{b:02x}")).collect::<String>());
    }

    let path = arg.unwrap_or_else(|| "relay.toml".into());
    let config = std::fs::read_to_string(&path)
        .map_err(|e| format!("{path}: {e}"))
        .and_then(|text| Config::parse(&text).map_err(|e| format!("{path}: {e}")));
    let shared = match config.and_then(Shared::new) {
        Ok(shared) => shared,
        Err(error) => {
            eprintln!("relay: {error}");
            std::process::exit(2);
        }
    };
    let (address, serving) = match server::bind(shared.clone()).await {
        Ok(bound) => bound,
        Err(error) => {
            eprintln!("relay: {}: {error}", shared.config.listen);
            std::process::exit(1);
        }
    };
    eprintln!("relay: listening on {address}");
    tokio::select! {
        _ = serving => {}
        _ = tokio::signal::ctrl_c() => {}
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
