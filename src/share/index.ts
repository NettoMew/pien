// `share` on the page's side: a folder on the visitor's computer, in the
// guest at /mnt/<its name>, to read and to write (see
// image/rootfs/etc/fish/functions/share.fish and hostd). Only this much
// loads with the page; the rest comes with the first folder.
//
// The guest learns what happened over the control line (hostd):
//   share up <n> <rw|ro>    a folder is listed in /.share/<n>: put it in place
//   share down <n> <why>    … and let go of: take it away
//   share none <why>        no folder was shared, as asked

import type { Machine } from "../machine.ts";

let folder: Promise<typeof import("./folder.ts")> | undefined;
let queue: Promise<unknown> = Promise.resolve();

/** `share;open` and `share;off[;<n>]` from the guest, one after another. */
export function share(verb: string, machine: Machine, which = "") {
  queue = queue
    .then(async () => {
      const { open, release } = await (folder ??= import("./folder.ts"));
      if (verb === "open") await open(machine);
      if (verb === "off") await release(machine, /^\d+$/.test(which) ? Number(which) : undefined);
    })
    .catch((error) => console.error("share:", error));
  return queue;
}

/** Commits what was written, and lets go of every folder without a word: the machine is going away. */
export async function unwire() {
  if (folder) await (await folder).release();
}
