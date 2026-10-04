// `net on`: the guest's network card, through the relay (relay/), over one
// WebSocket. Every frame travels sealed — the protocol is described in
// relay/src/channel.rs, and WebCrypto does all of it. The password never
// leaves this page; only the key made from it is kept, in this browser.

import type { Machine } from "../machine.ts";
import type { Way } from "./index.ts";

const STORE = "relay";
const URL_ = import.meta.env.VITE_RELAY_URL || `${import.meta.env.BASE_URL}relay`;
/** QEMU's user network, as the relay serves it (relay/src/session.rs). */
const UP = "net up relay 10.0.2.15/24 10.0.2.2 10.0.2.3 1500";
const HANDSHAKE = 15_000;
/** What the relay's close codes mean (relay/src/server.rs), in the guest's words (net.fish). */
const CLOSED: Record<number, string> = { 1008: "badkey", 1013: "busy", 4001: "quota", 4002: "idle" };

const subtle = crypto.subtle;
const text = (s: string) => new TextEncoder().encode(s);
const MAGIC = text("GHR1");
// The machine's old name, kept: it is part of every key (relay/src/channel.rs).
const INFO = text("guest@home relay v1");
const HELLO = "hello";
const WELCOME = "welcome";

/** PBKDF2-HMAC-SHA256 of the password, as `relay key` makes it. */
export async function login(password: string) {
  const base = await subtle.importKey("raw", text(password), "PBKDF2", false, ["deriveBits"]);
  const params = { name: "PBKDF2", hash: "SHA-256", salt: text("guest@home relay"), iterations: 600_000 };
  const key = new Uint8Array(await subtle.deriveBits(params, base, 256));
  store(btoa(String.fromCharCode(...key)));
}

export function logout() {
  store(null);
}

function stored(): Uint8Array<ArrayBuffer> | null {
  try {
    const key = localStorage.getItem(STORE);
    return key ? Uint8Array.from(atob(key), (c) => c.charCodeAt(0)) : null;
  } catch {
    return null;
  }
}

function store(key: string | null) {
  try {
    if (key) localStorage.setItem(STORE, key);
    else localStorage.removeItem(STORE);
  } catch {
    // Private windows may refuse; the key then lasts this visit only.
  }
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
    const key = stored();
    if (!key) return this.fail("nokey", true);
    this.state = "connecting";

    const url = new URL(URL_, location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    const inbox = new Inbox(socket);
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      const why = CLOSED[event.code] ?? (this.state === "up" ? "closed" : "norelay");
      this.fail(why);
    };

    try {
      this.channel = await Channel.open(socket, inbox, key);
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
  private waiting?: (message: ArrayBuffer) => void;
  private sink?: (message: ArrayBuffer) => void;

  constructor(socket: WebSocket) {
    socket.onmessage = ({ data }: MessageEvent<ArrayBuffer>) => {
      if (this.sink) this.sink(data);
      else if (this.waiting) this.waiting(data);
      else this.queue.push(data);
    };
  }

  next(): Promise<ArrayBuffer> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      this.waiting = (message) => {
        this.waiting = undefined;
        resolve(message);
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

  static async open(socket: WebSocket, inbox: Inbox, key: Uint8Array<ArrayBuffer>): Promise<Channel> {
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
      socket.send(concat(MAGIC, nonce, mine));

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
