//! Just enough DER for WARP: P-256 public keys, a self-signed certificate for
//! the device key, finding the key inside the edge's certificate, and ECDSA
//! signatures.

use p256::ecdsa::signature::Signer as _;
use p256::ecdsa::{Signature, SigningKey};
use p256::elliptic_curve::sec1::ToSec1Point;

/// SubjectPublicKeyInfo for an uncompressed P-256 key, up to the point itself.
const P256_SPKI: [u8; 26] = [
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce,
    0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
];

/// AlgorithmIdentifier for ecdsa-with-SHA256.
const ECDSA_SHA256: [u8; 12] = [0x30, 0x0a, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02];

const SEQUENCE: u8 = 0x30;
const INTEGER: u8 = 0x02;
const BIT_STRING: u8 = 0x03;
const UTC_TIME: u8 = 0x17;
const VERSION: u8 = 0xa0;

/// The uncompressed SEC 1 encoding of a public key.
pub fn point(key: &p256::PublicKey) -> [u8; 65] {
    key.to_sec1_point(false)
        .as_bytes()
        .try_into()
        .expect("uncompressed P-256 points are 65 bytes")
}

/// The device key's public half, as a point.
pub fn device_point(key: &SigningKey) -> [u8; 65] {
    point(&key.verifying_key().into())
}

pub fn spki(point: &[u8; 65]) -> Vec<u8> {
    [&P256_SPKI[..], point].concat()
}

/// The point inside a P-256 SubjectPublicKeyInfo, if that is what it is.
pub fn spki_point(spki: &[u8]) -> Option<[u8; 65]> {
    let point = spki.strip_prefix(&P256_SPKI)?;
    (point.first() == Some(&4)).then(|| point.try_into().ok()).flatten()
}

/// The SubjectPublicKeyInfo inside a certificate.
pub fn certificate_spki(cert: &[u8]) -> Option<&[u8]> {
    let (_, cert, _) = expect(SEQUENCE, cert)?;
    let (_, tbs, _) = expect(SEQUENCE, cert)?;
    let mut rest = tbs;
    if rest.first() == Some(&VERSION) {
        rest = tlv(rest)?.2;
    }
    // serialNumber, signature, issuer, validity, subject
    for _ in 0..5 {
        rest = tlv(rest)?.2;
    }
    let (whole, _, _) = expect(SEQUENCE, rest)?;
    Some(whole)
}

/// A certificate for the device key, the way the official client makes one:
/// serial 0, empty names, valid for a day.
pub fn self_signed(key: &SigningKey, now_secs: u64) -> Vec<u8> {
    let mut validity = Vec::new();
    put(&mut validity, UTC_TIME, &utc_time(now_secs.saturating_sub(3600)));
    put(&mut validity, UTC_TIME, &utc_time(now_secs + 86400));

    let mut body = vec![VERSION, 3, INTEGER, 1, 2, INTEGER, 1, 0];
    body.extend_from_slice(&ECDSA_SHA256);
    body.extend_from_slice(&[SEQUENCE, 0]); // issuer
    put(&mut body, SEQUENCE, &validity);
    body.extend_from_slice(&[SEQUENCE, 0]); // subject
    body.extend_from_slice(&spki(&device_point(key)));

    let mut tbs = Vec::new();
    put(&mut tbs, SEQUENCE, &body);
    let signature: Signature = key.sign(&tbs);
    let mut bits = vec![0];
    bits.extend_from_slice(&signature_der(&signature));

    tbs.extend_from_slice(&ECDSA_SHA256);
    put(&mut tbs, BIT_STRING, &bits);
    let mut cert = Vec::new();
    put(&mut cert, SEQUENCE, &tbs);
    cert
}

/// ECDSA-Sig-Value: SEQUENCE { r INTEGER, s INTEGER }.
pub fn signature_der(signature: &Signature) -> Vec<u8> {
    let bytes = signature.to_bytes();
    let mut both = Vec::with_capacity(72);
    for half in bytes.chunks(32) {
        let start = half.iter().position(|&b| b != 0).unwrap_or(31);
        let mut int = Vec::with_capacity(33);
        if half[start] & 0x80 != 0 {
            int.push(0);
        }
        int.extend_from_slice(&half[start..]);
        put(&mut both, INTEGER, &int);
    }
    let mut der = Vec::with_capacity(both.len() + 2);
    put(&mut der, SEQUENCE, &both);
    der
}

pub fn signature_from_der(der: &[u8]) -> Option<Signature> {
    let (_, mut rest, _) = expect(SEQUENCE, der)?;
    let mut bytes = [0; 64];
    for half in bytes.chunks_mut(32) {
        let (_, int, next) = expect(INTEGER, rest)?;
        let int = int.strip_prefix(&[0]).unwrap_or(int);
        half.get_mut(32usize.checked_sub(int.len())?..)?.copy_from_slice(int);
        rest = next;
    }
    Signature::from_slice(&bytes).ok()
}

// ─── DER plumbing ────────────────────────────────────────────────────────────

/// Splits off one element: (the whole element, its contents, what follows).
fn tlv(input: &[u8]) -> Option<(&[u8], &[u8], &[u8])> {
    let first = *input.get(1)?;
    let (len, header): (usize, usize) = match first {
        0..=0x7f => (first as usize, 2),
        0x81 => (*input.get(2)? as usize, 3),
        0x82 => (u16::from_be_bytes([*input.get(2)?, *input.get(3)?]) as usize, 4),
        _ => return None,
    };
    let end = header.checked_add(len)?;
    let whole = input.get(..end)?;
    Some((whole, &whole[header..], &input[end..]))
}

fn expect(tag: u8, input: &[u8]) -> Option<(&[u8], &[u8], &[u8])> {
    (*input.first()? == tag).then(|| tlv(input)).flatten()
}

fn put(out: &mut Vec<u8>, tag: u8, contents: &[u8]) {
    out.push(tag);
    match contents.len() {
        len @ 0..0x80 => out.push(len as u8),
        len @ 0x80..0x100 => out.extend_from_slice(&[0x81, len as u8]),
        len => out.extend_from_slice(&[0x82, (len >> 8) as u8, len as u8]),
    }
    out.extend_from_slice(contents);
}

/// YYMMDDHHMMSSZ.
fn utc_time(secs: u64) -> [u8; 13] {
    let (days, secs) = ((secs / 86400) as i64, secs % 86400);
    // Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);

    let mut out = *b"000000000000Z";
    let fields = [
        year % 100,
        month,
        day,
        (secs / 3600) as i64,
        (secs / 60 % 60) as i64,
        (secs % 60) as i64,
    ];
    for (i, field) in fields.into_iter().enumerate() {
        out[2 * i] = b'0' + (field / 10) as u8;
        out[2 * i + 1] = b'0' + (field % 10) as u8;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> SigningKey {
        SigningKey::from_slice(&[7; 32]).unwrap()
    }

    #[test]
    fn utc_times() {
        assert_eq!(&utc_time(0), b"700101000000Z");
        assert_eq!(&utc_time(951_782_400), b"000229000000Z"); // 2000-02-29
        assert_eq!(&utc_time(1_791_119_922), b"261004131842Z");
    }

    #[test]
    fn certificate_round_trip() {
        let key = key();
        let cert = self_signed(&key, 1_791_119_922);
        let spki = certificate_spki(&cert).unwrap();
        assert_eq!(spki_point(spki).unwrap(), device_point(&key));

        // The signature covers the TBSCertificate and verifies with the key.
        let (_, body, _) = expect(SEQUENCE, &cert).unwrap();
        let (tbs, _, rest) = expect(SEQUENCE, body).unwrap();
        let (_, _, rest) = expect(SEQUENCE, rest).unwrap();
        let (_, bits, _) = expect(BIT_STRING, rest).unwrap();
        assert!(crate::crypto::verify(&device_point(&key), tbs, &bits[1..]));
    }

    #[test]
    fn signatures_survive_der() {
        let key = key();
        for message in [&b""[..], b"warp", &[0xff; 300]] {
            let signature: Signature = key.sign(message);
            let der = signature_der(&signature);
            assert_eq!(signature_from_der(&der), Some(signature));
            assert!(crate::crypto::verify(&device_point(&key), message, &der));
        }
        assert_eq!(signature_from_der(&[0x30, 0]), None);
    }

    #[test]
    fn rejects_other_keys() {
        assert_eq!(spki_point(&[0x30, 0x59]), None);
        let mut compressed = spki(&device_point(&key()));
        compressed[26] = 2;
        assert_eq!(spki_point(&compressed), None);
    }
}
