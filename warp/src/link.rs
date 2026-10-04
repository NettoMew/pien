//! The guest's Ethernet on one side, bare IP packets on the other. Everything
//! the guest can reach lies behind one gateway, so every ARP question gets the
//! same answer and every frame just loses or gains its Ethernet header.

/// The gateway's MAC address, locally administered: 02 "warp" 01.
pub const GATEWAY: [u8; 6] = [0x02, b'w', b'a', b'r', b'p', 0x01];

const IPV4: [u8; 2] = [0x08, 0x00];
const ARP: [u8; 2] = [0x08, 0x06];
const IPV6: [u8; 2] = [0x86, 0xdd];

/// What became of a frame the guest sent.
pub enum Outgoing<'a> {
    /// An IP packet for the tunnel.
    Packet(&'a [u8]),
    /// A frame to hand straight back (an ARP reply).
    Reply(Vec<u8>),
    Ignore,
}

#[derive(Default)]
pub struct Link {
    /// Learned from the guest's first frame.
    guest: Option<[u8; 6]>,
}

impl Link {
    pub fn outgoing<'a>(&mut self, frame: &'a [u8]) -> Outgoing<'a> {
        let Some(header) = frame.get(..14) else {
            return Outgoing::Ignore;
        };
        let source: [u8; 6] = header[6..12].try_into().unwrap();
        self.guest = Some(source);
        let payload = &frame[14..];
        match [header[12], header[13]] {
            // Trust the IP header's length over the frame's: frames may be padded.
            IPV4 => match payload.get(2..4).map(|l| u16::from_be_bytes([l[0], l[1]]) as usize) {
                Some(len) if len >= 20 => payload.get(..len).map_or(Outgoing::Ignore, Outgoing::Packet),
                _ => Outgoing::Ignore,
            },
            ARP => arp_reply(source, payload).map_or(Outgoing::Ignore, Outgoing::Reply),
            _ => Outgoing::Ignore,
        }
    }

    pub fn incoming(&self, packet: &[u8]) -> Option<Vec<u8>> {
        let kind = match packet.first()? >> 4 {
            4 => IPV4,
            6 => IPV6,
            _ => return None,
        };
        let mut frame = Vec::with_capacity(14 + packet.len());
        frame.extend_from_slice(&self.guest?);
        frame.extend_from_slice(&GATEWAY);
        frame.extend_from_slice(&kind);
        frame.extend_from_slice(packet);
        Some(frame)
    }
}

/// Answers "who has <address>?" with the gateway, for any address but the
/// asker's own (and probes, which come from 0.0.0.0).
fn arp_reply(asker: [u8; 6], arp: &[u8]) -> Option<Vec<u8>> {
    // Ethernet, IPv4, 6-byte and 4-byte addresses, a request.
    let arp = arp.get(..28)?;
    if arp[..8] != [0, 1, 8, 0, 6, 4, 0, 1] {
        return None;
    }
    let (sender, target) = (&arp[14..18], &arp[24..28]);
    if sender == [0; 4] || sender == target {
        return None;
    }
    let mut reply = Vec::with_capacity(42);
    reply.extend_from_slice(&asker);
    reply.extend_from_slice(&GATEWAY);
    reply.extend_from_slice(&ARP);
    reply.extend_from_slice(&[0, 1, 8, 0, 6, 4, 0, 2]);
    reply.extend_from_slice(&GATEWAY);
    reply.extend_from_slice(target);
    reply.extend_from_slice(&asker);
    reply.extend_from_slice(sender);
    Some(reply)
}

#[cfg(test)]
mod tests {
    use super::*;

    const GUEST: [u8; 6] = [0x52, 0x54, 0, 0x12, 0x34, 0x56];

    fn frame(kind: [u8; 2], payload: &[u8]) -> Vec<u8> {
        [&[0xff; 6][..], &GUEST, &kind, payload].concat()
    }

    fn arp_request(sender: [u8; 4], target: [u8; 4]) -> Vec<u8> {
        frame(
            ARP,
            &[&[0, 1, 8, 0, 6, 4, 0, 1][..], &GUEST, &sender, &[0; 6], &target].concat(),
        )
    }

    #[test]
    fn answers_arp_for_the_gateway() {
        let mut link = Link::default();
        let Outgoing::Reply(reply) = link.outgoing(&arp_request([172, 16, 0, 2], [172, 16, 0, 1])) else {
            panic!("no reply");
        };
        assert_eq!(&reply[..6], &GUEST);
        assert_eq!(&reply[20..22], &[0, 2]); // a reply
        assert_eq!(&reply[22..28], &GATEWAY);
        assert_eq!(&reply[28..32], &[172, 16, 0, 1]);
        assert_eq!(&reply[38..42], &[172, 16, 0, 2]);

        assert!(matches!(
            link.outgoing(&arp_request([0; 4], [172, 16, 0, 2])),
            Outgoing::Ignore
        ));
        assert!(matches!(
            link.outgoing(&arp_request([172, 16, 0, 2], [172, 16, 0, 2])),
            Outgoing::Ignore
        ));
    }

    #[test]
    fn packets_lose_and_gain_ethernet() {
        let mut link = Link::default();
        let mut packet = vec![0x45, 0, 0, 24];
        packet.resize(24, 7);
        assert!(link.incoming(&packet).is_none(), "the guest's address is not known yet");

        let mut padded = packet.clone();
        padded.resize(46, 0);
        let padded = frame(IPV4, &padded);
        let Outgoing::Packet(out) = link.outgoing(&padded) else {
            panic!("dropped")
        };
        assert_eq!(out, packet);

        let back = link.incoming(&packet).unwrap();
        assert_eq!(back, [&GUEST[..], &GATEWAY, &IPV4, &packet].concat());
        assert!(matches!(link.outgoing(&frame(IPV6, &[0x60; 40])), Outgoing::Ignore));
        assert!(matches!(
            link.outgoing(&frame(IPV4, &[0x45, 0, 0, 99])),
            Outgoing::Ignore
        ));
    }
}
