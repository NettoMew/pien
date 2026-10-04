// `net` on the page's side: the guest's network card, wired to one way out
// at a time — the relay (`net on`, relay.ts) or Cloudflare WARP (`net warp`,
// ../warp/). Only this much loads with the page; a way out is fetched the
// first time a visitor asks for it.
//
// The guest learns what happened over the control line (hostd):
//   net up <way> <address/prefix> <gateway> <dns> <mtu>
//   net down <why>

import type { Machine } from "../machine.ts";

/** A way out for the guest's frames. */
export interface Way {
  connect(): Promise<void>;
  /** Quietly: without telling the guest, which is about to hear from another way. */
  disconnect(quietly?: boolean): void;
  /** A frame the guest sent. */
  frame(frame: Uint8Array): void;
}

const WARP_DEVICE = "warp";

/** Whether this browser already has a WARP device (the guest then skips its notice). */
export function known(): boolean {
  try {
    return localStorage.getItem(WARP_DEVICE) !== null;
  } catch {
    return false;
  }
}

let wired = false;
let active: Way | undefined;
let relay: Promise<typeof import("./relay.ts")> | undefined;
let warp: Promise<typeof import("../warp/session.ts")> | undefined;
const ways = new Map<string, Way>();

let queue: Promise<unknown> = Promise.resolve();

/**
 * `net on`, `net warp`, `net off`, `net login;<password>`, `net logout`,
 * `net forget` — one after another, so a login is done before the `on` that
 * follows it looks for the key.
 */
export function net(verb: string, argument: string, machine: Machine) {
  queue = queue.then(() => handle(verb, argument, machine)).catch((error) => console.error("net:", error));
  return queue;
}

async function handle(verb: string, argument: string, machine: Machine) {
  if (!wired) {
    machine.onFrame((frame) => active?.frame(frame));
    wired = true;
  }
  relay ??= import("./relay.ts");
  switch (verb) {
    case "on": {
      const { Relay } = await relay;
      return through("relay", () => new Relay(machine));
    }
    case "warp": {
      const { Warp } = await (warp ??= import("../warp/session.ts"));
      return through("warp", () => new Warp(machine));
    }
    case "off":
      return active?.disconnect();
    case "login":
      return (await relay).login(decodeURIComponent(argument));
    case "logout":
      return (await relay).logout();
    case "forget": {
      const { forget } = await (warp ??= import("../warp/session.ts"));
      if (ways.get("warp") === active) active?.disconnect();
      return forget(machine);
    }
  }
}

/** Makes `name` the way out, making it first if need be; the one before steps aside quietly. */
async function through(name: string, make: () => Way) {
  const way = ways.get(name) ?? make();
  ways.set(name, way);
  if (active && active !== way) active.disconnect(true);
  active = way;
  await way.connect();
}
