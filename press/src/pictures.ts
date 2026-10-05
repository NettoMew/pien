// Pictures, as they come from the machine: anything sharp reads, kept as one
// JPEG at most KEPT pixels wide, turned upright by its EXIF, and stripped of
// everything else in it (where it was taken, and with what). From that, the
// copies: WebP at the widths the web asks for, and a JPEG for the guest's
// home, which the terminal can show (it reads PNG, JPEG and GIF, not WebP).

import { createHash } from "node:crypto";
import sharp from "sharp";
import { Refusal } from "./http.ts";

/** The widest a kept picture gets. */
const KEPT = 1600;
/** The widths of the web's copies, below the picture's own. */
const COPIES = [480, 960];
/** The width of the guest's copy, at most. */
export const GUEST = 960;

export interface Kept {
  /** `<hash>.jpg`: what the Markdown shows as ../media/<name>. */
  name: string;
  data: Buffer;
  width: number;
  height: number;
}

/** The picture to keep, from what was sent; the same picture sent twice keeps one name. */
export async function keep(sent: Buffer): Promise<Kept> {
  try {
    const { data, info } = await sharp(sent, { limitInputPixels: 100_000_000 })
      .rotate()
      .resize({ width: KEPT, withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    const name = `${createHash("sha256").update(sent).digest("hex").slice(0, 12)}.jpg`;
    return { name, data, width: info.width, height: info.height };
  } catch {
    throw new Refusal(415, "That is not a picture press can read.");
  }
}

/** A kept picture's size. */
export async function size(data: Buffer): Promise<{ width: number; height: number }> {
  const { width = 0, height = 0 } = await sharp(data).metadata();
  return { width, height };
}

/** The widths a picture `width` wide is served at on the web: the copies narrower than it, and its own. */
export const widths = (width: number) => [...COPIES.filter((each) => each < width), width];

/** The web's copy of the kept picture `data`, `width` wide. */
export const webCopy = (data: Buffer, width: number) => sharp(data).resize({ width, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();

/** The guest's copy of the kept picture `data`, `own` pixels wide. */
export const guestCopy = (data: Buffer, own: number) =>
  own <= GUEST ? Promise.resolve(data) : sharp(data).resize({ width: GUEST }).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
