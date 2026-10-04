//! The smallest rustls crypto provider that can talk to the WARP edge: TLS 1.3
//! with one cipher suite (ChaCha20-Poly1305), one key exchange (P-256) and one
//! signature scheme (ECDSA P-256 with SHA-256), all from RustCrypto. The edge
//! asks for P-256 key shares anyway, so a single curve covers everything.

use std::sync::Arc;
use std::time::Duration;

use chacha20poly1305::{AeadInOut, ChaCha20Poly1305, KeyInit};
use hmac::{Hmac, Mac};
use p256::ecdsa::signature::{Signer as _, Verifier as _};
use rustls::crypto::cipher::{
    AeadKey, InboundOpaqueMessage, InboundPlainMessage, Iv, MessageDecrypter, MessageEncrypter, Nonce,
    OutboundOpaqueMessage, OutboundPlainMessage, PrefixedPayload, Tls13AeadAlgorithm, UnsupportedOperationError,
    make_tls13_aad,
};
use rustls::crypto::{
    self, ActiveKeyExchange, CipherSuiteCommon, CryptoProvider, GetRandomFailed, KeyProvider, SecureRandom,
    SharedSecret, SupportedKxGroup, WebPkiSupportedAlgorithms, hash, tls13,
};
use rustls::pki_types::{PrivateKeyDer, UnixTime};
use rustls::time_provider::TimeProvider;
use rustls::{
    CipherSuite, ConnectionTrafficSecrets, ContentType, Error, NamedGroup, PeerMisbehaved, ProtocolVersion,
    SignatureAlgorithm, SignatureScheme, SupportedCipherSuite, Tls13CipherSuite,
};
use sha2::{Digest, Sha256};

use crate::{cert, host};

pub const SCHEME: SignatureScheme = SignatureScheme::ECDSA_NISTP256_SHA256;

pub fn provider() -> CryptoProvider {
    CryptoProvider {
        cipher_suites: vec![CHACHA20_POLY1305],
        kx_groups: vec![&Secp256r1],
        // Only used by webpki verifiers; ours pins the edge's key instead.
        signature_verification_algorithms: WebPkiSupportedAlgorithms { all: &[], mapping: &[] },
        secure_random: &Host,
        key_provider: &Host,
    }
}

static CHACHA20_POLY1305: SupportedCipherSuite = SupportedCipherSuite::Tls13(&Tls13CipherSuite {
    common: CipherSuiteCommon {
        suite: CipherSuite::TLS13_CHACHA20_POLY1305_SHA256,
        hash_provider: &Sha256Hash,
        confidentiality_limit: u64::MAX,
    },
    hkdf_provider: &tls13::HkdfUsingHmac(&HmacSha256),
    aead_alg: &Chacha,
    quic: None,
});

// ─── Randomness, the clock, and (not) loading keys ───────────────────────────

#[derive(Debug)]
pub struct Host;

impl SecureRandom for Host {
    fn fill(&self, buf: &mut [u8]) -> Result<(), GetRandomFailed> {
        host::random(buf);
        Ok(())
    }
}

impl KeyProvider for Host {
    fn load_private_key(&self, _: PrivateKeyDer<'static>) -> Result<Arc<dyn rustls::sign::SigningKey>, Error> {
        Err(Error::General("the device key never comes as DER".into()))
    }
}

impl TimeProvider for Host {
    fn current_time(&self) -> Option<UnixTime> {
        Some(UnixTime::since_unix_epoch(Duration::from_millis(host::now_ms())))
    }
}

// ─── SHA-256 and HMAC ────────────────────────────────────────────────────────

struct Sha256Hash;

impl hash::Hash for Sha256Hash {
    fn start(&self) -> Box<dyn hash::Context> {
        Box::new(Sha256Context(Sha256::new()))
    }

    fn hash(&self, data: &[u8]) -> hash::Output {
        hash::Output::new(&Sha256::digest(data))
    }

    fn output_len(&self) -> usize {
        32
    }

    fn algorithm(&self) -> hash::HashAlgorithm {
        hash::HashAlgorithm::SHA256
    }
}

struct Sha256Context(Sha256);

impl hash::Context for Sha256Context {
    fn fork_finish(&self) -> hash::Output {
        hash::Output::new(&self.0.clone().finalize())
    }

    fn fork(&self) -> Box<dyn hash::Context> {
        Box::new(Self(self.0.clone()))
    }

    fn finish(self: Box<Self>) -> hash::Output {
        hash::Output::new(&self.0.finalize())
    }

    fn update(&mut self, data: &[u8]) {
        self.0.update(data);
    }
}

struct HmacSha256;

impl crypto::hmac::Hmac for HmacSha256 {
    fn with_key(&self, key: &[u8]) -> Box<dyn crypto::hmac::Key> {
        Box::new(HmacKey(
            Hmac::new_from_slice(key).expect("HMAC takes keys of any length"),
        ))
    }

    fn hash_output_len(&self) -> usize {
        32
    }
}

struct HmacKey(Hmac<Sha256>);

impl crypto::hmac::Key for HmacKey {
    fn sign_concat(&self, first: &[u8], middle: &[&[u8]], last: &[u8]) -> crypto::hmac::Tag {
        let mut mac = self.0.clone();
        mac.update(first);
        for part in middle {
            mac.update(part);
        }
        mac.update(last);
        crypto::hmac::Tag::new(&mac.finalize().into_bytes())
    }

    fn tag_len(&self) -> usize {
        32
    }
}

// ─── ChaCha20-Poly1305 records ───────────────────────────────────────────────

const TAG_LEN: usize = 16;

struct Chacha;

impl Tls13AeadAlgorithm for Chacha {
    fn encrypter(&self, key: AeadKey, iv: Iv) -> Box<dyn MessageEncrypter> {
        Box::new(Record(
            ChaCha20Poly1305::new_from_slice(key.as_ref()).expect("32-byte key"),
            iv,
        ))
    }

    fn decrypter(&self, key: AeadKey, iv: Iv) -> Box<dyn MessageDecrypter> {
        Box::new(Record(
            ChaCha20Poly1305::new_from_slice(key.as_ref()).expect("32-byte key"),
            iv,
        ))
    }

    fn key_len(&self) -> usize {
        32
    }

    fn extract_keys(&self, key: AeadKey, iv: Iv) -> Result<ConnectionTrafficSecrets, UnsupportedOperationError> {
        Ok(ConnectionTrafficSecrets::Chacha20Poly1305 { key, iv })
    }
}

struct Record(ChaCha20Poly1305, Iv);

impl Record {
    fn nonce(&self, seq: u64) -> chacha20poly1305::Nonce {
        Nonce::new(&self.1, seq).0.into()
    }
}

impl MessageEncrypter for Record {
    fn encrypt(&mut self, msg: OutboundPlainMessage<'_>, seq: u64) -> Result<OutboundOpaqueMessage, Error> {
        let total = self.encrypted_payload_len(msg.payload.len());
        let mut payload = PrefixedPayload::with_capacity(total);
        payload.extend_from_chunks(&msg.payload);
        payload.extend_from_slice(&msg.typ.to_array());
        let tag = self
            .0
            .encrypt_inout_detached(&self.nonce(seq), &make_tls13_aad(total), payload.as_mut().into())
            .map_err(|_| Error::EncryptError)?;
        payload.extend_from_slice(&tag);
        Ok(OutboundOpaqueMessage::new(
            ContentType::ApplicationData,
            ProtocolVersion::TLSv1_2,
            payload,
        ))
    }

    fn encrypted_payload_len(&self, payload_len: usize) -> usize {
        payload_len + 1 + TAG_LEN
    }
}

impl MessageDecrypter for Record {
    fn decrypt<'a>(&mut self, mut msg: InboundOpaqueMessage<'a>, seq: u64) -> Result<InboundPlainMessage<'a>, Error> {
        let payload = &mut msg.payload;
        let len = payload.len();
        let body_len = len.checked_sub(TAG_LEN).ok_or(Error::DecryptError)?;
        let (body, tag) = payload.split_at_mut(body_len);
        let tag: [u8; TAG_LEN] = (&*tag).try_into().map_err(|_| Error::DecryptError)?;
        self.0
            .decrypt_inout_detached(&self.nonce(seq), &make_tls13_aad(len), body.into(), &tag.into())
            .map_err(|_| Error::DecryptError)?;
        payload.truncate(body_len);
        msg.into_tls13_unpadded_message()
    }
}

// ─── P-256: key exchange, signing, verifying ─────────────────────────────────

#[derive(Debug)]
struct Secp256r1;

impl SupportedKxGroup for Secp256r1 {
    fn start(&self) -> Result<Box<dyn ActiveKeyExchange>, Error> {
        let secret = random_secret().to_nonzero_scalar();
        let public = p256::PublicKey::from_secret_scalar(&secret);
        Ok(Box::new(Exchange {
            secret,
            public: cert::point(&public),
        }))
    }

    fn name(&self) -> NamedGroup {
        NamedGroup::secp256r1
    }
}

struct Exchange {
    secret: p256::NonZeroScalar,
    public: [u8; 65],
}

impl ActiveKeyExchange for Exchange {
    fn complete(self: Box<Self>, peer: &[u8]) -> Result<SharedSecret, Error> {
        let peer = p256::PublicKey::from_sec1_bytes(peer).map_err(|_| PeerMisbehaved::InvalidKeyShare)?;
        let shared = p256::ecdh::diffie_hellman(self.secret, peer.as_affine());
        Ok(SharedSecret::from(&shared.raw_secret_bytes()[..]))
    }

    fn pub_key(&self) -> &[u8] {
        &self.public
    }

    fn group(&self) -> NamedGroup {
        NamedGroup::secp256r1
    }
}

fn random_secret() -> p256::SecretKey {
    loop {
        let mut bytes = [0; 32];
        host::random(&mut bytes);
        if let Ok(key) = p256::SecretKey::from_slice(&bytes) {
            return key;
        }
    }
}

/// The device key: it signs the TLS handshake (and our own certificate).
#[derive(Debug)]
pub struct DeviceKey(pub p256::ecdsa::SigningKey);

impl rustls::sign::SigningKey for DeviceKey {
    fn choose_scheme(&self, offered: &[SignatureScheme]) -> Option<Box<dyn rustls::sign::Signer>> {
        offered
            .contains(&SCHEME)
            .then(|| Box::new(DeviceKey(self.0.clone())) as Box<dyn rustls::sign::Signer>)
    }

    fn algorithm(&self) -> SignatureAlgorithm {
        SignatureAlgorithm::ECDSA
    }
}

impl rustls::sign::Signer for DeviceKey {
    fn sign(&self, message: &[u8]) -> Result<Vec<u8>, Error> {
        Ok(cert::signature_der(&self.0.sign(message)))
    }

    fn scheme(&self) -> SignatureScheme {
        SCHEME
    }
}

/// Checks an ECDSA P-256 / SHA-256 signature (DER) against an uncompressed point.
pub fn verify(point: &[u8; 65], message: &[u8], signature: &[u8]) -> bool {
    let Ok(key) = p256::ecdsa::VerifyingKey::from_sec1_bytes(point) else {
        return false;
    };
    cert::signature_from_der(signature).is_some_and(|sig| key.verify(message, &sig).is_ok())
}
