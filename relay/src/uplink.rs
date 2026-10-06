//! The relay's end of the host's own link, for one thing: answering the
//! upstream router's neighbour solicitations for the sessions' public
//! addresses (addresses.rs), which no interface of the host holds. An
//! upstream that routes the prefix to the host asks nothing, and needs none
//! of this; one that keeps the prefix on its link asks after each address
//! before it sends it anything, and hears back for those in use alone.
//!
//! A packet socket on that interface, which the kernel hands neighbour
//! solicitations alone, joined to the solicited-node group of each address
//! in use. Opening one takes CAP_NET_RAW, the one privilege the relay ever
//! needs: it opens the socket first thing, and then gives up every
//! capability it has ([`renounce`]).

#[cfg(target_os = "linux")]
pub use linux::{Uplink, renounce};

#[cfg(not(target_os = "linux"))]
pub use elsewhere::{Uplink, renounce};

#[cfg(target_os = "linux")]
mod linux {
    use std::ffi::CString;
    use std::fmt;
    use std::io;
    use std::mem::{size_of, zeroed};
    use std::net::Ipv6Addr;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};

    use smoltcp::wire::EthernetAddress;
    use tokio::io::unix::AsyncFd;

    use crate::packet;

    const CAP_NET_RAW: u32 = 13;
    const ICMPV6: u32 = 58;
    const NEIGHBOR_SOLICIT: u32 = 135;

    pub struct Uplink {
        name: String,
        socket: OwnedFd,
        index: libc::c_int,
        mac: EthernetAddress,
    }

    impl Uplink {
        /// The interface called `name`, as seen from a packet socket on it.
        pub fn open(name: &str) -> io::Result<Self> {
            let c_name = CString::new(name).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
            // SAFETY: a NUL-terminated name.
            let index = unsafe { libc::if_nametoindex(c_name.as_ptr()) };
            if index == 0 {
                return Err(io::Error::last_os_error());
            }
            let index = index as libc::c_int;
            effective(CAP_NET_RAW);
            // Of no protocol yet, it hears nothing until its filter is in place.
            let kind = libc::SOCK_DGRAM | libc::SOCK_NONBLOCK | libc::SOCK_CLOEXEC;
            // SAFETY: plain socket(2).
            let fd = cvt(unsafe { libc::socket(libc::AF_PACKET, kind, 0) }).map_err(|e| match e.kind() {
                io::ErrorKind::PermissionDenied => io::Error::new(e.kind(), "it takes CAP_NET_RAW (docs/relay.md)"),
                _ => e,
            })?;
            // SAFETY: a new descriptor, owned from here on.
            let socket = unsafe { OwnedFd::from_raw_fd(fd) };
            // What the kernel lets through: ICMPv6 neighbour solicitations. A
            // SOCK_DGRAM socket's packets start at the IPv6 header.
            let mut filter = [
                bpf(libc::BPF_LD | libc::BPF_B | libc::BPF_ABS, 0, 0, 6), // next header
                bpf(libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K, 0, 3, ICMPV6),
                bpf(libc::BPF_LD | libc::BPF_B | libc::BPF_ABS, 0, 0, 40), // ICMPv6 type
                bpf(libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K, 0, 1, NEIGHBOR_SOLICIT),
                bpf(libc::BPF_RET | libc::BPF_K, 0, 0, u32::MAX),
                bpf(libc::BPF_RET | libc::BPF_K, 0, 0, 0),
            ];
            let program = libc::sock_fprog { len: filter.len() as u16, filter: filter.as_mut_ptr() };
            setsockopt(&socket, libc::SOL_SOCKET, libc::SO_ATTACH_FILTER, &program)?;
            let mut address = link(index);
            let mut length = size_of::<libc::sockaddr_ll>() as libc::socklen_t;
            // SAFETY: a sockaddr_ll, and its size.
            cvt(unsafe { libc::bind(socket.as_raw_fd(), (&raw const address).cast(), length) })?;
            // Bound, the socket knows the interface's own address.
            // SAFETY: room for a sockaddr_ll, and its size.
            cvt(unsafe { libc::getsockname(socket.as_raw_fd(), (&raw mut address).cast(), &raw mut length) })?;
            if address.sll_halen != 6 {
                return Err(io::Error::new(io::ErrorKind::Unsupported, "not an Ethernet interface"));
            }
            let mac = EthernetAddress::from_bytes(&address.sll_addr[..6]);
            Ok(Self { name: name.to_owned(), socket, index, mac })
        }

        /// Hears the upstream's solicitations for `address` from now on.
        pub fn claim(&self, address: Ipv6Addr) {
            let _ = self.membership(libc::PACKET_ADD_MEMBERSHIP, address);
        }

        pub fn release(&self, address: Ipv6Addr) {
            let _ = self.membership(libc::PACKET_DROP_MEMBERSHIP, address);
        }

        /// The solicited-node group of `address`, joined or left. Addresses
        /// that share one share its membership too: the kernel counts them.
        fn membership(&self, change: libc::c_int, address: Ipv6Addr) -> io::Result<()> {
            let (_, group) = packet::solicited_node(address);
            // SAFETY: packet_mreq is plain old data.
            let mut request: libc::packet_mreq = unsafe { zeroed() };
            request.mr_ifindex = self.index;
            request.mr_type = libc::PACKET_MR_MULTICAST as u16;
            request.mr_alen = 6;
            request.mr_address[..6].copy_from_slice(group.as_bytes());
            setsockopt(&self.socket, libc::SOL_PACKET, change, &request)
        }

        /// Answers every solicitation for an address that `ours` says is in
        /// use, for as long as the relay runs. A probe for a duplicate (from
        /// the unspecified address) goes unanswered: nothing else may use
        /// these addresses, and the guests do not probe upstream.
        pub async fn answer(&self, ours: impl Fn(Ipv6Addr) -> bool) {
            let Ok(socket) = AsyncFd::new(self.socket.as_raw_fd()) else { return };
            let mut buf = [0; 1500];
            loop {
                let Ok(mut ready) = socket.readable().await else { return };
                let Ok(received) = ready.try_io(|fd| receive(*fd.get_ref(), &mut buf)) else { continue };
                let Ok((len, from)) = received else { continue };
                let Some(asked) = packet::neighbor_solicitation(&buf[..len]) else { continue };
                if asked.from.is_unspecified() || !ours(asked.target) {
                    continue;
                }
                let advert = packet::neighbor_advert(asked.target, asked.from, self.mac, false);
                let _ = self.send(&advert, asked.lladdr.unwrap_or(from));
            }
        }

        fn send(&self, packet: &[u8], to: EthernetAddress) -> io::Result<()> {
            let mut address = link(self.index);
            address.sll_halen = 6;
            address.sll_addr[..6].copy_from_slice(to.as_bytes());
            let (fd, length) = (self.socket.as_raw_fd(), size_of::<libc::sockaddr_ll>() as libc::socklen_t);
            let (bytes, len) = (packet.as_ptr().cast(), packet.len());
            // SAFETY: the packet and its length, and a sockaddr_ll and its size.
            let sent = unsafe { libc::sendto(fd, bytes, len, 0, (&raw const address).cast(), length) };
            usize::try_from(sent).map(drop).map_err(|_| io::Error::last_os_error())
        }
    }

    impl fmt::Display for Uplink {
        fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
            let mac: Vec<String> = self.mac.as_bytes().iter().map(|b| format!("{b:02x}")).collect();
            write!(f, "{} ({})", self.name, mac.join(":"))
        }
    }

    /// One packet off the socket, and the link-layer address it came from.
    fn receive(fd: RawFd, buf: &mut [u8]) -> io::Result<(usize, EthernetAddress)> {
        // SAFETY: sockaddr_ll is plain old data.
        let mut from: libc::sockaddr_ll = unsafe { zeroed() };
        let mut length = size_of::<libc::sockaddr_ll>() as libc::socklen_t;
        let (into, room) = (buf.as_mut_ptr().cast(), buf.len());
        // SAFETY: the buffer and its length, and room for a sockaddr_ll and its size.
        let len = unsafe { libc::recvfrom(fd, into, room, 0, (&raw mut from).cast(), &raw mut length) };
        let len = usize::try_from(len).map_err(|_| io::Error::last_os_error())?;
        Ok((len, EthernetAddress::from_bytes(&from.sll_addr[..6])))
    }

    /// The interface at `index`, for IPv6.
    fn link(index: libc::c_int) -> libc::sockaddr_ll {
        // SAFETY: sockaddr_ll is plain old data.
        let mut address: libc::sockaddr_ll = unsafe { zeroed() };
        address.sll_family = libc::AF_PACKET as u16;
        address.sll_protocol = (libc::ETH_P_IPV6 as u16).to_be();
        address.sll_ifindex = index;
        address
    }

    fn bpf(code: u32, jt: u8, jf: u8, k: u32) -> libc::sock_filter {
        libc::sock_filter { code: code as u16, jt, jf, k }
    }

    fn setsockopt<T>(socket: &OwnedFd, level: libc::c_int, name: libc::c_int, value: &T) -> io::Result<()> {
        let (fd, size) = (socket.as_raw_fd(), size_of::<T>() as libc::socklen_t);
        // SAFETY: a valid descriptor, and a value of the option's own type, and its size.
        cvt(unsafe { libc::setsockopt(fd, level, name, (value as *const T).cast(), size) }).map(drop)
    }

    fn cvt(result: libc::c_int) -> io::Result<libc::c_int> {
        if result < 0 { Err(io::Error::last_os_error()) } else { Ok(result) }
    }

    // ─── Capabilities ────────────────────────────────────────────────────────
    //
    // Per thread, in Linux: given up while the relay is a single thread, they
    // are given up for good. A relay given CAP_NET_RAW as a file capability
    // holds it as permitted alone, and makes it effective to use it.

    #[repr(C)]
    struct Header {
        version: u32,
        pid: libc::c_int,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct Sets {
        effective: u32,
        permitted: u32,
        inheritable: u32,
    }

    const VERSION_3: u32 = 0x2008_0522;

    fn capabilities() -> io::Result<[Sets; 2]> {
        let mut header = Header { version: VERSION_3, pid: 0 };
        let mut sets = [Sets::default(); 2];
        // SAFETY: a version 3 header, and the two sets it reads into.
        let result = unsafe { libc::syscall(libc::SYS_capget, &raw mut header, sets.as_mut_ptr()) };
        if result < 0 { Err(io::Error::last_os_error()) } else { Ok(sets) }
    }

    fn set(sets: [Sets; 2]) -> io::Result<()> {
        let mut header = Header { version: VERSION_3, pid: 0 };
        // SAFETY: a version 3 header, and the two sets it writes from.
        let result = unsafe { libc::syscall(libc::SYS_capset, &raw mut header, sets.as_ptr()) };
        if result < 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
    }

    /// Makes `capability` effective, if it is permitted at all.
    fn effective(capability: u32) {
        if let Ok(mut sets) = capabilities() {
            sets[0].effective |= sets[0].permitted & (1 << capability);
            let _ = set(sets);
        }
    }

    /// Gives up every capability, effective, permitted and inheritable alike.
    pub fn renounce() -> io::Result<()> {
        set([Sets::default(); 2])
    }
}

#[cfg(not(target_os = "linux"))]
mod elsewhere {
    use std::fmt;
    use std::io;
    use std::net::Ipv6Addr;

    /// None to be had: packet sockets, and binding to addresses the host
    /// does not hold, are Linux's.
    pub enum Uplink {}

    impl Uplink {
        pub fn open(_: &str) -> io::Result<Self> {
            Err(io::Error::new(io::ErrorKind::Unsupported, "Linux alone"))
        }

        pub fn claim(&self, _: Ipv6Addr) {
            match *self {}
        }

        pub fn release(&self, _: Ipv6Addr) {
            match *self {}
        }

        pub async fn answer(&self, _: impl Fn(Ipv6Addr) -> bool) {
            match *self {}
        }
    }

    impl fmt::Display for Uplink {
        fn fmt(&self, _: &mut fmt::Formatter) -> fmt::Result {
            match *self {}
        }
    }

    pub fn renounce() -> io::Result<()> {
        Ok(())
    }
}
