// `net warp`: the guest's network card, through the WARP client (warp.wasm),
// over a WebSocket to the edge. Loaded the first time a visitor asks; see
// ../net/index.ts for how a way out is chosen and how the guest hears of it.

import type { Machine } from "../machine.ts";
import type { Way } from "../net/index.ts";
import { formatBytes, status } from "../status.ts";
import { ApiError, type Call, type Device, openBytes, register, remove } from "./api.ts";
import { Core, DOWN, type Event, type Host } from "./core.ts";
import wasm from "./warp.wasm?url";

const STORE = "warp";

const BASE = `${import.meta.env.BASE_URL}warp/`;
const TICK = 10_000;
const ACCESS_DENIED = 49; // the TLS alert for a device the edge no longer knows

const call: Call = (path, init) => fetch(`${BASE}api${path}`, init);

function load(): Device | null {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? "null");
  } catch {
    return null;
  }
}

function save(device: Device | null) {
  try {
    if (device) localStorage.setItem(STORE, JSON.stringify(device));
    else localStorage.removeItem(STORE);
  } catch {
    // Private windows may refuse; the device then lasts this visit only.
  }
}

/** Deletes this browser's device, at Cloudflare and here. */
export async function forget(machine: Machine) {
  const device = load();
  save(null);
  machine.control("net forgotten");
  if (device) await remove(call, device).catch(() => {});
}

export class Warp implements Host, Way {
  private readonly machine: Machine;
  private core?: Core;
  private device?: Device;
  private socket?: WebSocket;
  private timer?: ReturnType<typeof setInterval>;
  private state: "off" | "connecting" | "up" | "down" = "off";
  /** The visitor asked for the network and has not turned it off since. */
  private wanted = false;
  private rx = 0;
  private tx = 0;
  private shown = 0;

  constructor(machine: Machine) {
    this.machine = machine;
    // Phones suspend background tabs and drop their sockets: come back up.
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && this.wanted && this.state === "down") void this.connect();
    });
  }

  async connect() {
    this.wanted = true;
    if (this.state === "up") return this.machine.control(this.up());
    if (this.state === "connecting") return;
    this.state = "connecting";
    status.net("connecting", "WARP 连接中");
    try {
      let device = load();
      if (!device) {
        status.net("connecting", "WARP 注册中");
        device = await register(call);
        save(device);
        this.machine.control("net known");
      }
      this.device = device;
      this.core ??= await Core.load(wasm, this);
    } catch (error) {
      return this.fail(error instanceof ApiError ? `api ${error.status}` : "api");
    }
    this.dial();
  }

  disconnect(quietly = false) {
    this.wanted = false;
    if (this.state === "off") return;
    this.state = "off";
    this.core?.close(); // close_notify, while the socket still takes it
    this.hangUp();
    if (!quietly) this.machine.control("net down off");
    status.net("off", "");
  }

  frame(frame: Uint8Array) {
    this.core?.fromGuest(frame);
  }

  /** WARP's tunnel: one address, the gateway the client answers ARP for, Cloudflare's DNS. */
  private up() {
    return `net up warp ${this.device!.v4}/32 172.16.0.1 1.1.1.1 1280`;
  }

  // ─── Host: what the WARP client hands back ─────────────────────────────────

  toSocket(bytes: Uint8Array<ArrayBuffer>) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(bytes);
    this.tx += bytes.length;
    this.show();
  }

  toGuest(frame: Uint8Array<ArrayBuffer>) {
    this.machine.sendFrame(frame);
  }

  event(event: Event) {
    if (event.kind === "up") {
      this.state = "up";
      this.machine.control(this.up());
      this.timer = setInterval(() => this.core?.tick(), TICK);
      return this.show(true);
    }
    if (event.code === DOWN.tls && event.detail === ACCESS_DENIED) {
      save(null); // gone at Cloudflare's end: register afresh next time
      return this.fail("denied");
    }
    const why: Record<number, string> = {
      [DOWN.pin]: "pin",
      [DOWN.refused]: `refused ${event.detail}`,
      [DOWN.timeout]: "timeout",
      [DOWN.closed]: "closed",
    };
    this.fail(why[event.code] ?? `edge ${event.code}`);
  }

  // ─── The socket ────────────────────────────────────────────────────────────

  private dial() {
    const url = new URL(`${BASE}edge`, location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      if (!this.core!.open(openBytes(this.device!))) this.fail("device");
    };
    socket.onmessage = ({ data }: MessageEvent<ArrayBuffer>) => {
      this.rx += data.byteLength;
      this.core!.fromSocket(new Uint8Array(data));
      this.show();
    };
    socket.onclose = () => {
      if (this.socket === socket) this.fail(this.state === "up" ? "closed" : "pipe");
    };
    this.socket = socket;
  }

  private fail(why: string) {
    if (this.state === "off" || this.state === "down") return;
    this.state = "down";
    this.hangUp();
    this.machine.control(`net down ${why}`);
    status.net("down", "WARP 已断开");
  }

  private hangUp() {
    clearInterval(this.timer);
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }

  /** The status line, at most twice a second. */
  private show(now = false) {
    if (this.state !== "up" || (!now && performance.now() - this.shown < 500)) return;
    this.shown = performance.now();
    status.net("up", `WARP  ↓${formatBytes(this.rx)}  ↑${formatBytes(this.tx)}`);
  }
}
