// What each program in the image loads as it starts: the shared libraries it
// names, and theirs, all the way down, as the files the 9p filesystem knows
// them by. The page fetches them all at once the moment the guest first
// reads the program (src/prefetch.ts), where the dynamic linker would ask
// for one after another, a round trip each.

import { posix } from "node:path";
import { blobName, type RootFS } from "./rootfs.ts";

/** Where musl looks for a library named without a slash. */
const SEARCH = ["/lib", "/usr/local/lib", "/usr/lib"];
/** musl's loader and C library in one: every process has it already, so it is never worth fetching ahead. */
const LOADER = /^ld-musl-[^/]+\.so\.1$/;
/** The shell, always running: what it loaded is in the guest's memory already, nothing to fetch ahead either. */
const SHELL = "/usr/bin/fish";

const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const DT_NEEDED = 1;
const DT_STRTAB = 5;

/** The libraries an ELF file names (DT_NEEDED), or undefined if it is not one with any. */
export function needed(data: Buffer): string[] | undefined {
  if (data.length < 52 || data.readUInt32BE(0) !== 0x7f454c46 || data[5] !== 1) return undefined; // ELF, little-endian
  const wide = data[4] === 2;
  const word = (at: number) => (wide ? Number(data.readBigUInt64LE(at)) : data.readUInt32LE(at));
  const [phoff, phentsize, phnum] = wide
    ? [word(0x20), data.readUInt16LE(0x36), data.readUInt16LE(0x38)]
    : [word(0x1c), data.readUInt16LE(0x2a), data.readUInt16LE(0x2c)];

  const loads: { offset: number; vaddr: number; size: number }[] = [];
  let dynamic: { offset: number; size: number } | undefined;
  for (let i = 0; i < phnum; i++) {
    const at = phoff + i * phentsize;
    if (at + phentsize > data.length) return undefined;
    const type = data.readUInt32LE(at);
    const [offset, vaddr, size] = wide ? [word(at + 8), word(at + 16), word(at + 32)] : [word(at + 4), word(at + 8), word(at + 16)];
    if (type === PT_LOAD) loads.push({ offset, vaddr, size });
    if (type === PT_DYNAMIC) dynamic = { offset, size };
  }
  if (!dynamic) return undefined;

  const entry = wide ? 16 : 8;
  const names: number[] = [];
  let strtab: number | undefined;
  for (let at = dynamic.offset; at + entry <= Math.min(dynamic.offset + dynamic.size, data.length); at += entry) {
    const [tag, value] = [word(at), word(at + entry / 2)];
    if (tag === 0) break;
    if (tag === DT_NEEDED) names.push(value);
    if (tag === DT_STRTAB) strtab = value;
  }
  // The string table is given as an address: find it in the file.
  const load = strtab === undefined ? undefined : loads.find(({ vaddr, size }) => strtab! >= vaddr && strtab! < vaddr + size);
  if (!load || !names.length) return undefined;
  const table = load.offset + (strtab! - load.vaddr);
  return names.map((name) => {
    const start = table + name;
    return data.toString("latin1", start, data.indexOf(0, start));
  });
}

/** Each program's libraries, all the way down, by blob: what the page fetches together. */
export function libraries(rootfs: RootFS): Record<string, string[]> {
  /** Where a library named `name` is, and its bytes. */
  const find = (name: string) => {
    for (const dir of name.includes("/") ? [""] : SEARCH) {
      const path = posix.join(dir, name);
      const node = rootfs.get(path, { follow: true });
      if (node?.kind === "file") return { path: resolved(path), data: node.data };
    }
    return undefined;
  };
  /** `path` with its symlinks followed, so that one library is one entry however it is named. */
  const resolved = (path: string): string => {
    const node = rootfs.get(path);
    return node?.kind === "symlink" ? resolved(posix.resolve(posix.dirname(path), node.target)) : path;
  };

  /** The libraries the ELF `data` loads, all the way down: their blobs, by where they are. */
  const closure = (data: Buffer) => {
    const found = new Map<string, string>();
    const queue = [...(needed(data) ?? [])];
    while (queue.length) {
      const library = find(queue.shift()!);
      if (!library || found.has(library.path)) continue;
      found.set(library.path, blobName(library.data));
      queue.push(...(needed(library.data) ?? []));
    }
    return found;
  };

  const shell = rootfs.get(SHELL, { follow: true });
  const resident = new Set(shell?.kind === "file" ? closure(shell.data).values() : []);
  const out: Record<string, string[]> = {};
  for (const [, node] of rootfs.walk()) {
    if (node.kind !== "file" || !(node.mode & 0o111) || !needed(node.data)) continue;
    const blobs = [...closure(node.data)].filter(([at, blob]) => !LOADER.test(posix.basename(at)) && !resident.has(blob)).map(([, blob]) => blob);
    if (blobs.length) out[blobName(node.data)] = [...new Set(blobs)].sort();
  }
  return out;
}
