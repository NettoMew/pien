//! guest@zutto-issho's way onto the internet: Cloudflare WARP, spoken from the page.
//!
//! Sealed since 2026-10-05: the page no longer loads it (docs/warp.md).
//!
//! The guest's network card produces Ethernet frames; WARP's MASQUE endpoint
//! takes IP packets as HTTP/2 capsules over TLS. This crate is the whole path
//! between them as a state machine without I/O (see docs/warp.md):
//!
//! ```text
//! guest frames ⇄ link ⇄ IP packets ⇄ capsule ⇄ h2 ⇄ tls (crypto, cert) ⇄ socket bytes
//! ```
//!
//! In the browser it is driven through `abi`; natively, `examples/edge.rs`
//! drives it over a plain TCP socket.

mod capsule;
mod cert;
mod crypto;
mod h2;
mod host;
mod link;
mod tls;
mod tunnel;

#[cfg(target_arch = "wasm32")]
mod abi;

pub use link::GATEWAY;
pub use tunnel::{Down, Event, Tunnel};
