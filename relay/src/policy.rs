//! Where a guest may go. Checked on the address actually dialled, after DNS,
//! so a name that resolves to a private address gets nowhere either.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use crate::config::Policy;

impl Policy {
    /// The address to dial for what the guest asked for, or `None`.
    pub fn route(&self, dst: SocketAddr) -> Option<SocketAddr> {
        if let Some(&real) = self.aliases.get(&dst.ip()) {
            return Some(SocketAddr::new(real, dst.port()));
        }
        let port_ok = (self.allow_ports.is_empty() || self.allow_ports.contains(&dst.port()))
            && !self.deny_ports.contains(&dst.port());
        port_ok
            .then(|| self.address(dst.ip()))
            .flatten()
            .map(|ip| SocketAddr::new(ip, dst.port()))
    }

    /// The same for a host alone (ping): aliases, and only the public internet.
    pub fn address(&self, ip: IpAddr) -> Option<IpAddr> {
        match self.aliases.get(&ip) {
            Some(&real) => Some(real),
            None => (self.allow_private || public(ip)).then_some(ip),
        }
    }
}

/// An address on the public internet.
pub fn public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => public_v4(ip),
        IpAddr::V6(ip) => public_v6(ip),
    }
}

/// Not private, loopback, link-local, shared (CGNAT), documentation,
/// benchmarking, multicast or reserved space.
fn public_v4(ip: Ipv4Addr) -> bool {
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

/// Global unicast (2000::/3), less what is set aside within it:
/// documentation, the IETF's protocol assignments (Teredo among them), and
/// 6to4, whose addresses carry IPv4 ones of any kind. Everything outside
/// it — unique local, link-local, loopback, multicast, IPv4-mapped — is not.
fn public_v6(ip: Ipv6Addr) -> bool {
    let [a, b, ..] = ip.segments();
    a & 0xe000 == 0x2000
        && !(a == 0x2001 && b == 0x0db8) // 2001:db8::/32, documentation
        && !(a == 0x3fff && b < 0x1000) // 3fff::/20, documentation
        && !(a == 0x2001 && b < 0x0200) // 2001::/23, IETF protocol assignments
        && a != 0x2002 // 2002::/16, 6to4
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> SocketAddr {
        s.parse().unwrap()
    }

    #[test]
    fn only_the_public_internet() {
        let policy = Policy::default();
        for ok in [
            "1.1.1.1:443",
            "8.8.8.8:53",
            "140.82.112.3:22",
            "[2606:4700:4700::1111]:443",
            "[2001:4860:4860::8888]:53",
            "[2403:18c0:1000:3b::1]:80",
        ] {
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
            "[::1]:22",
            "[::]:80",
            "[fd00::1]:80",
            "[fdca:c697:4c23::2]:80",
            "[fe80::1]:80",
            "[ff02::1]:80",
            "[::ffff:1.1.1.1]:443",
            "[::ffff:10.0.0.1]:80",
            "[64:ff9b::a00:1]:80",
            "[2001:db8::10]:80",
            "[3fff::1]:80",
            "[2001::1]:80",
            "[2001:1::1]:53",
            "[2002:a00:1::1]:80",
            "[2606:4700:4700::1111]:25",
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
        policy.aliases.insert([10, 0, 2, 4].into(), Ipv4Addr::LOCALHOST.into());
        policy.aliases.insert("2001:db8::4".parse().unwrap(), Ipv6Addr::LOCALHOST.into());
        assert_eq!(policy.route(at("10.0.2.4:22")), Some(at("127.0.0.1:22")));
        assert_eq!(policy.route(at("[2001:db8::4]:22")), Some(at("[::1]:22")));
        policy.allow_private = true;
        assert!(policy.route(at("192.168.1.1:80")).is_some());
        assert!(policy.route(at("[fd00::1]:80")).is_some());
    }
}
