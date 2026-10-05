// `net on`: the guest's network card, through a relay (relay/), over one
// WebSocket. Every frame travels sealed — the protocol is described in
// relay/src/channel.rs, and WebCrypto does all of it. This site's relay
// takes the owner's login (../account/); a visitor's own relay, the key it
// was given (relays.ts). Neither key ever travels.

import { current } from "../account/login.ts";
import type { Machine } from "../machine.ts";
import type { Way } from "./index.ts";
import { chosen, forget } from "./relays.ts";

/** QEMU's user network, as the relay serves it (relay/src/session.rs). */
const UP = "net up relay 10.0.2.15/24 10.0.2.2 10.0.2.3 1500";
const HANDSHAKE = 15_000;
/** What the relay's close codes mean (relay/src/server.rs), in the guest's words (net.fish). */
const CLOSED: Record<number, string> = { 1013: "busy", 4001: "quota", 4002: "idle" };

const subtle = crypto.subtle;
const text = (s: string) => new TextEncoder().encode(s);
/** A hello with a relay's own key, or with the site's login token. */
const MAGIC = text("GHR1");
const MAGIC_TOKEN = text("GHR2");
// The machine's old name, kept: it is part of every key (relay/src/channel.rs).
const INFO = text("guest@home relay v1");
const HELLO = "hello";
const WELCOME = "welcome";

const fromBase64Url = (data: string) => Uint8Array.from(atob(data.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/** How to open the channel: what the hello says, and the key it opens with. */
interface Opening {
  hello: (nonce: Uint8Array, point: Uint8Array) => Uint8Array<ArrayBuffer>;
  key: Uint8Array<ArrayBuffer>;
}

export class Relay implements Way {
  private readonly machine: Machine;
  private socket?: WebSocket;
  private channel?: Channel;
  private state: "off" | "connecting" | "up" | "down" = "off";
  private wanted = false;

  constructor(machine: Machine) {
    this.machine = machine;
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && this.wanted && this.state === "down") void this.connect();
    });
  }

  async connect() {
    this.wanted = true;
    if (this.state === "up") return this.machine.control(UP);
    if (this.state === "connecting") return;
    const relay = chosen();
    const login = current();
    let opening: Opening;
    if (relay.key) opening = { hello: (nonce, point) => concat(MAGIC, nonce, point), key: relay.key };
    else if (relay.own) return this.fail("nokey", true);
    else if (login) {
      const token = fromBase64Url(login.token);
      opening = { hello: (nonce, point) => concat(MAGIC_TOKEN, nonce, point, token), key: fromBase64Url(login.key) };
    } else return this.fail("login", true);
    this.state = "connecting";

    const socket = new WebSocket(relay.url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    const inbox = new Inbox(socket);
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      let why = CLOSED[event.code] ?? (this.state === "up" ? "closed" : "norelay");
      // Turned away: the key, or the login, was not the relay's. A wrong key
      // is forgotten, so that the next try asks for it again.
      if (event.code === 1008) {
        why = relay.own ? "badkey" : "badlogin";
        if (relay.own) forget(relay.url);
      }
      this.fail(why);
    };

    try {
      this.channel = await Channel.open(socket, inbox, opening);
    } catch {
      return socket.readyState === WebSocket.OPEN ? this.fail("protocol") : undefined; // onclose says why
    }
    if (this.socket !== socket) return;
    inbox.drain((sealed) => {
      this.channel!.open(sealed).then(
        (frame) => this.machine.sendFrame(frame),
        () => this.fail("protocol"),
      );
    });
    this.state = "up";
    this.machine.control(UP);
  }

  disconnect(quietly = false) {
    this.wanted = false;
    if (this.state === "off") return;
    this.state = "off";
    this.hangUp();
    if (!quietly) this.machine.control("net down off");
  }

  frame(frame: Uint8Array) {
    if (this.state !== "up" || !this.channel) return;
    this.channel.seal(frame);
  }

  private fail(why: string, quietly = false) {
    if (!quietly && (this.state === "off" || this.state === "down")) return;
    this.state = "down";
    this.hangUp();
    this.machine.control(`net down ${why}`);
  }

  private hangUp() {
    const socket = this.socket;
    this.socket = undefined;
    this.channel = undefined;
    socket?.close();
  }
}

// ─── The channel ─────────────────────────────────────────────────────────────

/** Messages from the socket, waited for one at a time, then handed over as they come. */
class Inbox {
  private readonly queue: ArrayBuffer[] = [];
  private waiting?: { resolve: (message: ArrayBuffer) => void; reject: (error: Error) => void };
  private sink?: (message: ArrayBuffer) => void;
  private closed = false;

  constructor(socket: WebSocket) {
    socket.onmessage = ({ data }: MessageEvent<ArrayBuffer>) => {
      if (this.sink) this.sink(data);
      else if (this.waiting) this.waiting.resolve(data);
      else this.queue.push(data);
    };
    // A relay that turns the key away hangs up instead of answering: whoever
    // waits for the answer must hear of that too.
    socket.addEventListener("close", () => {
      this.closed = true;
      this.waiting?.reject(new Error("closed"));
    });
  }

  next(): Promise<ArrayBuffer> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closed) return Promise.reject(new Error("closed"));
    return new Promise((resolve, reject) => {
      this.waiting = {
        resolve: (message) => {
          this.waiting = undefined;
          resolve(message);
        },
        reject: (error) => {
          this.waiting = undefined;
          reject(error);
        },
      };
    });
  }

  drain(sink: (message: ArrayBuffer) => void) {
    this.sink = sink;
    for (const message of this.queue.splice(0)) sink(message);
  }
}

class Channel {
  private readonly socket: WebSocket;
  private readonly sealing: CryptoKey;
  private readonly opening: CryptoKey;
  private sent = 0;
  private received = 0;
  /** Seals finish in any order; sends must not. */
  private sending: Promise<unknown> = Promise.resolve();
  private opened: Promise<unknown> = Promise.resolve();

  private constructor(socket: WebSocket, sealing: CryptoKey, opening: CryptoKey) {
    this.socket = socket;
    this.sealing = sealing;
    this.opening = opening;
  }

  static async open(socket: WebSocket, inbox: Inbox, { hello, key }: Opening): Promise<Channel> {
    await new Promise<void>((resolve, reject) => {
      if (socket.readyState === WebSocket.OPEN) return resolve();
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("close", () => reject(new Error("closed")), { once: true });
    });
    const timeout = setTimeout(() => socket.close(), HANDSHAKE);
    try {
      const ecdh = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
      const mine = new Uint8Array(await subtle.exportKey("raw", ecdh.publicKey));
      const nonce = crypto.getRandomValues(new Uint8Array(16));
      socket.send(hello(nonce, mine));

      const reply = new Uint8Array(await inbox.next());
      if (reply.length !== 16 + 65) throw new Error("not a reply");
      const theirs = await subtle.importKey("raw", reply.slice(16), { name: "ECDH", namedCurve: "P-256" }, false, []);
      const shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: theirs }, ecdh.privateKey, 256));
      const ikm = await subtle.importKey("raw", concat(key, shared), "HKDF", false, ["deriveBits"]);
      const params = { name: "HKDF", hash: "SHA-256", salt: concat(nonce, reply.slice(0, 16)), info: INFO };
      const okm = new Uint8Array(await subtle.deriveBits(params, ikm, 512));
      const sealing = await subtle.importKey("raw", okm.slice(0, 32), "AES-GCM", false, ["encrypt"]);
      const opening = await subtle.importKey("raw", okm.slice(32), "AES-GCM", false, ["decrypt"]);
      const channel = new Channel(socket, sealing, opening);

      channel.seal(text(HELLO));
      const welcome = await channel.open(await inbox.next());
      if (new TextDecoder().decode(welcome) !== WELCOME) throw new Error("no welcome");
      return channel;
    } finally {
      clearTimeout(timeout);
    }
  }

  seal(plaintext: Uint8Array) {
    const sealed = subtle.encrypt({ name: "AES-GCM", iv: nonce(this.sent++) }, this.sealing, plaintext as BufferSource);
    this.sending = this.sending.then(async () => {
      const message = await sealed;
      if (this.socket.readyState === WebSocket.OPEN) this.socket.send(message);
    });
  }

  /** Opens messages strictly in the order they arrived. */
  open(sealed: ArrayBuffer): Promise<Uint8Array<ArrayBuffer>> {
    const iv = nonce(this.received++);
    const opened = this.opened.then(() => subtle.decrypt({ name: "AES-GCM", iv }, this.opening, sealed));
    this.opened = opened.catch(() => {});
    return opened.then((plaintext) => new Uint8Array(plaintext));
  }
}

/** 4 zero bytes, then a 64-bit big-endian counter. */
function nonce(counter: number) {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setBigUint64(4, BigInt(counter));
  return iv;
}

function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
