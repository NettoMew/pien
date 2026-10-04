//! The page's side of the tunnel: a handful of functions over plain integers.
//!
//! Input goes through one buffer: the page asks `input(len)` for room, writes
//! the bytes there, then calls the function that consumes them. Output comes
//! back through the `host` imports once that function has done its work.

use std::cell::RefCell;

use crate::host::imports;
use crate::tunnel::Tunnel;

thread_local! {
    static INPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static TUNNEL: RefCell<Option<Tunnel>> = const { RefCell::new(None) };
}

/// Room for `len` bytes of input.
#[unsafe(no_mangle)]
pub extern "C" fn input(len: usize) -> *mut u8 {
    INPUT.with_borrow_mut(|input| {
        input.resize(len, 0);
        input.as_mut_ptr()
    })
}

/// Opens a tunnel. Input: the device's private key (32 bytes), then the
/// edge's SubjectPublicKeyInfo. Returns whether those made sense.
#[unsafe(no_mangle)]
pub extern "C" fn open() -> bool {
    let tunnel = INPUT.with_borrow(|input| {
        let (secret, edge) = input.split_at_checked(32)?;
        Tunnel::open(secret.try_into().ok()?, edge)
    });
    let opened = tunnel.is_some();
    TUNNEL.set(tunnel);
    flush();
    opened
}

/// Input: bytes from the socket.
#[unsafe(no_mangle)]
pub extern "C" fn from_socket() {
    with_input(Tunnel::from_socket);
}

/// Input: one Ethernet frame from the guest.
#[unsafe(no_mangle)]
pub extern "C" fn from_guest() {
    with_input(Tunnel::from_guest);
}

#[unsafe(no_mangle)]
pub extern "C" fn tick() {
    TUNNEL.with_borrow_mut(|tunnel| tunnel.as_mut().map(Tunnel::tick));
    flush();
}

#[unsafe(no_mangle)]
pub extern "C" fn close() {
    TUNNEL.with_borrow_mut(|tunnel| tunnel.as_mut().map(Tunnel::close));
    flush();
    TUNNEL.set(None);
}

fn with_input(f: fn(&mut Tunnel, &[u8])) {
    INPUT.with_borrow(|input| TUNNEL.with_borrow_mut(|tunnel| tunnel.as_mut().map(|tunnel| f(tunnel, input))));
    flush();
}

/// Hands everything that is ready to the page — outside of any borrow, so
/// the page may call straight back in.
fn flush() {
    let Some((socket, guest, events)) = TUNNEL.with_borrow_mut(|t| t.as_mut().map(Tunnel::drain)) else {
        return;
    };
    unsafe {
        if !socket.is_empty() {
            imports::to_socket(socket.as_ptr(), socket.len());
        }
        for frame in &guest {
            imports::to_guest(frame.as_ptr(), frame.len());
        }
        for event in events {
            let (kind, code, detail) = event.encode();
            imports::event(kind, code, detail);
        }
    }
}
