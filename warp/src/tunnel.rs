//! One tunnel, all layers: guest frames ⇄ IP packets ⇄ capsules ⇄ HTTP/2 ⇄
//! TLS ⇄ bytes for the socket. Nothing here does I/O; the caller moves bytes
//! in, then drains what is ready to go out.

use rustls::client::UnbufferedClientConnection;
use rustls::unbuffered::{AppDataRecord, ConnectionState, EncodeError, EncryptError, UnbufferedStatus};

use crate::h2::{self, H2};
use crate::link::{Link, Outgoing};
use crate::{capsule, cert, tls};

/// What the official client asks for, over HTTP/2.
const AUTHORITY: &str = "cloudflareaccess.com:443";
const HEADERS: &[(&str, &str)] = &[("cf-connect-proto", "cf-connect-ip"), ("pq-enabled", "false")];

/// Pings unanswered after this many ticks mean the edge is gone.
const PATIENCE: u8 = 3;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Event {
    Up,
    Down(Down),
}

/// Why a tunnel went down.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Down {
    /// The TLS handshake failed, with the alert the edge sent (0 if none).
    /// Alert 49, access denied, means the device is not registered (any more).
    Tls(u8),
    /// The edge's key is not the one from registration.
    Pin,
    /// The edge answered the CONNECT with this status.
    Refused(u16),
    /// The edge sent GOAWAY with this error code.
    GoAway(u32),
    /// The edge reset the stream with this error code.
    Reset(u32),
    /// The edge stopped answering pings.
    Timeout,
    /// The connection ended: the edge hung up, or we closed it.
    Closed,
    /// The edge broke HTTP/2 or the capsule framing.
    Protocol,
}

impl Event {
    /// (kind, code, detail) for the page.
    pub fn encode(self) -> (u32, u32, u32) {
        match self {
            Event::Up => (1, 0, 0),
            Event::Down(down) => match down {
                Down::Tls(alert) => (2, 1, alert.into()),
                Down::Pin => (2, 2, 0),
                Down::Refused(status) => (2, 3, status.into()),
                Down::GoAway(code) => (2, 4, code),
                Down::Reset(code) => (2, 5, code),
                Down::Timeout => (2, 6, 0),
                Down::Closed => (2, 7, 0),
                Down::Protocol => (2, 8, 0),
            },
        }
    }
}

pub struct Tunnel {
    tls: UnbufferedClientConnection,
    /// TLS bytes from the edge not yet consumed.
    received: Vec<u8>,
    h2: H2,
    capsules: capsule::Reader,
    link: Link,
    up: bool,
    down: bool,
    closing: bool,
    unanswered: u8,
    /// TLS bytes for the edge.
    socket: Vec<u8>,
    /// Ethernet frames for the guest.
    guest: Vec<Vec<u8>>,
    events: Vec<Event>,
}

impl Tunnel {
    /// Starts the TLS handshake; the CONNECT follows as soon as it is done.
    /// `secret` is the device's P-256 private key, `edge` the
    /// SubjectPublicKeyInfo the edge was given at registration.
    pub fn open(secret: &[u8; 32], edge: &[u8]) -> Option<Self> {
        let mut tunnel = Self {
            tls: tls::connect(secret, cert::spki_point(edge)?).ok()?,
            received: Vec::new(),
            h2: H2::connect(AUTHORITY, HEADERS),
            capsules: capsule::Reader::default(),
            link: Link::default(),
            up: false,
            down: false,
            closing: false,
            unanswered: 0,
            socket: Vec::new(),
            guest: Vec::new(),
            events: Vec::new(),
        };
        tunnel.pump();
        Some(tunnel)
    }

    /// Takes what is ready: bytes for the socket, frames for the guest, and
    /// what happened.
    pub fn drain(&mut self) -> (Vec<u8>, Vec<Vec<u8>>, Vec<Event>) {
        let socket = std::mem::take(&mut self.socket);
        (
            socket,
            std::mem::take(&mut self.guest),
            std::mem::take(&mut self.events),
        )
    }

    pub fn from_socket(&mut self, bytes: &[u8]) {
        self.received.extend_from_slice(bytes);
        self.pump();
    }

    pub fn from_guest(&mut self, frame: &[u8]) {
        match self.link.outgoing(frame) {
            Outgoing::Packet(packet) if self.up && !self.down => {
                let mut datagram = Vec::with_capacity(packet.len() + 4);
                capsule::datagram(packet, &mut datagram);
                self.h2.send(&datagram); // or dropped, as IP allows
                self.pump();
            }
            Outgoing::Reply(reply) => self.guest.push(reply),
            _ => {}
        }
    }

    /// Call every ten seconds or so: keeps the connection alive, and notices
    /// when the edge has gone quiet.
    pub fn tick(&mut self) {
        if !self.up || self.down {
            return;
        }
        if self.unanswered >= PATIENCE {
            return self.fail(Down::Timeout);
        }
        self.unanswered += 1;
        self.h2.ping();
        self.pump();
    }

    pub fn close(&mut self) {
        self.closing = true;
        self.pump();
        self.fail(Down::Closed);
    }

    /// Runs TLS until it needs more from the edge: handshake messages out,
    /// records in, our HTTP/2 bytes out once the handshake is done.
    fn pump(&mut self) {
        while !self.down {
            let mut plaintext = Vec::new();
            let mut failure = None;
            let mut wait = false;

            let UnbufferedStatus { mut discard, state } = self.tls.process_tls_records(&mut self.received);
            match state {
                Ok(ConnectionState::ReadTraffic(mut records)) => {
                    while let Some(record) = records.next_record() {
                        match record {
                            Ok(AppDataRecord { discard: more, payload }) => {
                                discard += more;
                                plaintext.extend_from_slice(payload);
                            }
                            Err(_) => failure = Some(Down::Protocol),
                        }
                    }
                }
                Ok(ConnectionState::EncodeTlsData(mut handshake)) => {
                    let encoded = append(&mut self.socket, |out| match handshake.encode(out) {
                        Err(EncodeError::InsufficientSize(need)) => Err(Some(need.required_size)),
                        result => result.map_err(|_| None),
                    });
                    if !encoded {
                        failure = Some(Down::Tls(0));
                    }
                }
                Ok(ConnectionState::TransmitTlsData(transmit)) => transmit.done(), // `socket` keeps the order
                Ok(ConnectionState::WriteTraffic(mut traffic)) => {
                    let out = self.h2.take_output();
                    let mut sent =
                        out.is_empty() || append(&mut self.socket, |buf| encrypted(traffic.encrypt(&out, buf)));
                    if self.closing {
                        sent &= append(&mut self.socket, |buf| encrypted(traffic.queue_close_notify(buf)));
                    }
                    if !sent {
                        failure = Some(Down::Protocol);
                    }
                    wait = true;
                }
                Ok(ConnectionState::PeerClosed | ConnectionState::Closed) => failure = Some(Down::Closed),
                Ok(_) => wait = true, // BlockedHandshake: the edge has to speak first
                Err(error) => {
                    failure = Some(match error {
                        rustls::Error::InvalidCertificate(_) => Down::Pin,
                        rustls::Error::AlertReceived(alert) => Down::Tls(alert.into()),
                        _ => Down::Tls(0),
                    })
                }
            }
            self.received.drain(..discard);

            if !plaintext.is_empty() {
                let result = self.h2.receive(&plaintext);
                self.after_h2(result);
            }
            if let Some(why) = failure {
                return self.fail(why);
            }
            if wait {
                return;
            }
        }
    }

    fn after_h2(&mut self, result: Result<(), h2::Error>) {
        match self.h2.status() {
            Some(200) if !self.up => {
                self.up = true;
                self.events.push(Event::Up);
            }
            Some(status) if status != 200 => return self.fail(Down::Refused(status)),
            _ => {}
        }
        if self.h2.take_pong() {
            self.unanswered = 0;
        }

        let body = self.h2.take_body();
        let (link, guest) = (&self.link, &mut self.guest);
        let read = self.capsules.read(&body, |kind, packet| {
            if kind == capsule::DATAGRAM {
                guest.extend(link.incoming(packet));
            }
        });
        if read.is_err() {
            return self.fail(Down::Protocol);
        }

        if let Err(error) = result {
            self.fail(match error {
                h2::Error::Protocol => Down::Protocol,
                h2::Error::GoAway(code) => Down::GoAway(code),
                h2::Error::Reset(code) => Down::Reset(code),
                h2::Error::Ended => Down::Closed,
            });
        }
    }

    fn fail(&mut self, why: Down) {
        if !self.down {
            self.down = true;
            self.events.push(Event::Down(why));
        }
    }
}

/// Lets rustls write onto the end of `out`, making room as it asks: `write`
/// fails with the size it needs, or with `None` if room is not the problem.
fn append(out: &mut Vec<u8>, mut write: impl FnMut(&mut [u8]) -> Result<usize, Option<usize>>) -> bool {
    let start = out.len();
    let mut room = 4096;
    loop {
        out.resize(start + room, 0);
        match write(&mut out[start..]) {
            Ok(written) => {
                out.truncate(start + written);
                return true;
            }
            Err(Some(needed)) if needed > room => room = needed,
            Err(_) => {
                out.truncate(start);
                return false;
            }
        }
    }
}

fn encrypted(result: Result<usize, EncryptError>) -> Result<usize, Option<usize>> {
    match result {
        Err(EncryptError::InsufficientSize(need)) => Err(Some(need.required_size)),
        result => result.map_err(|_| None),
    }
}
