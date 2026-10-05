//! Out into the world, in the family the destination is in: TCP directly, or
//! through a SOCKS5 proxy; UDP and ICMP always directly.

use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::{TcpStream, UdpSocket};

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

pub async fn tcp(egress: &Egress, to: SocketAddr) -> Result<Box<dyn Stream>, Failure> {
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
            let stream = TcpStream::connect(to).await.map_err(|e| match e.kind() {
                io::ErrorKind::ConnectionRefused => Failure::Refused,
                _ => Failure::Unreachable,
            })?;
            let _ = stream.set_nodelay(true);
            Ok(Box::new(stream))
        }
    }
}

pub async fn udp(to: SocketAddr) -> io::Result<UdpSocket> {
    let anywhere: IpAddr = match to {
        SocketAddr::V4(_) => Ipv4Addr::UNSPECIFIED.into(),
        SocketAddr::V6(_) => Ipv6Addr::UNSPECIFIED.into(),
    };
    let socket = UdpSocket::bind((anywhere, 0)).await?;
    socket.connect(to).await?;
    Ok(socket)
}

/// An unprivileged ICMP or ICMPv6 ("ping") socket to `to`: Linux, with the
/// relay's group inside net.ipv4.ping_group_range — the default in
/// containers — which rules over both families. The kernel fills in the
/// identifier and checksum.
#[cfg(target_os = "linux")]
pub fn ping(to: IpAddr) -> io::Result<UdpSocket> {
    use socket2::{Domain, Protocol, Socket, Type};
    let (domain, protocol) = match to {
        IpAddr::V4(_) => (Domain::IPV4, Protocol::ICMPV4),
        IpAddr::V6(_) => (Domain::IPV6, Protocol::ICMPV6),
    };
    let socket = Socket::new(domain, Type::DGRAM, Some(protocol))?;
    socket.set_nonblocking(true)?;
    socket.connect(&SocketAddr::new(to, 0).into())?;
    UdpSocket::from_std(socket.into())
}

#[cfg(not(target_os = "linux"))]
pub fn ping(_: IpAddr) -> io::Result<UdpSocket> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "ICMP needs Linux ping sockets",
    ))
}
