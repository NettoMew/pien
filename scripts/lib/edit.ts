// Where Microsoft Edit lives once built: a cache entry keyed by its build
// script (image/edit/build.sh), which pins the version.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../..");

export async function editBuild() {
  const script = (await readFile(join(ROOT, "image/edit/build.sh"), "utf8")).replace(/\r\n/g, "\n");
  const key = createHash("sha256").update(script).digest("hex").slice(0, 12);
  const version = /^VERSION=(\S+)$/m.exec(script)?.[1] ?? "unknown";
  return { script, version, file: join(ROOT, ".cache/edit", `msedit-${version}-${key}`) };
}
