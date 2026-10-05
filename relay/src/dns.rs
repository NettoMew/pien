//! The guest's DNS server, 10.0.2.3: every name is looked up here, upstream
//! over TLS by default, so nothing the guest asks leaks onto any network on
//! the way in the clear.

use std::collections::HashMap;
use std::net::IpAddr;

use hickory_resolver::config::{CLOUDFLARE, GOOGLE, NameServerConfig, QUAD9, ResolverConfig};
use hickory_resolver::net::runtime::TokioRuntimeProvider;
use hickory_resolver::proto::op::{Message, MessageType, OpCode, ResponseCode};
use hickory_resolver::proto::rr::rdata::{A, AAAA};
use hickory_resolver::proto::rr::{RData, Record, RecordType};
use hickory_resolver::{Resolver, TokioResolver};

use crate::config;

pub struct Dns {
    resolver: TokioResolver,
    hosts: HashMap<String, IpAddr>,
}

impl Dns {
    pub fn new(config: &config::Dns) -> Result<Self, String> {
        let provider = TokioRuntimeProvider::default();
        let builder = match config.upstream.as_str() {
            "system" => Resolver::builder(provider).map_err(|e| e.to_string())?,
            "cloudflare-tls" => Resolver::builder_with_config(ResolverConfig::tls(&CLOUDFLARE), provider),
            "quad9-tls" => Resolver::builder_with_config(ResolverConfig::tls(&QUAD9), provider),
            "google-tls" => Resolver::builder_with_config(ResolverConfig::tls(&GOOGLE), provider),
            address => {
                let ip = address
                    .parse()
                    .map_err(|_| format!("dns.upstream: unknown {address:?}"))?;
                let servers = vec![NameServerConfig::udp_and_tcp(ip)];
                Resolver::builder_with_config(ResolverConfig::from_name_servers(servers), provider)
            }
        };
        let resolver = builder.build().map_err(|e| e.to_string())?;
        let hosts = config.hosts.iter().map(|(name, ip)| (canonical(name), *ip)).collect();
        Ok(Self { resolver, hosts })
    }

    /// The answer to a query, as the bytes of a DNS message; `None` if the
    /// query is not one we can read.
    pub async fn answer(&self, query: &[u8]) -> Option<Vec<u8>> {
        let query = Message::from_vec(query).ok()?;
        let mut reply = Message::new(query.metadata.id, MessageType::Response, OpCode::Query);
        reply.metadata.recursion_desired = query.metadata.recursion_desired;
        reply.metadata.recursion_available = true;
        let Some(question) = query
            .queries
            .first()
            .filter(|_| query.metadata.op_code == OpCode::Query)
        else {
            reply.metadata.response_code = ResponseCode::NotImp;
            return reply.to_vec().ok();
        };
        reply.add_query(question.clone());

        let name = question.name().clone();
        if let Some(&ip) = self.hosts.get(&canonical(&name.to_ascii())) {
            // The name is here: its one address, if that is what was asked for.
            let data = match (ip, question.query_type()) {
                (IpAddr::V4(ip), RecordType::A) => Some(RData::A(A(ip))),
                (IpAddr::V6(ip), RecordType::AAAA) => Some(RData::AAAA(AAAA(ip))),
                _ => None,
            };
            if let Some(data) = data {
                reply.add_answer(Record::from_rdata(name, 300, data));
            }
            return reply.to_vec().ok();
        }

        match self.resolver.lookup(name, question.query_type()).await {
            Ok(lookup) => reply.insert_answers(lookup.answers().to_vec()),
            Err(error) if error.is_nx_domain() => reply.metadata.response_code = ResponseCode::NXDomain,
            Err(error) if error.is_no_records_found() => {}
            Err(_) => reply.metadata.response_code = ResponseCode::ServFail,
        }
        reply.to_vec().ok()
    }
}

fn canonical(name: &str) -> String {
    name.trim_end_matches('.').to_ascii_lowercase()
}
