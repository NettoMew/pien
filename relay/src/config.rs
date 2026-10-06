//! relay.toml. Every setting has a default fit for one person's own use; a
//! key is the only thing that must be given, of one kind or both:
//!
//! ```toml
//! listen = "127.0.0.1:8095"
//! key = "…"                       # a key of this relay's own, from `relay key`
//! session_key = "…"               # or the site's, shared with press: login tokens
//!
//! [dns]
//! upstream = "cloudflare-tls"     # quad9-tls, google-tls, system, or an address
//! hosts = { "nas.home" = "192.168.1.10", "printer.home" = "fd00::20" }
//!
//! [egress]
//! socks5 = "127.0.0.1:7890"       # TCP through a SOCKS5 proxy; default: direct
//! udp = true
//! ipv6 = "2001:db8:1:2:1::/80"    # each session an address of its own from here, to go
//!                                 # out from (addresses.rs); default: none, a private one
//! uplink = "eth0"                 # where the upstream asks after them (uplink.rs);
//!                                 # default: nowhere, it routes the prefix here
//!
//! [policy]
//! allow_private = false           # private, loopback, link-local … addresses
//! allow_ports = []                # empty: every port
//! deny_ports = [25]
//! aliases = { "10.0.2.4" = "192.168.1.10" }   # guest address → real one, unchecked; IPv6 too
//!
//! [limits]
//! sessions = 4
//! flows = 256                     # TCP connections per session
//! rate = 0                        # bytes per second, each way; 0: unlimited
//! quota = 0                       # bytes per session; 0: unlimited
//! idle = 1800                     # seconds without a frame from the guest
//! ```

use std::collections::HashMap;
use std::net::{IpAddr, Ipv6Addr, SocketAddr};
use std::str::FromStr;

use serde::Deserialize;

use crate::channel::Keys;

#[derive(Clone, Debug, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub listen: SocketAddr,
    /// The relay's own key, 64 hex digits: whoever was given it may connect.
    pub key: String,
    /// The site's session key, 64 hex digits: whoever logged in may connect.
    pub session_key: String,
    pub dns: Dns,
    pub egress: Egress,
    pub policy: Policy,
    pub limits: Limits,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Dns {
    pub upstream: String,
    /// Names the DNS server answers itself: A for an IPv4 address, AAAA for an IPv6 one.
    pub hosts: HashMap<String, IpAddr>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Egress {
    pub socks5: Option<SocketAddr>,
    pub udp: bool,
    /// A public prefix, whose addresses the sessions go out from.
    pub ipv6: Option<Prefix>,
    /// The interface the upstream asks after those addresses on.
    pub uplink: Option<String>,
}

/// An IPv6 prefix, written as one: `2001:db8:1:2:1::/80`.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(try_from = "String")]
pub struct Prefix {
    pub address: Ipv6Addr,
    pub len: u8,
}

impl Prefix {
    /// The address in the prefix whose remaining bits are `bits`'.
    pub fn with(self, bits: u128) -> Ipv6Addr {
        let network = u128::MAX.checked_shl(128 - u32::from(self.len)).unwrap_or(0);
        Ipv6Addr::from((u128::from(self.address) & network) | (bits & !network))
    }
}

impl FromStr for Prefix {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, String> {
        let bad = || format!("{s:?}: an IPv6 prefix, such as 2001:db8:1:2:1::/80");
        let (address, len) = s.split_once('/').ok_or_else(bad)?;
        let prefix = Self {
            address: address.parse().map_err(|_| bad())?,
            len: len.parse().map_err(|_| bad())?,
        };
        match prefix.len {
            0..=120 => Ok(Self { address: prefix.with(0), ..prefix }),
            _ => Err(format!("{s:?}: a /120 or wider, with addresses to draw from")),
        }
    }
}

impl TryFrom<String> for Prefix {
    type Error = String;

    fn try_from(s: String) -> Result<Self, String> {
        s.parse()
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Policy {
    pub allow_private: bool,
    pub allow_ports: Vec<u16>,
    pub deny_ports: Vec<u16>,
    pub aliases: HashMap<IpAddr, IpAddr>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Limits {
    pub sessions: usize,
    pub flows: usize,
    pub rate: u64,
    pub quota: u64,
    pub idle: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            listen: "127.0.0.1:8095".parse().unwrap(),
            key: String::new(),
            session_key: String::new(),
            dns: Dns::default(),
            egress: Egress::default(),
            policy: Policy::default(),
            limits: Limits::default(),
        }
    }
}

impl Default for Dns {
    fn default() -> Self {
        Self {
            upstream: "cloudflare-tls".into(),
            hosts: HashMap::new(),
        }
    }
}

impl Default for Egress {
    fn default() -> Self {
        Self {
            socks5: None,
            udp: true,
            ipv6: None,
            uplink: None,
        }
    }
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            allow_private: false,
            allow_ports: vec![],
            deny_ports: vec![25],
            aliases: HashMap::new(),
        }
    }
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            sessions: 4,
            flows: 256,
            rate: 0,
            quota: 0,
            idle: 1800,
        }
    }
}

impl Config {
    pub fn parse(text: &str) -> Result<Self, String> {
        let config: Self = toml::from_str(text).map_err(|e| e.to_string())?;
        config.keys()?;
        if config.egress.uplink.is_some() && config.egress.ipv6.is_none() {
            return Err("egress.uplink: answers for egress.ipv6's addresses, which is not set".into());
        }
        Ok(config)
    }

    pub fn keys(&self) -> Result<Keys, String> {
        let keys = Keys {
            own: hex("key", &self.key)?,
            session: hex("session_key", &self.session_key)?,
        };
        match keys {
            Keys { own: None, session: None } => Err("key or session_key: 64 hex digits, from `relay key`".into()),
            keys => Ok(keys),
        }
    }
}

/// 32 bytes from 64 hex digits; none from nothing.
fn hex(name: &str, digits: &str) -> Result<Option<[u8; 32]>, String> {
    let digits = digits.trim();
    if digits.is_empty() {
        return Ok(None);
    }
    let bytes: Option<Vec<u8>> = (digits.len() == 64)
        .then(|| (0..32).map(|i| u8::from_str_radix(digits.get(2 * i..2 * i + 2)?, 16).ok()).collect())
        .flatten();
    bytes
        .and_then(|b| b.try_into().ok())
        .map(Some)
        .ok_or_else(|| format!("{name}: 64 hex digits, from `relay key`"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_and_overrides() {
        let config = Config::parse(&format!(
            "key = \"{}\"\n[policy]\naliases = {{ \"10.0.2.4\" = \"127.0.0.1\", \"2001:db8::4\" = \"::1\" }}\n[limits]\nidle = 60\n",
            "ab".repeat(32)
        ))
        .unwrap();
        let keys = config.keys().unwrap();
        assert_eq!((keys.own, keys.session), (Some([0xab; 32]), None));
        let alias = |guest: &str| config.policy.aliases[&guest.parse().unwrap()].to_string();
        assert_eq!((alias("10.0.2.4"), alias("2001:db8::4")), ("127.0.0.1".into(), "::1".into()));
        assert_eq!((config.limits.idle, config.limits.sessions), (60, 4));
        assert_eq!(config.policy.deny_ports, [25]); // defaults hold for whatever a table leaves out
        assert!(Config::parse("key = \"short\"").is_err());
        assert!(Config::parse("nonsense = 1").is_err());
        assert!(Config::parse("").is_err()); // a relay nobody may use
        let site = Config::parse(&format!("session_key = \"{}\"", "CD".repeat(32))).unwrap();
        assert_eq!(site.keys().unwrap().session, Some([0xcd; 32]));
    }

    #[test]
    fn prefixes() {
        let prefix: Prefix = "2001:db8:1:2:1:ffff::/80".parse().unwrap();
        assert_eq!(prefix.address, "2001:db8:1:2:1::".parse::<Ipv6Addr>().unwrap()); // the host bits, cleared
        assert_eq!(prefix.with(u128::MAX), "2001:db8:1:2:1:ffff:ffff:ffff".parse::<Ipv6Addr>().unwrap());
        assert_eq!("::/0".parse::<Prefix>().unwrap().with(1), Ipv6Addr::from(1));
        for bad in ["2001:db8::", "2001:db8::/121", "10.0.2.0/24", "2001:db8::/x"] {
            assert!(bad.parse::<Prefix>().is_err(), "{bad}");
        }
        let key = format!("key = \"{}\"
", "ab".repeat(32));
        let public = Config::parse(&format!("{key}[egress]
ipv6 = \"2001:db8:1:2:1::/80\"
uplink = \"eth0\"")).unwrap();
        assert_eq!((public.egress.ipv6.map(|p| p.len), public.egress.uplink.as_deref()), (Some(80), Some("eth0")));
        assert!(Config::parse(&format!("{key}[egress]
uplink = \"eth0\"")).is_err()); // nothing to answer for
    }
}
