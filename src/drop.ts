// Files from the visitor's computer, into the guest's ~/drop: dropped onto
// the page, or chosen after the guest's `drop`. Nothing is copied in. Each
// file becomes an entry in the guest's filesystem whose bytes v86 asks for
// as the guest reads them, straight from the visitor's disk, so an image of
// a few gigabytes costs nothing until, say, fastboot sends it on.
//
// The entries go into a directory of their own, /.drop/<n>, and hostd moves
// them into ~/drop (see image/rootfs/usr/libexec/home/hostd):
//   drop <n>      the files are there
//   drop none     the visitor chose none

import type { Machine } from "./machine.ts";

// v86's 9p filesystem, as far as this reaches into it: none of it is typed.
interface Inode {
  size: number;
  status: number;
  sha256sum: string;
  mode: number;
  uid: number;
  gid: number;
  mtime: number;
}
interface Storage {
  read(key: string, offset: number, count: number, size: number): Promise<Uint8Array | null>;
  uncache(key: string): void;
}
interface Filesystem {
  inodes: Inode[];
  storage: Storage;
  SearchPath(path: string): { id: number };
  CreateDirectory(name: string, parent: number): number;
  CreateFile(name: string, parent: number): number;
}

/** An inode whose bytes v86 keeps elsewhere, and asks its storage for. */
const ELSEWHERE = 2;
/** The guest's user. */
const GUEST = 1000;

/** The files behind the entries, by their storage keys. */
const files = new Map<string, File>();
const taught = new WeakSet<Filesystem>();
let batches = 0;

/** The machine's filesystem, its storage taught where dropped files' bytes are. */
function filesystem(machine: Machine): Filesystem {
  const fs = (machine.emulator as unknown as { fs9p: Filesystem }).fs9p;
  if (taught.has(fs)) return fs;
  const storage = fs.storage;
  fs.storage = Object.assign(Object.create(storage) as Storage, {
    async read(key: string, offset: number, count: number, size: number) {
      const file = files.get(key);
      if (!file) return storage.read(key, offset, count, size);
      return new Uint8Array(await file.slice(offset, offset + count).arrayBuffer());
    },
    // The guest wrote to the file: v86 holds the whole of it from now on.
    uncache(key: string) {
      if (!files.delete(key)) storage.uncache(key);
    },
  });
  taught.add(fs);
  return fs;
}

/** A name the guest's filesystem takes as it is: no slashes, no control characters. */
// oxlint-disable-next-line no-control-regex
const plain = (name: string) => name.replace(/[\x00-\x1f/]/g, "_").replace(/^\.{1,2}$/, "_") || "file";

/** Puts `chosen` into the guest's ~/drop. */
export function put(chosen: File[], machine: Machine): void {
  if (!chosen.length) return machine.control("drop none");
  const fs = filesystem(machine);
  const root = fs.SearchPath("/.drop").id;
  const batch = String(++batches);
  const dir = fs.CreateDirectory(batch, root === -1 ? fs.CreateDirectory(".drop", 0) : root);
  const named = new Set<string>();
  for (const file of chosen) {
    const name = plain(file.name);
    if (named.has(name)) continue;
    named.add(name);
    const key = `drop/${batch}/${name}`;
    Object.assign(fs.inodes[fs.CreateFile(name, dir)]!, {
      size: file.size,
      status: ELSEWHERE,
      sha256sum: key,
      mode: 0o100644,
      uid: GUEST,
      gid: GUEST,
      mtime: Math.floor(file.lastModified / 1000),
    } satisfies Partial<Inode>);
    files.set(key, file);
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
