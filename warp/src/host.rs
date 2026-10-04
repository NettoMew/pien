//! What the page gives us: randomness and the time. In the browser both are
//! imports; anywhere else (tests, `examples/edge.rs`) they come from the OS.

#[cfg(target_arch = "wasm32")]
pub mod imports {
    #[link(wasm_import_module = "host")]
    unsafe extern "C" {
        pub fn random(ptr: *mut u8, len: usize);
        pub fn now() -> f64;
        pub fn to_socket(ptr: *const u8, len: usize);
        pub fn to_guest(ptr: *const u8, len: usize);
        pub fn event(kind: u32, code: u32, detail: u32);
    }
}

#[cfg(target_arch = "wasm32")]
pub fn random(buf: &mut [u8]) {
    // crypto.getRandomValues takes at most 64 KiB at a time.
    for chunk in buf.chunks_mut(65536) {
        unsafe { imports::random(chunk.as_mut_ptr(), chunk.len()) }
    }
}

#[cfg(target_arch = "wasm32")]
pub fn now_ms() -> u64 {
    unsafe { imports::now() as u64 }
}

#[cfg(not(target_arch = "wasm32"))]
pub fn random(buf: &mut [u8]) {
    getrandom::fill(buf).expect("the OS has no randomness");
}

#[cfg(not(target_arch = "wasm32"))]
pub fn now_ms() -> u64 {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH);
    now.map_or(0, |d| d.as_millis() as u64)
}
