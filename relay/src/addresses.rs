//! The guests' IPv6 addresses: each session one of its own, a /128 drawn at
//! random, which the guest is handed by DHCPv6 (dhcp.rs). From a public
//! prefix the relay was given (`egress.ipv6`), or else from its own unique
//! local one, fdca:c697:4c23::/64, behind the host's address.
//!
//! A public address is the session's way out too: its sockets are bound to
//! it, so whatever the guest reaches sees the guest's own address. The host
//! takes the whole prefix in as its own, though no interface holds any of it
//! (an AnyIP route, `ip -6 route add local <prefix> dev lo`), and the sockets
//! bind to addresses it does not hold (IPV6_FREEBIND, egress.rs). Where the
//! upstream asks after each address on its link rather than routing the
//! prefix to the host, the relay answers for those in use (uplink.rs).

use std::collections::HashSet;
use std::net::Ipv6Addr;
use std::sync::{Arc, Mutex};

use crate::config::{Egress, Prefix};
use crate::session::{GATEWAY6, PREFIX};
use crate::uplink::Uplink;

pub struct Addresses {
    prefix: Prefix,
    public: bool,
    held: Mutex<HashSet<Ipv6Addr>>,
    uplink: Option<Uplink>,
}

impl Addresses {
    /// `uplink`, opened before anything else (main.rs), for `egress.uplink`.
    pub fn new(egress: &Egress, uplink: Option<Uplink>) -> Result<Self, String> {
        if egress.ipv6.is_some() && !cfg!(target_os = "linux") {
            return Err("egress.ipv6: Linux alone lets sockets bind to addresses the host does not hold".into());
        }
        Ok(Self {
            prefix: egress.ipv6.unwrap_or(Prefix { address: PREFIX, len: 64 }),
            public: egress.ipv6.is_some(),
            held: Mutex::default(),
            uplink,
        })
    }

    /// A new address for a session of its own, until the lease is dropped.
    pub fn lease(self: &Arc<Self>) -> Lease {
        loop {
            let mut bits = [0; 16];
            getrandom::fill(&mut bits).expect("the OS has randomness");
            let address = self.prefix.with(u128::from_be_bytes(bits));
            // Not the prefix's own address (its routers' anycast one), nor the gateway's.
            if address == self.prefix.address || address == GATEWAY6 {
                continue;
            }
            if self.held.lock().unwrap().insert(address) {
                if let Some(uplink) = &self.uplink {
                    uplink.claim(address);
                }
                return Lease { pool: self.clone(), address };
            }
        }
    }

    /// Answers for the addresses in use wherever the upstream asks after
    /// them: on the uplink, for as long as the relay runs; or nowhere.
    pub async fn answer(&self) {
        match &self.uplink {
            Some(uplink) => uplink.answer(|target| self.held.lock().unwrap().contains(&target)).await,
            None => std::future::pending().await,
        }
    }

    /// Where the sessions' addresses come from, and whether they go out from them.
    pub fn describe(&self) -> String {
        let Prefix { address, len } = self.prefix;
        match (self.public, &self.uplink) {
            (false, _) => format!("each session its own address in {address}/{len}, out as the host"),
            (true, None) => format!("each session its own address in {address}/{len}, and out from it"),
            (true, Some(uplink)) => {
                format!("each session its own address in {address}/{len}, and out from it, answered for on {uplink}")
            }
        }
    }
}

/// A session's address, held until dropped.
pub struct Lease {
    pool: Arc<Addresses>,
    address: Ipv6Addr,
}

impl Lease {
    pub fn address(&self) -> Ipv6Addr {
        self.address
    }

    /// The address to go out from, when it is a public one; otherwise the
    /// host goes out as itself.
    pub fn way_out(&self) -> Option<Ipv6Addr> {
        self.pool.public.then_some(self.address)
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        self.pool.held.lock().unwrap().remove(&self.address);
        if let Some(uplink) = &self.pool.uplink {
            uplink.release(self.address);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pool(ipv6: Option<&str>) -> Arc<Addresses> {
        let egress = Egress { ipv6: ipv6.map(|p| p.parse().unwrap()), ..Egress::default() };
        Arc::new(Addresses::new(&egress, None).unwrap())
    }

    #[test]
    fn each_session_its_own_address() {
        let pool = pool(None);
        let leases: Vec<Lease> = (0..64).map(|_| pool.lease()).collect();
        let addresses: HashSet<Ipv6Addr> = leases.iter().map(Lease::address).collect();
        assert_eq!(addresses.len(), 64);
        assert!(addresses.iter().all(|a| a.segments()[..4] == PREFIX.segments()[..4]));
        assert!(leases.iter().all(|l| l.way_out().is_none())); // private: out as the host
        let first = leases[0].address();
        drop(leases);
        assert!(!pool.held.lock().unwrap().contains(&first)); // given back
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn public_addresses_are_the_way_out() {
        let pool = pool(Some("2001:db8:1:2:1::/80"));
        let lease = pool.lease();
        assert_eq!(lease.address().segments()[..5], [0x2001, 0xdb8, 1, 2, 1]);
        assert_eq!(lease.way_out(), Some(lease.address()));
    }

    #[test]
    fn a_narrow_prefix_still_skips_its_own_address() {
        let egress = Egress { ipv6: Some("2001:db8::/120".parse().unwrap()), ..Egress::default() };
        let Ok(addresses) = Addresses::new(&egress, None) else { return }; // Linux alone
        let pool = Arc::new(addresses);
        let leases: Vec<Lease> = (0..255).map(|_| pool.lease()).collect(); // every other address in it
        assert!(leases.iter().all(|l| l.address() != "2001:db8::".parse::<Ipv6Addr>().unwrap()));
    }
}
