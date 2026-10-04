//! guest@zutto-issho's relay: a private Ethernet segment for each WebSocket, with a
//! gateway onto the internet — what `net on` in the guest connects to.
//!
//! ```text
//! page (v86 eth0) ──WebSocket, sealed frames (channel.rs)──▶ relay
//!                                   session.rs: ARP, gateway, TCP (smoltcp), UDP, ICMP
//!                                   dns.rs: 10.0.2.3, upstream over TLS
//!                                   policy.rs: where a guest may go
//!                                   egress.rs: out, directly or via SOCKS5
//! ```
//!
//! The relay keeps counts — sessions, bytes, connections — and nothing about
//! where any of it went.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize};

pub mod channel;
pub mod config;
mod dns;
mod egress;
pub mod packet;
mod policy;
mod reports;
pub mod server;
pub mod session;

pub use config::Config;

pub struct Shared {
    pub config: Config,
    pub key: [u8; 32],
    dns: dns::Dns,
    pub stats: Stats,
}

#[derive(Default)]
pub struct Stats {
    pub active: AtomicUsize,
    pub sessions: AtomicU64,
    pub turned_away: AtomicU64,
    pub up: AtomicU64,
    pub down: AtomicU64,
}

impl Shared {
    pub fn new(config: Config) -> Result<Arc<Self>, String> {
        let key = config.key()?;
        let dns = dns::Dns::new(&config.dns)?;
        Ok(Arc::new(Self {
            config,
            key,
            dns,
            stats: Stats::default(),
        }))
    }
}
