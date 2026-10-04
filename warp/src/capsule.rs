//! Capsules (RFC 9297) on the CONNECT stream. WARP sends each IP packet as a
//! DATAGRAM capsule whose payload is the bare packet — without the context ID
//! that RFC 9484 would put in front of it.

pub const DATAGRAM: u64 = 0;

/// Capsules larger than this are not IP packets; give up on the stream.
const MAX_CAPSULE: u64 = 65_535;

pub fn datagram(packet: &[u8], out: &mut Vec<u8>) {
    put_varint(out, DATAGRAM);
    put_varint(out, packet.len() as u64);
    out.extend_from_slice(packet);
}

/// A QUIC variable-length integer (RFC 9000 §16).
pub fn put_varint(out: &mut Vec<u8>, v: u64) {
    match v {
        0..0x40 => out.push(v as u8),
        0x40..0x4000 => out.extend_from_slice(&(v as u16 | 0x4000).to_be_bytes()),
        0x4000..0x4000_0000 => out.extend_from_slice(&(v as u32 | 0x8000_0000).to_be_bytes()),
        _ => out.extend_from_slice(&(v | 0xc000_0000_0000_0000).to_be_bytes()),
    }
}

pub fn varint(buf: &[u8]) -> Option<(u64, usize)> {
    let len = 1 << (buf.first()? >> 6);
    let bytes = buf.get(..len)?;
    let v = bytes[1..]
        .iter()
        .fold(u64::from(bytes[0] & 0x3f), |v, &b| v << 8 | u64::from(b));
    Some((v, len))
}

#[derive(Debug, PartialEq)]
pub struct TooLarge;

/// Reassembles capsules from the bytes of the response body.
#[derive(Default)]
pub struct Reader {
    buf: Vec<u8>,
}

impl Reader {
    /// Takes more of the stream and hands over each complete capsule.
    pub fn read(&mut self, bytes: &[u8], mut each: impl FnMut(u64, &[u8])) -> Result<(), TooLarge> {
        self.buf.extend_from_slice(bytes);
        let mut at = 0;
        while let Some((kind, a)) = varint(&self.buf[at..]) {
            let Some((len, b)) = varint(&self.buf[at + a..]) else {
                break;
            };
            if len > MAX_CAPSULE {
                return Err(TooLarge);
            }
            let start = at + a + b;
            let end = start + len as usize;
            if end > self.buf.len() {
                break;
            }
            each(kind, &self.buf[start..end]);
            at = end;
        }
        self.buf.drain(..at);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn varints_from_rfc_9000() {
        // RFC 9000 Appendix A.1.
        for (bytes, value) in [
            (
                &[0xc2, 0x19, 0x7c, 0x5e, 0xff, 0x14, 0xe8, 0x8c][..],
                151_288_809_941_952_652,
            ),
            (&[0x9d, 0x7f, 0x3e, 0x7d], 494_878_333),
            (&[0x7b, 0xbd], 15_293),
            (&[0x25], 37),
        ] {
            assert_eq!(varint(bytes), Some((value, bytes.len())));
            let mut out = Vec::new();
            put_varint(&mut out, value);
            assert_eq!(out, bytes);
        }
        assert_eq!(varint(&[0x40]), None);
    }

    #[test]
    fn capsules_split_anywhere() {
        let packets: Vec<Vec<u8>> = (0..5).map(|n| vec![n as u8; n * 300 + 1]).collect();
        let mut stream = Vec::new();
        for packet in &packets {
            datagram(packet, &mut stream);
        }
        put_varint(&mut stream, 1); // ADDRESS_ASSIGN, ignored by the caller
        put_varint(&mut stream, 2);
        stream.extend_from_slice(&[0, 0]);

        for chunk in [1, 7, 1000, stream.len()] {
            let mut reader = Reader::default();
            let mut seen = Vec::new();
            for piece in stream.chunks(chunk) {
                reader
                    .read(piece, |kind, payload| seen.push((kind, payload.to_vec())))
                    .unwrap();
            }
            assert_eq!(seen.len(), 6);
            for (got, want) in seen.iter().zip(&packets) {
                assert_eq!(got, &(DATAGRAM, want.clone()));
            }
            assert_eq!(seen[5].0, 1);
        }
    }

    #[test]
    fn refuses_huge_capsules() {
        let mut stream = Vec::new();
        put_varint(&mut stream, DATAGRAM);
        put_varint(&mut stream, 1 << 20);
        assert_eq!(Reader::default().read(&stream, |_, _| {}), Err(TooLarge));
    }
}
