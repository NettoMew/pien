//! relay.toml. Every setting has a default fit for one person's own use; a
//! key is the only thing that must be given.
//!
//! ```toml
//! listen = "127.0.0.1:8095"
//! key = "…"                       # relay key < password
//!
//! [dns]
//! upstream = "cloudflare-tls"     # quad9-tls, google-tls, system, or an address
//! hosts = { "nas.home" = "192.168.1.10" }
//!
//! [egress]
//! socks5 = "127.0.0.1:7890"       # TCP through a SOCKS5 proxy; default: direct
//! udp = true
//!
//! [policy]
//! allow_private = false           # private, loopback, link-local … addresses
//! allow_ports = []                # empty: every port
//! deny_ports = [25]
//! aliases = { "10.0.2.4" = "192.168.1.10" }   # guest address → real one, unchecked
//!
//! [limits]
//! sessions = 4
//! flows = 256                     # TCP connections per session
//! rate = 0                        # bytes per second, each way; 0: unlimited
//! quota = 0                       # bytes per session; 0: unlimited
//! idle = 1800                     # seconds without a frame from the guest
//! ```

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr};

use serde::Deserialize;

#[derive(Clone, Debug, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub listen: SocketAddr,
    /// The pre-shared key, 64 hex digits.
    pub key: String,
    pub dns: Dns,
    pub egress: Egress,
    pub policy: Policy,
    pub limits: Limits,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Dns {
    pub upstream: String,
    pub hosts: HashMap<String, Ipv4Addr>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Egress {
    pub socks5: Option<SocketAddr>,
    pub udp: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Policy {
    pub allow_private: bool,
    pub allow_ports: Vec<u16>,
    pub deny_ports: Vec<u16>,
    pub aliases: HashMap<Ipv4Addr, Ipv4Addr>,
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
        config.key()?;
        Ok(config)
    }

    pub fn key(&self) -> Result<[u8; 32], String> {
        let hex = self.key.trim();
        let bytes: Option<Vec<u8>> = (hex.len() == 64)
            .then(|| {
                (0..32)
                    .map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).ok())
                    .collect()
            })
            .flatten();
        bytes
            .and_then(|b| b.try_into().ok())
            .ok_or_else(|| "key: 64 hex digits, from `relay key`".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_and_overrides() {
        let config = Config::parse(&format!(
            "key = \"{}\"\n[policy]\naliases = {{ \"10.0.2.4\" = \"127.0.0.1\" }}\n[limits]\nidle = 60\n",
            "ab".repeat(32)
        ))
        .unwrap();
        assert_eq!(config.key().unwrap(), [0xab; 32]);
        assert_eq!(config.policy.aliases[&Ipv4Addr::new(10, 0, 2, 4)], Ipv4Addr::LOCALHOST);
        assert_eq!((config.limits.idle, config.limits.sessions), (60, 4));
        assert_eq!(config.policy.deny_ports, [25]); // defaults hold for whatever a table leaves out
        assert!(Config::parse("key = \"short\"").is_err());
        assert!(Config::parse("nonsense = 1").is_err());
    }
}
