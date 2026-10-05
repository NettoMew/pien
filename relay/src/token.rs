//! The site's login tokens, as press issues them (press/src/tokens.ts). The
//! relay checks one itself, with the session key it shares with press, and
//! asks no one: a token is good until it expires, and no list of them exists
//! anywhere.
//!
//! ```text
//! body      version 1 (1) ‖ expiry, Unix seconds (8, big-endian) ‖ id (16, random)
//! token     body ‖ HMAC-SHA256(session key, "guest@home session v1" ‖ body)
//! channel   HMAC-SHA256(session key, "guest@home channel v1" ‖ body)
//! ```
//!
//! The channel key is what the page and the relay open the channel with
//! (channel.rs). Press hands it to the page at login, beside the token; the
//! relay derives it from the token. Whoever only saw a token pass by, in a
//! log say, holds nothing that opens a channel.

use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

const VERSION: u8 = 1;
const BODY: usize = 1 + 8 + 16;
/// A token's length in bytes.
pub const LEN: usize = BODY + 32;
const SESSION: &[u8] = b"guest@home session v1";
const CHANNEL: &[u8] = b"guest@home channel v1";

fn mac(key: &[u8; 32], label: &[u8], body: &[u8]) -> Hmac<Sha256> {
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(key).expect("HMAC takes any key length");
    mac.update(label);
    mac.update(body);
    mac
}

/// The channel key for `token`, if the session key made it and it is not
/// past its expiry at `now` (Unix seconds).
pub fn channel_key(session_key: &[u8; 32], token: &[u8], now: u64) -> Option<[u8; 32]> {
    let (body, tag) = (token.len() == LEN).then(|| token.split_at(BODY))?;
    mac(session_key, SESSION, body).verify_slice(tag).ok()?;
    let expiry = u64::from_be_bytes(body[1..9].try_into().expect("8 bytes"));
    (body[0] == VERSION && now < expiry).then(|| mac(session_key, CHANNEL, body).finalize().into_bytes().into())
}

/// A token good until `expiry`, as press makes one: for tests and tools.
pub fn issue(session_key: &[u8; 32], expiry: u64, id: [u8; 16]) -> [u8; LEN] {
    let body = [&[VERSION][..], &expiry.to_be_bytes(), &id].concat();
    let tag = mac(session_key, SESSION, &body).finalize().into_bytes();
    [&body[..], &tag].concat().try_into().expect("a token's length")
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: [u8; 32] = [0x5a; 32];
    const NOW: u64 = 1_790_000_000;

    #[test]
    fn a_token_opens_until_it_expires() {
        let token = issue(&KEY, NOW + 60, [9; 16]);
        let channel = channel_key(&KEY, &token, NOW).expect("a good token");
        assert_eq!(channel_key(&KEY, &token, NOW + 59), Some(channel));
        assert_eq!(channel_key(&KEY, &token, NOW + 60), None);
        assert_ne!(channel_key(&KEY, &issue(&KEY, NOW + 60, [8; 16]), NOW), Some(channel)); // each its own
    }

    #[test]
    fn only_the_session_key_makes_one() {
        let token = issue(&KEY, NOW + 60, [9; 16]);
        assert_eq!(channel_key(&[0x5b; 32], &token, NOW), None);
        for at in [0, 1, 9, 24, 25, LEN - 1] {
            let mut forged = token;
            forged[at] ^= 1;
            assert_eq!(channel_key(&KEY, &forged, NOW), None, "byte {at} changed");
        }
        assert_eq!(channel_key(&KEY, &token[1..], NOW), None);
    }

    /// The same vector press checks (press/test/tokens.test.ts): the two must agree.
    #[test]
    fn agrees_with_press() {
        let key: [u8; 32] = std::array::from_fn(|i| i as u8);
        let token = issue(&key, 2_000_000_000, std::array::from_fn(|i| 0xa0 + i as u8));
        let hex = |bytes: &[u8]| bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
        assert_eq!(
            hex(&token),
            concat!(
                "01",
                "0000000077359400",
                "a0a1a2a3a4a5a6a7a8a9aaabacadaeaf",
                "cab540784ee16f9fa56bac71966d409539bc2097cc148c8fd6a108590de1c127"
            )
        );
        let channel = channel_key(&key, &token, 0).unwrap();
        assert_eq!(hex(&channel), "35f7a8c0e5731324e0e6f63709195a237b4857755c87d7e663791af728fda40d");
    }
}
