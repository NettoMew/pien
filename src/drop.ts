// Files from the visitor's computer, into the guest's ~/drop: dropped onto
// the page, or chosen after the guest's `drop`. Nothing is copied in. Each
// file becomes an entry in the guest's filesystem whose bytes are read from
// the visitor's disk as the guest reads them (elsewhere.ts), so an image of a
// few gigabytes costs nothing until, say, fastboot sends it on.
//
// The entries go into a directory of their own, /.drop/<n>, and hostd moves
// them into ~/drop (see image/rootfs/usr/libexec/home/hostd):
//   drop <n>      the files are there
//   drop none     the visitor chose none

import { directory, lend, plain } from "./elsewhere.ts";
import type { Machine } from "./machine.ts";

let batches = 0;

/** Puts `chosen` into the guest's ~/drop. */
export function put(chosen: File[], machine: Machine): void {
  if (!chosen.length) return machine.control("drop none");
  const batch = String(++batches);
  const dir = directory(machine, `/.drop/${batch}`);
  const named = new Set<string>();
  for (const file of chosen) {
    const name = plain(file.name);
    if (named.has(name)) continue;
    named.add(name);
    const read = async (offset: number, count: number) => new Uint8Array(await file.slice(offset, offset + count).arrayBuffer());
    lend(machine, dir, name, file.size, `drop/${batch}/${name}`, read, file.lastModified / 1000);
  }
  machine.control(`drop ${batch}`);
}

/**
 * The guest's `drop`: the browser's file chooser. The key press that ran the
 * command is what lets the page open it; without one, nothing was chosen.
 */
export function pick(machine: Machine): void {
  if (navigator.userActivation && !navigator.userActivation.isActive) return machine.control("drop none");
  const input = Object.assign(document.createElement("input"), { type: "file", multiple: true });
  input.addEventListener("change", () => put([...(input.files ?? [])], machine));
  input.addEventListener("cancel", () => machine.control("drop none"));
  input.click();
}
