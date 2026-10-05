// Programs start sooner the first time. A program's file is read the moment
// the guest runs it; then the dynamic linker opens its libraries one after
// another, and Python its modules, each a fetch from the site, a round trip
// apiece. So when the guest first reads a program, the page fetches all it
// will read as it starts at once: its libraries, as the build lists them
// (scripts/lib/libraries.ts), and for Python's tools everything they read,
// as the build traced it (scripts/build-prefetch.ts). By the time the guest
// asks, it is here or on its way. What is already on its way is waited for,
// not fetched again.

import manifest from "virtual:vm-manifest";
import type { Machine } from "./machine.ts";

// v86's 9p filesystem, as far as this reaches into it.
interface Storage {
  read(key: string, offset: number, count: number, size: number): Promise<Uint8Array | null>;
}
interface Filesystem {
  inodes: ({ sha256sum: string; size: number } | undefined)[];
  storage: Storage;
}

/** Teaches the machine's filesystem to fetch what each program reads as it starts, the first time it is read. */
export async function prefetch(machine: Machine): Promise<void> {
  let starts: Record<string, string[]>;
  try {
    starts = await (await fetch(`${import.meta.env.BASE_URL}vm/${manifest.files.prefetch}`)).json();
  } catch {
    return; // then one at a time, as before
  }
  const fs = (machine.emulator as unknown as { fs9p: Filesystem }).fs9p;
  const sizes = new Map(fs.inodes.flatMap((inode) => (inode?.sha256sum ? [[inode.sha256sum, inode.size] as const] : [])));
  const storage = fs.storage;
  /** Every file asked for ahead, until it is here (v86 keeps what it fetched). */
  const coming = new Map<string, Promise<unknown>>();
  const programs = new Set(Object.keys(starts));

  fs.storage = Object.assign(Object.create(storage) as Storage, {
    async read(key: string, offset: number, count: number, size: number) {
      if (programs.delete(key)) {
        for (const file of starts[key]!) {
          if (coming.has(file)) continue;
          coming.set(file, storage.read(file, 0, 1, sizes.get(file) ?? 0).catch(() => {}));
        }
      }
      await coming.get(key);
      return storage.read(key, offset, count, size);
    },
  });
}
