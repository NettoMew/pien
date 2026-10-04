//! The relay end to end: a smoltcp guest (10.0.2.15, its own Ethernet and
//! ARP) talks over a real WebSocket and the sealed channel to a relay in this
//! process, which reaches services on this machine through an alias:
//! 192.0.2.10 → 127.0.0.1.

use std::collections::VecDeque;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant as Clock};

use futures_util::{SinkExt, StreamExt};
use relay::channel::{self, Connecting, HELLO, WELCOME};
use relay::{Config, Shared, server};
use smoltcp::iface::{Config as IfaceConfig, Interface, SocketHandle, SocketSet};
use smoltcp::phy::{ChecksumCapabilities, Device, DeviceCapabilities, Medium, RxToken, TxToken};
use smoltcp::socket::{tcp, udp};
use smoltcp::time::Instant;
use smoltcp::wire::{
    EthernetAddress, EthernetFrame, EthernetProtocol, EthernetRepr, HardwareAddress, Icmpv4Packet, Icmpv4Repr,
    IpAddress, IpCidr, IpProtocol, Ipv4Packet, Ipv4Repr,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, UdpSocket};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use tokio_tungstenite::tungstenite::Message;

const KEY: [u8; 32] = [0x11; 32];
const SERVICES: Ipv4Addr = Ipv4Addr::new(192, 0, 2, 10);
const GUEST_MAC: EthernetAddress = EthernetAddress([0x52, 0x54, 0x00, 0x12, 0x34, 0x56]);
const BULK: usize = 16 << 20;

async fn relay() -> SocketAddr {
    relay_with("").await
}

/// A relay in this process; `more` adds tables to its configuration.
async fn relay_with(more: &str) -> SocketAddr {
    let config = Config::parse(&format!(
        r#"
        listen = "127.0.0.1:0"
        key = "{}"
        [dns]
        upstream = "127.0.0.1"
        hosts = {{ "test.home" = "{SERVICES}" }}
        [policy]
        aliases = {{ "{SERVICES}" = "127.0.0.1" }}
        {more}
        "#,
        "11".repeat(32)
    ))
    .unwrap();
    let (address, serving) = server::bind(Shared::new(config).unwrap()).await.unwrap();
    tokio::spawn(serving);
    address
}

/// Opens the channel the way the page does; `None` if the relay turns us away.
async fn connect(relay: SocketAddr, key: [u8; 32]) -> Option<Guest> {
    let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{relay}/relay"))
        .await
        .unwrap();
    let (mut sink, mut source) = ws.split();
    let (hello, connecting) = Connecting::new();
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
    Some(Guest::new(to_relay, from_relay, closed))
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
        let mut iface = Interface::new(
            IfaceConfig::new(HardwareAddress::Ethernet(GUEST_MAC)),
            &mut wire,
            Instant::ZERO,
        );
        iface.update_ip_addrs(|a| a.push(IpCidr::new(IpAddress::v4(10, 0, 2, 15), 24)).unwrap());
        iface
            .routes_mut()
            .add_default_ipv4_route(Ipv4Addr::new(10, 0, 2, 2))
            .unwrap();
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

    fn tcp(&mut self, to: (Ipv4Addr, u16)) -> SocketHandle {
        let buffer = || tcp::SocketBuffer::new(vec![0; 1 << 20]);
        let mut socket = tcp::Socket::new(buffer(), buffer());
        self.port += 1;
        socket
            .connect(self.iface.context(), (IpAddress::Ipv4(to.0), to.1), self.port)
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

    /// An ICMP "destination unreachable" with this code came from the relay.
    fn unreachable(&self, code: u8) -> bool {
        self.seen.iter().any(|frame| {
            let Ok(ip) = Ipv4Packet::new_checked(&frame[14..]) else {
                return false;
            };
            let Ok(icmp) = Icmpv4Packet::new_checked(ip.payload()) else {
                return false;
            };
            ip.next_header() == IpProtocol::Icmp && u8::from(icmp.msg_type()) == 3 && icmp.msg_code() == code
        })
    }
}

fn finished(socket: &tcp::Socket) -> bool {
    !socket.may_recv() && !matches!(socket.state(), tcp::State::SynSent | tcp::State::SynReceived)
}

// ─── services on this machine ────────────────────────────────────────────────

async fn bulk_server() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
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
async fn count_server() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
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

async fn closed_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .await
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

// ─── the tests ───────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn tcp_both_ways() {
    let (relay, bulk, count) = (relay().await, bulk_server().await, count_server().await);
    let mut guest = connect(relay, KEY).await.expect("the relay lets us in");

    let handle = guest.tcp((SERVICES, bulk));
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
        "bulk: {} MiB in {secs:.2} s, {:.1} MiB/s",
        BULK >> 20,
        BULK as f64 / secs / 1048576.0
    );

    // Send, close our side, and still hear back: a half-close goes through.
    let handle = guest.tcp((SERVICES, count));
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
async fn refused_unreachable_prohibited() {
    let (relay, closed) = (relay().await, closed_port().await);
    let mut guest = connect(relay, KEY).await.unwrap();

    // Nothing listens: a reset while still in SYN-SENT, as from a real host.
    let handle = guest.tcp((SERVICES, closed));
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

    // A private address the policy does not allow: ICMP "host prohibited".
    let handle = guest.tcp((Ipv4Addr::new(10, 9, 9, 9), 80));
    guest
        .until(Duration::from_secs(5), |g| g.unreachable(10).then_some(()))
        .await
        .expect("prohibited");
    assert_eq!(guest.socket(handle).state(), tcp::State::SynSent);
}

#[tokio::test(flavor = "multi_thread")]
async fn udp_and_dns() {
    let relay = relay().await;
    let echo = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let echo_port = echo.local_addr().unwrap().port();
    tokio::spawn(async move {
        let mut buf = [0; 2048];
        while let Ok((n, from)) = echo.recv_from(&mut buf).await {
            echo.send_to(&buf[..n], from).await.unwrap();
        }
    });
    let mut guest = connect(relay, KEY).await.unwrap();

    let (handle, _) = guest.udp();
    guest
        .sockets
        .get_mut::<udp::Socket>(handle)
        .send_slice(b"marco", (IpAddress::Ipv4(SERVICES), echo_port))
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
    assert_eq!(reply.1.addr, IpAddress::Ipv4(SERVICES)); // from where we sent it, not the alias

    // test.home, from the relay's own hosts table.
    let query = [
        &[0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0][..],
        &[4],
        b"test",
        &[4],
        b"home",
        &[0, 0, 1, 0, 1],
    ]
    .concat();
    let (handle, _) = guest.udp();
    guest
        .sockets
        .get_mut::<udp::Socket>(handle)
        .send_slice(&query, (IpAddress::v4(10, 0, 2, 3), 53))
        .unwrap();
    let answer = guest
        .until(Duration::from_secs(5), |g| {
            g.sockets
                .get_mut::<udp::Socket>(handle)
                .recv_slice(&mut buf)
                .ok()
                .map(|(n, _)| buf[..n].to_vec())
        })
        .await
        .expect("an answer");
    assert_eq!(&answer[..2], &[0x12, 0x34]);
    assert_eq!(answer[3] & 0x0f, 0, "NOERROR");
    assert!(answer.ends_with(&SERVICES.octets()), "the A record");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_gateway_answers_ping() {
    let relay = relay().await;
    let mut guest = connect(relay, KEY).await.unwrap();
    // Learn the gateway's MAC address from any frame it sends: ask for something.
    let handle = guest.tcp((Ipv4Addr::new(10, 0, 2, 2), 1));
    guest
        .until(Duration::from_secs(5), |g| {
            (g.socket(handle).state() == tcp::State::Closed).then_some(())
        })
        .await;

    let request = Icmpv4Repr::EchoRequest {
        ident: 7,
        seq_no: 1,
        data: b"ping",
    };
    let ip = Ipv4Repr {
        src_addr: Ipv4Addr::new(10, 0, 2, 15),
        dst_addr: Ipv4Addr::new(10, 0, 2, 2),
        next_header: IpProtocol::Icmp,
        payload_len: request.buffer_len(),
        hop_limit: 64,
    };
    let ethernet = EthernetRepr {
        src_addr: GUEST_MAC,
        dst_addr: relay::session::GATEWAY_MAC,
        ethertype: EthernetProtocol::Ipv4,
    };
    let mut frame = vec![0; 14 + ip.buffer_len() + request.buffer_len()];
    ethernet.emit(&mut EthernetFrame::new_unchecked(&mut frame[..]));
    ip.emit(
        &mut Ipv4Packet::new_unchecked(&mut frame[14..]),
        &ChecksumCapabilities::default(),
    );
    request.emit(
        &mut Icmpv4Packet::new_unchecked(&mut frame[34..]),
        &ChecksumCapabilities::default(),
    );
    guest.to_relay.send(frame).unwrap();
    let echoed = guest
        .until(Duration::from_secs(5), |g| {
            g.seen
                .iter()
                .any(|f| {
                    let Ok(ip) = Ipv4Packet::new_checked(&f[14..]) else {
                        return false;
                    };
                    let Ok(icmp) = Icmpv4Packet::new_checked(ip.payload()) else {
                        return false;
                    };
                    ip.next_header() == IpProtocol::Icmp && u8::from(icmp.msg_type()) == 0 && icmp.echo_ident() == 7
                })
                .then_some(())
        })
        .await;
    assert!(echoed.is_some(), "an echo reply from 10.0.2.2");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_wrong_key_is_turned_away() {
    let relay = relay().await;
    assert!(connect(relay, [0x22; 32]).await.is_none());
    assert!(connect(relay, KEY).await.is_some());
    let _ = channel::key; // the same derivation `net login` uses; see channel.rs
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
    let (count, closed) = (count_server().await, closed_port().await);
    let mut guest = connect(relay, KEY).await.unwrap();

    let handle = guest.tcp((SERVICES, count));
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
    let handle = guest.tcp((SERVICES, closed));
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
        bulk_server().await,
    );
    let mut guest = connect(relay, KEY).await.unwrap();
    let handle = guest.tcp((SERVICES, bulk));
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
    let (relay, bulk) = (relay_with("[limits]\nquota = 1000000").await, bulk_server().await);
    let mut guest = connect(relay, KEY).await.unwrap();
    let handle = guest.tcp((SERVICES, bulk));
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
    let relay = relay().await;
    let closed = UdpSocket::bind("127.0.0.1:0")
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
            .send_slice(b"anyone?", (IpAddress::Ipv4(SERVICES), closed))
            .unwrap();
        if guest
            .until(Duration::from_secs(2), |g| g.unreachable(3).then_some(()))
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
/// recent distributions). 192.0.2.10 is an alias for 127.0.0.1.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn ping_goes_out() {
    let relay = relay().await;
    let mut guest = connect(relay, KEY).await.unwrap();
    // Learn the gateway's MAC address first.
    let handle = guest.tcp((Ipv4Addr::new(10, 0, 2, 2), 1));
    guest
        .until(Duration::from_secs(5), |g| {
            (g.socket(handle).state() == tcp::State::Closed).then_some(())
        })
        .await;

    let request = Icmpv4Repr::EchoRequest {
        ident: 9,
        seq_no: 3,
        data: b"out there",
    };
    let ip = Ipv4Repr {
        src_addr: Ipv4Addr::new(10, 0, 2, 15),
        dst_addr: SERVICES,
        next_header: IpProtocol::Icmp,
        payload_len: request.buffer_len(),
        hop_limit: 64,
    };
    let ethernet = EthernetRepr {
        src_addr: GUEST_MAC,
        dst_addr: relay::session::GATEWAY_MAC,
        ethertype: EthernetProtocol::Ipv4,
    };
    let mut frame = vec![0; 14 + ip.buffer_len() + request.buffer_len()];
    ethernet.emit(&mut EthernetFrame::new_unchecked(&mut frame[..]));
    ip.emit(
        &mut Ipv4Packet::new_unchecked(&mut frame[14..]),
        &ChecksumCapabilities::default(),
    );
    request.emit(
        &mut Icmpv4Packet::new_unchecked(&mut frame[34..]),
        &ChecksumCapabilities::default(),
    );
    guest.to_relay.send(frame).unwrap();
    let reply = guest
        .until(Duration::from_secs(5), |g| {
            g.seen.iter().find_map(|f| {
                let ip = Ipv4Packet::new_checked(&f[14..]).ok()?;
                let icmp = Icmpv4Packet::new_checked(ip.payload()).ok()?;
                (ip.next_header() == IpProtocol::Icmp && u8::from(icmp.msg_type()) == 0).then(|| {
                    (
                        ip.src_addr(),
                        icmp.echo_ident(),
                        icmp.echo_seq_no(),
                        icmp.data().to_vec(),
                    )
                })
            })
        })
        .await;
    assert_eq!(reply, Some((SERVICES, 9, 3, b"out there".to_vec())));
}
