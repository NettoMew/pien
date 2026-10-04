//! Packets the gateway makes up itself, outside smoltcp: what comes back from
//! the outside world (UDP, ICMP echo), and the ways a connection fails before
//! it exists (a TCP reset, an ICMP "unreachable").

use std::net::{Ipv4Addr, SocketAddrV4};

use smoltcp::phy::ChecksumCapabilities;
use smoltcp::wire::{
    EthernetAddress, EthernetFrame, EthernetProtocol, EthernetRepr, Icmpv4DstUnreachable, Icmpv4Packet, Icmpv4Repr,
    IpAddress, IpProtocol, Ipv4Packet, Ipv4Repr, TcpControl, TcpPacket, TcpRepr, TcpSeqNumber, UdpPacket, UdpRepr,
};

const TTL: u8 = 64;
const UDP_HEADER: usize = 8;

pub fn ethernet(dst: EthernetAddress, src: EthernetAddress, ip: &[u8]) -> Vec<u8> {
    let repr = EthernetRepr {
        src_addr: src,
        dst_addr: dst,
        ethertype: EthernetProtocol::Ipv4,
    };
    let mut frame = vec![0; repr.buffer_len() + ip.len()];
    let mut ethernet = EthernetFrame::new_unchecked(&mut frame);
    repr.emit(&mut ethernet);
    ethernet.payload_mut().copy_from_slice(ip);
    frame
}

pub fn udp(src: SocketAddrV4, dst: SocketAddrV4, data: &[u8]) -> Vec<u8> {
    let repr = UdpRepr {
        src_port: src.port(),
        dst_port: dst.port(),
    };
    let (from, to) = (IpAddress::Ipv4(*src.ip()), IpAddress::Ipv4(*dst.ip()));
    ipv4(*src.ip(), *dst.ip(), IpProtocol::Udp, UDP_HEADER + data.len(), |buf| {
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

pub fn echo_reply(from: Ipv4Addr, to: Ipv4Addr, ident: u16, seq_no: u16, data: &[u8]) -> Vec<u8> {
    let repr = Icmpv4Repr::EchoReply { ident, seq_no, data };
    ipv4(from, to, IpProtocol::Icmp, repr.buffer_len(), |buf| {
        repr.emit(&mut Icmpv4Packet::new_unchecked(buf), &checksums())
    })
}

/// "Connection refused": a reset answering `syn`, an IPv4 packet with a TCP SYN.
pub fn tcp_reset(syn: &[u8]) -> Option<Vec<u8>> {
    let ip = Ipv4Packet::new_checked(syn).ok()?;
    let tcp = TcpPacket::new_checked(ip.payload()).ok()?;
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
    let (from, to) = (ip.dst_addr(), ip.src_addr());
    Some(ipv4(from, to, IpProtocol::Tcp, repr.buffer_len(), |buf| {
        repr.emit(
            &mut TcpPacket::new_unchecked(buf),
            &from.into(),
            &to.into(),
            &checksums(),
        )
    }))
}

/// `from` telling the guest that `original` will not get through.
pub fn unreachable(from: Ipv4Addr, original: &[u8], reason: Icmpv4DstUnreachable) -> Option<Vec<u8>> {
    icmp_error(from, 3, u8::from(reason), &quote(original)?)
}

pub const TIME_EXCEEDED: u8 = 11;

/// An ICMP error from `from` — "time exceeded" (11), "unreachable" (3) … —
/// quoting the packet it is about, as received (see [`quote`]). traceroute
/// and mtr find their probes again by what is quoted.
pub fn icmp_error(from: Ipv4Addr, kind: u8, code: u8, quote: &[u8]) -> Option<Vec<u8>> {
    // A quote is cut short of the length its header claims: read the source as is.
    let to = Ipv4Addr::from(<[u8; 4]>::try_from(quote.get(12..16)?).ok()?);
    let mut message = vec![kind, code, 0, 0, 0, 0, 0, 0];
    message.extend_from_slice(quote);
    let sum = !checksum(&message);
    message[2..4].copy_from_slice(&sum.to_be_bytes());
    Some(ipv4(from, to, IpProtocol::Icmp, message.len(), |buf| buf.copy_from_slice(&message)))
}

/// What an ICMP error quotes of a packet: its IP header and 8 bytes beyond.
pub fn quote(packet: &[u8]) -> Option<Vec<u8>> {
    let ip = Ipv4Packet::new_checked(packet).ok()?;
    let len = (usize::from(ip.header_len()) + 8).min(packet.len());
    Some(packet[..len].to_vec())
}

/// The one's-complement sum of 16-bit words (RFC 1071), not yet inverted.
fn checksum(data: &[u8]) -> u16 {
    let mut sum: u32 = data.chunks(2).map(|w| u32::from(u16::from_be_bytes([w[0], *w.get(1).unwrap_or(&0)]))).sum();
    while sum > 0xffff {
        sum = (sum & 0xffff) + (sum >> 16);
    }
    sum as u16
}

fn ipv4(src: Ipv4Addr, dst: Ipv4Addr, protocol: IpProtocol, len: usize, emit: impl FnOnce(&mut [u8])) -> Vec<u8> {
    let repr = Ipv4Repr {
        src_addr: src,
        dst_addr: dst,
        next_header: protocol,
        payload_len: len,
        hop_limit: TTL,
    };
    let mut buf = vec![0; repr.buffer_len() + len];
    let mut packet = Ipv4Packet::new_unchecked(&mut buf);
    repr.emit(&mut packet, &checksums());
    emit(packet.payload_mut());
    buf
}

fn checksums() -> ChecksumCapabilities {
    ChecksumCapabilities::default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn syn() -> Vec<u8> {
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
        let (from, to) = (Ipv4Addr::new(10, 0, 2, 15), Ipv4Addr::new(1, 2, 3, 4));
        ipv4(from, to, IpProtocol::Tcp, repr.buffer_len(), |buf| {
            repr.emit(
                &mut TcpPacket::new_unchecked(buf),
                &from.into(),
                &to.into(),
                &checksums(),
            )
        })
    }

    #[test]
    fn resets_answer_the_syn() {
        let reset = tcp_reset(&syn()).unwrap();
        let ip = Ipv4Packet::new_checked(&reset[..]).unwrap();
        assert!(ip.verify_checksum());
        assert_eq!(
            (ip.src_addr(), ip.dst_addr()),
            (Ipv4Addr::new(1, 2, 3, 4), Ipv4Addr::new(10, 0, 2, 15))
        );
        let tcp = TcpPacket::new_checked(ip.payload()).unwrap();
        assert!(tcp.rst() && tcp.ack() && !tcp.syn());
        assert_eq!(
            (tcp.src_port(), tcp.dst_port(), tcp.ack_number()),
            (80, 40000, TcpSeqNumber(1001))
        );
        assert!(tcp.verify_checksum(&ip.src_addr().into(), &ip.dst_addr().into()));
    }

    #[test]
    fn unreachable_quotes_the_original() {
        let original = syn();
        let reply = unreachable(
            Ipv4Addr::new(10, 0, 2, 2),
            &original,
            Icmpv4DstUnreachable::HostProhibited,
        )
        .unwrap();
        let ip = Ipv4Packet::new_checked(&reply[..]).unwrap();
        assert_eq!(ip.dst_addr(), Ipv4Addr::new(10, 0, 2, 15));
        let icmp = Icmpv4Packet::new_checked(ip.payload()).unwrap();
        assert!(icmp.verify_checksum());
        assert_eq!(icmp.msg_code(), 10);
        assert_eq!(&icmp.data()[..20], &original[..20]); // the original IP header comes back
    }

    #[test]
    fn udp_checksums() {
        let packet = udp(
            "1.1.1.1:53".parse().unwrap(),
            "10.0.2.15:5353".parse().unwrap(),
            b"answer",
        );
        let ip = Ipv4Packet::new_checked(&packet[..]).unwrap();
        let udp = UdpPacket::new_checked(ip.payload()).unwrap();
        assert!(udp.verify_checksum(&ip.src_addr().into(), &ip.dst_addr().into()));
        assert_eq!(udp.payload(), b"answer");
    }
}
