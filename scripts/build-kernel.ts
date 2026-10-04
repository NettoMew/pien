// Builds the guest kernel (image/kernel/) in a Docker container — on this
// machine, or on a Linux host over ssh when there is no Docker here:
//
//   npm run build:kernel
//   KERNEL_HOST=v2in0 npm run build:kernel
//
// The result is cached under .cache/kernel/, keyed by build.sh and config;
// build-image picks it up from there.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { kernelBuild } from "./lib/kernel.ts";
import { info, size, step } from "./lib/log.ts";

const { script, config, version, file } = await kernelBuild();
const host = process.env.KERNEL_HOST;

step(`Linux ${version}`);
if (existsSync(file)) {
  info(`up to date · ${file}`);
  process.exit(0);
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const docker = [
  "docker", "run", "--rm", "-i", "-v", "homepage-kernel:/cache", "alpine:3.24",
  "sh", "-c", `echo ${Buffer.from(script).toString("base64")} | base64 -d > /tmp/build.sh && sh /tmp/build.sh`,
];
const [command, ...args] = host ? ["ssh", "-o", "BatchMode=yes", host, docker.map(quote).join(" ")] : docker;
info(host ? `building on ${host}` : "building with local Docker");

const started = performance.now();
const child = spawn(command!, args, { stdio: ["pipe", "pipe", "inherit"] });
child.stdin.end(config);
const chunks: Buffer[] = [];
child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
const code = await new Promise<number | null>((resolve) => child.on("close", resolve));

const kernel = Buffer.concat(chunks);
// A bzImage carries the "HdrS" signature of the Linux boot protocol at 0x202.
if (code !== 0 || kernel.length < 0x206 || kernel.toString("latin1", 0x202, 0x206) !== "HdrS") {
  console.error(`kernel build failed (exit ${code})`);
  process.exit(1);
}

await mkdir(dirname(file), { recursive: true });
await writeFile(file, kernel);
info(`${size(kernel.length)} · ${((performance.now() - started) / 1000).toFixed(0)} s · ${file}`);
