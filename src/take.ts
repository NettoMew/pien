// `take`: files from the guest, onto the visitor's computer (see
// image/rootfs/etc/fish/functions/take.fish). The guest lists what to take
// in a file of its own, a record of three fields for each, NUL after each:
//
//   f <name> <path>     a file, kept in the zip as <name>, read from <path>
//   d <name>/ <path>    a directory
//   l <name> <target>   a symbolic link
//
// and asks: `take <list> file <name>` saves one file as itself, `take <list>
// zip <name>` all of them as a zip (zip.ts). The bytes come straight out of
// v86's filesystem, where the guest's files are. Chromium on a computer
// writes them to the place the visitor chooses as they come; elsewhere they
// are gathered, and downloaded.

import { Download } from "lucide-react";
import { No } from "./no.ts";
import { gesture, touched } from "./gesture.ts";
import type { Machine } from "./machine.ts";
import { type Entry, zip } from "./zip.ts";

// v86's 9p filesystem, as far as this reaches into it.
interface Inode {
  mode: number;
  size: number;
  mtime: number;
}
interface Filesystem {
  inodes: Inode[];
  SearchPath(path: string): { id: number };
  Read(id: number, offset: number, count: number): Promise<Uint8Array | null>;
}

/** How much to read at a time. */
const PIECE = 1 << 20;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

/** Where the bytes go: a file the visitor chose, or a download. */
interface Sink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

export async function take(words: string[], machine: Machine): Promise<string[]> {
  const [list, how, name] = words;
  if (!list || (how !== "file" && how !== "zip") || !name) throw new No("take: a list, file or zip, and a name.");
  const fs = (machine.emulator as unknown as { fs9p: Filesystem }).fs9p;
  const entries = await listed(fs, list);
  if (how === "file" && entries.length !== 1) throw new No("take: one file, or a zip.");

  const sink = await choose(name);
  let size: number;
  try {
    if (how === "file") {
      size = 0;
      for await (const piece of entries[0]!.read()) {
        await sink.write(piece);
        size += piece.length;
      }
    } else size = await zip(entries, (chunk) => sink.write(chunk));
  } catch (error) {
    await sink.abort().catch(() => {});
    throw error;
  }
  await sink.close();
  return [`  Saved ${name}, ${bytes(size)}.`];
}

/** The guest's list, as entries whose bytes are read from the filesystem when the zip wants them. */
async function listed(fs: Filesystem, list: string): Promise<Entry[]> {
  const fields = new TextDecoder().decode(await whole(fs, list)).split("\0");
  fields.pop();
  if (fields.length % 3) throw new No("take: the list is not whole.");
  const entries: Entry[] = [];
  for (let at = 0; at < fields.length; at += 3) {
    const [kind, name, value] = fields.slice(at, at + 3) as [string, string, string];
    if (kind === "l") {
      const target = new TextEncoder().encode(value);
      entries.push({ name, mode: S_IFLNK | 0o777, mtime: Date.now() / 1000, size: target.length, read: async function* () { yield target; } });
      continue;
    }
    const id = fs.SearchPath(value).id;
    const inode = fs.inodes[id];
    if (id === -1 || !inode) throw new No(`take: ${value} went away.`);
    if (kind === "d") {
      entries.push({ name, mode: S_IFDIR | (inode.mode & 0o7777), mtime: inode.mtime, size: 0, read: async function* () {} });
      continue;
    }
    entries.push({ name, mode: inode.mode, mtime: inode.mtime, size: inode.size, read: () => pieces(fs, id, inode.size) });
  }
  return entries;
}

async function* pieces(fs: Filesystem, id: number, size: number) {
  for (let offset = 0; offset < size; offset += PIECE) {
    const piece = await fs.Read(id, offset, Math.min(PIECE, size - offset));
    if (!piece) throw new No("take: a file could not be read.");
    yield piece;
  }
}

async function whole(fs: Filesystem, path: string) {
  const id = fs.SearchPath(path).id;
  const inode = fs.inodes[id];
  if (id === -1 || !inode) throw new No("take: no list.");
  return (await fs.Read(id, 0, inode.size)) ?? new Uint8Array(0);
}

/**
 * Where to save `name`: a file the visitor chooses, written as the bytes
 * come, where the browser can (Chromium on a computer); else the bytes are
 * gathered, and downloaded once all are here. The browser lets either
 * happen only as the visitor touches the page.
 */
async function choose(name: string): Promise<Sink> {
  const picker = window.showSaveFilePicker?.bind(window);
  if (picker) {
    let handle: FileSystemFileHandle;
    try {
      handle = await gesture(`Save ${name}`, Download, () => picker({ suggestedName: name, id: "take" }));
    } catch (error) {
      throw error instanceof DOMException && error.name === "AbortError" ? new No("Not saved.") : error;
    }
    const writable = await handle.createWritable();
    return {
      write: (chunk) => writable.write(chunk as Uint8Array<ArrayBuffer>),
      close: () => writable.close(),
      abort: () => writable.abort(),
    };
  }
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  return {
    async write(chunk) {
      chunks.push(chunk.slice());
    },
    async close() {
      const url = URL.createObjectURL(new Blob(chunks));
      try {
        await gesture(`Save ${name}`, Download, () => {
          touched();
          Object.assign(document.createElement("a"), { href: url, download: name }).click();
        });
      } finally {
        // Long enough for the browser to have started the download.
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    },
    async abort() {},
  };
}

function bytes(size: number) {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return unit ? `${size.toFixed(1)} ${units[unit]}` : `${size} bytes`;
}
