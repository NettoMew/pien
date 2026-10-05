// Where the guest kernel lives once built: a cache entry keyed by everything
// that goes into it (image/kernel/build.sh and image/kernel/config).

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../..");

export async function kernelBuild() {
  const read = async (name: string) => (await readFile(join(ROOT, "image/kernel", name), "utf8")).replace(/\r\n/g, "\n");
  const script = await read("build.sh");
  const config = await read("config");
  const key = createHash("sha256").update(script).update(config).digest("hex").slice(0, 12);
  const version = /^VERSION=(\S+)$/m.exec(script)?.[1] ?? "unknown";
  // What uname -r says: the version, and the config's suffix after it.
  const release = version + (/^CONFIG_LOCALVERSION="([^"]*)"$/m.exec(config)?.[1] ?? "");
  return { script, config, version, release, file: join(ROOT, ".cache/kernel", `bzImage-${version}-${key}`) };
}
