//! What the network says back about our datagrams and pings — "time
//! exceeded" from a router on the way, "unreachable" from the end — as Linux
//! queues it for a socket with IP_RECVERR or IPV6_RECVERR: who said it, what,
//! and about which datagram. traceroute and mtr live on these; elsewhere
//! there are none.

use std::net::IpAddr;

pub struct Report {
    pub from: IpAddr,
    /// ICMP's type and code, as the sender's family numbers them, and the
    /// word after the checksum: the MTU of a "too big", say.
    pub kind: u8,
    pub code: u8,
    pub rest: u32,
    /// The datagram it is about, as we sent it (for a ping socket: the echo request).
    pub sent: Vec<u8>,
}

#[cfg(target_os = "linux")]
pub use linux::{drain, enable};

#[cfg(not(target_os = "linux"))]
pub fn enable(_: &tokio::net::UdpSocket) {}

#[cfg(not(target_os = "linux"))]
pub fn drain(_: &tokio::net::UdpSocket) -> Vec<Report> {
    Vec::new()
}

#[cfg(target_os = "linux")]
mod linux {
    use std::mem::{size_of, size_of_val, zeroed};
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
    use std::os::fd::AsRawFd;

    use tokio::net::UdpSocket;

    use super::Report;

    /// Queues the network's errors for this socket, in its family, and wakes
    /// its readers for them (SO_SELECT_ERR_QUEUE: the queue then reads as
    /// "priority data").
    pub fn enable(socket: &UdpSocket) {
        let errors = match socket.local_addr() {
            Ok(SocketAddr::V6(_)) => (libc::SOL_IPV6, libc::IPV6_RECVERR),
            _ => (libc::SOL_IP, libc::IP_RECVERR),
        };
        let on: libc::c_int = 1;
        for (level, option) in [errors, (libc::SOL_SOCKET, libc::SO_SELECT_ERR_QUEUE)] {
            // SAFETY: a valid descriptor and a c_int option value of the right size.
            unsafe {
                libc::setsockopt(
                    socket.as_raw_fd(),
                    level,
                    option,
                    (&raw const on).cast(),
                    size_of_val(&on) as libc::socklen_t,
                )
            };
        }
    }

    /// Every report waiting in the socket's error queue, without blocking.
    pub fn drain(socket: &UdpSocket) -> Vec<Report> {
        let mut reports = Vec::new();
        loop {
            let mut sent = [0u8; 2048];
            let mut control = [0u64; 64]; // u64s: aligned for cmsghdr
            let mut iov = libc::iovec { iov_base: sent.as_mut_ptr().cast(), iov_len: sent.len() };
            // SAFETY: msghdr is plain data; zero is a valid "nothing".
            let mut msg: libc::msghdr = unsafe { zeroed() };
            msg.msg_iov = &raw mut iov;
            msg.msg_iovlen = 1;
            msg.msg_control = control.as_mut_ptr().cast();
            msg.msg_controllen = size_of_val(&control) as _;
            // SAFETY: msg points at buffers that outlive the call.
            let n = unsafe { libc::recvmsg(socket.as_raw_fd(), &raw mut msg, libc::MSG_ERRQUEUE | libc::MSG_DONTWAIT) };
            if n < 0 {
                return reports;
            }
            // SAFETY: the kernel filled msg_control with well-formed cmsgs.
            let mut cmsg = unsafe { libc::CMSG_FIRSTHDR(&raw const msg) };
            while !cmsg.is_null() {
                // SAFETY: a cmsg the kernel wrote, read only as far as its type says.
                unsafe {
                    let kind = ((*cmsg).cmsg_level, (*cmsg).cmsg_type);
                    if kind == (libc::SOL_IP, libc::IP_RECVERR) || kind == (libc::SOL_IPV6, libc::IPV6_RECVERR) {
                        let error = libc::CMSG_DATA(cmsg).cast::<libc::sock_extended_err>().read_unaligned();
                        // SO_EE_OFFENDER: the sender's address follows the error.
                        let offender = libc::CMSG_DATA(cmsg).add(size_of::<libc::sock_extended_err>());
                        let from = match error.ee_origin {
                            libc::SO_EE_ORIGIN_ICMP => {
                                let from = offender.cast::<libc::sockaddr_in>().read_unaligned();
                                Some(IpAddr::from(Ipv4Addr::from(u32::from_be(from.sin_addr.s_addr))))
                            }
                            libc::SO_EE_ORIGIN_ICMP6 => {
                                let from = offender.cast::<libc::sockaddr_in6>().read_unaligned();
                                Some(IpAddr::from(Ipv6Addr::from(from.sin6_addr.s6_addr)))
                            }
                            _ => None,
                        };
                        if let Some(from) = from {
                            reports.push(Report {
                                from,
                                kind: error.ee_type,
                                code: error.ee_code,
                                rest: rest(from, &error),
                                sent: sent[..n as usize].to_vec(),
                            });
                        }
                    }
                    cmsg = libc::CMSG_NXTHDR(&raw const msg, cmsg);
                }
            }
        }
    }

    /// The word after the ICMP checksum, back as it was: Linux keeps only
    /// what means something in it — an MTU, a pointer — as ee_info.
    fn rest(from: IpAddr, error: &libc::sock_extended_err) -> u32 {
        match (from, error.ee_type) {
            (IpAddr::V4(_), 12) => error.ee_info << 24, // a parameter problem's pointer: the first byte
            _ => error.ee_info,
        }
    }
}
