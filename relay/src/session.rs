//! One guest's private network behind one WebSocket — QEMU's "user"
//! networking, in effect:
//!
//! ```text
//! 10.0.2.15   the guest
//! 10.0.2.2    the gateway: answers ARP and ping, and is every route out
//! 10.0.2.3    the DNS server (dns.rs)
//! ```
//!
//! smoltcp plays the gateway's end of every TCP connection. Each is dialled
//! for real before the guest's SYN is answered, so "refused" and
//! "unreachable" reach the guest the way a real network would say them. UDP
//! and ICMP echo go around smoltcp: each (guest port, destination) gets a
//! socket of its own out there.

use std::collections::{HashMap, VecDeque};
use std::io::ErrorKind;
use std::net::{Ipv4Addr, SocketAddrV4};
use std::sync::Arc;
use std::time::{Duration, Instant as Clock};

use bytes::{Buf, Bytes};
use smoltcp::iface::{Config, Interface, SocketHandle, SocketSet};
use smoltcp::phy::{Device, DeviceCapabilities, Medium, RxToken, TxToken};
use smoltcp::socket::tcp;
use smoltcp::time::Instant;
use smoltcp::wire::{
    EthernetAddress, EthernetFrame, EthernetProtocol, HardwareAddress, Icmpv4DstUnreachable, Icmpv4Message,
    Icmpv4Packet, IpAddress, IpCidr, IpListenEndpoint, IpProtocol, Ipv4Packet, TcpPacket, UdpPacket,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Semaphore, mpsc};
use tokio::task::JoinHandle;

use crate::Shared;
use crate::egress::{self, Failure};
use crate::packet;

pub const GUEST: Ipv4Addr = Ipv4Addr::new(10, 0, 2, 15);
pub const GATEWAY: Ipv4Addr = Ipv4Addr::new(10, 0, 2, 2);
pub const DNS: Ipv4Addr = Ipv4Addr::new(10, 0, 2, 3);
/// QEMU's gateway address, the one guests have met for decades.
pub const GATEWAY_MAC: EthernetAddress = EthernetAddress([0x52, 0x55, 0x0a, 0x00, 0x02, 0x02]);

const DIAL_TIMEOUT: Duration = Duration::from_secs(15);
const SOCKET_BUFFER: usize = 256 << 10;
const CHUNK: usize = 16 << 10;
const DATAGRAM_IDLE: Duration = Duration::from_secs(60);

/// A TCP connection, or a UDP / ICMP conversation: the guest's port (or
/// echo identifier), and the destination as the guest sees it.
type Key = (u16, SocketAddrV4);

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
    Datagram {
        from: SocketAddrV4,
        to_port: u16,
        data: Vec<u8>,
    },
    /// Nothing listens on that UDP port out there.
    PortClosed(Key),
    Echo {
        from: Ipv4Addr,
        ident: u16,
        seq_no: u16,
        data: Vec<u8>,
    },
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
    datagrams: HashMap<Key, mpsc::Sender<Vec<u8>>>,
    pings: HashMap<Key, mpsc::Sender<(u16, Vec<u8>)>>,
    events_tx: mpsc::Sender<Event>,
    events_rx: mpsc::Receiver<Event>,
    /// Frames made outside smoltcp, for the guest.
    outbox: Vec<Vec<u8>>,
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
            up: 0,
            down: 0,
            connections: 0,
        }
    }

    fn now(&self) -> Instant {
        Instant::from_micros(self.started.elapsed().as_micros() as i64)
    }

    /// Lets smoltcp process what came in, moves bytes between its sockets and
    /// the far ends, and collects every frame for the guest.
    fn step(&mut self) {
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
            EthernetProtocol::Ipv4 => self.guest_ip(frame),
            _ => {}
        }
    }

    fn guest_ip(&mut self, frame: Vec<u8>) {
        let Ok(ip) = Ipv4Packet::new_checked(&frame[EthernetFrame::<&[u8]>::header_len()..]) else {
            return;
        };
        if ip.src_addr() != GUEST || !ip.verify_checksum() {
            return;
        }
        let (dst, protocol, payload) = (ip.dst_addr(), ip.next_header(), ip.payload());

        if dst == DNS
            && protocol == IpProtocol::Udp
            && let Ok(udp) = UdpPacket::new_checked(payload)
            && udp.dst_port() == 53
        {
            return self.dns(udp.src_port(), udp.payload().to_vec());
        }
        if dst == GATEWAY || dst == DNS {
            return self.wire.rx.push_back(frame); // smoltcp: ping, and resets for the rest
        }
        if dst.is_broadcast() || dst.is_multicast() {
            return;
        }
        let parsed = match protocol {
            IpProtocol::Tcp => TcpPacket::new_checked(payload).ok().map(|tcp| {
                let syn = tcp.syn() && !tcp.ack();
                Packet::Tcp((tcp.src_port(), SocketAddrV4::new(dst, tcp.dst_port())), syn)
            }),
            IpProtocol::Udp => UdpPacket::new_checked(payload).ok().map(|udp| {
                Packet::Udp(
                    (udp.src_port(), SocketAddrV4::new(dst, udp.dst_port())),
                    udp.payload().to_vec(),
                )
            }),
            IpProtocol::Icmp => Icmpv4Packet::new_checked(payload)
                .ok()
                .filter(|icmp| icmp.msg_type() == Icmpv4Message::EchoRequest)
                .map(|icmp| {
                    Packet::Echo(
                        (icmp.echo_ident(), SocketAddrV4::new(dst, 0)),
                        icmp.echo_seq_no(),
                        icmp.data().to_vec(),
                    )
                }),
            _ => Some(Packet::Other),
        };
        match parsed {
            Some(Packet::Tcp(key, syn)) => self.tcp(key, syn, frame),
            Some(Packet::Udp(key, data)) => self.udp(key, data, &frame),
            Some(Packet::Echo(key, seq_no, data)) => self.echo(key, seq_no, data),
            Some(Packet::Other) => self.refuse(&frame, Icmpv4DstUnreachable::ProtoUnreachable),
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
            return self.refuse(&syn, Icmpv4DstUnreachable::HostProhibited);
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

    fn udp(&mut self, key: Key, data: Vec<u8>, frame: &[u8]) {
        if !self.shared.config.egress.udp {
            return self.refuse(frame, Icmpv4DstUnreachable::HostProhibited);
        }
        let data = match self.datagrams.get(&key) {
            Some(tx) => match tx.try_send(data) {
                Err(mpsc::error::TrySendError::Closed(data)) => data, // it went idle: start over
                _ => return,                                          // sent, or dropped as UDP may be
            },
            None => data,
        };
        let Some(target) = self.shared.config.policy.route(key.1) else {
            return self.refuse(frame, Icmpv4DstUnreachable::HostProhibited);
        };
        let (tx, rx) = mpsc::channel(64);
        let _ = tx.try_send(data);
        tokio::spawn(datagrams(key, target, rx, self.events_tx.clone()));
        self.datagrams.insert(key, tx);
    }

    fn echo(&mut self, key: Key, seq_no: u16, data: Vec<u8>) {
        let message = match self.pings.get(&key) {
            Some(tx) => match tx.try_send((seq_no, data)) {
                Err(mpsc::error::TrySendError::Closed(message)) => message,
                _ => return,
            },
            None => (seq_no, data),
        };
        let Some(target) = self.shared.config.policy.address(*key.1.ip()) else {
            return;
        };
        let (tx, rx) = mpsc::channel(16);
        let _ = tx.try_send(message);
        tokio::spawn(pings(key, target, rx, self.events_tx.clone()));
        self.pings.insert(key, tx);
    }

    fn dns(&mut self, port: u16, query: Vec<u8>) {
        let (shared, events) = (self.shared.clone(), self.events_tx.clone());
        tokio::spawn(async move {
            if let Some(data) = shared.dns.answer(&query).await {
                let from = SocketAddrV4::new(DNS, 53);
                let _ = events
                    .send(Event::Datagram {
                        from,
                        to_port: port,
                        data,
                    })
                    .await;
            }
        });
    }

    /// Tells the guest, as the gateway, that `frame` will not get through.
    fn refuse(&mut self, frame: &[u8], reason: Icmpv4DstUnreachable) {
        let ip = &frame[EthernetFrame::<&[u8]>::header_len()..];
        self.tell_guest(packet::unreachable(GATEWAY, ip, reason));
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
            Event::Datagram { from, to_port, data } => {
                self.tell_guest(Some(packet::udp(from, SocketAddrV4::new(GUEST, to_port), &data)));
            }
            Event::PortClosed((port, to)) => {
                // What the far host says, about a datagram like the guest's.
                let original = packet::udp(SocketAddrV4::new(GUEST, port), to, &[]);
                self.tell_guest(packet::unreachable(
                    *to.ip(),
                    &original,
                    Icmpv4DstUnreachable::PortUnreachable,
                ));
            }
            Event::Echo {
                from,
                ident,
                seq_no,
                data,
            } => {
                self.tell_guest(Some(packet::echo_reply(from, GUEST, ident, seq_no, &data)));
            }
        }
    }

    fn dialled(&mut self, key: Key, result: Result<(), Failure>) {
        let Some(syn) = self.flows.get_mut(&key).and_then(|flow| flow.syn.take()) else {
            return;
        };
        if let Err(failure) = result {
            self.flows.remove(&key);
            let ip = &syn[EthernetFrame::<&[u8]>::header_len()..];
            return self.tell_guest(match failure {
                Failure::Refused => packet::tcp_reset(ip),
                Failure::Unreachable => packet::unreachable(GATEWAY, ip, Icmpv4DstUnreachable::HostUnreachable),
            });
        }
        let buffer = || tcp::SocketBuffer::new(vec![0; SOCKET_BUFFER]);
        let mut socket = tcp::Socket::new(buffer(), buffer());
        socket.set_nagle_enabled(false);
        let endpoint = IpListenEndpoint {
            addr: Some(IpAddress::Ipv4(*key.1.ip())),
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

enum Packet {
    Tcp(Key, bool),
    Udp(Key, Vec<u8>),
    Echo(Key, u16, Vec<u8>),
    Other,
}

// ─── The far ends ────────────────────────────────────────────────────────────

/// One TCP connection out: dial, report, then carry bytes both ways.
async fn flow(
    key: Key,
    target: SocketAddrV4,
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
async fn datagrams(
    key: Key,
    target: SocketAddrV4,
    mut from_guest: mpsc::Receiver<Vec<u8>>,
    events: mpsc::Sender<Event>,
) {
    let Ok(socket) = egress::udp(target).await else { return };
    let mut buf = vec![0; 65536];
    loop {
        tokio::select! {
            out = from_guest.recv() => match out {
                Some(data) => drop(socket.send(&data).await),
                None => return,
            },
            got = socket.recv(&mut buf) => {
                let event = match got {
                    Ok(n) => Event::Datagram { from: key.1, to_port: key.0, data: buf[..n].to_vec() },
                    // An ICMP "port unreachable" for an earlier datagram (Windows calls it a reset).
                    Err(e) if matches!(e.kind(), ErrorKind::ConnectionRefused | ErrorKind::ConnectionReset) => {
                        Event::PortClosed(key)
                    }
                    Err(_) => continue,
                };
                if events.send(event).await.is_err() {
                    return;
                }
            }
            _ = tokio::time::sleep(DATAGRAM_IDLE) => return,
        }
    }
}

/// One ping conversation: the guest's echo identifier with one destination.
async fn pings(
    key: Key,
    target: Ipv4Addr,
    mut from_guest: mpsc::Receiver<(u16, Vec<u8>)>,
    events: mpsc::Sender<Event>,
) {
    let Ok(socket) = egress::ping(target) else { return };
    let mut buf = vec![0; 65536];
    loop {
        tokio::select! {
            out = from_guest.recv() => match out {
                Some((seq_no, data)) => {
                    let mut request = vec![8, 0, 0, 0, 0, 0];
                    request.extend_from_slice(&seq_no.to_be_bytes());
                    request.extend_from_slice(&data);
                    let _ = socket.send(&request).await;
                }
                None => return,
            },
            got = socket.recv(&mut buf) => if let Ok(n) = got && n >= 8 && buf[0] == 0 {
                let seq_no = u16::from_be_bytes([buf[6], buf[7]]);
                let event = Event::Echo { from: *key.1.ip(), ident: key.0, seq_no, data: buf[8..n].to_vec() };
                if events.send(event).await.is_err() {
                    return;
                }
            },
            _ = tokio::time::sleep(DATAGRAM_IDLE) => return,
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
