//! HTTP/2 for exactly one request: a CONNECT on stream 1, then capsules both
//! ways until either side gives up.
//!
//! Only `:status` of the response is decoded. Pseudo-header fields come first
//! (RFC 9113 §8.3), and in the first header block of a connection the HPACK
//! dynamic table is still empty, so the first field can always be read alone.

const PREFACE: &[u8] = b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n";

const DATA: u8 = 0x0;
const HEADERS: u8 = 0x1;
const RST_STREAM: u8 = 0x3;
const SETTINGS: u8 = 0x4;
const PING: u8 = 0x6;
const GOAWAY: u8 = 0x7;
const WINDOW_UPDATE: u8 = 0x8;

const END_STREAM: u8 = 0x1;
const ACK: u8 = 0x1;
const END_HEADERS: u8 = 0x4;
const PADDED: u8 = 0x8;
const PRIORITY: u8 = 0x20;

const SETTINGS_ENABLE_PUSH: u16 = 0x2;
const SETTINGS_INITIAL_WINDOW_SIZE: u16 = 0x4;
const SETTINGS_MAX_FRAME_SIZE: u16 = 0x5;

const STREAM: u32 = 1;
/// How much the edge may send before we acknowledge it, per stream and overall.
const WINDOW: u32 = 16 << 20;
/// Our SETTINGS_MAX_FRAME_SIZE, the protocol default.
const MAX_FRAME: usize = 16_384;
const DEFAULT_WINDOW: i64 = 65_535;

#[derive(Debug, PartialEq)]
pub enum Error {
    /// The edge broke the protocol, or answered in a way we cannot read.
    Protocol,
    /// The edge closed the connection (GOAWAY) with this error code.
    GoAway(u32),
    /// The edge reset the stream with this error code.
    Reset(u32),
    /// The edge ended the stream.
    Ended,
}

pub struct H2 {
    /// Bytes to send, in the clear (TLS comes after).
    out: Vec<u8>,
    inbuf: Vec<u8>,
    /// Response body received so far: the capsules.
    body: Vec<u8>,
    status: Option<u16>,
    send_conn: i64,
    send_stream: i64,
    peer_initial: i64,
    peer_max_frame: usize,
    unacked: u32,
    pong: bool,
    pings: u64,
}

impl H2 {
    pub fn connect(authority: &str, headers: &[(&str, &str)]) -> Self {
        let mut h2 = Self {
            out: PREFACE.to_vec(),
            inbuf: Vec::new(),
            body: Vec::new(),
            status: None,
            send_conn: DEFAULT_WINDOW,
            send_stream: DEFAULT_WINDOW,
            peer_initial: DEFAULT_WINDOW,
            peer_max_frame: MAX_FRAME,
            unacked: 0,
            pong: false,
            pings: 0,
        };
        let mut settings = Vec::new();
        for (id, value) in [(SETTINGS_ENABLE_PUSH, 0), (SETTINGS_INITIAL_WINDOW_SIZE, WINDOW)] {
            settings.extend_from_slice(&id.to_be_bytes());
            settings.extend_from_slice(&value.to_be_bytes());
        }
        h2.frame(SETTINGS, 0, 0, &settings);
        h2.frame(WINDOW_UPDATE, 0, 0, &(WINDOW - DEFAULT_WINDOW as u32).to_be_bytes());

        // A plain CONNECT (RFC 9113 §8.5): :method and :authority, no :scheme or :path.
        let mut block = Vec::new();
        literal(&mut block, Name::Static(2), "CONNECT");
        literal(&mut block, Name::Static(1), authority);
        for &(name, value) in headers {
            literal(&mut block, Name::New(name), value);
        }
        h2.frame(HEADERS, END_HEADERS, STREAM, &block);
        h2
    }

    /// The response status, once the edge has answered.
    pub fn status(&self) -> Option<u16> {
        self.status
    }

    pub fn take_output(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.out)
    }

    pub fn take_body(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.body)
    }

    /// Whether a PING was answered since the last call.
    pub fn take_pong(&mut self) -> bool {
        std::mem::take(&mut self.pong)
    }

    pub fn ping(&mut self) {
        self.pings += 1;
        self.frame(PING, 0, 0, &self.pings.to_be_bytes());
    }

    /// Sends request body bytes, or drops them — returning false — when the
    /// tunnel is not up yet or the edge's flow-control window is full. What
    /// travels here are IP packets, which may be dropped.
    pub fn send(&mut self, payload: &[u8]) -> bool {
        let len = payload.len() as i64;
        if self.status != Some(200)
            || len > self.send_conn
            || len > self.send_stream
            || payload.len() > self.peer_max_frame
        {
            return false;
        }
        self.send_conn -= len;
        self.send_stream -= len;
        self.frame(DATA, 0, STREAM, payload);
        true
    }

    pub fn receive(&mut self, bytes: &[u8]) -> Result<(), Error> {
        let mut inbuf = std::mem::take(&mut self.inbuf);
        inbuf.extend_from_slice(bytes);
        let mut at = 0;
        let result = loop {
            let Some(header) = inbuf.get(at..at + 9) else {
                break Ok(());
            };
            let len = u32::from_be_bytes([0, header[0], header[1], header[2]]) as usize;
            if len > MAX_FRAME {
                break Err(Error::Protocol);
            }
            let Some(payload) = inbuf.get(at + 9..at + 9 + len) else {
                break Ok(());
            };
            let stream = u32::from_be_bytes([header[5], header[6], header[7], header[8]]) & 0x7fff_ffff;
            if let Err(e) = self.handle(header[3], header[4], stream, payload) {
                break Err(e);
            }
            at += 9 + len;
        };
        inbuf.drain(..at);
        self.inbuf = inbuf;
        result
    }

    fn handle(&mut self, kind: u8, flags: u8, stream: u32, payload: &[u8]) -> Result<(), Error> {
        match kind {
            DATA => {
                // Flow control counts the whole frame, padding included.
                self.unacked += payload.len() as u32;
                if self.unacked >= WINDOW / 2 {
                    let increment = self.unacked.to_be_bytes();
                    self.frame(WINDOW_UPDATE, 0, 0, &increment);
                    self.frame(WINDOW_UPDATE, 0, STREAM, &increment);
                    self.unacked = 0;
                }
                if stream == STREAM {
                    self.body.extend_from_slice(unpad(flags, payload)?);
                    if flags & END_STREAM != 0 {
                        return Err(Error::Ended);
                    }
                }
            }
            HEADERS if stream == STREAM => {
                if self.status.is_none() {
                    let mut block = unpad(flags, payload)?;
                    if flags & PRIORITY != 0 {
                        block = block.get(5..).ok_or(Error::Protocol)?;
                    }
                    self.status = Some(status(block).ok_or(Error::Protocol)?);
                }
                if flags & END_STREAM != 0 {
                    return Err(Error::Ended);
                }
            }
            SETTINGS if flags & ACK == 0 => {
                if !payload.len().is_multiple_of(6) {
                    return Err(Error::Protocol);
                }
                for setting in payload.chunks(6) {
                    let value = u32::from_be_bytes([setting[2], setting[3], setting[4], setting[5]]);
                    match u16::from_be_bytes([setting[0], setting[1]]) {
                        SETTINGS_INITIAL_WINDOW_SIZE => {
                            self.send_stream += i64::from(value) - self.peer_initial;
                            self.peer_initial = i64::from(value);
                        }
                        SETTINGS_MAX_FRAME_SIZE => self.peer_max_frame = value as usize,
                        _ => {}
                    }
                }
                self.frame(SETTINGS, ACK, 0, &[]);
            }
            PING if flags & ACK == 0 => self.frame(PING, ACK, 0, payload),
            PING => self.pong = true,
            WINDOW_UPDATE => {
                let increment = i64::from(u32::from_be_bytes(word(payload, 0)?) & 0x7fff_ffff);
                match stream {
                    0 => self.send_conn += increment,
                    STREAM => self.send_stream += increment,
                    _ => {}
                }
            }
            RST_STREAM if stream == STREAM => return Err(Error::Reset(u32::from_be_bytes(word(payload, 0)?))),
            GOAWAY => return Err(Error::GoAway(u32::from_be_bytes(word(payload, 4)?))),
            // PRIORITY, CONTINUATION, PUSH_PROMISE (push is off), other streams, unknown types.
            _ => {}
        }
        Ok(())
    }

    fn frame(&mut self, kind: u8, flags: u8, stream: u32, payload: &[u8]) {
        self.out.extend_from_slice(&(payload.len() as u32).to_be_bytes()[1..]);
        self.out.extend_from_slice(&[kind, flags]);
        self.out.extend_from_slice(&stream.to_be_bytes());
        self.out.extend_from_slice(payload);
    }
}

fn word(payload: &[u8], at: usize) -> Result<[u8; 4], Error> {
    payload
        .get(at..at + 4)
        .and_then(|w| w.try_into().ok())
        .ok_or(Error::Protocol)
}

fn unpad(flags: u8, payload: &[u8]) -> Result<&[u8], Error> {
    if flags & PADDED == 0 {
        return Ok(payload);
    }
    let (&pad, rest) = payload.split_first().ok_or(Error::Protocol)?;
    rest.get(..rest.len().checked_sub(pad as usize).ok_or(Error::Protocol)?)
        .ok_or(Error::Protocol)
}

// ─── HPACK, as little as possible ────────────────────────────────────────────

enum Name<'a> {
    Static(u8),
    New(&'a str),
}

/// A literal header field without indexing, never Huffman-coded.
fn literal(block: &mut Vec<u8>, name: Name<'_>, value: &str) {
    match name {
        Name::Static(index) => block.push(index), // fits the 4-bit prefix
        Name::New(name) => {
            block.push(0);
            string(block, name);
        }
    }
    string(block, value);
}

fn string(block: &mut Vec<u8>, s: &str) {
    debug_assert!(s.len() < 127, "longer strings need a multi-byte length");
    block.push(s.len() as u8);
    block.extend_from_slice(s.as_bytes());
}

/// `:status` from the first field of the response's header block.
fn status(mut block: &[u8]) -> Option<u16> {
    // Static table entries 8–14 are `:status` with these values.
    const STATUS: [u16; 7] = [200, 204, 206, 304, 400, 404, 500];
    loop {
        let first = *block.first()?;
        let (index, rest) = match first {
            _ if first & 0x80 != 0 => {
                let (index, _) = integer(block, 7)?;
                return STATUS.get(index.checked_sub(8)?).copied();
            }
            _ if first & 0xe0 == 0x20 => {
                block = integer(block, 5)?.1; // a dynamic table size update
                continue;
            }
            _ if first & 0xc0 == 0x40 => integer(block, 6)?,
            _ => integer(block, 4)?,
        };
        let value = match index {
            0 => {
                let (name, rest) = string_value(rest)?;
                (name == b":status").then_some(())?;
                string_value(rest)?.0
            }
            8..=14 => string_value(rest)?.0,
            _ => return None,
        };
        return match value.as_slice() {
            &[a @ b'1'..=b'5', b @ b'0'..=b'9', c @ b'0'..=b'9'] => {
                Some(u16::from(a - b'0') * 100 + u16::from(b - b'0') * 10 + u16::from(c - b'0'))
            }
            _ => None,
        };
    }
}

/// An HPACK integer with an `n`-bit prefix (RFC 7541 §5.1).
fn integer(buf: &[u8], n: u8) -> Option<(usize, &[u8])> {
    let max = (1usize << n) - 1;
    let mut value = (*buf.first()? as usize) & max;
    let mut rest = &buf[1..];
    if value == max {
        let mut shift = 0;
        loop {
            let (&b, more) = rest.split_first()?;
            rest = more;
            value = value.checked_add(((b & 0x7f) as usize).checked_shl(shift)?)?;
            shift += 7;
            if b & 0x80 == 0 || shift > 28 {
                break;
            }
        }
    }
    Some((value, rest))
}

/// A string literal; Huffman-coded ones may only hold the characters a status
/// line or `:status` name needs.
fn string_value(buf: &[u8]) -> Option<(Vec<u8>, &[u8])> {
    let huffman = *buf.first()? & 0x80 != 0;
    let (len, rest) = integer(buf, 7)?;
    let bytes = rest.get(..len)?;
    let value = if huffman {
        huffman_digits(bytes)?
    } else {
        bytes.to_vec()
    };
    Some((value, &rest[len..]))
}

/// Decodes a Huffman string (RFC 7541 Appendix B) made only of digits.
fn huffman_digits(bytes: &[u8]) -> Option<Vec<u8>> {
    let bits = bytes.len() * 8;
    let bit = |i: usize| bytes[i / 8] >> (7 - i % 8) & 1;
    let take = |at: usize, n: usize| (at..at + n).fold(0u8, |v, i| v << 1 | bit(i));
    let mut out = Vec::new();
    let mut at = 0;
    while bits - at >= 5 {
        let (len, digit) = match take(at, 5) {
            // '0', '1' and '2' have 5-bit codes …
            code @ 0..=2 => (5, b'0' + code),
            // … '3' to '9' are 011001 to 011111.
            0b01100..=0b01111 if bits - at >= 6 => match take(at, 6) {
                code @ 0x19..=0x1f => (6, b'3' + code - 0x19),
                _ => return None,
            },
            0b11111 => break, // padding: the start of EOS
            _ => return None,
        };
        out.push(digit);
        at += len;
    }
    // Whatever is left must be padding: fewer than 8 bits, all ones.
    (bits - at < 8 && (at..bits).all(|i| bit(i) == 1)).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(kind: u8, flags: u8, stream: u32, payload: &[u8]) -> Vec<u8> {
        let mut out = (payload.len() as u32).to_be_bytes()[1..].to_vec();
        out.extend_from_slice(&[kind, flags]);
        out.extend_from_slice(&stream.to_be_bytes());
        out.extend_from_slice(payload);
        out
    }

    fn connected() -> H2 {
        let mut h2 = H2::connect("cloudflareaccess.com:443", &[("cf-connect-proto", "cf-connect-ip")]);
        h2.take_output();
        h2.receive(&frame(HEADERS, END_HEADERS, STREAM, &[0x88])).unwrap();
        h2
    }

    #[test]
    fn request_on_the_wire() {
        let mut h2 = H2::connect("cloudflareaccess.com:443", &[("pq-enabled", "false")]);
        let out = h2.take_output();
        assert!(out.starts_with(PREFACE));
        let mut block = vec![0x02, 7];
        block.extend_from_slice(b"CONNECT");
        block.extend_from_slice(&[0x01, 24]);
        block.extend_from_slice(b"cloudflareaccess.com:443");
        block.extend_from_slice(&[0x00, 10]);
        block.extend_from_slice(b"pq-enabled");
        block.push(5);
        block.extend_from_slice(b"false");
        assert!(out.ends_with(&frame(HEADERS, END_HEADERS, STREAM, &block)));
    }

    #[test]
    fn status_from_rfc_7541() {
        assert_eq!(status(&[0x88]), Some(200));
        assert_eq!(status(&[0x8d]), Some(404));
        // C.5.1: literal with incremental indexing, name 8, "302".
        assert_eq!(status(&[0x48, 0x03, b'3', b'0', b'2', 0x58]), Some(302));
        // C.6.1: the same with Huffman coding.
        assert_eq!(status(&[0x48, 0x82, 0x64, 0x02, 0x58]), Some(302));
        // C.6.2: "307".
        assert_eq!(status(&[0x48, 0x83, 0x64, 0x0e, 0xff]), Some(307));
        // A table size update first, then a literal new name.
        let mut block = vec![0x3f, 0xe1, 0x1f, 0x00, 7];
        block.extend_from_slice(b":status");
        block.extend_from_slice(&[3, b'4', b'2', b'9']);
        assert_eq!(status(&block), Some(429));
        assert_eq!(status(&[0x82]), None); // :method GET is not a status
        assert_eq!(status(&[0x48, 0x82, 0x1c, 0x64]), None); // Huffman letters
    }

    #[test]
    fn settings_ping_and_flow_control() {
        let mut h2 = connected();
        assert_eq!(h2.status(), Some(200));

        let mut settings = Vec::new();
        settings.extend_from_slice(&SETTINGS_INITIAL_WINDOW_SIZE.to_be_bytes());
        settings.extend_from_slice(&100u32.to_be_bytes());
        h2.receive(&frame(SETTINGS, 0, 0, &settings)).unwrap();
        h2.receive(&frame(PING, 0, 0, &[9; 8])).unwrap();
        assert_eq!(
            h2.take_output(),
            [frame(SETTINGS, ACK, 0, &[]), frame(PING, ACK, 0, &[9; 8])].concat()
        );

        // The stream window is now 100 bytes.
        assert!(h2.send(&[1; 60]));
        assert!(!h2.send(&[1; 60]));
        h2.receive(&frame(WINDOW_UPDATE, 0, STREAM, &1000u32.to_be_bytes()))
            .unwrap();
        assert!(h2.send(&[1; 60]));
        assert_eq!(
            h2.take_output(),
            [frame(DATA, 0, STREAM, &[1; 60]), frame(DATA, 0, STREAM, &[1; 60])].concat()
        );
    }

    #[test]
    fn body_split_across_reads() {
        let mut h2 = connected();
        let mut padded = vec![3];
        padded.extend_from_slice(b"capsules");
        padded.extend_from_slice(&[0; 3]);
        let bytes = [frame(DATA, 0, STREAM, b"hello "), frame(DATA, PADDED, STREAM, &padded)].concat();
        for piece in bytes.chunks(5) {
            h2.receive(piece).unwrap();
        }
        assert_eq!(h2.take_body(), b"hello capsules");
    }

    #[test]
    fn acknowledges_what_it_reads() {
        let mut h2 = connected();
        let chunk = vec![0; MAX_FRAME];
        for _ in 0..(WINDOW as usize / 2 / MAX_FRAME) {
            h2.receive(&frame(DATA, 0, STREAM, &chunk)).unwrap();
        }
        let increment = (WINDOW / 2).to_be_bytes();
        assert_eq!(
            h2.take_output(),
            [
                frame(WINDOW_UPDATE, 0, 0, &increment),
                frame(WINDOW_UPDATE, 0, STREAM, &increment)
            ]
            .concat()
        );
    }

    #[test]
    fn endings() {
        let mut h2 = H2::connect("a:443", &[]);
        assert!(!h2.send(b"too early"));
        assert_eq!(
            h2.receive(&frame(HEADERS, END_HEADERS | END_STREAM, STREAM, &[0x8d])),
            Err(Error::Ended)
        );
        assert_eq!(h2.status(), Some(404));
        assert_eq!(
            connected().receive(&frame(RST_STREAM, 0, STREAM, &[0, 0, 0, 8])),
            Err(Error::Reset(8))
        );
        assert_eq!(
            connected().receive(&frame(GOAWAY, 0, 0, &[0, 0, 0, 1, 0, 0, 0, 2])),
            Err(Error::GoAway(2))
        );
        assert_eq!(
            connected().receive(&frame(DATA, 0, STREAM, &vec![0; MAX_FRAME + 1])),
            Err(Error::Protocol)
        );
    }
}
