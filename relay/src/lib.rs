//! pien's relay: a private Ethernet segment for each WebSocket, with a
//! gateway onto the internet — what `net on` in the guest connects to.
//!
//! ```text
//! page (v86 eth0) ──WebSocket, sealed frames (channel.rs)──▶ relay
//!                                   session.rs: a gateway for IPv4 and IPv6 — ARP and
//!                                     neighbour discovery, TCP (smoltcp), UDP, ICMP
//!                                   addresses.rs, dhcp.rs: each guest its own IPv6 address
//!                                   dns.rs: 10.0.2.3, upstream over TLS
//!                                   policy.rs: where a guest may go
//!                                   egress.rs: out, directly or via SOCKS5
//!                                   uplink.rs: the upstream, told where those addresses are
//! ```
//!
//! The relay keeps counts — sessions, bytes, connections — and nothing about
//! where any of it went.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize};

mod addresses;
pub mod channel;
pub mod config;
pub mod dhcp;
mod dns;
mod egress;
pub mod packet;
mod policy;
mod reports;
pub mod server;
pub mod session;
pub mod token;
pub mod uplink;

pub use config::Config;

pub struct Shared {
    pub config: Config,
    pub keys: channel::Keys,
    dns: dns::Dns,
    addresses: Arc<addresses::Addresses>,
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
    /// What every session shares: `uplink` is `egress.uplink`'s, opened
    /// already (uplink.rs), if it names one.
    pub fn new(config: Config, uplink: Option<uplink::Uplink>) -> Result<Arc<Self>, String> {
        let keys = config.keys()?;
        let dns = dns::Dns::new(&config.dns)?;
        let addresses = Arc::new(addresses::Addresses::new(&config.egress, uplink)?);
        Ok(Arc::new(Self {
            config,
            keys,
            dns,
            addresses,
            stats: Stats::default(),
        }))
    }

    /// Where the sessions' IPv6 addresses come from, in a word for the log.
    pub fn addresses(&self) -> String {
        self.addresses.describe()
    }
}
