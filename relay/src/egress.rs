//! Out into the world, in the family the destination is in: TCP directly, or
//! through a SOCKS5 proxy; UDP and ICMP always directly. Over IPv6, from the
//! session's own address when it has a public one (addresses.rs) — which the
//! host takes in but does not hold, so the sockets bind to it freely
//! (IPV6_FREEBIND) — and otherwise from wherever the host picks.

use std::io;
use std::net::{IpAddr, Ipv6Addr, SocketAddr};

use socket2::{Domain, Protocol, Socket, Type};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::{TcpSocket, UdpSocket};

use crate::config::Egress;

pub trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}

/// Why a connection could not be made — which decides what the guest hears.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Failure {
    /// Nothing listens there: the guest gets a TCP reset.
    Refused,
    /// No way there, or no answer: the guest gets ICMP "unreachable".
    Unreachable,
}

pub async fn tcp(egress: &Egress, to: SocketAddr, from: Option<Ipv6Addr>) -> Result<Box<dyn Stream>, Failure> {
    match egress.socks5 {
        Some(proxy) => {
            let stream = tokio_socks::tcp::Socks5Stream::connect(proxy, to)
                .await
                .map_err(|e| match e {
                    tokio_socks::Error::ConnectionRefused => Failure::Refused,
                    _ => Failure::Unreachable,
                })?;
            Ok(Box::new(stream))
        }
        None => {
            let socket = socket(to, Type::STREAM, None, from).map_err(|_| Failure::Unreachable)?;
            let stream = TcpSocket::from_std_stream(socket.into())
                .connect(to)
                .await
                .map_err(|e| match e.kind() {
                    io::ErrorKind::ConnectionRefused => Failure::Refused,
                    _ => Failure::Unreachable,
                })?;
            let _ = stream.set_nodelay(true);
            Ok(Box::new(stream))
        }
    }
}

pub async fn udp(to: SocketAddr, from: Option<Ipv6Addr>) -> io::Result<UdpSocket> {
    let socket = UdpSocket::from_std(socket(to, Type::DGRAM, Some(Protocol::UDP), from)?.into())?;
    socket.connect(to).await?;
    Ok(socket)
}

/// An unprivileged ICMP or ICMPv6 ("ping") socket to `to`: Linux, with the
/// relay's group inside net.ipv4.ping_group_range — the default in
/// containers — which rules over both families. The kernel fills in the
/// identifier and checksum.
#[cfg(target_os = "linux")]
pub fn ping(to: IpAddr, from: Option<Ipv6Addr>) -> io::Result<UdpSocket> {
    let protocol = if to.is_ipv6() { Protocol::ICMPV6 } else { Protocol::ICMPV4 };
    let to = SocketAddr::new(to, 0);
    let socket = socket(to, Type::DGRAM, Some(protocol), from)?;
    socket.connect(&to.into())?;
    UdpSocket::from_std(socket.into())
}

#[cfg(not(target_os = "linux"))]
pub fn ping(_: IpAddr, _: Option<Ipv6Addr>) -> io::Result<UdpSocket> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "ICMP needs Linux ping sockets",
    ))
}

/// A non-blocking socket in `to`'s family; over IPv6 bound to `from`, if
/// there is one, and otherwise left for connecting to bind.
fn socket(to: SocketAddr, kind: Type, protocol: Option<Protocol>, from: Option<Ipv6Addr>) -> io::Result<Socket> {
    let socket = Socket::new(Domain::for_address(to), kind, protocol)?;
    socket.set_nonblocking(true)?;
    if let (SocketAddr::V6(_), Some(from)) = (to, from) {
        #[cfg(target_os = "linux")]
        socket.set_freebind_v6(true)?;
        socket.bind(&SocketAddr::from((from, 0)).into())?;
    }
    Ok(socket)
}
