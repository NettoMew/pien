// Builds Microsoft Edit (image/edit/) for the guest in a Docker container,
// here or on BUILD_HOST, the way build-kernel.ts builds the kernel:
//
//   npm run build:edit
//
// The result is cached under .cache/edit/, keyed by build.sh; build-image
// picks it up from there.

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { buildHost, runContainer } from "./lib/docker.ts";
import { editBuild } from "./lib/edit.ts";
import { info, size, step } from "./lib/log.ts";

const { script, version, file } = await editBuild();

step(`Edit ${version}`);
if (existsSync(file)) {
  info(`up to date · ${file}`);
  process.exit(0);
}
info(buildHost ? `building on ${buildHost}` : "building with local Docker");

const started = performance.now();
const partial = `${file}.partial`;
await mkdir(dirname(file), { recursive: true });
try {
  await runContainer({ image: "alpine:3.24", platform: "linux/386", script }, partial);
} catch (error) {
  await rm(partial, { force: true });
  console.error(`Edit build failed: ${(error as Error).message}`);
  process.exit(1);
}

const binary = await readFile(partial);
if (binary.length < 4 || binary.toString("latin1", 0, 4) !== "\x7fELF") {
  await rm(partial, { force: true });
  console.error("Edit build failed: what came out is not an executable");
  process.exit(1);
}
await rename(partial, file);
info(`${size(binary.length)} · ${((performance.now() - started) / 1000).toFixed(0)} s · ${file}`);
