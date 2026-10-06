//! The relay end to end: a smoltcp guest (10.0.2.15, and the IPv6 address
//! the gateway hands it by DHCPv6; its own Ethernet, ARP and neighbour
//! discovery) talks over a real WebSocket and the sealed channel to a relay
//! in this process, which reaches services on this machine through aliases:
//! 192.0.2.10 → 127.0.0.1, 2001:db8::10 → ::1.

use std::collections::VecDeque;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant as Clock};

use futures_util::{SinkExt, StreamExt};
use relay::channel::{Connecting, HELLO, WELCOME};
use relay::session::{GATEWAY, GATEWAY_LINK, GATEWAY_MAC, GATEWAY6, GUEST, PREFIX};
use relay::{Config, Shared, dhcp, server, token};
use smoltcp::iface::{Config as IfaceConfig, Interface, SocketHandle, SocketSet};
use smoltcp::phy::{ChecksumCapabilities, Device, DeviceCapabilities, Medium, RxToken, TxToken};
use smoltcp::socket::{tcp, udp};
use smoltcp::time::Instant;
use smoltcp::wire::{
    EthernetAddress, EthernetFrame, EthernetProtocol, EthernetRepr, HardwareAddress, Icmpv4Packet, Icmpv4Repr,
    Icmpv6Packet, Icmpv6Repr, IpAddress, IpCidr, IpProtocol, IpRepr, Ipv4Packet, Ipv6Packet,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, UdpSocket};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use tokio_tungstenite::tungstenite::Message;

const KEY: [u8; 32] = [0x11; 32];
const SESSION_KEY: [u8; 32] = [0x33; 32];
const SERVICES: Ipv4Addr = Ipv4Addr::new(192, 0, 2, 10);
const SERVICES6: Ipv6Addr = Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 0x10);
const GUEST_MAC: EthernetAddress = EthernetAddress([0x52, 0x54, 0x00, 0x12, 0x34, 0x56]);
/// The guest's link-local address, from its MAC (EUI-64), as Linux makes it.
const GUEST_LINK: Ipv6Addr = Ipv6Addr::new(0xfe80, 0, 0, 0, 0x5054, 0x00ff, 0xfe12, 0x3456);
const BULK: usize = 16 << 20;

/// One family of addresses, for what the tests try in both.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Family {
    V4,
    V6,
}

use Family::{V4, V6};

impl Family {
    /// The services on this machine, as the guest reaches them: an alias.
    fn services(self) -> IpAddr {
        match self {
            V4 => SERVICES.into(),
            V6 => SERVICES6.into(),
        }
    }

    /// Where those services really are.
    fn here(self) -> IpAddr {
        match self {
            V4 => Ipv4Addr::LOCALHOST.into(),
            V6 => Ipv6Addr::LOCALHOST.into(),
        }
    }

    fn gateway(self) -> IpAddr {
        match self {
            V4 => GATEWAY.into(),
            V6 => GATEWAY6.into(),
        }
    }

    /// Somewhere private, where the policy lets no guest go.
    fn private(self) -> IpAddr {
        match self {
            V4 => Ipv4Addr::new(10, 9, 9, 9).into(),
            V6 => Ipv6Addr::new(0xfd00, 0, 0, 0, 0, 0, 0, 9).into(),
        }
    }

    /// ICMP's types (and codes), as this family numbers them.
    fn echo(self) -> (u8, u8) {
        match self {
            V4 => (8, 0),
            V6 => (128, 129),
        }
    }

    fn prohibited(self) -> (u8, u8) {
        match self {
            V4 => (3, 10),
            V6 => (1, 1),
        }
    }

    fn port_closed(self) -> (u8, u8) {
        match self {
            V4 => (3, 3),
            V6 => (1, 4),
        }
    }

    fn time_exceeded(self) -> u8 {
        match self {
            V4 => 11,
            V6 => 3,
        }
    }
}

async fn relay() -> SocketAddr {
    relay_with("").await
}

/// A relay in this process; `more` adds tables to its configuration.
async fn relay_with(more: &str) -> SocketAddr {
    let config = Config::parse(&format!(
        r#"
        listen = "127.0.0.1:0"
        key = "{}"
        session_key = "{}"
        [dns]
        upstream = "127.0.0.1"
        hosts = {{ "test.home" = "{SERVICES}", "test6.home" = "{SERVICES6}" }}
        [policy]
        aliases = {{ "{SERVICES}" = "127.0.0.1", "{SERVICES6}" = "::1" }}
        {more}
        "#,
        "11".repeat(32),
        "33".repeat(32)
    ))
    .unwrap();
    let (address, serving) = server::bind(Shared::new(config, None).unwrap()).await.unwrap();
    tokio::spawn(serving);
    address
}

/// Opens the channel the way the page does with a relay's own key; `None` if
/// the relay turns us away.
async fn connect(relay: SocketAddr, key: [u8; 32]) -> Option<Guest> {
    open(relay, Connecting::new(), key).await
}

/// Opens the channel the way the page does with the site's login.
async fn log_in(relay: SocketAddr, token: &[u8], key: [u8; 32]) -> Option<Guest> {
    open(relay, Connecting::with_token(token), key).await
}

async fn open(relay: SocketAddr, (hello, connecting): (Vec<u8>, Connecting), key: [u8; 32]) -> Option<Guest> {
    let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{relay}/relay"))
        .await
        .unwrap();
    let (mut sink, mut source) = ws.split();
    sink.send(Message::binary(hello)).await.unwrap();
    let reply = binary(&mut source).await?;
    let (mut sealer, mut opener) = connecting.finish(&key, &reply)?;
    sink.send(Message::binary(sealer.seal(HELLO))).await.unwrap();
    let welcome = binary(&mut source).await?;
    assert_eq!(opener.open(&welcome).as_deref(), Some(WELCOME));

    let (to_relay, mut outgoing) = unbounded_channel::<Vec<u8>>();
    let (incoming, from_relay) = unbounded_channel::<Vec<u8>>();
    tokio::spawn(async move {
        while let Some(frame) = outgoing.recv().await {
            if sink.send(Message::binary(sealer.seal(&frame))).await.is_err() {
                return;
            }
        }
    });
    let closed = Arc::new(Mutex::new(None));
    let close_code = closed.clone();
    tokio::spawn(async move {
        while let Some(Ok(message)) = source.next().await {
            match message {
                Message::Binary(sealed) => {
                    let _ = incoming.send(opener.open(&sealed).expect("frames from the relay open"));
                }
                Message::Close(frame) => *close_code.lock().unwrap() = frame.map(|f| u16::from(f.code)),
                _ => {}
            }
        }
    });
    Some(Guest::new(to_relay, from_relay, closed).boot().await)
}

async fn binary<S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin>(
    source: &mut S,
) -> Option<bytes::Bytes> {
    loop {
        match source.next().await? {
            Ok(Message::Binary(data)) => return Some(data),
            Ok(Message::Ping(_) | Message::Pong(_)) => {}
            _ => return None,
        }
    }
}

// ─── the guest ───────────────────────────────────────────────────────────────

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

struct Guest {
    iface: Interface,
    wire: Wire,
    sockets: SocketSet<'static>,
    to_relay: UnboundedSender<Vec<u8>>,
    from_relay: UnboundedReceiver<Vec<u8>>,
    started: Clock,
    port: u16,
    /// Every frame the relay sent, for the ones smoltcp would not show us.
    seen: Vec<Vec<u8>>,
    /// The relay's close code, once it has hung up.
    closed: Arc<Mutex<Option<u16>>>,
    hung_up: bool,
}

impl Guest {
    fn new(
        to_relay: UnboundedSender<Vec<u8>>,
        from_relay: UnboundedReceiver<Vec<u8>>,
        closed: Arc<Mutex<Option<u16>>>,
    ) -> Self {
        let mut wire = Wire::default();
        let config = IfaceConfig::new(HardwareAddress::Ethernet(GUEST_MAC));
        let mut iface = Interface::new(config, &mut wire, Instant::ZERO);
        iface.update_ip_addrs(|a| {
            a.push(IpCidr::new(GUEST.into(), 24)).unwrap();
            a.push(IpCidr::new(GUEST_LINK.into(), 64)).unwrap();
        });
        Self {
            iface,
            wire,
            sockets: SocketSet::new(vec![]),
            to_relay,
            from_relay,
            started: Clock::now(),
            port: 49152,
            seen: vec![],
            closed,
            hung_up: false,
        }
    }

    fn now(&self) -> Instant {
        Instant::from_micros(self.started.elapsed().as_micros() as i64)
    }

    /// Comes up as Linux does behind the relay: the gateway advertises
    /// itself, and that addresses are to be asked for; the guest asks, the
    /// way udhcpc6 does — solicit, advertise, request, reply — and takes the
    /// gateway as its way out in both families.
    async fn boot(mut self) -> Self {
        self.until(Duration::from_secs(5), |g| g.advertised().then_some(()))
            .await
            .expect("the gateway's advertisement, saying to ask for an address");
        let advert = self.dhcpv6(SOLICIT, &[]).await.expect("an advertise");
        assert_eq!(advert[0], ADVERTISE);
        let server = dhcpv6_option(&advert, SERVER_ID).expect("the server's DUID");
        let reply = self.dhcpv6(REQUEST, &[(SERVER_ID, &server)]).await.expect("a reply");
        assert_eq!(reply[0], REPLY);
        let address = dhcpv6_lease(&reply).expect("an address, for the guest's IA_NA");
        self.iface.update_ip_addrs(|a| a.push(IpCidr::new(address.into(), 128)).unwrap());
        self.iface.routes_mut().add_default_ipv6_route(GATEWAY_LINK).unwrap();
        self.iface.routes_mut().add_default_ipv4_route(GATEWAY).unwrap();
        self
    }

    /// Whether the gateway has advertised itself (type 134), with the M flag.
    fn advertised(&self) -> bool {
        self.icmp()
            .any(|(from, message)| from == IpAddr::V6(GATEWAY_LINK) && message[0] == 134 && message[5] & 0x80 != 0)
    }

    /// Sends the gateway a DHCPv6 message of this type, from the guest's
    /// link-local address, and waits for its answer.
    async fn dhcpv6(&mut self, kind: u8, more: &[(u16, &[u8])]) -> Option<Vec<u8>> {
        let buffer = || udp::PacketBuffer::new(vec![udp::PacketMetadata::EMPTY; 4], vec![0; 2048]);
        let mut socket = udp::Socket::new(buffer(), buffer());
        socket.bind((IpAddress::from(GUEST_LINK), dhcp::CLIENT)).unwrap();
        socket.send_slice(&dhcpv6_message(kind, more), (IpAddress::from(dhcp::SERVERS), dhcp::SERVER)).unwrap();
        let handle = self.sockets.add(socket);
        let mut buf = [0; 2048];
        let answer = self
            .until(Duration::from_secs(5), |g| {
                let socket = g.sockets.get_mut::<udp::Socket>(handle);
                socket.recv_slice(&mut buf).ok().map(|(n, _)| buf[..n].to_vec())
            })
            .await;
        self.sockets.remove(handle);
        answer
    }

    fn ipv6(&self) -> Option<IpAddr> {
        self.iface.ip_addrs().iter().find_map(|cidr| match cidr.address() {
            IpAddress::Ipv6(ip) if !ip.is_unicast_link_local() => Some(IpAddr::V6(ip)),
            _ => None,
        })
    }

    /// The guest's address in this family: 10.0.2.15, or the one it made.
    fn address(&self, family: Family) -> IpAddr {
        match family {
            V4 => GUEST.into(),
            V6 => self.ipv6().expect("up"),
        }
    }

    fn tcp(&mut self, to: (IpAddr, u16)) -> SocketHandle {
        let buffer = || tcp::SocketBuffer::new(vec![0; 1 << 20]);
        let mut socket = tcp::Socket::new(buffer(), buffer());
        self.port += 1;
        socket
            .connect(self.iface.context(), (IpAddress::from(to.0), to.1), self.port)
            .unwrap();
        self.sockets.add(socket)
    }

    fn udp(&mut self) -> (SocketHandle, u16) {
        let buffer = || udp::PacketBuffer::new(vec![udp::PacketMetadata::EMPTY; 8], vec![0; 65536]);
        let mut socket = udp::Socket::new(buffer(), buffer());
        self.port += 1;
        socket.bind(self.port).unwrap();
        (self.sockets.add(socket), self.port)
    }

    /// Runs the network until `done` returns something, for at most `limit`.
    async fn until<R>(&mut self, limit: Duration, mut done: impl FnMut(&mut Self) -> Option<R>) -> Option<R> {
        let deadline = Clock::now() + limit;
        loop {
            let now = self.now();
            self.iface.poll(now, &mut self.wire, &mut self.sockets);
            for frame in self.wire.tx.drain(..) {
                let _ = self.to_relay.send(frame);
            }
            if let Some(result) = done(self) {
                return Some(result);
            }
            if Clock::now() > deadline {
                return None;
            }
            let wait = self
                .iface
                .poll_delay(now, &self.sockets)
                .map_or(10_000, |d| d.total_micros())
                .min(10_000);
            if self.hung_up {
                tokio::time::sleep(Duration::from_micros(wait)).await;
                continue;
            }
            tokio::select! {
                frame = self.from_relay.recv() => {
                    let Some(frame) = frame else {
                        self.hung_up = true;
                        continue;
                    };
                    self.seen.push(frame.clone());
                    self.wire.rx.push_back(frame);
                    while let Ok(frame) = self.from_relay.try_recv() {
                        self.seen.push(frame.clone());
                        self.wire.rx.push_back(frame);
                    }
                }
                _ = tokio::time::sleep(Duration::from_micros(wait)) => {}
            }
        }
    }

    fn close_code(&self) -> Option<u16> {
        *self.closed.lock().unwrap()
    }

    fn socket(&mut self, handle: SocketHandle) -> &mut tcp::Socket<'static> {
        self.sockets.get_mut(handle)
    }

    /// Every ICMP message the relay sent, in either family: who from, and
    /// the message itself.
    fn icmp(&self) -> impl Iterator<Item = (IpAddr, &[u8])> {
        self.seen.iter().filter_map(|frame| {
            let ip = &frame[14..];
            match ip.first()? >> 4 {
                4 => {
                    let ip = Ipv4Packet::new_checked(ip).ok()?;
                    (ip.next_header() == IpProtocol::Icmp).then(|| (IpAddr::V4(ip.src_addr()), ip.payload()))
                }
                6 => {
                    let ip = Ipv6Packet::new_checked(ip).ok()?;
                    (ip.next_header() == IpProtocol::Icmpv6).then(|| (IpAddr::V6(ip.src_addr()), ip.payload()))
                }
                _ => None,
            }
        })
    }

    /// The relay said this: an ICMP message of this type and code.
    fn heard(&self, (kind, code): (u8, u8)) -> bool {
        self.icmp().any(|(_, message)| message.starts_with(&[kind, code]))
    }

    /// Who answered our echo (ident, seq_no), and with what.
    fn echoed(&self, family: Family, ident: u16, seq_no: u16) -> Option<(IpAddr, Vec<u8>)> {
        self.icmp().find_map(|(from, message)| {
            let id = [&ident.to_be_bytes()[..], &seq_no.to_be_bytes()].concat();
            (message.len() >= 8 && message[0] == family.echo().1 && message[4..8] == id[..]).then(|| (from, message[8..].to_vec()))
        })
    }

    /// Who answered "time exceeded" about our echo (ident, seq_no).
    fn time_exceeded(&self, family: Family, ident: u16, seq_no: u16) -> Option<IpAddr> {
        let header = if family == V4 { 20 } else { 40 };
        self.icmp().find_map(|(from, message)| {
            (message.first() == Some(&family.time_exceeded())).then_some(())?;
            // The quote: the original IP header, then the echo's first 8 bytes.
            let echo = message.get(8 + header..8 + header + 8)?;
            let ours = echo[0] == family.echo().0 && echo[4..6] == ident.to_be_bytes() && echo[6..8] == seq_no.to_be_bytes();
            ours.then_some(from)
        })
    }
}

fn finished(socket: &tcp::Socket) -> bool {
    !socket.may_recv() && !matches!(socket.state(), tcp::State::SynSent | tcp::State::SynReceived)
}

/// An echo request as the guest's IP stack would send it, with this hop limit.
fn echo_frame(from: IpAddr, to: IpAddr, hop_limit: u8, ident: u16, seq_no: u16) -> Vec<u8> {
    let data = b"out there";
    let caps = ChecksumCapabilities::default();
    let (protocol, ethertype, mut message) = match (from, to) {
        (IpAddr::V4(_), IpAddr::V4(_)) => {
            let request = Icmpv4Repr::EchoRequest { ident, seq_no, data };
            let mut message = vec![0; request.buffer_len()];
            request.emit(&mut Icmpv4Packet::new_unchecked(&mut message[..]), &caps);
            (IpProtocol::Icmp, EthernetProtocol::Ipv4, message)
        }
        (IpAddr::V6(src), IpAddr::V6(dst)) => {
            let request = Icmpv6Repr::EchoRequest { ident, seq_no, data };
            let mut message = vec![0; request.buffer_len()];
            request.emit(&src, &dst, &mut Icmpv6Packet::new_unchecked(&mut message[..]), &caps);
            (IpProtocol::Icmpv6, EthernetProtocol::Ipv6, message)
        }
        _ => panic!("{from} and {to} are of two families"),
    };
    let ip = IpRepr::new(from.into(), to.into(), protocol, message.len(), hop_limit);
    let ethernet = EthernetRepr { src_addr: GUEST_MAC, dst_addr: GATEWAY_MAC, ethertype };
    let mut frame = vec![0; ethernet.buffer_len()];
    ethernet.emit(&mut EthernetFrame::new_unchecked(&mut frame[..]));
    let mut packet = vec![0; ip.header_len()];
    ip.emit(&mut packet[..], &caps);
    frame.append(&mut packet);
    frame.append(&mut message);
    frame
}

// DHCPv6, as much as the guest speaks.
const SOLICIT: u8 = 1;
const ADVERTISE: u8 = 2;
const REQUEST: u8 = 3;
const REPLY: u8 = 7;
const CLIENT_ID: u16 = 1;
const SERVER_ID: u16 = 2;
const IA_NA: u16 = 3;
const IA_ADDR: u16 = 5;

/// A DHCPv6 message from the guest: its client ID (DUID-LL, from its MAC),
/// an IA_NA to fill in, and `more`.
fn dhcpv6_message(kind: u8, more: &[(u16, &[u8])]) -> Vec<u8> {
    let client = [&[0, 3, 0, 1][..], &GUEST_MAC.0].concat();
    let ia = [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0];
    let options = [(CLIENT_ID, &client[..]), (IA_NA, &ia[..])].into_iter().chain(more.iter().copied());
    let mut message = vec![kind, 0x12, 0x34, 0x56];
    for (code, data) in options {
        message.extend(code.to_be_bytes());
        message.extend((data.len() as u16).to_be_bytes());
        message.extend(data);
    }
    message
}

/// The options in `bytes`, by code.
fn dhcpv6_options(mut bytes: &[u8]) -> Vec<(u16, &[u8])> {
    let mut options = Vec::new();
    while bytes.len() >= 4 {
        let len = usize::from(u16::from_be_bytes([bytes[2], bytes[3]]));
        options.push((u16::from_be_bytes([bytes[0], bytes[1]]), &bytes[4..4 + len]));
        bytes = &bytes[4 + len..];
    }
    options
}

fn dhcpv6_option(message: &[u8], code: u16) -> Option<Vec<u8>> {
    dhcpv6_options(&message[4..]).into_iter().find(|&(c, _)| c == code).map(|(_, data)| data.to_vec())
}

/// The address a DHCPv6 answer leases the guest.
fn dhcpv6_lease(message: &[u8]) -> Option<Ipv6Addr> {
    let ia = dhcpv6_option(message, IA_NA)?;
    let (_, lease) = dhcpv6_options(&ia[12..]).into_iter().find(|&(c, _)| c == IA_ADDR)?;
    Some(Ipv6Addr::from(<[u8; 16]>::try_from(&lease[..16]).ok()?))
}

/// A DNS query for `name`, of this record type.
fn query(id: u16, name: &str, kind: u16) -> Vec<u8> {
    let mut query = [&id.to_be_bytes()[..], &[0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]].concat();
    for label in name.split('.') {
        query.push(label.len() as u8);
        query.extend_from_slice(label.as_bytes());
    }
    query.extend_from_slice(&[0, 0, kind as u8, 0, 1]);
    query
}

// ─── services on this machine ────────────────────────────────────────────────

async fn bulk_server(on: IpAddr) -> u16 {
    let listener = TcpListener::bind((on, 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let chunk = vec![7; 64 << 10];
                for _ in 0..BULK / chunk.len() {
                    if stream.write_all(&chunk).await.is_err() {
                        return; // the guest stopped listening
                    }
                }
            });
        }
    });
    port
}

/// Reads to the end, then says how much it got.
async fn count_server(on: IpAddr) -> u16 {
    let listener = TcpListener::bind((on, 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut all = Vec::new();
                stream.read_to_end(&mut all).await.unwrap();
                stream.write_all(format!("got {}", all.len()).as_bytes()).await.unwrap();
            });
        }
    });
    port
}

async fn echo_server(on: IpAddr) -> u16 {
    let echo = UdpSocket::bind((on, 0)).await.unwrap();
    let port = echo.local_addr().unwrap().port();
    tokio::spawn(async move {
        let mut buf = [0; 2048];
        while let Ok((n, from)) = echo.recv_from(&mut buf).await {
            echo.send_to(&buf[..n], from).await.unwrap();
        }
    });
    port
}

async fn closed_port(on: IpAddr) -> u16 {
    TcpListener::bind((on, 0)).await.unwrap().local_addr().unwrap().port()
}

// ─── the tests ───────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn each_guest_is_given_an_ipv6_address_of_its_own() {
    let relay = relay().await;
    // Two guests alike to the last bit, as every visitor's machine is: the
    // same snapshot, the same MAC address.
    let (one, two) = (connect(relay, KEY).await.unwrap(), connect(relay, KEY).await.unwrap());
    let (one, two) = (one.address(V6), two.address(V6));
    assert_ne!(one, two);
    for address in [one, two] {
        let IpAddr::V6(address) = address else { panic!("{address}: not IPv6") };
        assert_eq!(address.segments()[..4], PREFIX.segments()[..4]); // the relay's own, without a public prefix
    }
}

/// Seen from out there, a session with a public address is that address.
/// The host has to take the prefix in, as the deployment does; CI does too:
/// `ip -6 route add local 2001:db8:5::/64 dev lo`.
#[cfg(target_os = "linux")]
#[ignore = "needs an AnyIP route: ip -6 route add local 2001:db8:5::/64 dev lo"]
#[tokio::test(flavor = "multi_thread")]
async fn a_public_address_is_the_way_out() {
    let relay = relay_with("[egress]\nipv6 = \"2001:db8:5::/64\"").await;
    let mut guest = connect(relay, KEY).await.unwrap();
    let IpAddr::V6(address) = guest.address(V6) else { unreachable!() };
    assert_eq!(address.segments()[..4], [0x2001, 0xdb8, 5, 0]);

    // A service that says who it sees.
    let listener = TcpListener::bind((Ipv6Addr::LOCALHOST, 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (mut stream, peer) = listener.accept().await.unwrap();
        stream.write_all(peer.ip().to_string().as_bytes()).await.unwrap();
    });
    let handle = guest.tcp((V6.services(), port));
    let (mut seen, mut buf) = (Vec::new(), [0; 64]);
    guest
        .until(Duration::from_secs(5), |g| {
            let socket = g.socket(handle);
            while let Ok(n @ 1..) = socket.recv_slice(&mut buf) {
                seen.extend_from_slice(&buf[..n]);
            }
            finished(socket).then_some(())
        })
        .await
        .expect("the service says, and hangs up");
    assert_eq!(String::from_utf8_lossy(&seen), address.to_string());
}

#[tokio::test(flavor = "multi_thread")]
async fn tcp_both_ways() {
    both_ways(V4).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn tcp_both_ways_over_ipv6() {
    both_ways(V6).await;
}

async fn both_ways(family: Family) {
    let (relay, bulk, count) = (relay().await, bulk_server(family.here()).await, count_server(family.here()).await);
    let mut guest = connect(relay, KEY).await.expect("the relay lets us in");

    let handle = guest.tcp((family.services(), bulk));
    let started = Clock::now();
    let mut got = 0;
    let mut buf = vec![0; 1 << 16];
    guest
        .until(Duration::from_secs(60), |g| {
            let socket = g.socket(handle);
            while let Ok(n) = socket.recv_slice(&mut buf) {
                if n == 0 {
                    break;
                }
                got += n;
            }
            (got == BULK).then_some(())
        })
        .await
        .expect("all of it arrives");
    let secs = started.elapsed().as_secs_f64();
    println!(
        "bulk over {family:?}: {} MiB in {secs:.2} s, {:.1} MiB/s",
        BULK >> 20,
        BULK as f64 / secs / 1048576.0
    );

    // Send, close our side, and still hear back: a half-close goes through.
    let handle = guest.tcp((family.services(), count));
    let mut sent = false;
    let mut reply = Vec::new();
    guest
        .until(Duration::from_secs(10), |g| {
            let socket = g.socket(handle);
            if !sent && socket.may_send() {
                socket.send_slice(&[1; 100_000]).unwrap();
                socket.close();
                sent = true;
            }
            while let Ok(n) = socket.recv_slice(&mut buf) {
                if n == 0 {
                    break;
                }
                reply.extend_from_slice(&buf[..n]);
            }
            (sent && finished(socket)).then_some(())
        })
        .await
        .expect("the reply arrives and the connection ends");
    assert_eq!(String::from_utf8_lossy(&reply), "got 100000");
}

#[tokio::test(flavor = "multi_thread")]
async fn refused_and_prohibited() {
    refused(V4).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn refused_and_prohibited_over_ipv6() {
    refused(V6).await;
}

async fn refused(family: Family) {
    let (relay, closed) = (relay().await, closed_port(family.here()).await);
    let mut guest = connect(relay, KEY).await.unwrap();

    // Nothing listens: a reset while still in SYN-SENT, as from a real host.
    let handle = guest.tcp((family.services(), closed));
    let mut states = vec![];
    guest
        .until(Duration::from_secs(5), |g| {
            let state = g.socket(handle).state();
            if states.last() != Some(&state) {
                states.push(state);
            }
            (state == tcp::State::Closed).then_some(())
        })
        .await
        .expect("refused at once");
    assert_eq!(states, [tcp::State::SynSent, tcp::State::Closed]);

    // A private address the policy does not allow: ICMP "prohibited".
    let handle = guest.tcp((family.private(), 80));
    guest
        .until(Duration::from_secs(5), |g| g.heard(family.prohibited()).then_some(()))
        .await
        .expect("prohibited");
    assert_eq!(guest.socket(handle).state(), tcp::State::SynSent);
}

#[tokio::test(flavor = "multi_thread")]
async fn udp_both_ways() {
    datagrams(V4).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn udp_both_ways_over_ipv6() {
    datagrams(V6).await;
}

async fn datagrams(family: Family) {
    let (relay, echo) = (relay().await, echo_server(family.here()).await);
    let mut guest = connect(relay, KEY).await.unwrap();

    let (handle, _) = guest.udp();
    guest
        .sockets
        .get_mut::<udp::Socket>(handle)
        .send_slice(b"marco", (IpAddress::from(family.services()), echo))
        .unwrap();
    let mut buf = [0; 2048];
    let reply = guest
        .until(Duration::from_secs(5), |g| {
            let socket = g.sockets.get_mut::<udp::Socket>(handle);
            socket
                .recv_slice(&mut buf)
                .ok()
                .map(|(n, meta)| (buf[..n].to_vec(), meta.endpoint))
        })
        .await
        .expect("the echo comes back");
    assert_eq!(reply.0, b"marco");
    assert_eq!(reply.1.addr, IpAddress::from(family.services())); // from where we sent it, not the alias
}

#[tokio::test(flavor = "multi_thread")]
async fn dns_from_the_hosts_table() {
    let relay = relay().await;
    let mut guest = connect(relay, KEY).await.unwrap();
    let mut ask = async |name: &str, kind: u16| {
        let (handle, _) = guest.udp();
        guest
            .sockets
            .get_mut::<udp::Socket>(handle)
            .send_slice(&query(0x1234, name, kind), (IpAddress::v4(10, 0, 2, 3), 53))
            .unwrap();
        let mut buf = [0; 2048];
        let answer = guest
            .until(Duration::from_secs(5), |g| {
                let socket = g.sockets.get_mut::<udp::Socket>(handle);
                socket.recv_slice(&mut buf).ok().map(|(n, _)| buf[..n].to_vec())
            })
            .await
            .expect("an answer");
        assert_eq!(&answer[..2], &[0x12, 0x34]);
        assert_eq!(answer[3] & 0x0f, 0, "NOERROR");
        answer
    };
    assert!(ask("test.home", 1).await.ends_with(&SERVICES.octets()), "the A record");
    assert!(ask("test6.home", 28).await.ends_with(&SERVICES6.octets()), "the AAAA record");
    let none = ask("test.home", 28).await;
    assert_eq!(&none[6..8], &[0, 0], "no AAAA record: an IPv4 address alone");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_gateway_answers_ping() {
    gateway_ping(V4).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_gateway_answers_ping_over_ipv6() {
    gateway_ping(V6).await;
}

/// The first ping, too: the gateway knows the guest's MAC address from its
/// first frame, and asks nobody before it answers.
async fn gateway_ping(family: Family) {
    let relay = relay().await;
    let mut guest = connect(relay, KEY).await.unwrap();
    let from = guest.address(family);
    guest.to_relay.send(echo_frame(from, family.gateway(), 64, 7, 1)).unwrap();
    let echoed = guest.until(Duration::from_secs(5), |g| g.echoed(family, 7, 1)).await;
    assert_eq!(echoed, Some((family.gateway(), b"out there".to_vec())));
}

/// Asked where it is, the gateway says it is a router: answering as anything
/// else, it would stop being one, and Linux would drop its way out with it.
#[tokio::test(flavor = "multi_thread")]
async fn the_gateway_answers_as_a_router() {
    let relay = relay().await;
    let mut guest = connect(relay, KEY).await.unwrap();
    let handle = guest.tcp((V6.gateway(), 1)); // by way of fe80::2, which the guest asks after first
    guest
        .until(Duration::from_secs(5), |g| (g.socket(handle).state() == tcp::State::Closed).then_some(()))
        .await
        .expect("turned away");
    let advert = guest
        .icmp()
        .find(|&(from, message)| from == IpAddr::V6(GATEWAY_LINK) && message[0] == 136)
        .map(|(_, message)| message[4])
        .expect("the gateway's neighbour advertisement");
    assert_eq!(advert & 0xe0, 0xe0); // router, solicited, override
}

#[tokio::test(flavor = "multi_thread")]
async fn a_wrong_key_is_turned_away() {
    let relay = relay().await;
    assert!(connect(relay, [0x22; 32]).await.is_none());
    assert!(connect(relay, KEY).await.is_some());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_login_lets_the_site_in() {
    let (relay, count) = (relay().await, count_server(V4.here()).await);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    let token = token::issue(&SESSION_KEY, now + 3600, [5; 16]);
    let key = token::channel_key(&SESSION_KEY, &token, now).unwrap();
    let mut guest = log_in(relay, &token, key).await.expect("a fresh login");
    let handle = guest.tcp((V4.services(), count));
    guest
        .until(Duration::from_secs(10), |g| g.socket(handle).may_send().then_some(()))
        .await
        .expect("a connection through it");

    let expired = token::issue(&SESSION_KEY, now - 1, [5; 16]);
    let key = token::channel_key(&SESSION_KEY, &expired, now - 2).unwrap();
    assert!(log_in(relay, &expired, key).await.is_none());
    let forged = token::issue(&[0x44; 32], now + 3600, [5; 16]);
    let key = token::channel_key(&[0x44; 32], &forged, now).unwrap();
    assert!(log_in(relay, &forged, key).await.is_none());
}

// ─── R3: egress through SOCKS5, limits, closed UDP ports ─────────────────────

/// Enough of a SOCKS5 server: no authentication, CONNECT to an IPv4 address.
/// Counts the connections it was asked for.
async fn socks5() -> (u16, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let asked = Arc::new(AtomicUsize::new(0));
    let counter = asked.clone();
    tokio::spawn(async move {
        while let Ok((mut client, _)) = listener.accept().await {
            let counter = counter.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 262];
                client.read_exact(&mut buf[..2]).await.unwrap();
                let methods = buf[1] as usize;
                client.read_exact(&mut buf[..methods]).await.unwrap();
                client.write_all(&[5, 0]).await.unwrap();
                client.read_exact(&mut buf[..10]).await.unwrap(); // VER CMD RSV ATYP=1 IPv4 PORT
                assert_eq!(&buf[..4], &[5, 1, 0, 1]);
                let target = SocketAddr::from(([buf[4], buf[5], buf[6], buf[7]], u16::from_be_bytes([buf[8], buf[9]])));
                counter.fetch_add(1, Ordering::SeqCst);
                match tokio::net::TcpStream::connect(target).await {
                    Ok(mut out) => {
                        client.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await.unwrap();
                        let _ = tokio::io::copy_bidirectional(&mut client, &mut out).await;
                    }
                    Err(_) => client.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]).await.unwrap(), // refused
                }
            });
        }
    });
    (port, asked)
}

#[tokio::test(flavor = "multi_thread")]
async fn through_socks5() {
    let (proxy, asked) = socks5().await;
    let relay = relay_with(&format!("[egress]\nsocks5 = \"127.0.0.1:{proxy}\"")).await;
    let (count, closed) = (count_server(V4.here()).await, closed_port(V4.here()).await);
    let mut guest = connect(relay, KEY).await.unwrap();

    let handle = guest.tcp((V4.services(), count));
    let (mut sent, mut reply, mut buf) = (false, Vec::new(), [0; 64]);
    guest
        .until(Duration::from_secs(10), |g| {
            let socket = g.socket(handle);
            if !sent && socket.may_send() {
                socket.send_slice(b"through the proxy").unwrap();
                socket.close();
                sent = true;
            }
            while let Ok(n @ 1..) = socket.recv_slice(&mut buf) {
                reply.extend_from_slice(&buf[..n]);
            }
            (sent && finished(socket)).then_some(())
        })
        .await
        .expect("an answer through the proxy");
    assert_eq!(String::from_utf8_lossy(&reply), "got 17");
    assert_eq!(asked.load(Ordering::SeqCst), 1);

    // The proxy says "refused": the guest hears a reset, as if directly.
    let handle = guest.tcp((V4.services(), closed));
    guest
        .until(Duration::from_secs(5), |g| {
            (g.socket(handle).state() == tcp::State::Closed).then_some(())
        })
        .await
        .expect("refused through the proxy");
    assert_eq!(asked.load(Ordering::SeqCst), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rate_paces_the_session() {
    const RATE: usize = 1_000_000;
    const WANT: usize = 3_000_000;
    let (relay, bulk) = (
        relay_with(&format!("[limits]\nrate = {RATE}")).await,
        bulk_server(V4.here()).await,
    );
    let mut guest = connect(relay, KEY).await.unwrap();
    let handle = guest.tcp((V4.services(), bulk));
    let started = Clock::now();
    let (mut got, mut buf) = (0, vec![0; 1 << 16]);
    guest
        .until(Duration::from_secs(20), |g| {
            while let Ok(n @ 1..) = g.socket(handle).recv_slice(&mut buf) {
                got += n;
            }
            (got >= WANT).then_some(())
        })
        .await
        .expect("it arrives, slowly");
    let secs = started.elapsed().as_secs_f64();
    println!("rate {RATE} B/s: {WANT} B in {secs:.2} s");
    // A second's burst, then the rate: about 2 s for 3 MB, framing included.
    assert!((1.5..6.0).contains(&secs), "{secs:.2} s");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_quota_ends_the_session() {
    let (relay, bulk) = (relay_with("[limits]\nquota = 1000000").await, bulk_server(V4.here()).await);
    let mut guest = connect(relay, KEY).await.unwrap();
    let handle = guest.tcp((V4.services(), bulk));
    let (mut got, mut buf) = (0, vec![0; 1 << 16]);
    let code = guest
        .until(Duration::from_secs(10), |g| {
            while let Ok(n @ 1..) = g.socket(handle).recv_slice(&mut buf) {
                got += n;
            }
            g.close_code()
        })
        .await;
    assert_eq!(code, Some(4001), "closed for the quota");
    assert!(got < 2_000_000, "{got} bytes");
}

#[tokio::test(flavor = "multi_thread")]
async fn silence_ends_the_session() {
    let relay = relay_with("[limits]\nidle = 1").await;
    let mut guest = connect(relay, KEY).await.unwrap();
    let code = guest.until(Duration::from_secs(5), |g| g.close_code()).await;
    assert_eq!(code, Some(4002), "closed for being idle");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_closed_udp_port_says_so() {
    closed_udp_port(V4).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_closed_udp_port_says_so_over_ipv6() {
    closed_udp_port(V6).await;
}

async fn closed_udp_port(family: Family) {
    let relay = relay().await;
    let closed = UdpSocket::bind((family.here(), 0))
        .await
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let mut guest = connect(relay, KEY).await.unwrap();
    let (handle, _) = guest.udp();
    for _ in 0..2 {
        // The first datagram finds out; the "unreachable" comes with the next receive.
        guest
            .sockets
            .get_mut::<udp::Socket>(handle)
            .send_slice(b"anyone?", (IpAddress::from(family.services()), closed))
            .unwrap();
        if guest
            .until(Duration::from_secs(2), |g| g.heard(family.port_closed()).then_some(()))
            .await
            .is_some()
        {
            return;
        }
    }
    panic!("no ICMP port unreachable");
}

/// Ping out through an unprivileged ping socket: Linux, with this user's
/// group in net.ipv4.ping_group_range (the default in containers and on
/// recent distributions). The services' aliases lead to this machine.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn ping_goes_out() {
    ping_out(V4).await;
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn ping_goes_out_over_ipv6() {
    ping_out(V6).await;
}

#[cfg(target_os = "linux")]
async fn ping_out(family: Family) {
    let relay = relay().await;
    let mut guest = connect(relay, KEY).await.unwrap();
    let from = guest.address(family);
    guest.to_relay.send(echo_frame(from, family.services(), 64, 9, 3)).unwrap();
    let echoed = guest.until(Duration::from_secs(5), |g| g.echoed(family, 9, 3)).await;
    assert_eq!(echoed, Some((family.services(), b"out there".to_vec())));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_last_hop_ends_at_the_gateway() {
    last_hop(V4).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_last_hop_ends_at_the_gateway_over_ipv6() {
    last_hop(V6).await;
}

async fn last_hop(family: Family) {
    let relay = relay().await;
    let mut guest = connect(relay, KEY).await.unwrap();
    let from = guest.address(family);
    guest.to_relay.send(echo_frame(from, family.services(), 1, 21, 1)).unwrap();
    let said = guest.until(Duration::from_secs(5), |g| g.time_exceeded(family, 21, 1)).await;
    assert_eq!(said, Some(family.gateway()), "hop 1 is the gateway");
}

/// Hop 2 is the first router out there: Linux, with a network to cross.
/// cargo test -- --ignored the_next_hop_is_out_there
#[cfg(target_os = "linux")]
#[ignore = "needs a route to 1.1.1.1"]
#[tokio::test(flavor = "multi_thread")]
async fn the_next_hop_is_out_there() {
    let relay = relay().await;
    let mut guest = connect(relay, KEY).await.unwrap();
    let mut hops = Vec::new();
    for ttl in 2..=4 {
        let probe = echo_frame(GUEST.into(), Ipv4Addr::new(1, 1, 1, 1).into(), ttl, 22, u16::from(ttl));
        guest.to_relay.send(probe).unwrap();
        let hop = guest.until(Duration::from_secs(3), |g| g.time_exceeded(V4, 22, u16::from(ttl))).await;
        hops.push(hop);
    }
    println!("hops 2..=4: {hops:?}");
    assert!(hops[0].is_some(), "the first router out there said so");
}
