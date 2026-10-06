//! Packets the gateway makes up itself, outside smoltcp, in either family:
//! what comes back from the outside world (UDP, ICMP echo), the ways a
//! connection fails before it exists (a TCP reset, an ICMP error), and the
//! link's own: answers to ARP and neighbour solicitations, and router
//! advertisements. And what little the gateway reads of the guest's own
//! packets ([`Ip`]). On the uplink, the same both ways round (uplink.rs):
//! the upstream's neighbour solicitations, and the relay's answers.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use smoltcp::phy::ChecksumCapabilities;
use smoltcp::wire::{
    ArpOperation, ArpPacket, ArpRepr, EthernetAddress, EthernetFrame, EthernetProtocol, EthernetRepr,
    IPV6_LINK_LOCAL_ALL_NODES, IPV6_MIN_MTU,
    Icmpv6Message, Icmpv6Packet, Icmpv6Repr, IpAddress, IpProtocol, IpRepr, Ipv4Packet, Ipv6Packet,
    NdiscNeighborFlags, NdiscRepr, NdiscRouterFlags, TcpControl, TcpPacket, TcpRepr, TcpSeqNumber, UdpPacket,
    UdpRepr,
};

const TTL: u8 = 64;
/// Neighbour discovery's hop limit: proof that a message never crossed a router.
const ON_LINK: u8 = 255;
const IPV4_HEADER: usize = 20;
const IPV6_HEADER: usize = 40;
const UDP_HEADER: usize = 8;
const ICMP_HEADER: usize = 8;

/// An IPv4 or IPv6 packet, as far as the gateway reads one. Fragments, and
/// IPv6 packets with extension headers, it leaves be.
pub struct Ip<'a> {
    pub src: IpAddr,
    pub dst: IpAddr,
    pub protocol: IpProtocol,
    pub hop_limit: u8,
    pub payload: &'a [u8],
}

impl<'a> Ip<'a> {
    pub fn parse(packet: &'a [u8]) -> Option<Self> {
        match packet.first()? >> 4 {
            4 => {
                let ip = Ipv4Packet::new_checked(packet).ok()?;
                let whole = ip.verify_checksum() && !ip.more_frags() && ip.frag_offset() == 0;
                whole.then(|| Self {
                    src: ip.src_addr().into(),
                    dst: ip.dst_addr().into(),
                    protocol: ip.next_header(),
                    hop_limit: ip.hop_limit(),
                    payload: ip.payload(),
                })
            }
            6 => {
                let ip = Ipv6Packet::new_checked(packet).ok()?;
                let extended = matches!(
                    ip.next_header(),
                    IpProtocol::HopByHop | IpProtocol::Ipv6Route | IpProtocol::Ipv6Frag | IpProtocol::Ipv6Opts
                );
                (!extended).then(|| Self {
                    src: ip.src_addr().into(),
                    dst: ip.dst_addr().into(),
                    protocol: ip.next_header(),
                    hop_limit: ip.hop_limit(),
                    payload: ip.payload(),
                })
            }
            _ => None,
        }
    }

    /// The type of an ICMPv6 message: how neighbour discovery's are told apart.
    pub fn icmpv6(&self) -> Option<Icmpv6Message> {
        match (self.src, self.protocol) {
            (IpAddr::V6(_), IpProtocol::Icmpv6) => self.payload.first().map(|&kind| kind.into()),
            _ => None,
        }
    }

    /// An echo request's identifier, sequence number and data.
    pub fn echo_request(&self) -> Option<(u16, u16, &'a [u8])> {
        let (request, _) = match (self.src, self.protocol) {
            (IpAddr::V4(_), IpProtocol::Icmp) => echo(false),
            (IpAddr::V6(_), IpProtocol::Icmpv6) => echo(true),
            _ => return None,
        };
        let p = self.payload;
        (p.len() >= ICMP_HEADER && p[0] == request).then(|| {
            let word = |at: usize| u16::from_be_bytes([p[at], p[at + 1]]);
            (word(4), word(6), &p[ICMP_HEADER..])
        })
    }
}

/// ICMP's echo request and reply types, in IPv6's numbering or IPv4's.
pub const fn echo(v6: bool) -> (u8, u8) {
    if v6 { (128, 129) } else { (8, 0) }
}

/// Why a packet goes no further, as ICMP says it in either family.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Why {
    /// Its hop limit ran out here: traceroute's answer.
    TimeExceeded,
    /// No way there, or no answer.
    Unreachable,
    /// The policy does not let it out.
    Prohibited,
    /// Nothing listens on that port.
    PortClosed,
    /// A protocol the gateway does not carry.
    Protocol,
    /// What the network out there said, in its own family's numbers: ICMP's
    /// type and code, and the word after the checksum (an MTU, a pointer).
    Reported { kind: u8, code: u8, rest: u32 },
}

impl Why {
    /// ICMP's type and code for it, and the word after the checksum.
    fn icmp(self, v6: bool) -> (u8, u8, u32) {
        match (self, v6) {
            (Why::TimeExceeded, false) => (11, 0, 0),
            (Why::TimeExceeded, true) => (3, 0, 0),
            (Why::Unreachable, false) => (3, 1, 0),
            (Why::Unreachable, true) => (1, 3, 0),
            (Why::Prohibited, false) => (3, 10, 0),
            (Why::Prohibited, true) => (1, 1, 0),
            (Why::PortClosed, false) => (3, 3, 0),
            (Why::PortClosed, true) => (1, 4, 0),
            (Why::Protocol, false) => (3, 2, 0),
            // IPv6 says it as a parameter problem, pointing at the next header field.
            (Why::Protocol, true) => (4, 1, 6),
            (Why::Reported { kind, code, rest }, _) => (kind, code, rest),
        }
    }
}

pub fn ethernet(dst: EthernetAddress, src: EthernetAddress, ip: &[u8]) -> Vec<u8> {
    let repr = EthernetRepr {
        src_addr: src,
        dst_addr: dst,
        ethertype: match ip.first().map(|b| b >> 4) {
            Some(6) => EthernetProtocol::Ipv6,
            _ => EthernetProtocol::Ipv4,
        },
    };
    let mut frame = vec![0; repr.buffer_len() + ip.len()];
    let mut ethernet = EthernetFrame::new_unchecked(&mut frame);
    repr.emit(&mut ethernet);
    ethernet.payload_mut().copy_from_slice(ip);
    frame
}

pub fn udp(src: SocketAddr, dst: SocketAddr, data: &[u8]) -> Option<Vec<u8>> {
    let repr = UdpRepr {
        src_port: src.port(),
        dst_port: dst.port(),
    };
    let (from, to) = (IpAddress::from(src.ip()), IpAddress::from(dst.ip()));
    ip(src.ip(), dst.ip(), IpProtocol::Udp, TTL, UDP_HEADER + data.len(), |buf| {
        let emit_data = |payload: &mut [u8]| payload.copy_from_slice(data);
        repr.emit(
            &mut UdpPacket::new_unchecked(buf),
            &from,
            &to,
            data.len(),
            emit_data,
            &checksums(),
        );
    })
}

pub fn echo_reply(from: IpAddr, to: IpAddr, ident: u16, seq_no: u16, data: &[u8]) -> Option<Vec<u8>> {
    let (_, reply) = echo(to.is_ipv6());
    let message = [&[reply, 0, 0, 0][..], &ident.to_be_bytes(), &seq_no.to_be_bytes(), data].concat();
    icmp(from, to, message)
}

/// "Connection refused": a reset answering `syn`, a packet with a TCP SYN.
pub fn tcp_reset(syn: &[u8]) -> Option<Vec<u8>> {
    let syn = Ip::parse(syn)?;
    let tcp = TcpPacket::new_checked(syn.payload).ok()?;
    let repr = TcpRepr {
        src_port: tcp.dst_port(),
        dst_port: tcp.src_port(),
        control: TcpControl::Rst,
        seq_number: TcpSeqNumber(0),
        ack_number: Some(tcp.seq_number() + 1),
        window_len: 0,
        window_scale: None,
        max_seg_size: None,
        sack_permitted: false,
        sack_ranges: [None; 3],
        timestamp: None,
        payload: &[],
    };
    let (from, to) = (syn.dst, syn.src);
    ip(from, to, IpProtocol::Tcp, TTL, repr.buffer_len(), |buf| {
        repr.emit(
            &mut TcpPacket::new_unchecked(buf),
            &from.into(),
            &to.into(),
            &checksums(),
        )
    })
}

/// `from` telling the guest why `original` — a packet it sent, whole or
/// quoted — goes no further, in the family the guest sent it in.
pub fn icmp_error(from: IpAddr, why: Why, original: &[u8]) -> Option<Vec<u8>> {
    let to = source(original)?;
    let (kind, code, rest) = why.icmp(to.is_ipv6());
    let message = [&[kind, code, 0, 0][..], &rest.to_be_bytes(), quote(original)].concat();
    icmp(from, to, message)
}

/// What an ICMP error quotes of a packet, whole or already quoted: its IPv4
/// header and 8 bytes beyond (RFC 792), or as much of the IPv6 packet as fits
/// in the smallest MTU (RFC 4443). traceroute and mtr find their probes again
/// by what is quoted.
pub fn quote(packet: &[u8]) -> &[u8] {
    let (quoted, total) = match packet.first().map(|b| b >> 4) {
        Some(4) if packet.len() >= IPV4_HEADER => (
            usize::from(packet[0] & 0x0f) * 4 + 8,
            usize::from(u16::from_be_bytes([packet[2], packet[3]])),
        ),
        Some(6) if packet.len() >= IPV6_HEADER => (
            IPV6_MIN_MTU - IPV6_HEADER - ICMP_HEADER,
            IPV6_HEADER + usize::from(u16::from_be_bytes([packet[4], packet[5]])),
        ),
        _ => (0, 0),
    };
    &packet[..quoted.min(total).min(packet.len())]
}

/// Who sent a packet, whole or quoted.
pub fn source(packet: &[u8]) -> Option<IpAddr> {
    match packet.first()? >> 4 {
        4 => Some(Ipv4Addr::from(<[u8; 4]>::try_from(packet.get(12..16)?).ok()?).into()),
        6 => Some(Ipv6Addr::from(<[u8; 16]>::try_from(packet.get(8..24)?).ok()?).into()),
        _ => None,
    }
}

/// A router advertisement, to every node on the link: `router` (link-local,
/// at `mac`) is the way out for `lifetime`, and addresses come from DHCPv6
/// (the M flag; dhcp.rs). No prefix is on the link to make one in.
pub fn router_advert(router: Ipv6Addr, mac: EthernetAddress, lifetime: Duration) -> Vec<u8> {
    let advert = Icmpv6Repr::Ndisc(NdiscRepr::RouterAdvert {
        hop_limit: TTL,
        flags: NdiscRouterFlags::MANAGED,
        router_lifetime: lifetime.into(),
        reachable_time: smoltcp::time::Duration::ZERO,
        retrans_time: smoltcp::time::Duration::ZERO,
        lladdr: Some(mac.into()),
        mtu: None,
        prefix_info: None,
    });
    let everyone = IPV6_LINK_LOCAL_ALL_NODES;
    ip(router.into(), everyone.into(), IpProtocol::Icmpv6, ON_LINK, advert.buffer_len(), |buf| {
        advert.emit(&router, &everyone, &mut Icmpv6Packet::new_unchecked(buf), &checksums())
    })
    .expect("both ends are IPv6")
}

/// An ARP request: who asks, at which addresses, and after which address.
pub struct ArpRequest {
    pub from: Ipv4Addr,
    pub mac: EthernetAddress,
    pub target: Ipv4Addr,
}

/// `packet`, if it is an ARP request for an IPv4 address on Ethernet.
pub fn arp_request(packet: &[u8]) -> Option<ArpRequest> {
    let arp = ArpPacket::new_checked(packet).ok()?;
    match ArpRepr::parse(&arp).ok()? {
        ArpRepr::EthernetIpv4 {
            operation: ArpOperation::Request,
            source_hardware_addr,
            source_protocol_addr,
            target_protocol_addr,
            ..
        } if source_hardware_addr.is_unicast() => Some(ArpRequest {
            from: source_protocol_addr,
            mac: source_hardware_addr,
            target: target_protocol_addr,
        }),
        _ => None,
    }
}

/// The answer to an ARP request, a whole frame: its target is at `mac`.
pub fn arp_reply(asked: &ArpRequest, mac: EthernetAddress) -> Vec<u8> {
    let reply = ArpRepr::EthernetIpv4 {
        operation: ArpOperation::Reply,
        source_hardware_addr: mac,
        source_protocol_addr: asked.target,
        target_hardware_addr: asked.mac,
        target_protocol_addr: asked.from,
    };
    let ethernet = EthernetRepr {
        src_addr: mac,
        dst_addr: asked.mac,
        ethertype: EthernetProtocol::Arp,
    };
    let mut frame = vec![0; ethernet.buffer_len() + reply.buffer_len()];
    let mut packet = EthernetFrame::new_unchecked(&mut frame);
    ethernet.emit(&mut packet);
    reply.emit(&mut ArpPacket::new_unchecked(packet.payload_mut()));
    frame
}

/// A neighbour solicitation, as the gateway hears one from the guest, or the
/// uplink from upstream: who asks, after which address, and at which
/// link-layer address the asker says it is.
pub struct Solicitation {
    pub from: Ipv6Addr,
    pub target: Ipv6Addr,
    pub lladdr: Option<EthernetAddress>,
}

/// `packet`, if it is a neighbour solicitation that never crossed a router
/// (RFC 4861, 7.1.1), its checksum checked.
pub fn neighbor_solicitation(packet: &[u8]) -> Option<Solicitation> {
    let ip = Ipv6Packet::new_checked(packet).ok()?;
    if ip.next_header() != IpProtocol::Icmpv6 || ip.hop_limit() != ON_LINK {
        return None;
    }
    let icmp = Icmpv6Packet::new_checked(ip.payload()).ok()?;
    match Icmpv6Repr::parse(&ip.src_addr(), &ip.dst_addr(), &icmp, &checksums()).ok()? {
        Icmpv6Repr::Ndisc(NdiscRepr::NeighborSolicit { target_addr, lladdr }) if !target_addr.is_multicast() => {
            Some(Solicitation {
                from: ip.src_addr(),
                target: target_addr,
                lladdr: lladdr
                    .filter(|l| l.len() == 6)
                    .map(|l| EthernetAddress::from_bytes(l.as_bytes())),
            })
        }
        _ => None,
    }
}

/// The group solicitations for `address` are sent to, and its Ethernet
/// address: the solicited-node multicast group (RFC 4291, 2.7.1).
pub fn solicited_node(address: Ipv6Addr) -> (Ipv6Addr, EthernetAddress) {
    let [.., a, b, c] = address.octets();
    let group = Ipv6Addr::from([0xff, 0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x01, 0xff, a, b, c]);
    (group, EthernetAddress([0x33, 0x33, 0xff, a, b, c]))
}

/// The answer to `to`'s neighbour solicitation: `target` is at `mac`, and
/// is a router or not. A router that answers as anything else stops being
/// one: hosts drop their routes through it (RFC 4861, 7.2.5).
pub fn neighbor_advert(target: Ipv6Addr, to: Ipv6Addr, mac: EthernetAddress, router: bool) -> Vec<u8> {
    let mut flags = NdiscNeighborFlags::SOLICITED | NdiscNeighborFlags::OVERRIDE;
    flags.set(NdiscNeighborFlags::ROUTER, router);
    let advert = Icmpv6Repr::Ndisc(NdiscRepr::NeighborAdvert {
        flags,
        target_addr: target,
        lladdr: Some(mac.into()),
    });
    ip(target.into(), to.into(), IpProtocol::Icmpv6, ON_LINK, advert.buffer_len(), |buf| {
        advert.emit(&target, &to, &mut Icmpv6Packet::new_unchecked(buf), &checksums())
    })
    .expect("both ends are IPv6")
}

/// An ICMP message from `from` to `to`, its checksum filled in: over the
/// message alone for ICMPv4, and the IPv6 pseudo-header too for ICMPv6.
fn icmp(from: IpAddr, to: IpAddr, mut message: Vec<u8>) -> Option<Vec<u8>> {
    let (protocol, pseudo_header) = match (from, to) {
        (IpAddr::V4(_), IpAddr::V4(_)) => (IpProtocol::Icmp, Vec::new()),
        (IpAddr::V6(from), IpAddr::V6(to)) => {
            let length = u32::try_from(message.len()).ok()?.to_be_bytes();
            let next_header = [0, 0, 0, u8::from(IpProtocol::Icmpv6)];
            (IpProtocol::Icmpv6, [&from.octets()[..], &to.octets(), &length, &next_header].concat())
        }
        _ => return None,
    };
    let sum = !checksum(&[pseudo_header, message.clone()].concat());
    message[2..4].copy_from_slice(&sum.to_be_bytes());
    ip(from, to, protocol, TTL, message.len(), |buf| buf.copy_from_slice(&message))
}

/// The one's-complement sum of 16-bit words (RFC 1071), not yet inverted.
fn checksum(data: &[u8]) -> u16 {
    let mut sum: u32 = data.chunks(2).map(|w| u32::from(u16::from_be_bytes([w[0], *w.get(1).unwrap_or(&0)]))).sum();
    while sum > 0xffff {
        sum = (sum & 0xffff) + (sum >> 16);
    }
    sum as u16
}

/// An IP packet from `src` to `dst`, which are of one family or make none,
/// with `len` bytes of `protocol` that `emit` writes.
fn ip(src: IpAddr, dst: IpAddr, protocol: IpProtocol, hop_limit: u8, len: usize, emit: impl FnOnce(&mut [u8])) -> Option<Vec<u8>> {
    if src.is_ipv6() != dst.is_ipv6() {
        return None;
    }
    let repr = IpRepr::new(src.into(), dst.into(), protocol, len, hop_limit);
    let mut buf = vec![0; repr.buffer_len()];
    repr.emit(&mut buf[..], &checksums());
    emit(&mut buf[repr.header_len()..]);
    Some(buf)
}

fn checksums() -> ChecksumCapabilities {
    ChecksumCapabilities::default()
}

#[cfg(test)]
mod tests {
    use smoltcp::wire::Icmpv4Packet;

    use super::*;

    const GUEST: IpAddr = IpAddr::V4(Ipv4Addr::new(10, 0, 2, 15));
    const GUEST6: IpAddr = IpAddr::V6(Ipv6Addr::new(0xfdca, 0xc697, 0x4c23, 0, 0x5054, 0xff, 0xfe12, 0x3456));
    const FAR: IpAddr = IpAddr::V4(Ipv4Addr::new(1, 2, 3, 4));
    const FAR6: IpAddr = IpAddr::V6(Ipv6Addr::new(0x2606, 0x4700, 0, 0, 0, 0, 0, 0x1111));

    fn syn(from: IpAddr, to: IpAddr) -> Vec<u8> {
        let repr = TcpRepr {
            src_port: 40000,
            dst_port: 80,
            control: TcpControl::Syn,
            seq_number: TcpSeqNumber(1000),
            ack_number: None,
            window_len: 64240,
            window_scale: Some(7),
            max_seg_size: Some(1460),
            sack_permitted: true,
            sack_ranges: [None; 3],
            timestamp: None,
            payload: &[],
        };
        ip(from, to, IpProtocol::Tcp, TTL, repr.buffer_len(), |buf| {
            repr.emit(
                &mut TcpPacket::new_unchecked(buf),
                &from.into(),
                &to.into(),
                &checksums(),
            )
        })
        .unwrap()
    }

    /// The ICMPv6 message in `packet`, its checksum checked.
    fn icmpv6(packet: &[u8]) -> (Ipv6Packet<&[u8]>, Icmpv6Packet<&[u8]>) {
        let ip = Ipv6Packet::new_checked(packet).unwrap();
        let icmp = Icmpv6Packet::new_checked(ip.payload()).unwrap();
        assert!(icmp.verify_checksum(&ip.src_addr(), &ip.dst_addr()));
        (ip, icmp)
    }

    #[test]
    fn resets_answer_the_syn() {
        for (guest, far) in [(GUEST, FAR), (GUEST6, FAR6)] {
            let reset = tcp_reset(&syn(guest, far)).unwrap();
            let ip = Ip::parse(&reset).unwrap();
            assert_eq!((ip.src, ip.dst), (far, guest));
            let tcp = TcpPacket::new_checked(ip.payload).unwrap();
            assert!(tcp.rst() && tcp.ack() && !tcp.syn());
            assert_eq!(
                (tcp.src_port(), tcp.dst_port(), tcp.ack_number()),
                (80, 40000, TcpSeqNumber(1001))
            );
            assert!(tcp.verify_checksum(&ip.src.into(), &ip.dst.into()));
        }
    }

    #[test]
    fn errors_quote_the_original() {
        let original = syn(GUEST, FAR);
        let reply = icmp_error(IpAddr::V4(Ipv4Addr::new(10, 0, 2, 2)), Why::Prohibited, &original).unwrap();
        let ip = Ipv4Packet::new_checked(&reply[..]).unwrap();
        assert_eq!(IpAddr::V4(ip.dst_addr()), GUEST);
        let icmp = Icmpv4Packet::new_checked(ip.payload()).unwrap();
        assert!(icmp.verify_checksum());
        assert_eq!((u8::from(icmp.msg_type()), icmp.msg_code()), (3, 10));
        assert_eq!(icmp.data(), &original[..28]); // the original IP header, and 8 bytes beyond

        let original = syn(GUEST6, FAR6);
        let reply = icmp_error(FAR6, Why::Prohibited, &original).unwrap();
        let (ip, icmp) = icmpv6(&reply);
        assert_eq!(IpAddr::V6(ip.dst_addr()), GUEST6);
        assert_eq!((u8::from(icmp.msg_type()), icmp.msg_code()), (1, 1));
        assert_eq!(icmp.payload(), &original[..]); // all of it: it is short
    }

    #[test]
    fn ipv6_quotes_fill_the_smallest_mtu() {
        let datagram = udp((GUEST6, 5000).into(), (FAR6, 443).into(), &[7; 1400]).unwrap();
        let reply = icmp_error(FAR6, Why::Reported { kind: 3, code: 0, rest: 0 }, &datagram).unwrap();
        assert_eq!(reply.len(), IPV6_MIN_MTU);
        let (_, icmp) = icmpv6(&reply);
        assert_eq!(icmp.payload(), &datagram[..IPV6_MIN_MTU - 48]);
        // A quote, quoted again, stays as it was: what probes keep for later.
        assert_eq!(quote(quote(&datagram)), quote(&datagram));
        assert_eq!(quote(&datagram[..60]), &datagram[..60]);
    }

    #[test]
    fn each_family_says_it_its_own_way() {
        let numbers = |why, v6| {
            let (guest, gateway) = if v6 { (GUEST6, FAR6) } else { (GUEST, FAR) };
            let reply = icmp_error(gateway, why, &syn(guest, gateway)).unwrap();
            let message = &reply[if v6 { 40 } else { 20 }..];
            (message[0], message[1], u32::from_be_bytes(message[4..8].try_into().unwrap()))
        };
        assert_eq!(numbers(Why::TimeExceeded, false), (11, 0, 0));
        assert_eq!(numbers(Why::TimeExceeded, true), (3, 0, 0));
        assert_eq!(numbers(Why::PortClosed, true), (1, 4, 0));
        assert_eq!(numbers(Why::Protocol, true), (4, 1, 6)); // the next header field, at byte 6
        let mtu = Why::Reported { kind: 2, code: 0, rest: 1280 };
        assert_eq!(numbers(mtu, true), (2, 0, 1280));
        // About a packet in one family, from an address in the other: nothing.
        assert!(icmp_error(FAR, Why::Unreachable, &syn(GUEST6, FAR6)).is_none());
    }

    #[test]
    fn udp_checksums() {
        for (from, to) in [(FAR, GUEST), (FAR6, GUEST6)] {
            let packet = udp((from, 53).into(), (to, 5353).into(), b"answer").unwrap();
            let ip = Ip::parse(&packet).unwrap();
            let udp = UdpPacket::new_checked(ip.payload).unwrap();
            assert!(udp.verify_checksum(&ip.src.into(), &ip.dst.into()));
            assert_eq!(udp.payload(), b"answer");
        }
    }

    #[test]
    fn echo_replies() {
        let reply = echo_reply(FAR, GUEST, 7, 1, b"ping").unwrap();
        let icmp = Icmpv4Packet::new_checked(&reply[20..]).unwrap();
        assert!(icmp.verify_checksum());
        assert_eq!((u8::from(icmp.msg_type()), icmp.echo_ident(), icmp.echo_seq_no()), (0, 7, 1));

        let reply = echo_reply(FAR6, GUEST6, 7, 1, b"ping").unwrap();
        let (_, icmp) = icmpv6(&reply);
        assert_eq!((icmp.msg_type(), icmp.echo_ident(), icmp.echo_seq_no()), (Icmpv6Message::EchoReply, 7, 1));
        assert_eq!(icmp.payload(), b"ping");
    }

    #[test]
    fn what_the_gateway_reads() {
        let request = [&[128, 0, 0, 0, 0, 9, 0, 3][..], b"hi"].concat();
        let packet = ip(GUEST6, FAR6, IpProtocol::Icmpv6, 1, request.len(), |buf| buf.copy_from_slice(&request)).unwrap();
        let ip = Ip::parse(&packet).unwrap();
        assert_eq!((ip.hop_limit, ip.icmpv6()), (1, Some(Icmpv6Message::EchoRequest)));
        assert_eq!(ip.echo_request(), Some((9, 3, &b"hi"[..])));
        // The same bytes as ICMP for IPv4, in IPv6: not an echo request.
        let odd = ip_packet_with(IpProtocol::Icmp, &request);
        assert_eq!(Ip::parse(&odd).unwrap().echo_request(), None);
        // Extension headers, a fragment's among them: left be.
        assert!(Ip::parse(&ip_packet_with(IpProtocol::Ipv6Frag, &[0; 8])).is_none());
    }

    fn ip_packet_with(protocol: IpProtocol, payload: &[u8]) -> Vec<u8> {
        ip(GUEST6, FAR6, protocol, TTL, payload.len(), |buf| buf.copy_from_slice(payload)).unwrap()
    }

    const ROUTER: Ipv6Addr = Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 2);
    const MAC: EthernetAddress = EthernetAddress([0x52, 0x55, 0x0a, 0x00, 0x02, 0x02]);

    #[test]
    fn router_advertisements() {
        let advert = router_advert(ROUTER, MAC, Duration::from_secs(1800));
        let (ip, icmp) = icmpv6(&advert);
        assert_eq!((ip.src_addr(), ip.dst_addr(), ip.hop_limit()), (ROUTER, IPV6_LINK_LOCAL_ALL_NODES, 255));
        let repr = Icmpv6Repr::parse(&ROUTER, &ip.dst_addr(), &icmp, &checksums()).unwrap();
        let Icmpv6Repr::Ndisc(NdiscRepr::RouterAdvert { router_lifetime, lladdr, flags, prefix_info, .. }) = repr else {
            panic!("not an advertisement: {repr:?}");
        };
        assert_eq!(router_lifetime, smoltcp::time::Duration::from_secs(1800));
        assert_eq!(lladdr, Some(MAC.into()));
        assert_eq!((flags, prefix_info), (NdiscRouterFlags::MANAGED, None)); // DHCPv6, and no prefix
    }

    /// A neighbour solicitation from an upstream router, with this hop limit.
    fn solicitation(target: Ipv6Addr, to: Ipv6Addr, hop_limit: u8) -> Vec<u8> {
        let router = Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 1);
        let solicit = Icmpv6Repr::Ndisc(NdiscRepr::NeighborSolicit { target_addr: target, lladdr: Some(MAC.into()) });
        ip(router.into(), to.into(), IpProtocol::Icmpv6, hop_limit, solicit.buffer_len(), |buf| {
            solicit.emit(&router, &to, &mut Icmpv6Packet::new_unchecked(buf), &checksums())
        })
        .unwrap()
    }

    #[test]
    fn neighbour_discovery_upstream() {
        let ours = Ipv6Addr::new(0x2001, 0xdb8, 1, 2, 1, 0xabcd, 0x1234, 0x5678);
        // Multicast to the address's solicited-node group, or, checking it is
        // still there, unicast to the address itself.
        let (group, group_mac) = solicited_node(ours);
        assert_eq!(group, "ff02::1:ff34:5678".parse::<Ipv6Addr>().unwrap());
        assert_eq!(group_mac, EthernetAddress([0x33, 0x33, 0xff, 0x34, 0x56, 0x78]));
        let asked = neighbor_solicitation(&solicitation(ours, group, 255)).unwrap();
        assert_eq!((asked.target, asked.lladdr), (ours, Some(MAC)));
        assert!(neighbor_solicitation(&solicitation(ours, ours, 255)).is_some());
        assert!(neighbor_solicitation(&solicitation(ours, ours, 64)).is_none()); // it crossed a router: forged
        let mut broken = solicitation(ours, ours, 255);
        *broken.last_mut().unwrap() ^= 1;
        assert!(neighbor_solicitation(&broken).is_none());

        let mine = EthernetAddress([0x00, 0x6c, 0x70, 0x12, 0x1a, 0x36]);
        let advert = neighbor_advert(ours, asked.from, mine, false);
        let (ip, icmp) = icmpv6(&advert);
        assert_eq!((ip.src_addr(), ip.dst_addr(), ip.hop_limit()), (ours, asked.from, 255));
        let repr = Icmpv6Repr::parse(&ours, &asked.from, &icmp, &checksums()).unwrap();
        let Icmpv6Repr::Ndisc(NdiscRepr::NeighborAdvert { flags, target_addr, lladdr }) = repr else {
            panic!("not an advertisement: {repr:?}");
        };
        assert_eq!((target_addr, lladdr), (ours, Some(mine.into())));
        assert_eq!(flags, NdiscNeighborFlags::SOLICITED | NdiscNeighborFlags::OVERRIDE); // and no router

        // The gateway, answering the guest, says it is a router: or the guest
        // takes it for one no longer, and drops its way out.
        let advert = neighbor_advert(ROUTER, asked.from, MAC, true);
        let (_, icmp) = icmpv6(&advert);
        let repr = Icmpv6Repr::parse(&ROUTER, &asked.from, &icmp, &checksums()).unwrap();
        let Icmpv6Repr::Ndisc(NdiscRepr::NeighborAdvert { flags, .. }) = repr else {
            panic!("not an advertisement: {repr:?}");
        };
        let all = NdiscNeighborFlags::ROUTER | NdiscNeighborFlags::SOLICITED | NdiscNeighborFlags::OVERRIDE;
        assert_eq!(flags, all);
    }

    #[test]
    fn arp_answered() {
        let (guest, gateway) = (Ipv4Addr::new(10, 0, 2, 15), Ipv4Addr::new(10, 0, 2, 2));
        let guest_mac = EthernetAddress([0x52, 0x54, 0x00, 0x12, 0x34, 0x56]);
        let request = ArpRepr::EthernetIpv4 {
            operation: ArpOperation::Request,
            source_hardware_addr: guest_mac,
            source_protocol_addr: guest,
            target_hardware_addr: EthernetAddress([0; 6]),
            target_protocol_addr: gateway,
        };
        let mut bytes = vec![0; request.buffer_len()];
        request.emit(&mut ArpPacket::new_unchecked(&mut bytes[..]));
        let asked = arp_request(&bytes).unwrap();
        assert_eq!((asked.from, asked.mac, asked.target), (guest, guest_mac, gateway));

        let frame = arp_reply(&asked, MAC);
        let ethernet = EthernetFrame::new_checked(&frame[..]).unwrap();
        assert_eq!((ethernet.dst_addr(), ethernet.src_addr()), (guest_mac, MAC));
        assert_eq!(ethernet.ethertype(), EthernetProtocol::Arp);
        let reply = ArpRepr::parse(&ArpPacket::new_checked(ethernet.payload()).unwrap()).unwrap();
        let ArpRepr::EthernetIpv4 { operation, source_hardware_addr, source_protocol_addr, target_protocol_addr, .. } =
            reply
        else {
            panic!("not IPv4 over Ethernet: {reply:?}");
        };
        assert_eq!((operation, source_hardware_addr), (ArpOperation::Reply, MAC));
        assert_eq!((source_protocol_addr, target_protocol_addr), (gateway, guest));
        assert!(arp_request(ethernet.payload()).is_none()); // a reply is not a question
    }
}
