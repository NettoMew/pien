// Programs start sooner the first time. A program's file is read the moment
// the guest runs it; then the dynamic linker opens its libraries one after
// another, each a fetch from the site, a round trip apiece. So when the guest
// first reads a program, the page fetches all of its libraries at once
// (scripts/lib/libraries.ts lists them at build time); by the time the
// linker asks, they are here or on their way. One already on its way is
// waited for, not fetched again.

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

/** Teaches the machine's filesystem to fetch each program's libraries the first time it is read. */
export async function prefetch(machine: Machine): Promise<void> {
  let libraries: Record<string, string[]>;
  try {
    libraries = await (await fetch(`${import.meta.env.BASE_URL}vm/${manifest.files.libraries}`)).json();
  } catch {
    return; // then one at a time, as before
  }
  const fs = (machine.emulator as unknown as { fs9p: Filesystem }).fs9p;
  const sizes = new Map(fs.inodes.flatMap((inode) => (inode?.sha256sum ? [[inode.sha256sum, inode.size] as const] : [])));
  const storage = fs.storage;
  /** Every library asked for ahead, until it is here (v86 keeps what it fetched). */
  const coming = new Map<string, Promise<unknown>>();
  const programs = new Set(Object.keys(libraries));

  fs.storage = Object.assign(Object.create(storage) as Storage, {
    async read(key: string, offset: number, count: number, size: number) {
      if (programs.delete(key)) {
        for (const library of libraries[key]!) {
          if (coming.has(library)) continue;
          const fetched = storage.read(library, 0, 1, sizes.get(library) ?? 0).catch(() => {});
          coming.set(library, fetched);
        }
      }
      await coming.get(key);
      return storage.read(key, offset, count, size);
    },
  });
}
