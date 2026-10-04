//! Where a guest may go. Checked on the address actually dialled, after DNS,
//! so a name that resolves to a private address gets nowhere either.

use std::net::{Ipv4Addr, SocketAddrV4};

use crate::config::Policy;

impl Policy {
    /// The address to dial for what the guest asked for, or `None`.
    pub fn route(&self, dst: SocketAddrV4) -> Option<SocketAddrV4> {
        if let Some(&real) = self.aliases.get(dst.ip()) {
            return Some(SocketAddrV4::new(real, dst.port()));
        }
        let port_ok = (self.allow_ports.is_empty() || self.allow_ports.contains(&dst.port()))
            && !self.deny_ports.contains(&dst.port());
        port_ok
            .then(|| self.address(*dst.ip()))
            .flatten()
            .map(|ip| SocketAddrV4::new(ip, dst.port()))
    }

    /// The same for a host alone (ping): aliases, and only the public internet.
    pub fn address(&self, ip: Ipv4Addr) -> Option<Ipv4Addr> {
        match self.aliases.get(&ip) {
            Some(&real) => Some(real),
            None => (self.allow_private || public(ip)).then_some(ip),
        }
    }
}

/// An address on the public internet: not private, loopback, link-local,
/// shared (CGNAT), documentation, benchmarking, multicast or reserved space.
pub fn public(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()
        || a == 0
        || a >= 240
        || (a == 100 && (64..128).contains(&b))
        || (a == 198 && (18..20).contains(&b))
        || (a == 192 && b == 0 && ip.octets()[2] == 0))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> SocketAddrV4 {
        s.parse().unwrap()
    }

    #[test]
    fn only_the_public_internet() {
        let policy = Policy::default();
        for ok in ["1.1.1.1:443", "8.8.8.8:53", "140.82.112.3:22"] {
            assert_eq!(policy.route(at(ok)), Some(at(ok)), "{ok}");
        }
        for no in [
            "10.0.0.1:80",
            "172.27.120.101:80",
            "192.168.1.1:80",
            "127.0.0.1:22",
            "169.254.169.254:80",
            "100.64.0.1:80",
            "0.0.0.0:80",
            "224.0.0.1:80",
            "255.255.255.255:80",
            "192.0.2.10:80",
            "1.1.1.1:25",
        ] {
            assert_eq!(policy.route(at(no)), None, "{no}");
        }
    }

    #[test]
    fn ports_and_aliases() {
        let mut policy = Policy {
            allow_ports: vec![80, 443],
            deny_ports: vec![],
            ..Policy::default()
        };
        assert!(policy.route(at("1.1.1.1:443")).is_some());
        assert!(policy.route(at("1.1.1.1:22")).is_none());
        policy.aliases.insert(Ipv4Addr::new(10, 0, 2, 4), Ipv4Addr::LOCALHOST);
        assert_eq!(policy.route(at("10.0.2.4:22")), Some(at("127.0.0.1:22")));
        policy.allow_private = true;
        assert!(policy.route(at("192.168.1.1:80")).is_some());
    }
}
