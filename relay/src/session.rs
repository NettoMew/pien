//! One guest's private network behind one WebSocket — QEMU's "user"
//! networking, in effect, with IPv6 beside it:
//!
//! ```text
//! 10.0.2.15            the guest
//! 10.0.2.2             the gateway: answers ARP and ping, and is every route out
//! 10.0.2.3             the DNS server (dns.rs)
//! fdca:c697:4c23::/64  the guest's IPv6 network: it makes its own address in it
//! fdca:c697:4c23::2    the gateway again, which advertises itself from fe80::2
//! ```
//!
//! smoltcp plays the gateway's end of every TCP connection. Each is dialled
//! for real before the guest's SYN is answered, so "refused" and
//! "unreachable" reach the guest the way a real network would say them. UDP
//! and ICMP echo go around smoltcp: each (guest port, destination) gets a
//! socket of its own out there.

use std::collections::{HashMap, VecDeque};
use std::io::ErrorKind;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant as Clock};

use bytes::{Buf, Bytes};
use smoltcp::iface::{Config, Interface, SocketHandle, SocketSet};
use smoltcp::phy::{Device, DeviceCapabilities, Medium, RxToken, TxToken};
use smoltcp::socket::tcp;
use smoltcp::time::Instant;
use smoltcp::wire::{
    EthernetAddress, EthernetFrame, EthernetProtocol, HardwareAddress, Icmpv6Message, IpAddress, IpCidr,
    IpListenEndpoint, IpProtocol, TcpPacket, UdpPacket,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UdpSocket;
use tokio::sync::{Semaphore, mpsc};
use tokio::task::JoinHandle;

use crate::Shared;
use crate::egress::{self, Failure};
use crate::packet::{self, Why};
use crate::reports::{self, Report};

pub const GUEST: Ipv4Addr = Ipv4Addr::new(10, 0, 2, 15);
pub const GATEWAY: Ipv4Addr = Ipv4Addr::new(10, 0, 2, 2);
pub const DNS: Ipv4Addr = Ipv4Addr::new(10, 0, 2, 3);
/// The guest's IPv6 network, a /64 of unique local addresses (RFC 4193)
/// whose global ID was drawn at random once: the same in every session, as
/// 10.0.2.0/24 is. The guest makes its address in it (SLAAC).
pub const PREFIX: Ipv6Addr = Ipv6Addr::new(0xfdca, 0xc697, 0x4c23, 0, 0, 0, 0, 0);
pub const GATEWAY6: Ipv6Addr = Ipv6Addr::new(0xfdca, 0xc697, 0x4c23, 0, 0, 0, 0, 2);
/// The gateway on the link itself: routers advertise from link-local addresses.
pub const GATEWAY_LINK: Ipv6Addr = Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 2);
/// QEMU's gateway address, the one guests have met for decades.
pub const GATEWAY_MAC: EthernetAddress = EthernetAddress([0x52, 0x55, 0x0a, 0x00, 0x02, 0x02]);
/// Where frames for every IPv6 node on the link go: ff02::1's.
const ALL_NODES_MAC: EthernetAddress = EthernetAddress([0x33, 0x33, 0, 0, 0, 1]);

/// How long one advertisement keeps the gateway the guest's way out, and
/// how often it advertises again: RFC 4861's defaults.
const ROUTER_LIFETIME: Duration = Duration::from_secs(1800);
const ADVERTISE_EVERY: Duration = Duration::from_secs(600);

const ETHERNET: usize = EthernetFrame::<&[u8]>::header_len();
const DIAL_TIMEOUT: Duration = Duration::from_secs(15);
const SOCKET_BUFFER: usize = 256 << 10;
const CHUNK: usize = 16 << 10;
const DATAGRAM_IDLE: Duration = Duration::from_secs(60);

/// A TCP connection, or a UDP / ICMP conversation: the guest's end (its
/// address, with its port or echo identifier), and the far end as the guest
/// sees it.
type Key = (SocketAddr, SocketAddr);

/// How a session ended, and what went through it — counts only.
#[derive(Debug)]
pub struct Summary {
    pub end: End,
    pub up: u64,
    pub down: u64,
    pub connections: u64,
}

#[derive(Debug, PartialEq)]
pub enum End {
    /// The page went away (or broke the channel).
    Left,
    /// Nothing from the guest for `limits.idle` seconds.
    Idle,
    /// More than `limits.quota` bytes, both ways together.
    Quota,
}

enum Event {
    Dialled(Key, Result<(), Failure>),
    Data(Key, Bytes),
    Eof(Key),
    Broken(Key),
    Wrote,
    /// From the far end of a UDP conversation, or from the DNS server.
    Datagram(Key, Vec<u8>),
    /// Nothing listens on that UDP port out there (where there are no reports).
    PortClosed(Key),
    /// An ICMP error from the network about something the guest sent (reports.rs).
    Report { from: IpAddr, why: Why, quote: Vec<u8> },
    Echo { key: Key, seq_no: u16, data: Vec<u8> },
}

impl Event {
    /// What the network said about a datagram of the guest's, which `quote`
    /// stands for.
    fn report(report: &Report, quote: &[u8]) -> Self {
        let why = Why::Reported { kind: report.kind, code: report.code, rest: report.rest };
        Event::Report { from: report.from, why, quote: quote.to_vec() }
    }
}

struct Flow {
    /// The guest's SYN, held until the far end answers.
    syn: Option<Vec<u8>>,
    socket: Option<SocketHandle>,
    to_remote: Option<mpsc::Sender<Bytes>>,
    /// One chunk from the far end at a time, given back once it is in smoltcp.
    credit: Arc<Semaphore>,
    pending: Bytes,
    owed: bool,
    remote_eof: bool,
    closing: bool,
    task: JoinHandle<()>,
}

pub async fn run(
    shared: Arc<Shared>,
    mut from_page: mpsc::Receiver<Vec<u8>>,
    to_page: mpsc::Sender<Vec<u8>>,
) -> Summary {
    let mut session = Session::new(shared);
    let idle = Duration::from_secs(session.shared.config.limits.idle.max(1));
    let quota = session.shared.config.limits.quota;
    let mut heard = Clock::now();
    let end = loop {
        session.step();
        for frame in std::mem::take(&mut session.outbox) {
            session.down += frame.len() as u64;
            if to_page.send(frame).await.is_err() {
                break;
            }
        }
        if to_page.is_closed() {
            break End::Left;
        }
        if heard.elapsed() > idle {
            break End::Idle;
        }
        if quota > 0 && session.up + session.down > quota {
            break End::Quota;
        }
        let wait = session.iface.poll_delay(session.now(), &session.sockets);
        let wait = wait
            .map_or(Duration::from_secs(1), |d| Duration::from_micros(d.total_micros()))
            .min(Duration::from_secs(1));
        tokio::select! {
            event = session.events_rx.recv() => {
                let Some(event) = event else { break End::Left };
                session.event(event);
                while let Ok(event) = session.events_rx.try_recv() {
                    session.event(event);
                }
            }
            frame = from_page.recv() => {
                let Some(frame) = frame else { break End::Left };
                heard = Clock::now();
                session.guest_frame(frame);
                while let Ok(frame) = from_page.try_recv() {
                    session.guest_frame(frame);
                }
            }
            _ = tokio::time::sleep(wait) => {}
        }
    };
    for flow in session.flows.values() {
        flow.task.abort();
    }
    Summary {
        end,
        up: session.up,
        down: session.down,
        connections: session.connections,
    }
}

struct Session {
    shared: Arc<Shared>,
    iface: Interface,
    wire: Wire,
    sockets: SocketSet<'static>,
    started: Clock,
    guest_mac: Option<EthernetAddress>,
    flows: HashMap<Key, Flow>,
    datagrams: HashMap<Key, mpsc::Sender<Probe>>,
    pings: HashMap<Key, mpsc::Sender<Probe>>,
    events_tx: mpsc::Sender<Event>,
    events_rx: mpsc::Receiver<Event>,
    /// Frames made outside smoltcp, for the guest.
    outbox: Vec<Vec<u8>>,
    /// When the gateway next tells the link it is there, unasked.
    next_advert: Clock,
    up: u64,
    down: u64,
    connections: u64,
}

impl Session {
    fn new(shared: Arc<Shared>) -> Self {
        let mut wire = Wire::default();
        let mut config = Config::new(HardwareAddress::Ethernet(GATEWAY_MAC));
        let mut seed = [0; 8];
        getrandom::fill(&mut seed).expect("the OS has randomness");
        config.random_seed = u64::from_le_bytes(seed);
        let mut iface = Interface::new(config, &mut wire, Instant::from_millis(0));
        iface.update_ip_addrs(|addrs| {
            addrs.push(IpCidr::new(IpAddress::Ipv4(GATEWAY), 24)).unwrap();
            addrs.push(IpCidr::new(IpAddress::Ipv4(DNS), 24)).unwrap();
            addrs.push(IpCidr::new(IpAddress::Ipv6(GATEWAY6), 64)).unwrap();
            addrs.push(IpCidr::new(IpAddress::Ipv6(GATEWAY_LINK), 64)).unwrap();
        });
        // Accept packets for any address, as a router does: all routes lead here.
        iface.set_any_ip(true);
        iface.routes_mut().add_default_ipv4_route(GATEWAY).unwrap();
        let (events_tx, events_rx) = mpsc::channel(1024);
        Self {
            shared,
            iface,
            wire,
            sockets: SocketSet::new(vec![]),
            started: Clock::now(),
            guest_mac: None,
            flows: HashMap::new(),
            datagrams: HashMap::new(),
            pings: HashMap::new(),
            events_tx,
            events_rx,
            outbox: Vec::new(),
            next_advert: Clock::now(),
            up: 0,
            down: 0,
            connections: 0,
        }
    }

    fn now(&self) -> Instant {
        Instant::from_micros(self.started.elapsed().as_micros() as i64)
    }

    /// Lets smoltcp process what came in, moves bytes between its sockets and
    /// the far ends, and collects every frame for the guest — with an
    /// advertisement of the gateway, when one is due.
    fn step(&mut self) {
        if Clock::now() >= self.next_advert {
            self.advertise();
        }
        let now = self.now();
        self.iface.poll(now, &mut self.wire, &mut self.sockets);
        self.service();
        self.iface.poll(now, &mut self.wire, &mut self.sockets);
        self.outbox.append(&mut self.wire.tx);
    }

    // ─── From the guest ──────────────────────────────────────────────────────

    fn guest_frame(&mut self, frame: Vec<u8>) {
        self.up += frame.len() as u64;
        let Ok(ethernet) = EthernetFrame::new_checked(&frame[..]) else {
            return;
        };
        if ethernet.src_addr().is_unicast() {
            self.guest_mac = Some(ethernet.src_addr());
        }
        match ethernet.ethertype() {
            EthernetProtocol::Arp => self.wire.rx.push_back(frame),
            EthernetProtocol::Ipv4 | EthernetProtocol::Ipv6 => self.guest_ip(frame),
            _ => {}
        }
    }

    fn guest_ip(&mut self, frame: Vec<u8>) {
        let raw = &frame[ETHERNET..];
        let Some(ip) = packet::Ip::parse(raw) else {
            return;
        };
        match ip.icmpv6() {
            Some(Icmpv6Message::RouterSolicit) => return self.advertise(),
            // smoltcp keeps the gateway's neighbours, and answers as one.
            Some(Icmpv6Message::NeighborSolicit | Icmpv6Message::NeighborAdvert) => {
                return self.wire.rx.push_back(frame);
            }
            _ => {}
        }
        let to_gateway = is_gateway(ip.dst);
        if !from_guest(ip.src, to_gateway) {
            return;
        }
        if ip.dst == IpAddr::V4(DNS)
            && ip.protocol == IpProtocol::Udp
            && let Ok(udp) = UdpPacket::new_checked(ip.payload)
            && udp.dst_port() == 53
        {
            return self.dns(SocketAddr::new(ip.src, udp.src_port()), udp.payload().to_vec());
        }
        if to_gateway {
            return self.wire.rx.push_back(frame); // smoltcp: ping, and resets for the rest
        }
        if ip.dst.is_multicast() || ip.dst == IpAddr::V4(Ipv4Addr::BROADCAST) {
            return;
        }
        // A router: what arrives on its last hop goes no further. This is
        // traceroute's (and mtr's) first answer.
        if ip.hop_limit <= 1 {
            return self.refuse(raw, Why::TimeExceeded);
        }
        let ends = |from, to| (SocketAddr::new(ip.src, from), SocketAddr::new(ip.dst, to));
        let probe = |seq_no, data: &[u8]| Probe {
            seq_no,
            data: data.to_vec(),
            hop_limit: ip.hop_limit,
            quote: packet::quote(raw).to_vec(),
        };
        let parsed = match ip.protocol {
            IpProtocol::Tcp => TcpPacket::new_checked(ip.payload).ok().map(|tcp| {
                let syn = tcp.syn() && !tcp.ack();
                Packet::Tcp(ends(tcp.src_port(), tcp.dst_port()), syn)
            }),
            IpProtocol::Udp => UdpPacket::new_checked(ip.payload)
                .ok()
                .map(|udp| Packet::Udp(ends(udp.src_port(), udp.dst_port()), probe(0, udp.payload()))),
            IpProtocol::Icmp | IpProtocol::Icmpv6 => ip
                .echo_request()
                .map(|(ident, seq_no, data)| Packet::Echo(ends(ident, 0), probe(seq_no, data))),
            _ => Some(Packet::Other),
        };
        match parsed {
            Some(Packet::Tcp(key, syn)) => self.tcp(key, syn, frame),
            Some(Packet::Udp(key, probe)) => self.udp(key, probe, &frame[ETHERNET..]),
            Some(Packet::Echo(key, probe)) => self.echo(key, probe),
            Some(Packet::Other) => self.refuse(&frame[ETHERNET..], Why::Protocol),
            None => {}
        }
    }

    fn tcp(&mut self, key: Key, syn: bool, frame: Vec<u8>) {
        match self.flows.get(&key) {
            Some(flow) if flow.socket.is_some() => self.wire.rx.push_back(frame),
            Some(_) => {} // the SYN again, while we dial
            None if syn => self.dial(key, frame),
            None => self.wire.rx.push_back(frame), // a stray segment: smoltcp resets it
        }
    }

    fn dial(&mut self, key: Key, syn: Vec<u8>) {
        let config = &self.shared.config;
        let target = (self.flows.len() < config.limits.flows)
            .then(|| config.policy.route(key.1))
            .flatten();
        let Some(target) = target else {
            return self.refuse(&syn[ETHERNET..], Why::Prohibited);
        };
        let (to_remote, from_guest) = mpsc::channel(4);
        let credit = Arc::new(Semaphore::new(1));
        let task = tokio::spawn(flow(
            key,
            target,
            self.shared.clone(),
            from_guest,
            credit.clone(),
            self.events_tx.clone(),
        ));
        self.flows.insert(
            key,
            Flow {
                syn: Some(syn),
                socket: None,
                to_remote: Some(to_remote),
                credit,
                pending: Bytes::new(),
                owed: false,
                remote_eof: false,
                closing: false,
                task,
            },
        );
        self.connections += 1;
    }

    fn udp(&mut self, key: Key, probe: Probe, packet: &[u8]) {
        if !self.shared.config.egress.udp {
            return self.refuse(packet, Why::Prohibited);
        }
        let probe = match self.datagrams.get(&key) {
            Some(tx) => match tx.try_send(probe) {
                Err(mpsc::error::TrySendError::Closed(probe)) => probe, // it went idle: start over
                _ => return,                                            // sent, or dropped as UDP may be
            },
            None => probe,
        };
        let Some(target) = self.shared.config.policy.route(key.1) else {
            return self.refuse(packet, Why::Prohibited);
        };
        let (tx, rx) = mpsc::channel(64);
        let _ = tx.try_send(probe);
        tokio::spawn(datagrams(key, target, rx, self.events_tx.clone()));
        self.datagrams.insert(key, tx);
    }

    fn echo(&mut self, key: Key, probe: Probe) {
        let probe = match self.pings.get(&key) {
            Some(tx) => match tx.try_send(probe) {
                Err(mpsc::error::TrySendError::Closed(probe)) => probe,
                _ => return,
            },
            None => probe,
        };
        let Some(target) = self.shared.config.policy.address(key.1.ip()) else {
            return;
        };
        let (tx, rx) = mpsc::channel(64);
        let _ = tx.try_send(probe);
        tokio::spawn(pings(key, target, rx, self.events_tx.clone()));
        self.pings.insert(key, tx);
    }

    fn dns(&mut self, guest: SocketAddr, query: Vec<u8>) {
        let (shared, events) = (self.shared.clone(), self.events_tx.clone());
        tokio::spawn(async move {
            if let Some(answer) = shared.dns.answer(&query).await {
                let _ = events.send(Event::Datagram((guest, (DNS, 53).into()), answer)).await;
            }
        });
    }

    /// Tells every node on the link — the guest — that the gateway is the
    /// way out, and which network to make an address in.
    fn advertise(&mut self) {
        let advert = packet::router_advert(GATEWAY_LINK, GATEWAY_MAC, PREFIX, ROUTER_LIFETIME);
        self.outbox.push(packet::ethernet(ALL_NODES_MAC, GATEWAY_MAC, &advert));
        self.next_advert = Clock::now() + ADVERTISE_EVERY;
    }

    /// Tells the guest, as the gateway, why `packet` goes no further.
    fn refuse(&mut self, packet: &[u8], why: Why) {
        let gateway = match packet::source(packet) {
            Some(IpAddr::V4(_)) => IpAddr::V4(GATEWAY),
            Some(IpAddr::V6(_)) => IpAddr::V6(GATEWAY6),
            None => return,
        };
        self.tell_guest(packet::icmp_error(gateway, why, packet));
    }

    fn tell_guest(&mut self, ip: Option<Vec<u8>>) {
        if let (Some(ip), Some(mac)) = (ip, self.guest_mac) {
            self.outbox.push(packet::ethernet(mac, GATEWAY_MAC, &ip));
        }
    }

    // ─── From the far ends ───────────────────────────────────────────────────

    fn event(&mut self, event: Event) {
        match event {
            Event::Dialled(key, result) => self.dialled(key, result),
            Event::Data(key, data) => {
                if let Some(flow) = self.flows.get_mut(&key) {
                    flow.pending = data;
                    flow.owed = true;
                }
            }
            Event::Eof(key) => {
                if let Some(flow) = self.flows.get_mut(&key) {
                    flow.remote_eof = true;
                }
            }
            Event::Broken(key) => {
                if let Some(flow) = self.flows.get_mut(&key) {
                    flow.remote_eof = true;
                    flow.to_remote = None;
                    flow.pending = Bytes::new();
                    if let Some(socket) = flow.socket {
                        self.sockets.get_mut::<tcp::Socket>(socket).abort();
                    }
                }
            }
            Event::Wrote => {} // room again on the way out: the next step uses it
            Event::Datagram((guest, far), data) => self.tell_guest(packet::udp(far, guest, &data)),
            Event::PortClosed((guest, far)) => {
                // What the far host says, about a datagram like the guest's.
                let datagram = packet::udp(guest, far, &[]);
                self.tell_guest(datagram.and_then(|d| packet::icmp_error(far.ip(), Why::PortClosed, &d)));
            }
            Event::Report { from, why, quote } => self.tell_guest(packet::icmp_error(from, why, &quote)),
            Event::Echo { key: (guest, far), seq_no, data } => {
                self.tell_guest(packet::echo_reply(far.ip(), guest.ip(), guest.port(), seq_no, &data));
            }
        }
    }

    fn dialled(&mut self, key: Key, result: Result<(), Failure>) {
        let Some(syn) = self.flows.get_mut(&key).and_then(|flow| flow.syn.take()) else {
            return;
        };
        if let Err(failure) = result {
            self.flows.remove(&key);
            let ip = &syn[ETHERNET..];
            return match failure {
                Failure::Refused => self.tell_guest(packet::tcp_reset(ip)),
                Failure::Unreachable => self.refuse(ip, Why::Unreachable),
            };
        }
        let buffer = || tcp::SocketBuffer::new(vec![0; SOCKET_BUFFER]);
        let mut socket = tcp::Socket::new(buffer(), buffer());
        socket.set_nagle_enabled(false);
        let endpoint = IpListenEndpoint {
            addr: Some(key.1.ip().into()),
            port: key.1.port(),
        };
        socket.listen(endpoint).expect("a fresh socket listens");
        let handle = self.sockets.add(socket);
        self.flows.get_mut(&key).expect("still dialling").socket = Some(handle);
        // Hand it this SYN at once, before any other listener could take it.
        self.wire.rx.push_back(syn);
        let now = self.now();
        self.iface.poll(now, &mut self.wire, &mut self.sockets);
    }

    /// Moves bytes between smoltcp's sockets and the far ends.
    fn service(&mut self) {
        let mut done = Vec::new();
        for (key, flow) in &mut self.flows {
            let Some(handle) = flow.socket else { continue };
            let socket = self.sockets.get_mut::<tcp::Socket>(handle);

            // The far end → the guest.
            if !flow.pending.is_empty()
                && socket.can_send()
                && let Ok(sent) = socket.send_slice(&flow.pending)
            {
                flow.pending.advance(sent);
            }
            if flow.pending.is_empty() {
                if flow.owed {
                    flow.credit.add_permits(1);
                    flow.owed = false;
                }
                if flow.remote_eof && !flow.closing {
                    socket.close();
                    flow.closing = true;
                }
            }

            // The guest → the far end.
            if let Some(to_remote) = &flow.to_remote {
                while socket.can_recv() {
                    let Ok(permit) = to_remote.try_reserve() else { break };
                    let chunk = socket.recv(|buf| {
                        let n = buf.len().min(CHUNK);
                        (n, Bytes::copy_from_slice(&buf[..n]))
                    });
                    if let Ok(chunk) = chunk {
                        permit.send(chunk);
                    }
                }
                let guest_done = matches!(
                    socket.state(),
                    tcp::State::CloseWait | tcp::State::LastAck | tcp::State::Closing | tcp::State::TimeWait
                );
                if guest_done && socket.recv_queue() == 0 {
                    flow.to_remote = None; // the guest's FIN, passed on as a half-close
                }
            }

            if matches!(socket.state(), tcp::State::Closed | tcp::State::TimeWait) {
                done.push(*key);
            }
        }
        for key in done {
            let flow = self.flows.remove(&key).expect("just seen");
            self.sockets.remove(flow.socket.expect("open"));
            if flow.to_remote.is_some() || !flow.remote_eof {
                flow.task.abort(); // reset, not closed: drop the far end too
            }
        }
    }
}

/// The addresses the gateway answers on itself.
fn is_gateway(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ip == GATEWAY || ip == DNS,
        IpAddr::V6(ip) => ip == GATEWAY6 || ip == GATEWAY_LINK,
    }
}

/// Whether the guest may send from `src`: 10.0.2.15, or an address it made in
/// its IPv6 network. Its link-local address reaches the gateway alone, as on
/// any link: routers forward nothing from one.
fn from_guest(src: IpAddr, to_gateway: bool) -> bool {
    match src {
        IpAddr::V4(src) => src == GUEST,
        IpAddr::V6(src) => src.segments()[..4] == PREFIX.segments()[..4] || (to_gateway && src.is_unicast_link_local()),
    }
}

enum Packet {
    Tcp(Key, bool),
    Udp(Key, Probe),
    Echo(Key, Probe),
    Other,
}

/// A datagram or echo request for out there: what the guest sent, with the
/// hop limit it arrived with and what an ICMP error about it would quote.
struct Probe {
    seq_no: u16,
    data: Vec<u8>,
    hop_limit: u8,
    quote: Vec<u8>,
}

// ─── The far ends ────────────────────────────────────────────────────────────

/// One TCP connection out: dial, report, then carry bytes both ways.
async fn flow(
    key: Key,
    target: SocketAddr,
    shared: Arc<Shared>,
    mut from_guest: mpsc::Receiver<Bytes>,
    credit: Arc<Semaphore>,
    events: mpsc::Sender<Event>,
) {
    let dialled = tokio::time::timeout(DIAL_TIMEOUT, egress::tcp(&shared.config.egress, target)).await;
    let stream = match dialled.unwrap_or(Err(Failure::Unreachable)) {
        Ok(stream) => stream,
        Err(failure) => return drop(events.send(Event::Dialled(key, Err(failure))).await),
    };
    if events.send(Event::Dialled(key, Ok(()))).await.is_err() {
        return;
    }
    let (mut reader, mut writer) = tokio::io::split(stream);
    let down = async {
        let mut buf = vec![0; CHUNK];
        loop {
            let Ok(permit) = credit.acquire().await else { return };
            permit.forget();
            let event = match reader.read(&mut buf).await {
                Ok(0) => Event::Eof(key),
                Ok(n) => Event::Data(key, Bytes::copy_from_slice(&buf[..n])),
                Err(_) => Event::Broken(key),
            };
            let last = !matches!(event, Event::Data(..));
            if events.send(event).await.is_err() || last {
                return;
            }
        }
    };
    let up = async {
        while let Some(chunk) = from_guest.recv().await {
            if writer.write_all(&chunk).await.is_err() {
                return drop(events.send(Event::Broken(key)).await);
            }
            let _ = events.send(Event::Wrote).await;
        }
        let _ = writer.shutdown().await;
    };
    tokio::join!(down, up);
}

/// One UDP conversation: the guest's port with one destination.
async fn datagrams(key: Key, target: SocketAddr, mut from_guest: mpsc::Receiver<Probe>, events: mpsc::Sender<Event>) {
    let Ok(socket) = egress::udp(target).await else { return };
    reports::enable(&socket);
    let mut hops = Hops::default();
    let mut quote = Vec::new(); // the latest datagram's, for what the network says about it
    let mut buf = vec![0; 65536];
    loop {
        tokio::select! {
            out = from_guest.recv() => match out {
                Some(probe) => {
                    hops.set(&socket, probe.hop_limit);
                    quote = probe.quote;
                    let _ = socket.send(&probe.data).await;
                }
                None => return,
            },
            got = socket.recv(&mut buf) => {
                let mut out: Vec<Event> = reports::drain(&socket).iter().map(|r| Event::report(r, &quote)).collect();
                match got {
                    Ok(n) => out.push(Event::Datagram(key, buf[..n].to_vec())),
                    // Without reports: "port unreachable" for an earlier datagram (Windows calls it a reset).
                    Err(e) if out.is_empty() && matches!(e.kind(), ErrorKind::ConnectionRefused | ErrorKind::ConnectionReset) => {
                        out.push(Event::PortClosed(key));
                    }
                    Err(_) => {}
                }
                for event in out {
                    if events.send(event).await.is_err() {
                        return;
                    }
                }
            }
            _ = tokio::time::sleep(DATAGRAM_IDLE) => return,
        }
    }
}

/// One ping conversation: the guest's echo identifier with one destination.
async fn pings(key: Key, target: IpAddr, mut from_guest: mpsc::Receiver<Probe>, events: mpsc::Sender<Event>) {
    let Ok(socket) = egress::ping(target) else { return };
    reports::enable(&socket);
    let (request, reply) = packet::echo(target.is_ipv6());
    let mut hops = Hops::default();
    // What errors about recent requests would quote, by sequence number.
    let mut quotes: VecDeque<(u16, Vec<u8>)> = VecDeque::new();
    let mut buf = vec![0; 65536];
    loop {
        tokio::select! {
            out = from_guest.recv() => match out {
                Some(probe) => {
                    hops.set(&socket, probe.hop_limit);
                    if quotes.len() == 64 {
                        quotes.pop_front();
                    }
                    quotes.push_back((probe.seq_no, probe.quote));
                    let mut message = vec![request, 0, 0, 0, 0, 0];
                    message.extend_from_slice(&probe.seq_no.to_be_bytes());
                    message.extend_from_slice(&probe.data);
                    let _ = socket.send(&message).await;
                }
                None => return,
            },
            got = socket.recv(&mut buf) => {
                let mut out = Vec::new();
                if let Ok(n) = got && n >= 8 && buf[0] == reply {
                    let seq_no = u16::from_be_bytes([buf[6], buf[7]]);
                    out.push(Event::Echo { key, seq_no, data: buf[8..n].to_vec() });
                }
                for report in reports::drain(&socket) {
                    // The request it is about carries our sequence number.
                    let Some(seq_no) = report.sent.get(6..8).map(|s| u16::from_be_bytes([s[0], s[1]])) else { continue };
                    if let Some((_, quote)) = quotes.iter().find(|(s, _)| *s == seq_no) {
                        out.push(Event::report(&report, quote));
                    }
                }
                for event in out {
                    if events.send(event).await.is_err() {
                        return;
                    }
                }
            }
            _ = tokio::time::sleep(DATAGRAM_IDLE) => return,
        }
    }
}

/// The hop limit a socket sends with: what the guest's packet had left after
/// this gateway, so that traceroute and mtr reach as far as they mean to.
#[derive(Default)]
struct Hops(u8);

impl Hops {
    fn set(&mut self, socket: &UdpSocket, guest_hop_limit: u8) {
        let left = guest_hop_limit.saturating_sub(1).max(1);
        if left == self.0 {
            return;
        }
        let options = socket2::SockRef::from(socket);
        let set = match socket.local_addr() {
            Ok(SocketAddr::V6(_)) => options.set_unicast_hops_v6(left.into()),
            _ => options.set_ttl_v4(left.into()),
        };
        if set.is_ok() {
            self.0 = left;
        }
    }
}

// ─── smoltcp's view of the wire ──────────────────────────────────────────────

#[derive(Default)]
struct Wire {
    rx: VecDeque<Vec<u8>>,
    tx: Vec<Vec<u8>>,
}

struct Rx(Vec<u8>);
struct Tx<'a>(&'a mut Vec<Vec<u8>>);

impl RxToken for Rx {
    fn consume<R, F: FnOnce(&[u8]) -> R>(self, f: F) -> R {
        f(&self.0)
    }
}

impl TxToken for Tx<'_> {
    fn consume<R, F: FnOnce(&mut [u8]) -> R>(self, len: usize, f: F) -> R {
        let mut frame = vec![0; len];
        let result = f(&mut frame);
        self.0.push(frame);
        result
    }
}

impl Device for Wire {
    type RxToken<'a> = Rx;
    type TxToken<'a> = Tx<'a>;

    fn receive(&mut self, _: Instant) -> Option<(Rx, Tx<'_>)> {
        let frame = self.rx.pop_front()?;
        Some((Rx(frame), Tx(&mut self.tx)))
    }

    fn transmit(&mut self, _: Instant) -> Option<Tx<'_>> {
        Some(Tx(&mut self.tx))
    }

    fn capabilities(&self) -> DeviceCapabilities {
        let mut caps = DeviceCapabilities::default();
        caps.medium = Medium::Ethernet;
        caps.max_transmission_unit = 1514;
        caps
    }
}
