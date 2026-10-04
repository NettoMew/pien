// `net` on the page's side. All that loads with the page is this: whether
// this browser already has a WARP device (then the guest skips its notice).
// The client itself — session.ts and warp.wasm — comes when a visitor asks.

import type { Machine } from "../machine.ts";

export const STORE = "warp";

export function known(): boolean {
  try {
    return localStorage.getItem(STORE) !== null;
  } catch {
    return false;
  }
}

let session: Promise<typeof import("./session.ts")> | undefined;

/** `net warp`, `net off`, `net forget`, as printed by the guest's net command. */
export async function net(verb: string, machine: Machine) {
  session ??= import("./session.ts");
  await (await session).handle(verb, machine);
}
