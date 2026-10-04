// Docker for the builders — here, or on a Linux host over ssh when this
// machine has no Docker of its own:
//
//   BUILD_HOST=v2in0 npm run build:kernel
//
// Inputs travel on stdin, results come back on stdout, and Docker's own
// chatter shows up on stderr as the build log.

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";

/** Always explicit: an image may be cached for more than one. */
export type Platform = "linux/amd64" | "linux/386";

/** Where Docker runs: BUILD_HOST over ssh, or locally. */
export const buildHost = process.env.BUILD_HOST;

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** ssh's own way of saying the connection, not the command, failed. */
const SSH_DROPPED = 255;

async function docker(args: string[], stdin: string | Buffer, output?: string) {
  const [command, ...rest] = buildHost
    ? ["ssh", "-o", "BatchMode=yes", buildHost, ["docker", ...args].map(quote).join(" ")]
    : ["docker", ...args];
  // A dropped connection is worth another go: builds pick up from Docker's
  // cache, and the output file starts over.
  for (let attempt = 1; ; attempt++) {
    const child = spawn(command!, rest, { stdio: ["pipe", output ? "pipe" : "inherit", "inherit"] });
    child.stdin!.end(stdin);
    const file = output ? child.stdout!.pipe(createWriteStream(output)) : undefined;
    const [code] = await Promise.all([new Promise<number | null>((resolve) => child.on("close", resolve)), file && finished(file)]);
    if (code === 0) return;
    if (buildHost && code === SSH_DROPPED && attempt < 3) {
      console.error(`  the connection to ${buildHost} dropped; again`);
      continue;
    }
    throw new Error(`docker ${args[0]} failed with exit ${code}`);
  }
}

export interface Run {
  image: string;
  platform: Platform;
  /** Named volumes, as name → mount point, kept between runs. */
  volumes?: Record<string, string>;
  script: string;
  stdin?: string | Buffer;
}

/** Runs `script` with sh in a throwaway container and writes its stdout to `output`. */
export async function runContainer({ image, platform, volumes = {}, script, stdin = "" }: Run, output: string) {
  await docker(
    [
      "run", "--rm", "-i", "--platform", platform,
      ...Object.entries(volumes).flatMap(([name, path]) => ["-v", `${name}:${path}`]),
      image,
      "sh", "-c", `echo ${Buffer.from(script).toString("base64")} | base64 -d > /tmp/run.sh && sh /tmp/run.sh`,
    ],
    stdin,
    output,
  );
}

export interface Build {
  tag: string;
  platform: Platform;
  /** A tar archive with the Dockerfile at its top. */
  context: Buffer;
  args?: Record<string, string>;
}

/** Builds an image on the build host, where Docker's layer cache keeps unchanged stages for next time. */
export async function buildImage({ tag, platform, context, args = {} }: Build) {
  await docker(
    [
      "build", "--platform", platform, "--progress", "plain", "--tag", tag,
      ...Object.entries(args).flatMap(([name, value]) => ["--build-arg", `${name}=${value}`]),
      "-",
    ],
    context,
  );
}
