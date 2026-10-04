//! The tunnel against the real WARP edge, from this machine, over plain TCP:
//!
//!   node scripts/warp.ts register
//!   cargo run --manifest-path warp/Cargo.toml --example edge -- .cache/warp/open.bin
//!
//! Plays a guest that pings a few addresses, then reports what came back.

use std::io::{ErrorKind, Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

use warp::{Event, GATEWAY, Tunnel};

const GUEST_MAC: [u8; 6] = [0x02, 0, 0, 0, 0, 0x02];
const GUEST_IP: [u8; 4] = [172, 16, 0, 2];
const TARGETS: [[u8; 4]; 3] = [[1, 1, 1, 1], [8, 8, 8, 8], [192, 0, 2, 1]];
const PINGS: u16 = 4;

fn main() {
    let mut args = std::env::args().skip(1);
    let open = std::fs::read(args.next().expect("usage: edge <open.bin> [edge address]")).expect("open.bin");
    let edge = args.next().unwrap_or_else(|| "162.159.198.2:443".into());

    let started = Instant::now();
    let mut tunnel = Tunnel::open(open[..32].try_into().unwrap(), &open[32..]).expect("open.bin is not a device");
    let mut socket = TcpStream::connect(&edge).expect("connect to the edge");
    socket.set_read_timeout(Some(Duration::from_millis(50))).unwrap();
    println!("tcp to {edge} in {:?}", started.elapsed());

    let mut buf = vec![0; 1 << 16];
    let mut up: Option<Instant> = None;
    let mut sent: Vec<([u8; 4], u16, Instant)> = Vec::new();
    let mut replies: Vec<([u8; 4], u16, Duration)> = Vec::new();
    let mut bytes_in = 0;

    loop {
        let (out, frames, events) = tunnel.drain();
        socket.write_all(&out).expect("write to the edge");
        for frame in frames {
            if let Some((from, seq)) = echo_reply(&frame)
                && let Some(&(_, _, when)) = sent.iter().find(|&&(t, s, _)| t == from && s == seq)
            {
                replies.push((from, seq, when.elapsed()));
            }
        }
        for event in events {
            match event {
                Event::Up => {
                    println!("up after {:?} ({bytes_in} bytes from the edge)", started.elapsed());
                    up = Some(Instant::now());
                }
                Event::Down(why) => {
                    println!("down: {why:?}");
                    return report(&sent, &replies);
                }
            }
        }

        if let Some(at) = up {
            let due = (at.elapsed().as_millis() / 250) as u16;
            let seq = sent.len() as u16 / TARGETS.len() as u16;
            if seq < PINGS && seq <= due {
                for target in TARGETS {
                    tunnel.from_guest(&echo_request(target, seq));
                    sent.push((target, seq, Instant::now()));
                }
            }
            if at.elapsed() > Duration::from_secs(3) {
                tunnel.tick(); // a PING frame, for good measure
                tunnel.close();
                let (out, _, _) = tunnel.drain();
                socket.write_all(&out).ok();
                return report(&sent, &replies);
            }
        } else if started.elapsed() > Duration::from_secs(15) {
            println!("no tunnel after 15 s");
            return;
        }

        match socket.read(&mut buf) {
            Ok(0) => {
                println!("the edge hung up");
                return report(&sent, &replies);
            }
            Ok(n) => {
                bytes_in += n;
                tunnel.from_socket(&buf[..n]);
            }
            Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(e) => panic!("reading from the edge: {e}"),
        }
    }
}

fn report(sent: &[([u8; 4], u16, Instant)], replies: &[([u8; 4], u16, Duration)]) {
    for target in TARGETS {
        let rtts: Vec<_> = replies.iter().filter(|r| r.0 == target).map(|r| r.2).collect();
        let asked = sent.iter().filter(|s| s.0 == target).count();
        let ip = target.map(|b| b.to_string()).join(".");
        println!("ping {ip:<12} {}/{asked} answered {rtts:?}", rtts.len());
    }
}

fn echo_request(to: [u8; 4], seq: u16) -> Vec<u8> {
    let mut icmp = vec![8, 0, 0, 0, 0x12, 0x34];
    icmp.extend_from_slice(&seq.to_be_bytes());
    icmp.extend_from_slice(b"guest@home");
    let sum = checksum(&icmp);
    icmp[2..4].copy_from_slice(&sum.to_be_bytes());

    let mut ip = vec![0x45, 0, 0, 0, 0, 0, 0x40, 0, 64, 1, 0, 0];
    ip[2..4].copy_from_slice(&((20 + icmp.len()) as u16).to_be_bytes());
    ip.extend_from_slice(&GUEST_IP);
    ip.extend_from_slice(&to);
    let sum = checksum(&ip);
    ip[10..12].copy_from_slice(&sum.to_be_bytes());

    [&GATEWAY[..], &GUEST_MAC, &[0x08, 0x00], &ip, &icmp].concat()
}

/// (from, seq) if this frame is an echo reply to us.
fn echo_reply(frame: &[u8]) -> Option<([u8; 4], u16)> {
    let ip = frame.get(14..)?;
    let icmp = ip.get(usize::from(ip[0] & 0xf) * 4..)?;
    (frame[..6] == GUEST_MAC && ip[9] == 1 && icmp.first() == Some(&0) && icmp.get(4..6)? == [0x12, 0x34])
        .then(|| (ip[12..16].try_into().unwrap(), u16::from_be_bytes([icmp[6], icmp[7]])))
}

fn checksum(bytes: &[u8]) -> u16 {
    let mut sum: u32 = bytes
        .chunks(2)
        .map(|c| u32::from(u16::from_be_bytes([c[0], *c.get(1).unwrap_or(&0)])))
        .sum();
    while sum > 0xffff {
        sum = (sum & 0xffff) + (sum >> 16);
    }
    !(sum as u16)
}
