// adb, fastboot and usb on the page's side: a phone on this computer's USB,
// bridged to the workbench's own tools through ports of the console (see
// image/workbench/fish/vendor_functions.d/ and hostd). Only this much loads
// with the page; WebUSB and the two protocols come the first time a tool
// asks for a phone.
//
// The guest learns what happened over the control line (hostd):
//   usb key <private> <public> <name>   this browser's adb key
//   usb up <tool> <serial> <name>
//   usb down <tool> <why>

import type { Machine } from "../machine.ts";

export type Tool = "adb" | "fastboot";

let devices: Promise<typeof import("./devices.ts")> | undefined;
let queue: Promise<unknown> = Promise.resolve();

/** `usb;adb`, `usb;fastboot` and `usb;off` from the guest, one after another. */
export function usb(verb: string, machine: Machine) {
  queue = queue
    .then(async () => {
      const { attach, release } = await (devices ??= import("./devices.ts"));
      if (verb === "adb" || verb === "fastboot") await attach(verb, machine);
      if (verb === "off") await release(machine);
    })
    .catch((error) => console.error("usb:", error));
  return queue;
}

/**
 * Hands the workbench this browser's adb key, made the first time. Without
 * storage to keep one in, adb makes its own, for this visit only.
 */
export async function introduce(machine: Machine) {
  try {
    const { adbKey } = await import("./key.ts");
    const key = await adbKey();
    machine.control(`usb key ${key.private} ${key.public} ${key.name}`);
  } catch (error) {
    console.warn("usb: no adb key kept in this browser:", error);
  }
}

/** Lets go of the phone without a word: the machine it was joined to is going away. */
export async function unwire() {
  if (devices) await (await devices).release();
}
