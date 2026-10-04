// Builds the workbench's toolchain disk (image/workbench/, docs/workbench.md)
// with Docker — here, or on BUILD_HOST — and puts it in public/vm/ under a
// content-hashed name, recorded in the manifest with the versions it carries.
//
//   npm run build:workbench
//
// The image's packages go in at the image's exact versions: the disk is
// measured against, and laid over, precisely that system. The first build
// pins Neovim's plugins into image/workbench/nvim/lazy-lock.json; later builds
// restore those commits. Builds are cached under .cache/workbench/, keyed by
// everything that goes into them.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import config from "../image/image.config.ts";
import { Repository } from "./lib/apk.ts";
import { buildHost, buildImage, runContainer } from "./lib/docker.ts";
import { info, size, step } from "./lib/log.ts";
import { putHashedFile, readManifest, writeManifest } from "./lib/manifest.ts";
import { writeTar } from "./lib/tar.ts";

const ROOT = join(import.meta.dirname, "..");
const CONTEXT = join(ROOT, "image/workbench");
const LOCKFILE = join(CONTEXT, "nvim/lazy-lock.json");
const CACHE = join(ROOT, ".cache/workbench");

/** The versions shown when the workbench starts, by the packages that carry them. */
const SHOWN = { gcc: "gcc", clang: "clang", rust: "rust", go: "go", python: "python3", node: "nodejs", neovim: "neovim" };

const started = performance.now();
step("workbench");

// The image's packages exactly as it was built with them (build-image), and
// the tools at whatever Alpine has now.
const manifest = await readManifest();
const repo = await new Repository(config.mirror, config.branch, config.arch).load(config.repos);
const base = Object.entries(manifest.packages);
const tools = repo.resolve(config.workbench.packages).filter((pkg) => !(pkg.name in manifest.packages));
const args = {
  BASE: base.map(([name, version]) => `${name}=${version}`).join(" "),
  TOOLS: tools.map((pkg) => `${pkg.name}=${pkg.version}`).join(" "),
  NPM: config.workbench.npm.join(" "),
  GO: config.workbench.go.join(" "),
  PIP: config.workbench.pip.join(" "),
};
info(`${tools.length} packages over the image's ${base.length}, ${size(tools.reduce((sum, pkg) => sum + pkg.size, 0))} from Alpine`);

// The build context is image/workbench/ as it stands, Dockerfile at the top.
const files: { name: string; data: Buffer }[] = [];
for (const entry of await readdir(CONTEXT, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const path = join(entry.parentPath, entry.name);
  files.push({ name: relative(CONTEXT, path).split(sep).join("/"), data: await readFile(path) });
}
files.sort((a, b) => a.name.localeCompare(b.name));
const context = writeTar(files);

const key = createHash("sha256").update(context).update(JSON.stringify(args)).digest("hex").slice(0, 12);
const disk = join(CACHE, `workbench-${key}.sqfs`);

if (existsSync(disk)) {
  info(`up to date · ${disk}`);
} else {
  info(buildHost ? `building on ${buildHost}` : "building with local Docker");
  const tag = `homepage-workbench:${key}`;
  await mkdir(CACHE, { recursive: true });
  await buildImage({ tag, platform: "linux/386", context, args });
  const image = { image: tag, platform: "linux/386" } as const;
  await runContainer({ ...image, script: "cat /workbench.sqfs" }, `${disk}.partial`);
  await runContainer({ ...image, script: "cat /lazy-lock.json" }, `${disk}.lock`);
  await rename(`${disk}.partial`, disk);

  // The first build pins every plugin; later ones restore the pins, so the
  // lockfile only changes when the plugins are deliberately updated.
  const lock = await readFile(`${disk}.lock`, "utf8");
  await rm(`${disk}.lock`);
  if (!existsSync(LOCKFILE) || (await readFile(LOCKFILE, "utf8")) !== lock) {
    await writeFile(LOCKFILE, lock);
    info(`pinned ${Object.keys(JSON.parse(lock)).length} Neovim plugins · image/workbench/nvim/lazy-lock.json`);
  }
}

/** "15.2.0-r5" as "15.2": what is worth a line when the machine starts. */
const release = (version: string) => version.replace(/[-_].*$/, "").split(".").slice(0, 2).join(".");
const versions = Object.fromEntries(Object.entries(SHOWN).map(([shown, name]) => [shown, release(repo.lookup(name).version)]));

manifest.workbench = { disk: await putHashedFile("workbench/disk.sqfs", disk), size: (await stat(disk)).size, versions };
await writeManifest(manifest);
info(`${size(manifest.workbench.size)} · ${((performance.now() - started) / 1000).toFixed(0)} s · ${manifest.workbench.disk}`);
