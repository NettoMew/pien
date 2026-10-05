// A zip of files kept as they are, stored rather than compressed: what is
// taken from the guest (images, archives, firmware) would hardly shrink, and
// any computer opens a stored zip. Each file is read twice, once for its CRC
// and once into the zip, so every header is whole before its data: a reader
// that goes through the zip in order, rather than by its directory at the
// end, finds every size where it looks. ZIP64 where a file or the zip
// outgrows 4 GiB; names in UTF-8; the time each was changed, in UTC beside
// the DOS time zip keeps.

/** A file, directory (its name ending in "/") or symbolic link, as the zip keeps it. */
export interface Entry {
  name: string;
  /** Its mode, with the bits that tell its type. */
  mode: number;
  /** When it was last changed, in seconds. */
  mtime: number;
  size: number;
  /** Its bytes from the start, in pieces; a link's are its target's name. */
  read(): AsyncIterable<Uint8Array>;
}

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const END64 = 0x06064b50;
const LOCATOR64 = 0x07064b50;
/** What a 32-bit field says when its value is in the ZIP64 field instead. */
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
/** Names in UTF-8. */
const UTF8 = 0x0800;
/** Made on Unix, to version 4.5 of the format, the first with ZIP64. */
const MADE_BY = (3 << 8) | 45;
const DIRECTORY_ATTRIBUTE = 0x10;

/** CRC-32, as zip has it: IEEE 802.3, reflected. */
const TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(data: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) c = TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}

/** Little-endian fields, one after another. */
class Fields {
  private readonly bytes: number[] = [];
  u16(value: number) {
    this.bytes.push(value & 0xff, (value >>> 8) & 0xff);
    return this;
  }
  u32(value: number) {
    return this.u16(value & 0xffff).u16(Math.floor(value / 0x10000) & 0xffff);
  }
  u64(value: number) {
    return this.u32(value % 0x100000000).u32(Math.floor(value / 0x100000000));
  }
  raw(data: Uint8Array) {
    this.bytes.push(...data);
    return this;
  }
  done() {
    return Uint8Array.from(this.bytes);
  }
}

/** The DOS time and date zip keeps, in the visitor's local time, as an archiver of theirs would write it. */
function dos(mtime: number): [time: number, date: number] {
  const when = new Date(Math.max(mtime * 1000, Date.UTC(1980, 0, 2)));
  const time = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
  const date = ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  return [time, date];
}

/** The time in UTC, to the second: Info-ZIP's extended timestamp. */
const stamp = (mtime: number) => new Fields().u16(0x5455).u16(5).raw(Uint8Array.of(1)).u32(Math.max(0, Math.floor(mtime))).done();

/**
 * Writes `entries` as a zip to `write`; returns its size. ZIP64 fields are
 * used for what reaches `zip64At`: 4 GiB, where the 32-bit fields end,
 * unless asked for sooner, as the format allows.
 */
export async function zip(entries: Entry[], write: (chunk: Uint8Array) => Promise<void>, zip64At = MAX32): Promise<number> {
  const encoder = new TextEncoder();
  const central: Uint8Array[] = [];
  let offset = 0;
  const put = async (chunk: Uint8Array) => {
    await write(chunk);
    offset += chunk.length;
  };

  for (const entry of entries) {
    let crc = 0;
    for await (const piece of entry.read()) crc = crc32(piece, crc);
    const name = encoder.encode(entry.name);
    const [time, date] = dos(entry.mtime);
    const large = entry.size >= zip64At;
    const at = offset;
    const far = at >= zip64At;
    const needs = large || far ? 45 : 20;

    const local = new Fields()
      .u32(LOCAL).u16(needs).u16(UTF8).u16(0).u16(time).u16(date).u32(crc)
      .u32(large ? MAX32 : entry.size).u32(large ? MAX32 : entry.size);
    const localExtra = new Fields().raw(large ? new Fields().u16(0x0001).u16(16).u64(entry.size).u64(entry.size).done() : new Uint8Array(0)).raw(stamp(entry.mtime)).done();
    await put(local.u16(name.length).u16(localExtra.length).raw(name).raw(localExtra).done());
    let written = 0;
    for await (const piece of entry.read()) {
      await put(piece);
      written += piece.length;
    }
    if (written !== entry.size) throw new Error(`${entry.name} changed while it was taken`);

    const zip64 = new Fields();
    if (large) zip64.u64(entry.size).u64(entry.size);
    if (far) zip64.u64(at);
    const sixtyFour = zip64.done();
    const centralExtra = new Fields().raw(sixtyFour.length ? new Fields().u16(0x0001).u16(sixtyFour.length).raw(sixtyFour).done() : new Uint8Array(0)).raw(stamp(entry.mtime)).done();
    const directory = entry.name.endsWith("/");
    central.push(
      new Fields()
        .u32(CENTRAL).u16(MADE_BY).u16(needs).u16(UTF8).u16(0).u16(time).u16(date).u32(crc)
        .u32(large ? MAX32 : entry.size).u32(large ? MAX32 : entry.size)
        .u16(name.length).u16(centralExtra.length).u16(0).u16(0).u16(0)
        .u32(((entry.mode & 0xffff) * 0x10000 + (directory ? DIRECTORY_ATTRIBUTE : 0)) >>> 0)
        .u32(far ? MAX32 : at)
        .raw(name).raw(centralExtra)
        .done(),
    );
  }

  const start = offset;
  for (const record of central) await put(record);
  const length = offset - start;
  const count = entries.length;
  const end64 = count >= MAX16 || start >= zip64At || length >= zip64At;
  if (end64) {
    const at = offset;
    await put(new Fields().u32(END64).u64(44).u16(MADE_BY).u16(45).u32(0).u32(0).u64(count).u64(count).u64(length).u64(start).done());
    await put(new Fields().u32(LOCATOR64).u32(0).u64(at).u32(1).done());
  }
  const clip = (value: number, max: number) => (end64 ? max : value);
  await put(new Fields().u32(END).u16(0).u16(0).u16(clip(count, MAX16)).u16(clip(count, MAX16)).u32(clip(length, MAX32)).u32(clip(start, MAX32)).u16(0).done());
  return offset;
}
