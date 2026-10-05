// Files in the guest's filesystem whose bytes live elsewhere. v86 asks its
// 9p filesystem's storage for a file's bytes, by the file's key, as the guest
// reads them; this teaches that storage keys of the page's own, each with a
// way to read: a file on the visitor's disk (drop.ts), a file on the site
// (content.ts). Nothing is fetched or copied until the guest reads.

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
export const GUEST = 1000;

/** Reads `count` bytes at `offset`. */
export type Reader = (offset: number, count: number) => Promise<Uint8Array>;

/** How to read each file the page put there, by its key. */
const readers = new Map<string, Reader>();
const taught = new WeakSet<Filesystem>();

/** The machine's filesystem, its storage taught the page's keys. */
function filesystem(machine: Machine): Filesystem {
  const fs = (machine.emulator as unknown as { fs9p: Filesystem }).fs9p;
  if (taught.has(fs)) return fs;
  const storage = fs.storage;
  fs.storage = Object.assign(Object.create(storage) as Storage, {
    async read(key: string, offset: number, count: number, size: number) {
      const read = readers.get(key);
      return read ? read(offset, count) : storage.read(key, offset, count, size);
    },
    // The guest wrote to the file: v86 holds the whole of it from now on.
    uncache(key: string) {
      if (!readers.delete(key)) storage.uncache(key);
    },
  });
  taught.add(fs);
  return fs;
}

/** A name the guest's filesystem takes as it is: no slashes, no control characters. */
// oxlint-disable-next-line no-control-regex
export const plain = (name: string) => name.replace(/[\x00-\x1f/]/g, "_").replace(/^\.{1,2}$/, "_") || "file";

/** The directory `path`, made with any parents it lacks; those made are the guest's. Its inode. */
export function directory(machine: Machine, path: string): number {
  const fs = filesystem(machine);
  let at = 0;
  let walked = "";
  for (const name of path.split("/").filter(Boolean)) {
    walked += `/${name}`;
    const found = fs.SearchPath(walked).id;
    if (found !== -1) {
      at = found;
      continue;
    }
    at = fs.CreateDirectory(plain(name), at);
    Object.assign(fs.inodes[at]!, { uid: GUEST, gid: GUEST });
  }
  return at;
}

/** Puts the file `name` in directory `parent`, `size` bytes that `read` gives, under the storage key `key`. */
export function lend(machine: Machine, parent: number, name: string, size: number, key: string, read: Reader, mtime = Date.now() / 1000) {
  const fs = filesystem(machine);
  Object.assign(fs.inodes[fs.CreateFile(plain(name), parent)]!, {
    size,
    status: ELSEWHERE,
    sha256sum: key,
    mode: 0o100644,
    uid: GUEST,
    gid: GUEST,
    mtime: Math.floor(mtime),
  } satisfies Partial<Inode>);
  readers.set(key, read);
}

/** A reader for bytes already here. */
export const held =
  (data: Uint8Array): Reader =>
  async (offset, count) =>
    data.subarray(offset, offset + count);
