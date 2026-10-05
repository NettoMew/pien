// `net` on the page's side: the guest's network card, wired to a way out,
// the relay (`net on`, relay.ts). Only this much loads with the page; the way
// out is fetched the first time a visitor asks for it. (Cloudflare WARP, the
// other way, is sealed since 2026-10-05; see docs/warp.md.)
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

/** The machine whose network card is wired to `active`. */
let wired: Machine | undefined;
let active: Way | undefined;
let relay: Promise<typeof import("./relay.ts")> | undefined;
const ways = new Map<string, Way>();

let queue: Promise<unknown> = Promise.resolve();

/**
 * `net on`, `net off`, `net login;<password>`, `net logout`, one after
 * another, so a login is done before the `on` that follows it looks for the key.
 */
export function net(verb: string, argument: string, machine: Machine) {
  queue = queue.then(() => handle(verb, argument, machine)).catch((error) => console.error("net:", error));
  return queue;
}

async function handle(verb: string, argument: string, machine: Machine) {
  if (wired !== machine) {
    machine.onFrame((frame) => wired === machine && active?.frame(frame));
    wired = machine;
  }
  relay ??= import("./relay.ts");
  switch (verb) {
    case "on": {
      const { Relay } = await relay;
      return through("relay", () => new Relay(machine));
    }
    case "off":
      return active?.disconnect();
    case "login":
      return (await relay).login(decodeURIComponent(argument));
    case "logout":
      return (await relay).logout();
  }
}

/** Lets go of the machine that is going away, its ways out with it. */
export function unwire() {
  active?.disconnect(true);
  active = undefined;
  ways.clear();
  wired = undefined;
}

/** Makes `name` the way out, making it first if need be; the one before steps aside quietly. */
async function through(name: string, make: () => Way) {
  const way = ways.get(name) ?? make();
  ways.set(name, way);
  if (active && active !== way) active.disconnect(true);
  active = way;
  await way.connect();
}
