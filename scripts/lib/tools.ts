// The tools built for the guest rather than taken from Alpine (image/tools/).
// Each is a directory with a build.sh, which runs in a throwaway i686 Alpine
// container, the guest's own userland, with the directory as its working
// directory, and lays out under $OUT what it builds, as it goes in the image.
// Whatever else is in the directory is for build.sh to read; what the tool
// needs from Alpine to run is in image.config.ts with the rest. Each build is
// cached, keyed by everything in its directory, where its version is pinned.

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeTar } from "./tar.ts";

const ROOT = join(import.meta.dirname, "../..");
const TOOLS = join(ROOT, "image/tools");

export interface Tool {
  name: string;
  /** Its directory, as a tar. */
  context: Buffer;
  /** Where its build is cached: a tar of what goes in the image. */
  file: string;
}

export async function tools(): Promise<Tool[]> {
  const out: Tool[] = [];
  for (const name of (await readdir(TOOLS)).sort()) {
    const dir = join(TOOLS, name);
    const files = await Promise.all(
      (await readdir(dir)).sort().map(async (file) => ({
        name: file,
        // Source files may come from a Windows checkout; the container wants LF.
        data: Buffer.from((await readFile(join(dir, file), "utf8")).replace(/\r\n/g, "\n")),
        mode: file.endsWith(".sh") ? 0o755 : 0o644,
      })),
    );
    const key = createHash("sha256");
    for (const file of files) key.update(`${file.name}\0`).update(file.data);
    out.push({ name, context: writeTar(files), file: join(ROOT, ".cache/tools", `${name}-${key.digest("hex").slice(0, 12)}.tar`) });
  }
  return out;
}

/**
 * What runs in the container: the tool's directory, arriving on stdin as a
 * tar, unpacked and built, and $OUT sent back as a tar on stdout. Everything
 * else goes to stderr, the build's log.
 */
export const RUN = `set -eu
exec 3>&1 1>&2
mkdir -p /tool /out
tar -xf - -C /tool
cd /tool
OUT=/out sh ./build.sh
tar -C /out -cf - . >&3
`;
