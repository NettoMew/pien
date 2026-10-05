//! The channel inside the WebSocket, so that only the page and the relay see
//! the guest's frames — not the TLS terminator in front, nor its logs.
//!
//! ```text
//! page → relay   "GHR1" ‖ page nonce (16) ‖ page P-256 key (65, uncompressed)
//!            or  "GHR2" ‖ page nonce (16) ‖ page P-256 key (65) ‖ login token (57)
//! relay → page   relay nonce (16) ‖ relay P-256 key (65)
//! keys           HKDF-SHA256(ikm  = key ‖ ECDH x-coordinate,
//!                            salt = page nonce ‖ relay nonce,
//!                            info = "guest@home relay v1") → page→relay ‖ relay→page
//! then           every message AES-256-GCM, nonce = 4 zero bytes ‖ 64-bit counter
//!                page's first: "hello"; relay's first: "welcome"; after that, one
//!                Ethernet frame each
//! ```
//!
//! `key` is one of two (see [`Keys`]). A relay someone runs for themselves
//! has a random key of its own, which they paste into the page once: GHR1.
//! The site's relay takes the site's login instead: the page sends its token,
//! and both ends open the channel with the key that belongs to it (token.rs):
//! GHR2. Either way the key itself never travels. The ephemeral ECDH gives
//! forward secrecy; the fresh nonces on both sides keep old messages from
//! being replayed. All of it is what WebCrypto offers, so the page needs no
//! code of its own.

use aes_gcm::aead::{Aead, Nonce};
use aes_gcm::{Aes256Gcm, KeyInit};
use hkdf::Hkdf;
use p256::elliptic_curve::sec1::ToSec1Point;
use sha2::Sha256;

use crate::token;

/// A hello with the relay's own key.
pub const MAGIC: &[u8; 4] = b"GHR1";
/// A hello with the site's login token.
pub const MAGIC_TOKEN: &[u8; 4] = b"GHR2";
const NONCE: usize = 16;
const POINT: usize = 65;
pub const REPLY_LEN: usize = NONCE + POINT;
// The protocol keeps the name the machine had when it was written: these
// labels go into every key, so changing them would turn every key away.
const INFO: &[u8] = b"guest@home relay v1";
pub const HELLO: &[u8] = b"hello";
pub const WELCOME: &[u8] = b"welcome";

/// What a relay opens channels with: a key of its own, the site's session
/// key (to check login tokens with), or both.
#[derive(Clone, Copy, Default)]
pub struct Keys {
    pub own: Option<[u8; 32]>,
    pub session: Option<[u8; 32]>,
}

impl Keys {
    /// The key `hello` asks the channel to open with, and its nonce and point;
    /// `now` is in Unix seconds, for the token's expiry.
    fn of<'a>(&self, hello: &'a [u8], now: u64) -> Option<([u8; 32], &'a [u8])> {
        if let Some(rest) = hello.strip_prefix(MAGIC.as_slice()) {
            return Some((self.own?, rest));
        }
        let (rest, token) = hello.strip_prefix(MAGIC_TOKEN.as_slice())?.split_at_checked(NONCE + POINT)?;
        Some((token::channel_key(&self.session?, token, now)?, rest))
    }
}

/// Seals messages in one direction.
pub struct Sealer {
    cipher: Aes256Gcm,
    counter: u64,
}

/// Opens messages from the other direction, in order.
pub struct Opener {
    cipher: Aes256Gcm,
    counter: u64,
}

impl Sealer {
    pub fn seal(&mut self, plaintext: &[u8]) -> Vec<u8> {
        let nonce = nonce(&mut self.counter);
        self.cipher
            .encrypt(&nonce, plaintext)
            .expect("AES-GCM takes any length we send")
    }
}

impl Opener {
    pub fn open(&mut self, sealed: &[u8]) -> Option<Vec<u8>> {
        let nonce = nonce(&mut self.counter);
        self.cipher.decrypt(&nonce, sealed).ok()
    }
}

fn nonce(counter: &mut u64) -> Nonce<Aes256Gcm> {
    let mut nonce = [0; 12];
    nonce[4..].copy_from_slice(&counter.to_be_bytes());
    *counter += 1;
    nonce.into()
}

fn ciphers(key: &[u8; 32], shared: &[u8], client_nonce: &[u8], server_nonce: &[u8]) -> (Aes256Gcm, Aes256Gcm) {
    let ikm = [&key[..], shared].concat();
    let salt = [client_nonce, server_nonce].concat();
    let mut okm = [0; 64];
    Hkdf::<Sha256>::new(Some(&salt), &ikm)
        .expand(INFO, &mut okm)
        .expect("64 bytes is a valid length");
    let cipher = |k: &[u8]| Aes256Gcm::new_from_slice(k).expect("32-byte key");
    (cipher(&okm[..32]), cipher(&okm[32..]))
}

struct Ephemeral {
    secret: p256::NonZeroScalar,
    public: [u8; POINT],
}

impl Ephemeral {
    fn new() -> Self {
        let secret = loop {
            let mut bytes = [0; 32];
            getrandom::fill(&mut bytes).expect("the OS has randomness");
            if let Ok(key) = p256::SecretKey::from_slice(&bytes) {
                break key.to_nonzero_scalar();
            }
        };
        let public = p256::PublicKey::from_secret_scalar(&secret).to_sec1_point(false);
        Self {
            secret,
            public: public.as_bytes().try_into().expect("65-byte point"),
        }
    }

    fn agree(&self, peer: &[u8]) -> Option<[u8; 32]> {
        let peer = p256::PublicKey::from_sec1_bytes(peer).ok()?;
        let shared = p256::ecdh::diffie_hellman(self.secret, peer.as_affine());
        Some((*shared.raw_secret_bytes()).into())
    }
}

fn random_nonce() -> [u8; NONCE] {
    let mut nonce = [0; NONCE];
    getrandom::fill(&mut nonce).expect("the OS has randomness");
    nonce
}

/// The relay's half of the handshake, at `now` (Unix seconds): the reply to
/// send, then the opener for the page's messages and the sealer for ours.
/// `None` if `hello` is not one, or asks for a key the relay does not take.
pub fn accept(keys: &Keys, hello: &[u8], now: u64) -> Option<(Vec<u8>, Opener, Sealer)> {
    let (key, rest) = keys.of(hello, now)?;
    let (client_nonce, client_point) = (rest.len() == NONCE + POINT).then(|| rest.split_at(NONCE))?;
    let ephemeral = Ephemeral::new();
    let shared = ephemeral.agree(client_point)?;
    let server_nonce = random_nonce();
    let (from_client, to_client) = ciphers(&key, &shared, client_nonce, &server_nonce);
    let reply = [&server_nonce[..], &ephemeral.public].concat();
    Some((
        reply,
        Opener {
            cipher: from_client,
            counter: 0,
        },
        Sealer {
            cipher: to_client,
            counter: 0,
        },
    ))
}

/// The page's half, for tests and tools: the hello to send, and what to do
/// with the reply.
pub struct Connecting {
    ephemeral: Ephemeral,
    nonce: [u8; NONCE],
}

impl Connecting {
    /// A hello for a relay's own key.
    pub fn new() -> (Vec<u8>, Self) {
        Self::hello(MAGIC, &[])
    }

    /// A hello with the site's login token; the channel then opens with the
    /// key that belongs to it.
    pub fn with_token(token: &[u8]) -> (Vec<u8>, Self) {
        Self::hello(MAGIC_TOKEN, token)
    }

    fn hello(magic: &[u8; 4], token: &[u8]) -> (Vec<u8>, Self) {
        let (ephemeral, nonce) = (Ephemeral::new(), random_nonce());
        let hello = [&magic[..], &nonce, &ephemeral.public, token].concat();
        (hello, Self { ephemeral, nonce })
    }

    /// The sealer for our messages and the opener for the relay's.
    pub fn finish(self, key: &[u8; 32], reply: &[u8]) -> Option<(Sealer, Opener)> {
        let (server_nonce, server_point) = (reply.len() == REPLY_LEN).then(|| reply.split_at(NONCE))?;
        let shared = self.ephemeral.agree(server_point)?;
        let (to_server, from_server) = ciphers(key, &shared, &self.nonce, server_nonce);
        Some((
            Sealer {
                cipher: to_server,
                counter: 0,
            },
            Opener {
                cipher: from_server,
                counter: 0,
            },
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_790_000_000;
    const OWN: Keys = Keys { own: Some([7; 32]), session: None };

    /// Both halves, through to the welcome; the page's sealer and opener.
    fn open(keys: &Keys, (hello, connecting): (Vec<u8>, Connecting), key: &[u8; 32]) -> Option<(Sealer, Opener)> {
        let (reply, mut relay_opens, mut relay_seals) = accept(keys, &hello, NOW)?;
        let (mut page_seals, mut page_opens) = connecting.finish(key, &reply)?;
        (relay_opens.open(&page_seals.seal(HELLO))? == HELLO).then_some(())?;
        (page_opens.open(&relay_seals.seal(WELCOME))? == WELCOME).then_some((page_seals, page_opens))
    }

    #[test]
    fn both_halves_agree() {
        let key = [7; 32];
        let (hello, connecting) = Connecting::new();
        let (reply, mut relay_opens, mut relay_seals) = accept(&OWN, &hello, NOW).unwrap();
        let (mut page_seals, mut page_opens) = connecting.finish(&key, &reply).unwrap();

        assert_eq!(relay_opens.open(&page_seals.seal(HELLO)).as_deref(), Some(HELLO));
        assert_eq!(page_opens.open(&relay_seals.seal(WELCOME)).as_deref(), Some(WELCOME));
        for frame in [&b"one"[..], &[0; 1514], b""] {
            assert_eq!(relay_opens.open(&page_seals.seal(frame)).as_deref(), Some(frame));
        }
    }

    #[test]
    fn a_wrong_key_opens_nothing() {
        assert!(open(&OWN, Connecting::new(), &[2; 32]).is_none());
    }

    #[test]
    fn a_token_opens_with_its_own_key() {
        let session = [3; 32];
        let site = Keys { own: None, session: Some(session) };
        let token = token::issue(&session, NOW + 60, [1; 16]);
        let key = token::channel_key(&session, &token, NOW).unwrap();
        assert!(open(&site, Connecting::with_token(&token), &key).is_some());
        assert!(open(&site, Connecting::with_token(&token), &session).is_none()); // not the session key itself

        let expired = token::issue(&session, NOW, [1; 16]);
        assert!(accept(&site, &Connecting::with_token(&expired).0, NOW).is_none());
        let forged = token::issue(&[4; 32], NOW + 60, [1; 16]);
        assert!(accept(&site, &Connecting::with_token(&forged).0, NOW).is_none());
    }

    #[test]
    fn a_relay_takes_only_the_keys_it_has() {
        let session = [3; 32];
        let token = token::issue(&session, NOW + 60, [1; 16]);
        assert!(accept(&OWN, &Connecting::with_token(&token).0, NOW).is_none());
        assert!(accept(&Keys { own: None, session: Some(session) }, &Connecting::new().0, NOW).is_none());
        let both = Keys { own: Some([7; 32]), session: Some(session) };
        assert!(accept(&both, &Connecting::new().0, NOW).is_some());
        assert!(accept(&both, &Connecting::with_token(&token).0, NOW).is_some());
    }

    #[test]
    fn replays_and_reorders_fail() {
        let key = [7; 32];
        let (hello, connecting) = Connecting::new();
        let (reply, mut opens, _) = accept(&OWN, &hello, NOW).unwrap();
        let (mut seals, _) = connecting.finish(&key, &reply).unwrap();
        let (first, second) = (seals.seal(b"1"), seals.seal(b"2"));
        assert_eq!(opens.open(&second), None); // out of order
        let (hello, connecting) = Connecting::new();
        let (reply, mut opens, _) = accept(&OWN, &hello, NOW).unwrap();
        let _ = connecting.finish(&key, &reply);
        assert_eq!(opens.open(&first), None); // from another session
    }

    #[test]
    fn rejects_what_is_not_a_hello() {
        assert!(accept(&OWN, b"GET / HTTP/1.1", NOW).is_none());
        assert!(accept(&OWN, &[&MAGIC[..], &[0; NONCE + POINT]].concat(), NOW).is_none()); // not a point
        assert!(accept(&OWN, &[&Connecting::new().0[..], &[0]].concat(), NOW).is_none()); // a byte too many
    }
}
