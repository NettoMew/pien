// Minimal tar reader. Understands ustar, PAX and GNU long names, and keeps
// going past end-of-archive markers so concatenated archives (as found in
// Alpine .apk files) are read in full.

export type TarEntryType = "file" | "link" | "symlink" | "dir";

export interface TarEntry {
  name: string;
  type: TarEntryType;
  mode: number;
  uid: number;
  gid: number;
  mtime: number;
  linkname: string;
  data: Buffer;
}

const BLOCK = 512;

const TYPES: Record<string, TarEntryType> = {
  "0": "file",
  "\0": "file",
  "7": "file",
  "1": "link",
  "2": "symlink",
  "5": "dir",
};

function str(buf: Buffer, off: number, len: number): string {
  const end = buf.indexOf(0, off);
  return buf.toString("utf8", off, end === -1 || end > off + len ? off + len : end);
}

function octal(buf: Buffer, off: number, len: number): number {
  return parseInt(str(buf, off, len).trim() || "0", 8);
}

function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const len = parseInt(data.toString("utf8", i, sp), 10);
    const record = data.toString("utf8", sp + 1, i + len - 1);
    const eq = record.indexOf("=");
    out[record.slice(0, eq)] = record.slice(eq + 1);
    i += len;
  }
  return out;
}

export function* readTar(buf: Buffer): Generator<TarEntry> {
  let off = 0;
  let pax: Record<string, string> = {};
  let longName: string | null = null;
  let longLink: string | null = null;

  while (off + BLOCK <= buf.length) {
    const header = buf.subarray(off, off + BLOCK);
    off += BLOCK;
    if (header.every((b) => b === 0)) continue;

    const size = octal(header, 124, 12);
    const flag = String.fromCharCode(header[156]!);
    const data = buf.subarray(off, off + size);
    off += Math.ceil(size / BLOCK) * BLOCK;

    if (flag === "x") { pax = parsePax(data); continue; }
    if (flag === "g") continue;
    if (flag === "L") { longName = str(data, 0, data.length); continue; }
    if (flag === "K") { longLink = str(data, 0, data.length); continue; }

    const prefix = header.toString("utf8", 257, 263) === "ustar\0" ? str(header, 345, 155) : "";
    const name = pax.path ?? longName ?? (prefix ? `${prefix}/` : "") + str(header, 0, 100);

    const type = TYPES[flag];
    if (type) {
      yield {
        name: name.replace(/^\.?\/+/, "").replace(/\/+$/, ""),
        type,
        mode: octal(header, 100, 8) & 0o7777,
        uid: octal(header, 108, 8),
        gid: octal(header, 116, 8),
        mtime: Math.floor(Number(pax.mtime ?? octal(header, 136, 12))),
        linkname: pax.linkpath ?? longLink ?? str(header, 157, 100),
        data,
      };
    }

    pax = {};
    longName = longLink = null;
  }
}

/**
 * A minimal ustar writer for regular files (names of up to 100 bytes; their
 * directories are implied). Every entry has the same owner and time, so the
 * same files always make the same archive.
 */
export function writeTar(files: { name: string; data: Buffer; mode?: number }[]): Buffer {
  const blocks: Buffer[] = [];
  const field = (header: Buffer, value: number, off: number, len: number) =>
    header.write(`${value.toString(8).padStart(len - 1, "0")}\0`, off, len, "ascii");
  for (const { name, data, mode = 0o644 } of files) {
    if (Buffer.byteLength(name) > 100) throw new Error(`tar: name too long: ${name}`);
    const header = Buffer.alloc(BLOCK);
    header.write(name, 0, 100);
    field(header, mode, 100, 8);
    field(header, 0, 108, 8); // uid
    field(header, 0, 116, 8); // gid
    field(header, data.length, 124, 12);
    field(header, 0, 136, 12); // mtime
    header.write(" ".repeat(8), 148, 8, "ascii"); // the checksum counts itself as spaces
    header.write("0", 156, 1, "ascii");
    header.write("ustar\0" + "00", 257, 8, "ascii");
    header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK));
  }
  blocks.push(Buffer.alloc(2 * BLOCK));
  return Buffer.concat(blocks);
}
