// A folder on the visitor's computer, in the guest, to read and to write:
// Chromium on a computer lets the visitor choose one. It is listed once, as
// it is shared, into a directory of the guest's 9p filesystem, which hostd
// then moves to /mnt; its files are read as the guest reads them, never
// copied in (elsewhere.ts). What the guest does in it goes back to the
// folder as it happens, for this takes v86's filesystem over for the
// share's inodes:
//
//   write, truncate    into a writable stream on the file, made the first
//                      time it is written, and committed when the guest
//                      closes the file, reads it, or writes nothing to it
//                      for two seconds
//   create, mkdir,     the same in the folder, one after another, in the
//   unlink, rename     order the guest did them
//
// Modes, owners, times and links stay in the guest: the folder keeps none
// of them. A rename into the share or out of it is a move between
// filesystems: EXDEV, and mv copies. Letting go of a folder never touches
// it: the page lets go first, and the guest's copy of the listing goes after.

import { FolderOpen } from "lucide-react";
import { adopt, forget, GUEST, type Reader } from "../elsewhere.ts";
import { gesture } from "../gesture.ts";
import type { Machine } from "../machine.ts";

// v86's 9p filesystem, as far as this reaches into it.
interface Inode {
  mode: number;
  size: number;
  mtime: number;
  uid: number;
  gid: number;
}
interface Filesystem {
  inodes: Inode[];
  SearchPath(path: string): { id: number };
  Search(parent: number, name: string): number;
  CreateDirectory(name: string, parent: number): number;
  CreateFile(name: string, parent: number): number;
  Unlink(parent: number, name: string): number;
  Link(parent: number, target: number, name: string): number;
  Rename(fromDirectory: number, from: string, toDirectory: number, to: string): Promise<number>;
  Write(id: number, offset: number, count: number, buffer: Uint8Array): Promise<void>;
  ChangeSize(id: number, size: number): Promise<void>;
  CloseInode(id: number): Promise<void>;
  DeleteNode(path: string): void;
}
type Methods = Pick<Filesystem, "CreateDirectory" | "CreateFile" | "Unlink" | "Link" | "Rename" | "Write" | "ChangeSize" | "CloseInode">;

const EPERM = 1;
const EXDEV = 18;

/** A folder too big to list at once is better shared a part at a time. */
const LIMIT = 100_000;
/** How long a file may go without a write before what was written is committed. */
const QUIET_MS = 2000;

interface Share {
  number: number;
  /** Its directory in the guest. */
  root: number;
  /** What it did to the folder, one after another. */
  queue: Promise<unknown>;
}

/** A directory of a share's, or a file: the folder's own, or one being made in it. */
interface Node {
  share: Share;
  handle: Promise<FileSystemDirectoryHandle | FileSystemFileHandle>;
}
interface File extends Node {
  handle: Promise<FileSystemFileHandle>;
  key: string;
  /** The file as it was when last committed, for reading. */
  snapshot?: Promise<globalThis.File>;
  /** The writes since. */
  writer?: { stream: Promise<FileSystemWritableFileStream>; quiet?: ReturnType<typeof setTimeout> };
}
interface Directory extends Node {
  handle: Promise<FileSystemDirectoryHandle>;
}

const shares = new Map<number, Share>();
const directories = new Map<number, Directory>();
const files = new Map<number, File>();
let shared = 0;
let keys = 0;

/** v86's own methods, before this took them over. */
const original = new WeakMap<Filesystem, Methods>();

/**
 * Has the visitor choose a folder, lists it into /.share/<n>, and tells
 * hostd to put it in place: share up <n>, or share none <why>.
 */
export async function open(machine: Machine) {
  const picker = window.showDirectoryPicker?.bind(window);
  if (!picker) return machine.control("share none unsupported");
  let folder: FileSystemDirectoryHandle;
  try {
    folder = await gesture("Choose a folder", FolderOpen, () => picker({ id: "share", mode: "readwrite" }));
  } catch {
    return machine.control("share none cancelled");
  }
  const writable = (await folder.queryPermission?.({ mode: "readwrite" })) === "granted";
  const fs = taken(machine);
  const number = ++shared;
  const staging = methods(fs).CreateDirectory(String(number), fs.SearchPath("/.share").id);
  const root = methods(fs).CreateDirectory(plain(folder.name), staging);
  const share: Share = { number, root, queue: Promise.resolve() };
  try {
    await list(machine, fs, share, folder, root, writable, { count: 0 });
  } catch (error) {
    drop(share);
    fs.DeleteNode(`/.share/${number}`);
    return machine.control(`share none ${error instanceof TooBig ? "big" : `error ${describe(error)}`}`);
  }
  shares.set(number, share);
  machine.control(`share up ${number} ${writable ? "rw" : "ro"}`);
}

/** Lets go of share <n>, or every one: committed first, and never a file of the folder touched after. */
export async function release(machine?: Machine, which?: number) {
  for (const share of [...shares.values()]) {
    if (which !== undefined && share.number !== which) continue;
    for (const [, file] of files) if (file.share === share) await commit(file);
    await share.queue;
    drop(share);
    shares.delete(share.number);
    machine?.control(`share down ${share.number} off`);
  }
}

class TooBig extends Error {}

/** Lists `folder` into the guest's directory `into`: its directories, and its files, to be read as the guest reads them. */
async function list(machine: Machine, fs: Filesystem, share: Share, folder: FileSystemDirectoryHandle, into: number, writable: boolean, seen: { count: number }) {
  setDirectory(fs, into, writable);
  directories.set(into, { share, handle: Promise.resolve(folder) });
  for await (const [name, handle] of folder.entries()) {
    if (++seen.count > LIMIT) throw new TooBig();
    if (handle.kind === "directory") {
      await list(machine, fs, share, handle, methods(fs).CreateDirectory(name, into), writable, seen);
      continue;
    }
    const file = await handle.getFile();
    const id = methods(fs).CreateFile(name, into);
    Object.assign(fs.inodes[id]!, { size: file.size, mtime: Math.floor(file.lastModified / 1000), mode: 0o100000 | (writable ? 0o644 : 0o444), uid: GUEST, gid: GUEST });
    keep(machine, id, share, Promise.resolve(handle), Promise.resolve(file));
  }
}

function setDirectory(fs: Filesystem, id: number, writable: boolean) {
  Object.assign(fs.inodes[id]!, { mode: 0o040000 | (writable ? 0o755 : 0o555), uid: GUEST, gid: GUEST });
}

/** Makes the guest's file `id` one of the share's: read from the folder's file, written back to it. */
function keep(machine: Machine, id: number, share: Share, handle: Promise<FileSystemFileHandle>, snapshot?: Promise<globalThis.File>) {
  const file: File = { share, handle, key: `share/${share.number}/${++keys}`, snapshot };
  files.set(id, file);
  const read: Reader = async (offset, count) => {
    // A file being written is read as written: what was written goes first.
    await commit(file);
    const now = await (file.snapshot ??= file.handle.then((handle) => handle.getFile()));
    return new Uint8Array(await now.slice(offset, offset + count).arrayBuffer());
  };
  adopt(machine, id, file.key, read);
}

/** Commits what was written to `file`, so the folder has it, and the file is read afresh. */
async function commit(file: File) {
  const writer = file.writer;
  if (!writer) return;
  file.writer = undefined;
  clearTimeout(writer.quiet);
  try {
    await (await writer.stream).close();
  } catch (error) {
    console.warn("share: a file could not be written:", error);
  }
  file.snapshot = undefined;
}

/** The share's file `file`'s writer, made if it has none; the quiet commit put off. */
function writerOf(file: File) {
  const writer = (file.writer ??= { stream: file.handle.then((handle) => handle.createWritable({ keepExistingData: true })) });
  clearTimeout(writer.quiet);
  writer.quiet = setTimeout(() => void commit(file), QUIET_MS);
  return writer.stream;
}

/** Does `work` on the folder after everything before it. */
function then<T>(share: Share, work: () => Promise<T>): Promise<T> {
  const done = share.queue.then(work);
  share.queue = done.catch((error) => console.warn("share:", error));
  return done;
}

/** Forgets every inode of the share: v86 has them as its own from now on, and the guest may remove them. */
function drop(share: Share) {
  for (const [id, directory] of directories) if (directory.share === share) directories.delete(id);
  for (const [id, file] of files) {
    if (file.share !== share) continue;
    files.delete(id);
    forget(file.key);
  }
}

/** The machine's filesystem, its methods taken over for the shares' inodes. */
function taken(machine: Machine): Filesystem {
  const fs = (machine.emulator as unknown as { fs9p: Filesystem }).fs9p;
  if (original.has(fs)) return fs;
  const own: Methods = {
    CreateDirectory: fs.CreateDirectory.bind(fs),
    CreateFile: fs.CreateFile.bind(fs),
    Unlink: fs.Unlink.bind(fs),
    Link: fs.Link.bind(fs),
    Rename: fs.Rename.bind(fs),
    Write: fs.Write.bind(fs),
    ChangeSize: fs.ChangeSize.bind(fs),
    CloseInode: fs.CloseInode.bind(fs),
  };
  original.set(fs, own);
  if (fs.SearchPath("/.share").id === -1) own.CreateDirectory(".share", 0);

  fs.CreateFile = (name, parent) => {
    const id = own.CreateFile(name, parent);
    const directory = directories.get(parent);
    if (directory) keep(machine, id, directory.share, then(directory.share, async () => (await directory.handle).getFileHandle(name, { create: true })));
    return id;
  };
  fs.CreateDirectory = (name, parent) => {
    const id = own.CreateDirectory(name, parent);
    const directory = directories.get(parent);
    if (directory) directories.set(id, { share: directory.share, handle: then(directory.share, async () => (await directory.handle).getDirectoryHandle(name, { create: true })) });
    return id;
  };
  fs.Unlink = (parent, name) => {
    const id = fs.Search(parent, name);
    const ret = own.Unlink(parent, name);
    const directory = directories.get(parent);
    if (ret < 0 || !directory) return ret;
    const file = files.get(id);
    if (file) {
      files.delete(id);
      forget(file.key);
      const writer = file.writer;
      file.writer = undefined;
      if (writer) {
        clearTimeout(writer.quiet);
        void writer.stream.then((stream) => stream.abort()).catch(() => {});
      }
    }
    directories.delete(id);
    void then(directory.share, async () => (await directory.handle).removeEntry(name));
    return ret;
  };
  // Links of every kind are the guest's own; a hard one into or out of a share would be two files.
  fs.Link = (parent, target, name) => (directories.has(parent) || files.has(target) ? -EPERM : own.Link(parent, target, name));
  fs.Rename = async (fromDirectory, from, toDirectory, to) => {
    const source = directories.get(fromDirectory);
    const target = directories.get(toDirectory);
    if (!source && !target) return own.Rename(fromDirectory, from, toDirectory, to);
    if (!source || !target || source.share !== target.share) return -EXDEV;
    const id = fs.Search(fromDirectory, from);
    const file = files.get(id);
    const directory = directories.get(id);
    // A directory moves only where the browser can move it; a file is copied where it cannot.
    if (!file && !(directory && FileSystemHandle.prototype.move)) return -EPERM;
    if (file) await commit(file);
    const ret = await own.Rename(fromDirectory, from, toDirectory, to);
    if (ret < 0) return ret;
    const share = source.share;
    if (file) {
      // Where it was, held before it is moved: the move is where it will be.
      const before = file.handle;
      file.handle = then(share, async () => {
        const handle = await before;
        const into = await target.handle;
        if (handle.move) return (await handle.move(into, to), handle);
        const copy = await into.getFileHandle(to, { create: true });
        await (await handle.getFile()).stream().pipeTo(await copy.createWritable());
        await (await source.handle).removeEntry(from);
        return copy;
      });
      file.snapshot = undefined;
    } else if (directory) {
      const before = directory.handle;
      directory.handle = then(share, async () => {
        const handle = await before;
        await handle.move!(await target.handle, to);
        return handle;
      });
    }
    return 0;
  };
  fs.Write = async (id, offset, count, buffer) => {
    const file = files.get(id);
    if (!file) return own.Write(id, offset, count, buffer);
    const inode = fs.inodes[id]!;
    try {
      await (await writerOf(file)).write({ type: "write", position: offset, data: buffer.slice(0, count) });
    } catch (error) {
      console.warn("share: a write could not be made:", error);
    }
    inode.size = Math.max(inode.size, offset + count);
  };
  fs.ChangeSize = async (id, size) => {
    const file = files.get(id);
    if (!file) return own.ChangeSize(id, size);
    try {
      await (await writerOf(file)).truncate(size);
    } catch (error) {
      console.warn("share: a file could not be resized:", error);
    }
    fs.inodes[id]!.size = size;
  };
  fs.CloseInode = async (id) => {
    const file = files.get(id);
    if (file) await commit(file);
    return own.CloseInode(id);
  };
  return fs;
}

const methods = (fs: Filesystem) => original.get(fs) ?? fs;

/** The folder's name, as the guest's filesystem takes it. */
const plain = (name: string) => name.replace(/[\0/]/g, "_").replace(/^\.{1,2}$/, "_") || "folder";

function describe(error: unknown) {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).replace(/\s+/g, " ").slice(0, 160);
}
