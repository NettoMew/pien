//! TLS to the WARP edge. The device shows a certificate for its registered
//! key; the edge must show the key it was given at registration. No
//! certificate authorities are involved either way.

use std::sync::Arc;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::client::{ResolvesClientCert, Resumption, UnbufferedClientConnection};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::sign::CertifiedKey;
use rustls::{CertificateError, ClientConfig, DigitallySignedStruct, Error, SignatureScheme};

use crate::crypto::{self, DeviceKey, SCHEME};
use crate::{cert, host};

/// The name the official client asks for, whatever address it connects to.
pub const SNI: &str = "consumer-masque.cloudflareclient.com";

pub fn connect(secret: &[u8; 32], edge: [u8; 65]) -> Result<UnbufferedClientConnection, Error> {
    let key =
        p256::ecdsa::SigningKey::from_slice(secret).map_err(|_| Error::General("not a P-256 private key".into()))?;
    let cert = cert::self_signed(&key, host::now_ms() / 1000);
    let device = CertifiedKey::new(vec![CertificateDer::from(cert)], Arc::new(DeviceKey(key)));

    let mut config = ClientConfig::builder_with_details(Arc::new(crypto::provider()), Arc::new(crypto::Host))
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(Pinned(edge)))
        .with_client_cert_resolver(Arc::new(Device(Arc::new(device))));
    config.alpn_protocols = vec![b"h2".to_vec()];
    config.resumption = Resumption::disabled();
    UnbufferedClientConnection::new(Arc::new(config), ServerName::try_from(SNI).expect("a valid name"))
}

/// Accepts exactly one key: the edge's, from registration.
#[derive(Debug)]
struct Pinned([u8; 65]);

impl ServerCertVerifier for Pinned {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        _: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        match cert::certificate_spki(end_entity).and_then(cert::spki_point) {
            Some(point) if point == self.0 => Ok(ServerCertVerified::assertion()),
            _ => Err(Error::InvalidCertificate(
                CertificateError::ApplicationVerificationFailure,
            )),
        }
    }

    fn verify_tls12_signature(
        &self,
        _: &[u8],
        _: &CertificateDer<'_>,
        _: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        Err(Error::General("TLS 1.2 is never negotiated".into()))
    }

    /// The certificate's key was checked to be the pinned one, so verify with that.
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        _: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        if dss.scheme == SCHEME && crypto::verify(&self.0, message, dss.signature()) {
            Ok(HandshakeSignatureValid::assertion())
        } else {
            Err(Error::InvalidCertificate(CertificateError::BadSignature))
        }
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![SCHEME]
    }
}

#[derive(Debug)]
struct Device(Arc<CertifiedKey>);

impl ResolvesClientCert for Device {
    fn resolve(&self, _: &[&[u8]], schemes: &[SignatureScheme]) -> Option<Arc<CertifiedKey>> {
        schemes.contains(&SCHEME).then(|| self.0.clone())
    }

    fn has_certs(&self) -> bool {
        true
    }
}
