// Builds the guest's own tools (image/tools/, scripts/lib/tools.ts) in
// Docker, here or on BUILD_HOST, the way build-kernel.ts builds the kernel:
//
//   npm run build:tools               every tool not built yet
//   npm run build:tools -- edit       just these, built anew
//
// Each build is cached under .cache/tools/, keyed by its directory;
// build-image picks them up from there.

import { existsSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { buildHost, runContainer } from "./lib/docker.ts";
import { info, size, step } from "./lib/log.ts";
import { RUN, tools } from "./lib/tools.ts";

const asked = process.argv.slice(2);
const all = await tools();
const unknown = asked.filter((name) => !all.some((tool) => tool.name === name));
if (unknown.length) throw new Error(`no tool called ${unknown.join(", ")}; there is ${all.map((tool) => tool.name).join(", ")}`);

for (const tool of all) {
  if (asked.length ? !asked.includes(tool.name) : existsSync(tool.file)) continue;
  step(tool.name);
  info(buildHost ? `building on ${buildHost}` : "building with local Docker");
  const started = performance.now();
  const partial = `${tool.file}.partial`;
  await mkdir(dirname(tool.file), { recursive: true });
  try {
    await runContainer({ image: "alpine:3.24", platform: "linux/386", script: RUN, stdin: tool.context }, partial);
  } catch (error) {
    await rm(partial, { force: true });
    console.error(`${tool.name}: the build failed: ${(error as Error).message}`);
    process.exit(1);
  }
  await rename(partial, tool.file);
  info(`${size((await stat(tool.file)).size)} · ${((performance.now() - started) / 1000).toFixed(0)} s · ${tool.file}`);
}
