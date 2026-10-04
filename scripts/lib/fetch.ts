// Download with an on-disk cache, so rebuilding the image is offline-fast.

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CACHE = join(import.meta.dirname, "../../.cache/downloads");

export async function cached(url: string, { maxAge = Infinity } = {}): Promise<Buffer> {
  const key = createHash("sha256").update(url).digest("hex").slice(0, 16);
  const file = join(CACHE, `${key}-${url.split("/").pop()}`);

  try {
    const { mtimeMs } = await stat(file);
    if (Date.now() - mtimeMs < maxAge) return await readFile(file);
  } catch {}

  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());

  await mkdir(CACHE, { recursive: true });
  await writeFile(file, data);
  return data;
}
