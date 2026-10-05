// `usb` on the page's side: the visitor's USB devices, lent to the guest over
// USB/IP (see image/rootfs/etc/fish/functions/usb.fish and hostd). Only this
// much loads with the page; WebUSB and USB/IP come with the first device.
//
// The guest learns what happened over the control line (hostd):
//   usb key <private> <public> <name>   this browser's adb key, before a phone with adb is lent
//   usb attach <port> <busid> <name>    a device to attach, through that port of the console
//   usb up <port>                       … and the guest has configured it: it is the visitor's
//   usb detach <port> <why>             a device taken back, or gone
//   usb down <why>                      no device lent, as asked

import type { Machine } from "../machine.ts";

let devices: Promise<typeof import("./devices.ts")> | undefined;
let queue: Promise<unknown> = Promise.resolve();

/** `usb;open;<kinds>` and `usb;off` from the guest, one after another. */
export function usb(verb: string, machine: Machine, kinds = "") {
  queue = queue
    .then(async () => {
      const { attach, release } = await (devices ??= import("./devices.ts"));
      if (verb === "open") await attach(machine, kinds);
      if (verb === "off") await release(machine);
    })
    .catch((error) => console.error("usb:", error));
  return queue;
}

/** Lets go of every device without a word: the machine they were lent to is going away. */
export async function unwire() {
  if (devices) await (await devices).release();
}
