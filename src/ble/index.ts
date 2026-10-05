// `ble` on the page's side: a Bluetooth LE device's serial service, lent to
// the guest as its ttyS3 (see image/rootfs/etc/fish/functions/ble.fish and
// hostd). Only this much loads with the page; the rest comes with the first
// device.
//
// The guest learns what happened over the control line (hostd):
//   ble up <name>      the device's name, and its service's
//   ble down <why>

import type { Machine } from "../machine.ts";

let bridge: Promise<typeof import("./bridge.ts")> | undefined;
let queue: Promise<unknown> = Promise.resolve();

/** `ble;open[;<service>]` and `ble;off` from the guest, one after another. */
export function ble(verb: string, machine: Machine, service?: string) {
  queue = queue
    .then(async () => {
      const { open, release } = await (bridge ??= import("./bridge.ts"));
      if (verb === "open") await open(machine, service || undefined);
      if (verb === "off") await release(machine);
    })
    .catch((error) => console.error("ble:", error));
  return queue;
}

/** Lets go of the device without a word: the machine it was lent to is going away. */
export async function unwire() {
  if (bridge) await (await bridge).release();
}
