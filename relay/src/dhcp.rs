//! DHCPv6 (RFC 8415), as much of it as hands the guest its address: the
//! session's own /128 (addresses.rs), for good. The gateway is the only
//! server on the link and has nothing else to give, so every client hears
//! the same from it: this one address, never to be renewed.

use std::net::Ipv6Addr;

use smoltcp::wire::EthernetAddress;

/// The ports clients send from and servers listen on.
pub const CLIENT: u16 = 546;
pub const SERVER: u16 = 547;
/// Where clients send: All_DHCP_Relay_Agents_and_Servers.
pub const SERVERS: Ipv6Addr = Ipv6Addr::new(0xff02, 0, 0, 0, 0, 0, 1, 2);

// Messages.
const SOLICIT: u8 = 1;
const ADVERTISE: u8 = 2;
const REQUEST: u8 = 3;
const CONFIRM: u8 = 4;
const RENEW: u8 = 5;
const REBIND: u8 = 6;
const REPLY: u8 = 7;
const RELEASE: u8 = 8;
const DECLINE: u8 = 9;
const INFORMATION_REQUEST: u8 = 11;

// Options.
const CLIENT_ID: u16 = 1;
const SERVER_ID: u16 = 2;
const IA_NA: u16 = 3;
const IA_ADDR: u16 = 5;
const PREFERENCE: u16 = 7;
const STATUS_CODE: u16 = 13;
const RAPID_COMMIT: u16 = 14;

// Statuses.
const SUCCESS: u16 = 0;
const NO_ADDRS_AVAIL: u16 = 2;
const NOT_ON_LINK: u16 = 4;

/// Lifetimes, and times to renew, of forever.
const INFINITY: u32 = u32::MAX;

/// What the server at `mac` says to a client's `message`, if anything: that
/// `address` is the client's, for the first IA_NA it asks about.
pub fn answer(message: &[u8], address: Ipv6Addr, mac: EthernetAddress) -> Option<Vec<u8>> {
    let (&kind, rest) = message.split_first()?;
    let transaction = rest.get(..3)?;
    let options = options(rest.get(3..)?)?;
    let find = |code| options.iter().find(|&&(c, _)| c == code).map(|&(_, data)| data);
    let duid = [&[0, 3, 0, 1][..], mac.as_bytes()].concat(); // DUID-LL: the gateway's MAC
    let (client, server) = (find(CLIENT_ID), find(SERVER_ID));
    let (asked, ours) = (client.is_some() && server.is_none(), client.is_some() && server == Some(&duid[..]));
    let ias: Vec<&[u8]> = options
        .iter()
        .filter(|&&(code, data)| code == IA_NA && data.len() >= 12)
        .map(|&(_, data)| data)
        .collect();

    let (kind, body) = match kind {
        SOLICIT if asked && !ias.is_empty() => match find(RAPID_COMMIT) {
            Some(_) => (REPLY, [option(RAPID_COMMIT, &[]), leases(&ias, address)].concat()),
            // The most preferred a server can be: the client need wait for no other.
            None => (ADVERTISE, [option(PREFERENCE, &[255]), leases(&ias, address)].concat()),
        },
        REQUEST | RENEW if ours && !ias.is_empty() => (REPLY, leases(&ias, address)),
        REBIND if asked && !ias.is_empty() => (REPLY, leases(&ias, address)),
        // Whether the addresses it had are still good here: only this one is.
        CONFIRM if asked => {
            let had: Vec<Ipv6Addr> = ias.iter().flat_map(|ia| addresses(ia)).collect();
            if had.is_empty() {
                return None;
            }
            let fine = had.iter().all(|&a| a == address);
            (REPLY, status(if fine { SUCCESS } else { NOT_ON_LINK }))
        }
        RELEASE | DECLINE if ours => (REPLY, status(SUCCESS)),
        INFORMATION_REQUEST if server.is_none() || server == Some(&duid[..]) => (REPLY, Vec::new()),
        _ => return None,
    };
    let mut reply = [&[kind][..], transaction, &option(SERVER_ID, &duid)].concat();
    if let Some(client) = client {
        reply.extend(option(CLIENT_ID, client));
    }
    reply.extend(body);
    Some(reply)
}

/// A message's options, as (code, data); `None` if one runs past the end.
fn options(mut bytes: &[u8]) -> Option<Vec<(u16, &[u8])>> {
    let mut options = Vec::new();
    while !bytes.is_empty() {
        let code = u16::from_be_bytes(bytes.get(..2)?.try_into().ok()?);
        let len = usize::from(u16::from_be_bytes(bytes.get(2..4)?.try_into().ok()?));
        options.push((code, bytes.get(4..4 + len)?));
        bytes = &bytes[4 + len..];
    }
    Some(options)
}

fn option(code: u16, data: &[u8]) -> Vec<u8> {
    let len = u16::try_from(data.len()).expect("options are short");
    [&code.to_be_bytes()[..], &len.to_be_bytes(), data].concat()
}

fn status(code: u16) -> Vec<u8> {
    option(STATUS_CODE, &code.to_be_bytes())
}

/// The answer for each IA_NA asked about, by its IAID: `address` for the
/// first, for good; none for any other.
fn leases(ias: &[&[u8]], address: Ipv6Addr) -> Vec<u8> {
    ias.iter()
        .enumerate()
        .flat_map(|(i, ia)| {
            let iaid = &ia[..4];
            let body = match i {
                0 => {
                    let lease = [&address.octets()[..], &INFINITY.to_be_bytes(), &INFINITY.to_be_bytes()].concat();
                    [iaid, &INFINITY.to_be_bytes(), &INFINITY.to_be_bytes(), &option(IA_ADDR, &lease)].concat()
                }
                _ => [iaid, &[0; 8], &status(NO_ADDRS_AVAIL)].concat(),
            };
            option(IA_NA, &body)
        })
        .collect()
}

/// The addresses in an IA_NA, as a client holds them.
fn addresses(ia: &[u8]) -> Vec<Ipv6Addr> {
    options(&ia[12..])
        .unwrap_or_default()
        .into_iter()
        .filter(|&(code, data)| code == IA_ADDR && data.len() >= 24)
        .filter_map(|(_, data)| <[u8; 16]>::try_from(&data[..16]).ok().map(Ipv6Addr::from))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const GATEWAY: EthernetAddress = EthernetAddress([0x52, 0x55, 0x0a, 0x00, 0x02, 0x02]);
    const DUID: [u8; 10] = [0, 3, 0, 1, 0x52, 0x55, 0x0a, 0x00, 0x02, 0x02];
    const CLIENT_DUID: [u8; 10] = [0, 3, 0, 1, 0x52, 0x54, 0x00, 0x12, 0x34, 0x56];
    const LEASE: Ipv6Addr = Ipv6Addr::new(0x2001, 0xdb8, 1, 2, 1, 0xabcd, 0x1234, 0x5678);

    /// A client's message, as udhcpc6 sends one.
    fn message(kind: u8, options: &[Vec<u8>]) -> Vec<u8> {
        [&[kind, 0xa1, 0xb2, 0xc3][..], &options.concat()].concat()
    }

    fn client() -> Vec<u8> {
        option(CLIENT_ID, &CLIENT_DUID)
    }

    fn server(duid: &[u8]) -> Vec<u8> {
        option(SERVER_ID, duid)
    }

    fn ia(iaid: u32, had: Option<Ipv6Addr>) -> Vec<u8> {
        let had = had.map_or(vec![], |a| option(IA_ADDR, &[&a.octets()[..], &[0; 8]].concat()));
        option(IA_NA, &[&iaid.to_be_bytes()[..], &[0; 8], &had].concat())
    }

    /// The answer's type, and its options by code, top level.
    fn read(answer: &[u8]) -> (u8, Vec<(u16, Vec<u8>)>) {
        assert_eq!(&answer[1..4], &[0xa1, 0xb2, 0xc3]); // the client's transaction
        let options = options(&answer[4..]).unwrap();
        (answer[0], options.into_iter().map(|(c, d)| (c, d.to_vec())).collect())
    }

    fn get(options: &[(u16, Vec<u8>)], code: u16) -> Option<&[u8]> {
        options.iter().find(|(c, _)| *c == code).map(|(_, d)| &d[..])
    }

    /// The address an answer leases, for good, to the IA it names.
    fn leased(options: &[(u16, Vec<u8>)], iaid: u32) -> Option<Ipv6Addr> {
        let ia = get(options, IA_NA)?;
        assert_eq!(&ia[..4], &iaid.to_be_bytes());
        assert_eq!(&ia[4..12], &[0xff; 8]); // never to renew, nor rebind
        let (code, lease) = super::options(&ia[12..])?.into_iter().next()?;
        assert_eq!((code, &lease[16..24]), (IA_ADDR, &[0xff; 8][..])); // preferred and valid for good
        Some(Ipv6Addr::from(<[u8; 16]>::try_from(&lease[..16]).unwrap()))
    }

    #[test]
    fn solicit_advertise_request_reply() {
        let advert = answer(&message(SOLICIT, &[client(), ia(7, None)]), LEASE, GATEWAY).unwrap();
        let (kind, options) = read(&advert);
        assert_eq!(kind, ADVERTISE);
        assert_eq!(get(&options, SERVER_ID), Some(&DUID[..]));
        assert_eq!(get(&options, CLIENT_ID), Some(&CLIENT_DUID[..]));
        assert_eq!(get(&options, PREFERENCE), Some(&[255][..]));
        assert_eq!(leased(&options, 7), Some(LEASE));

        let request = message(REQUEST, &[client(), server(&DUID), ia(7, Some(LEASE))]);
        let (kind, options) = read(&answer(&request, LEASE, GATEWAY).unwrap());
        assert_eq!((kind, leased(&options, 7)), (REPLY, Some(LEASE)));
        // Asking another server: not ours to answer.
        let elsewhere = message(REQUEST, &[client(), server(&CLIENT_DUID), ia(7, None)]);
        assert_eq!(answer(&elsewhere, LEASE, GATEWAY), None);
    }

    #[test]
    fn rapid_commit_skips_the_advertisement() {
        let solicit = message(SOLICIT, &[client(), option(RAPID_COMMIT, &[]), ia(1, None)]);
        let (kind, options) = read(&answer(&solicit, LEASE, GATEWAY).unwrap());
        assert_eq!((kind, leased(&options, 1)), (REPLY, Some(LEASE)));
        assert_eq!(get(&options, RAPID_COMMIT), Some(&[][..]));
    }

    #[test]
    fn one_address_for_the_first_ia_and_none_for_more() {
        let solicit = message(SOLICIT, &[client(), ia(1, None), ia(2, None)]);
        let (_, options) = read(&answer(&solicit, LEASE, GATEWAY).unwrap());
        let ias: Vec<&Vec<u8>> = options.iter().filter(|(c, _)| *c == IA_NA).map(|(_, d)| d).collect();
        assert_eq!(ias.len(), 2);
        assert_eq!(&ias[1][..4], &2u32.to_be_bytes());
        assert_eq!(super::options(&ias[1][12..]).unwrap(), [(STATUS_CODE, &NO_ADDRS_AVAIL.to_be_bytes()[..])]);
    }

    #[test]
    fn renew_rebind_confirm_release() {
        // Renewing names the server; rebinding, after it went quiet, does not.
        for (kind, server) in [(RENEW, vec![server(&DUID)]), (REBIND, vec![])] {
            let message = message(kind, &[vec![client(), ia(7, Some(LEASE))], server].concat());
            let (kind, options) = read(&answer(&message, LEASE, GATEWAY).unwrap());
            assert_eq!((kind, leased(&options, 7)), (REPLY, Some(LEASE)));
        }
        let confirm = |had| {
            let message = message(CONFIRM, &[client(), ia(7, Some(had))]);
            let (kind, options) = read(&answer(&message, LEASE, GATEWAY).unwrap());
            assert_eq!(kind, REPLY);
            u16::from_be_bytes(get(&options, STATUS_CODE).unwrap().try_into().unwrap())
        };
        assert_eq!(confirm(LEASE), SUCCESS);
        assert_eq!(confirm(Ipv6Addr::new(0xfdca, 0xc697, 0x4c23, 0, 0, 0, 0, 9)), NOT_ON_LINK); // another session's
        let release = message(RELEASE, &[client(), server(&DUID), ia(7, Some(LEASE))]);
        let (kind, options) = read(&answer(&release, LEASE, GATEWAY).unwrap());
        assert_eq!((kind, get(&options, STATUS_CODE)), (REPLY, Some(&[0, 0][..])));
    }

    #[test]
    fn information_alone() {
        let (kind, options) = read(&answer(&message(INFORMATION_REQUEST, &[]), LEASE, GATEWAY).unwrap());
        assert_eq!((kind, get(&options, SERVER_ID), get(&options, IA_NA)), (REPLY, Some(&DUID[..]), None));
    }

    #[test]
    fn what_goes_unanswered() {
        let unanswered = |m: Vec<u8>| answer(&m, LEASE, GATEWAY).is_none();
        assert!(unanswered(message(SOLICIT, &[ia(1, None)]))); // nobody asking
        assert!(unanswered(message(SOLICIT, &[client(), server(&DUID), ia(1, None)]))); // a server already in mind
        assert!(unanswered(message(SOLICIT, &[client()]))); // nothing to give
        assert!(unanswered(message(ADVERTISE, &[client(), server(&DUID)]))); // a server's message
        assert!(unanswered(message(CONFIRM, &[client(), ia(1, None)]))); // nothing to confirm
        let mut cut = message(SOLICIT, &[client(), ia(1, None)]);
        cut.pop();
        assert!(unanswered(cut)); // an option running past the end
        assert!(unanswered(vec![SOLICIT, 0]));
    }
}
