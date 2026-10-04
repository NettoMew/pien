// public/vm/manifest.json: what the builders produced, under which names.
// Every artifact is named by its content hash, so the whole of /vm/ can be
// cached forever; the page learns the current names from this manifest,
// which Vite bakes into its bundle (see vite.config.ts).

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import type { Manifest } from "../../vm.config.ts";

export const VM = join(import.meta.dirname, "../../public/vm");
const FILE = join(VM, "manifest.json");

export async function readManifest(): Promise<Manifest> {
  if (!existsSync(FILE)) throw new Error("public/vm/manifest.json is missing: npm run build:image first");
  return JSON.parse(await readFile(FILE, "utf8"));
}

export async function writeManifest(manifest: Manifest): Promise<void> {
  await writeFile(FILE, JSON.stringify(manifest, null, 2) + "\n");
}

/**
 * Writes `data` as e.g. "bios/seabios-1a2b3c4d.bin" for the name
 * "bios/seabios.bin", drops older versions of it, and returns the new name.
 */
export async function putHashed(name: string, data: Buffer | Uint8Array): Promise<string> {
  const suffix = name.endsWith(".bin.zst") ? ".bin.zst" : posix.extname(name);
  const dir = posix.dirname(name);
  const base = posix.basename(name, suffix);
  const hash = createHash("sha256").update(data).digest("hex").slice(0, 10);
  const hashed = posix.join(dir, `${base}-${hash}${suffix}`);

  await mkdir(dirname(join(VM, hashed)), { recursive: true });
  for (const old of existsSync(join(VM, dir)) ? await readdir(join(VM, dir)) : []) {
    if (old.startsWith(`${base}-`) && old.endsWith(suffix) && old !== posix.basename(hashed)) await rm(join(VM, dir, old));
  }
  await writeFile(join(VM, hashed), data);
  return hashed;
}
