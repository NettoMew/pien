//! Out into the world: TCP directly, or through a SOCKS5 proxy; UDP and ICMP
//! always directly.

use std::io;
use std::net::{Ipv4Addr, SocketAddrV4};

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
    /// No way there, or no answer: the guest gets ICMP "host unreachable".
    Unreachable,
}

pub async fn tcp(egress: &Egress, to: SocketAddrV4) -> Result<Box<dyn Stream>, Failure> {
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

pub async fn udp(to: SocketAddrV4) -> io::Result<UdpSocket> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).await?;
    socket.connect(to).await?;
    Ok(socket)
}

/// An unprivileged ICMP ("ping") socket to `to`: Linux, with the relay's
/// group inside net.ipv4.ping_group_range — the default in containers. The
/// kernel fills in the identifier and checksum.
#[cfg(target_os = "linux")]
pub fn ping(to: Ipv4Addr) -> io::Result<UdpSocket> {
    use socket2::{Domain, Protocol, SockAddr, Socket, Type};
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::ICMPV4))?;
    socket.set_nonblocking(true)?;
    socket.connect(&SockAddr::from(SocketAddrV4::new(to, 0)))?;
    UdpSocket::from_std(socket.into())
}

#[cfg(not(target_os = "linux"))]
pub fn ping(_: Ipv4Addr) -> io::Result<UdpSocket> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "ICMP needs Linux ping sockets",
    ))
}
