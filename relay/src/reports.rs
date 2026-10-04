//! What the network says back about our datagrams and pings — "time
//! exceeded" from a router on the way, "unreachable" from the end — as Linux
//! queues it for a socket with IP_RECVERR: who said it, what, and about which
//! datagram. traceroute and mtr live on these; elsewhere there are none.

use std::net::Ipv4Addr;

pub struct Report {
    pub from: Ipv4Addr,
    /// ICMP type and code.
    pub kind: u8,
    pub code: u8,
    /// The datagram it is about, as we sent it (for a ping socket: the echo request).
    pub sent: Vec<u8>,
}

#[cfg(target_os = "linux")]
pub use linux::{drain, enable};

#[cfg(not(target_os = "linux"))]
pub fn enable<S>(_: &S) {}

#[cfg(not(target_os = "linux"))]
pub fn drain<S>(_: &S) -> Vec<Report> {
    Vec::new()
}

#[cfg(target_os = "linux")]
mod linux {
    use std::mem::{size_of, size_of_val, zeroed};
    use std::net::Ipv4Addr;
    use std::os::fd::AsRawFd;

    use super::Report;

    /// Queues the network's errors for this socket, and wakes its readers for
    /// them (SO_SELECT_ERR_QUEUE: the queue then reads as "priority data").
    pub fn enable(socket: &impl AsRawFd) {
        let on: libc::c_int = 1;
        for (level, option) in [(libc::SOL_IP, libc::IP_RECVERR), (libc::SOL_SOCKET, libc::SO_SELECT_ERR_QUEUE)] {
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
    pub fn drain(socket: &impl AsRawFd) -> Vec<Report> {
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
                    if (*cmsg).cmsg_level == libc::SOL_IP && (*cmsg).cmsg_type == libc::IP_RECVERR {
                        let error = libc::CMSG_DATA(cmsg).cast::<libc::sock_extended_err>().read_unaligned();
                        if error.ee_origin == libc::SO_EE_ORIGIN_ICMP {
                            // SO_EE_OFFENDER: the sender's address follows the error.
                            let offender = libc::CMSG_DATA(cmsg)
                                .add(size_of::<libc::sock_extended_err>())
                                .cast::<libc::sockaddr_in>()
                                .read_unaligned();
                            reports.push(Report {
                                from: Ipv4Addr::from(u32::from_be(offender.sin_addr.s_addr)),
                                kind: error.ee_type,
                                code: error.ee_code,
                                sent: sent[..n as usize].to_vec(),
                            });
                        }
                    }
                    cmsg = libc::CMSG_NXTHDR(&raw const msg, cmsg);
                }
            }
        }
    }
}
