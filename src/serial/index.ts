// `serial` on the page's side: a serial port on this computer, lent to the
// guest as its ttyS2 (see image/rootfs/etc/fish/functions/serial.fish and
// hostd). Only this much loads with the page; the rest comes with the first
// port.
//
// The guest learns what happened over the control line (hostd):
//   serial up <name>
//   serial down <why>

import type { Machine } from "../machine.ts";

let bridge: Promise<typeof import("./bridge.ts")> | undefined;
let queue: Promise<unknown> = Promise.resolve();

/** `serial;open` and `serial;off` from the guest, one after another. */
export function serial(verb: string, machine: Machine) {
  queue = queue
    .then(async () => {
      const { open, release } = await (bridge ??= import("./bridge.ts"));
      if (verb === "open") await open(machine);
      if (verb === "off") await release(machine);
    })
    .catch((error) => console.error("serial:", error));
  return queue;
}

/** Lets go of the port without a word: the machine it was lent to is going away. */
export async function unwire() {
  if (bridge) await (await bridge).release();
}
