// Builds the guest kernel (image/kernel/) in a Docker container — on this
// machine, or on a Linux host over ssh when there is no Docker here:
//
//   npm run build:kernel
//   BUILD_HOST=v2in0 npm run build:kernel
//
// The result is cached under .cache/kernel/, keyed by build.sh and config;
// build-image picks it up from there.

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { buildHost, runContainer } from "./lib/docker.ts";
import { kernelBuild } from "./lib/kernel.ts";
import { info, size, step } from "./lib/log.ts";

const { script, config, version, file } = await kernelBuild();

step(`Linux ${version}`);
if (existsSync(file)) {
  info(`up to date · ${file}`);
  process.exit(0);
}
info(buildHost ? `building on ${buildHost}` : "building with local Docker");

const started = performance.now();
const partial = `${file}.partial`;
await mkdir(dirname(file), { recursive: true });
try {
  await runContainer({ image: "alpine:3.24", platform: "linux/amd64", volumes: { "homepage-kernel": "/cache" }, script, stdin: config }, partial);
} catch (error) {
  await rm(partial, { force: true });
  console.error(`kernel build failed: ${(error as Error).message}`);
  process.exit(1);
}

const kernel = await readFile(partial);
// A bzImage carries the "HdrS" signature of the Linux boot protocol at 0x202.
if (kernel.length < 0x206 || kernel.toString("latin1", 0x202, 0x206) !== "HdrS") {
  await rm(partial, { force: true });
  console.error("kernel build failed: what came out is not a bzImage");
  process.exit(1);
}
await rename(partial, file);
info(`${size(kernel.length)} · ${((performance.now() - started) / 1000).toFixed(0)} s · ${file}`);
