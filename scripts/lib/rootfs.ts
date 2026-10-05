// An in-memory root filesystem, serialised to the format v86 mounts over 9p:
// a JSON tree of metadata plus one zstd blob per file, named by content hash.
// The guest sees every file immediately; bytes are fetched on first read.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { constants, zstdCompressSync } from "node:zlib";
import type { TarEntry } from "./tar.ts";

interface Attrs {
  mode: number;
  uid: number;
  gid: number;
  mtime: number;
}

export type Node =
  | (Attrs & { kind: "dir"; children: Map<string, Node> })
  | (Attrs & { kind: "file"; data: Buffer })
  | (Attrs & { kind: "symlink"; target: string });

type Dir = Extract<Node, { kind: "dir" }>;

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

// v86's fs.json, version 3: [name, size, mtime, mode, uid, gid, children | target | blob]
type JsonNode = [string, number, number, number, number, number, JsonNode[] | string];

const HASH_LENGTH = 10; // must match v86's tools/fs2json.py

/** The blob a file's bytes go into, by its content: also the key v86's 9p storage reads it by. */
export const blobName = (data: Buffer) => `${createHash("sha256").update(data).digest("hex").slice(0, HASH_LENGTH)}.bin.zst`;

export class RootFS {
  readonly root: Dir;
  readonly mtime: number;

  constructor(mtime: number) {
    this.mtime = mtime;
    this.root = this.dirNode();
  }

  private dirNode(attrs: Partial<Attrs> = {}): Dir {
    return { kind: "dir", mode: 0o755, uid: 0, gid: 0, mtime: this.mtime, ...attrs, children: new Map() };
  }

  /** Finds the parent directory of `path`, following symlinks along the way. */
  private locate(path: string, create: true): [Dir, string];
  private locate(path: string, create: false): [Dir, string] | undefined;
  private locate(path: string, create: boolean): [Dir, string] | undefined {
    const parts = posix.normalize(`/${path}`).split("/").filter(Boolean);
    const name = parts.pop() ?? "";
    let dir = this.root;
    let cwd = "/";
    for (const part of parts) {
      let next = dir.children.get(part);
      if (next?.kind === "symlink") next = this.get(posix.resolve(cwd, next.target), { follow: true });
      cwd = posix.join(cwd, part);
      if (!next && !create) return undefined;
      if (!next) dir.children.set(part, (next = this.dirNode()));
      if (next.kind !== "dir") throw new Error(`rootfs: ${part} in ${path} is not a directory`);
      dir = next;
    }
    return [dir, name];
  }

  private split(path: string): [Dir, string] {
    return this.locate(path, true);
  }

  get(path: string, { follow = false } = {}): Node | undefined {
    const found = this.locate(path, false);
    if (!found) return undefined;
    const [dir, name] = found;
    const node = name ? dir.children.get(name) : dir;
    if (follow && node?.kind === "symlink") {
      return this.get(posix.resolve(posix.dirname(posix.normalize(`/${path}`)), node.target), { follow });
    }
    return node;
  }

  /** Names in a directory (following symlinks), or nothing if it doesn't exist. */
  list(path: string): string[] {
    const node = this.get(path, { follow: true });
    return node?.kind === "dir" ? [...node.children.keys()] : [];
  }

  mkdir(path: string, attrs: Partial<Attrs> = {}): void {
    const [dir, name] = this.split(path);
    const existing = dir.children.get(name);
    if (existing?.kind === "dir") Object.assign(existing, attrs);
    else dir.children.set(name, this.dirNode(attrs));
  }

  write(path: string, data: Buffer | string, attrs: Partial<Attrs> = {}): void {
    const [dir, name] = this.split(path);
    const buf = typeof data === "string" ? Buffer.from(data) : data;
    dir.children.set(name, { kind: "file", mode: 0o644, uid: 0, gid: 0, mtime: this.mtime, ...attrs, data: buf });
  }

  symlink(path: string, target: string, attrs: Partial<Attrs> = {}): void {
    const [dir, name] = this.split(path);
    dir.children.set(name, { kind: "symlink", mode: 0o777, uid: 0, gid: 0, mtime: this.mtime, ...attrs, target });
  }

  remove(path: string): void {
    const found = this.locate(path, false);
    found?.[0].children.delete(found[1]);
  }

  /** Adds an entry from a tar archive (hard links become copies, as in v86's fs2json). */
  add(e: TarEntry): void {
    const attrs = { mode: e.mode, uid: e.uid, gid: e.gid, mtime: e.mtime };
    if (e.type === "dir") this.mkdir(e.name, attrs);
    else if (e.type === "symlink") this.symlink(e.name, e.linkname, attrs);
    else if (e.type === "file") this.write(e.name, e.data, attrs);
    else {
      const target = this.get(e.linkname);
      if (target?.kind !== "file") throw new Error(`rootfs: dangling hard link ${e.name}`);
      this.write(e.name, target.data, attrs);
    }
  }

  *walk(dir: Dir = this.root, prefix = ""): Generator<[string, Node]> {
    for (const [name, node] of dir.children) {
      const path = `${prefix}/${name}`;
      yield [path, node];
      if (node.kind === "dir") yield* this.walk(node, path);
    }
  }

  /** Writes content-addressed blobs into `blobDir` and returns v86's fs.json. */
  async export(blobDir: string) {
    await mkdir(blobDir, { recursive: true });
    const seen = new Map<string, string>();
    let totalSize = 0;

    const blob = async (data: Buffer) => {
      const hash = createHash("sha256").update(data).digest("hex");
      const name = blobName(data);
      const prev = seen.get(name);
      if (prev && prev !== hash) throw new Error(`rootfs: short hash collision on ${name}`);
      seen.set(name, hash);

      const file = join(blobDir, name);
      if (!existsSync(file)) {
        const level = data.length > 4 << 20 ? 12 : 19;
        await writeFile(file, zstdCompressSync(data, { params: { [constants.ZSTD_c_compressionLevel]: level } }));
      }
      return name;
    };

    const visit = async (dir: Dir): Promise<JsonNode[]> => {
      const out: JsonNode[] = [];
      for (const name of [...dir.children.keys()].sort()) {
        const node = dir.children.get(name)!;
        const head = [name, 0, node.mtime, node.mode, node.uid, node.gid] as const;
        if (node.kind === "dir") {
          out.push([head[0], 0, head[2], S_IFDIR | node.mode, head[4], head[5], await visit(node)]);
        } else if (node.kind === "symlink") {
          out.push([head[0], node.target.length, head[2], S_IFLNK | node.mode, head[4], head[5], node.target]);
        } else {
          totalSize += node.data.length;
          out.push([head[0], node.data.length, head[2], S_IFREG | node.mode, head[4], head[5], await blob(node.data)]);
        }
      }
      return out;
    };

    const fsroot = await visit(this.root);
    return { json: { fsroot, version: 3, size: totalSize }, blobs: new Set(seen.keys()), bytes: totalSize };
  }
}
