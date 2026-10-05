// Builds the guest machine from nothing but Node — no Docker, no Linux host.
//
//   Alpine packages + image/rootfs + content + the kernel  →  public/vm/
//
//   fs-*.json      the whole directory tree, metadata only
//   fs/*.bin.zst   file contents: one blob per file, named by hash, fetched on first read
//   boot/bzimage-* the kernel (npm run build:kernel), only needed to cold-boot
//   bios/          SeaBIOS, pinned to the v86 release in node_modules
//   manifest.json  versions, and the current name of each of the above
//
// Every name carries a content hash, so the whole of /vm/ can be cached forever.

import { existsSync } from "node:fs";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import config from "../image/image.config.ts";
import { BLOBS } from "../vm.config.ts";
import { Repository } from "./lib/apk.ts";
import { CONTENT, frontMatter } from "./lib/content.ts";
import { cached } from "./lib/fetch.ts";
import { editBuild } from "./lib/edit.ts";
import { kernelBuild } from "./lib/kernel.ts";
import { info, size, step } from "./lib/log.ts";
import { putHashed, VM, writeManifest } from "./lib/manifest.ts";
import { RootFS } from "./lib/rootfs.ts";

const ROOT = join(import.meta.dirname, "..");
const BUILT = Math.floor(Date.now() / 1000);

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

/** Source files may come from a Windows checkout; the guest wants LF. */
const unix = async (path: string) => (await readFile(path, "utf8")).replace(/\r\n/g, "\n");
const guestPath = (base: string, path: string) => "/" + relative(base, path).split(sep).join("/");
const release = (version: string) => version.replace(/-r\d+$/, "");

// fish ships completions for ~1000 commands; keep only those that can run here.
const FISH_BUILTINS = new Set(
  ("abbr and argparse begin bg bind block break builtin case cd command commandline complete " +
    "contains continue count disown echo else emit end eval exec exit false fg for function functions " +
    "history if jobs math not or path printf pwd random read realpath return set set_color source " +
    "status string switch test time true type ulimit wait while").split(" "),
);

// ─── Packages ────────────────────────────────────────────────────────────────

step("packages");
const repo = await new Repository(config.mirror, config.branch, config.arch).load(config.repos);
const packages = repo.resolve(config.packages, config.replace);
const rootfs = new RootFS(BUILT);

for (const pkg of packages) {
  for (const entry of await repo.unpack(pkg)) rootfs.add(entry);
}
info(packages.map((p) => p.name).sort().join(" "));

const busyboxPaths = rootfs.get("/etc/busybox-paths.d/busybox");
if (busyboxPaths?.kind !== "file") throw new Error("busybox applet list not found");
for (const applet of busyboxPaths.data.toString().split("\n").filter(Boolean)) {
  if (!rootfs.get(applet)) rootfs.symlink(applet, "/bin/busybox");
}

for (const path of config.exclude) rootfs.remove(path);

const commands = new Set(["/bin", "/sbin", "/usr/bin", "/usr/sbin"].flatMap((dir) => rootfs.list(dir)));
const fishFunctions = new Set(rootfs.list("/usr/share/fish/functions"));
for (const name of rootfs.list("/usr/share/fish/completions")) {
  const cmd = name.replace(/\.fish$/, "");
  if (!commands.has(cmd) && !FISH_BUILTINS.has(cmd) && !fishFunctions.has(name)) {
    rootfs.remove(`/usr/share/fish/completions/${name}`);
  }
}

// ─── System ──────────────────────────────────────────────────────────────────

step("system");
const alpine = release(repo.lookup("alpine-release").version);

for (const dir of ["/dev", "/proc", "/sys", "/run", "/tmp", "/mnt"]) rootfs.mkdir(dir);
rootfs.mkdir("/root", { mode: 0o700 });

const overlay = join(ROOT, "image/rootfs");
for await (const path of walk(overlay)) {
  const target = guestPath(overlay, path);
  const data = await unix(path);
  rootfs.write(target, data, { mode: config.modes[target] ?? (data.startsWith("#!") ? 0o755 : 0o644) });
}
// The packages' files take their modes from config too.
for (const [path, mode] of Object.entries(config.modes)) {
  const node = rootfs.get(path);
  if (!node) throw new Error(`image.config.ts modes: ${path} is not in the image`);
  node.mode = mode;
}

rootfs.write("/etc/hostname", `${config.hostname}\n`);
rootfs.write("/etc/hosts", `127.0.0.1\tlocalhost ${config.hostname}\n::1\t\tlocalhost ${config.hostname}\n`);
rootfs.write("/etc/alpine-release", `${alpine}\n`);
rootfs.write(
  "/etc/os-release",
  `NAME="Alpine Linux"\nID=alpine\nVERSION_ID=${alpine}\n` +
    `PRETTY_NAME="Alpine Linux v${config.branch.slice(1)}"\nHOME_URL="https://alpinelinux.org/"\n`,
);
info(`Alpine ${alpine} · ${commands.size} commands`);

// ─── Content ─────────────────────────────────────────────────────────────────

step("content");
const { uid, gid, home } = config.user;
const owner = { uid, gid };
const content = CONTENT;
const posts: string[][] = [];

rootfs.mkdir(home, owner);
for await (const path of walk(content)) {
  const target = home + guestPath(content, path);
  const data = await unix(path);
  const { meta } = frontMatter(data);
  const mtime = meta.date ? Math.floor(Date.parse(meta.date) / 1000) : BUILT;

  rootfs.mkdir(target.slice(0, target.lastIndexOf("/")), owner);
  rootfs.write(target, data, { ...owner, mtime });

  if (target.startsWith(`${home}/blog/`) && meta.title) {
    posts.push([meta.date ?? "", target.slice(home.length + 6), meta.title]);
  }
  info(`${target}  ${size(Buffer.byteLength(data))}`);
}

posts.sort((a, b) => b[0]!.localeCompare(a[0]!));
rootfs.write("/usr/share/home/posts", posts.map((p) => p.join("\t") + "\n").join(""));

// ─── Edit ────────────────────────────────────────────────────────────────────

step("edit");
const edit = await editBuild();
if (!existsSync(edit.file)) {
  console.error("No Edit built for this image yet: npm run build:edit (BUILD_HOST=<linux host> without local Docker)");
  process.exit(1);
}
const msedit = await readFile(edit.file);
// Its own name, as Microsoft asks of distributions, and the short one beside it.
rootfs.write("/usr/bin/msedit", msedit, { mode: 0o755 });
rootfs.symlink("/usr/bin/edit", "msedit");
info(`Edit ${edit.version} · ${size(msedit.length)}`);

// ─── Kernel ──────────────────────────────────────────────────────────────────

step("kernel");
const kernel = await kernelBuild();
if (!existsSync(kernel.file)) {
  console.error("No kernel built for this config yet: npm run build:kernel (BUILD_HOST=<linux host> without local Docker)");
  process.exit(1);
}
const bzimage = await readFile(kernel.file);
const kernelFile = await putHashed("boot/bzimage", bzimage);
info(`Linux ${kernel.release} · ${size(bzimage.length)}`);

// ─── BIOS ────────────────────────────────────────────────────────────────────

const v86 = JSON.parse(await readFile(join(ROOT, "node_modules/v86/package.json"), "utf8"));
const commit = /\+g([0-9a-f]+)$/.exec(v86.version)?.[1];
if (!commit) throw new Error(`cannot tell which v86 commit ${v86.version} was built from`);
const bios = (name: string) => cached(`https://raw.githubusercontent.com/copy/v86/${commit}/bios/${name}`);
const biosFile = await putHashed("bios/seabios.bin", await bios("seabios.bin"));
const vgaBiosFile = await putHashed("bios/vgabios.bin", await bios("vgabios.bin"));

// ─── Export ──────────────────────────────────────────────────────────────────

step("export");
const blobDir = join(VM, BLOBS);
const { json, blobs, bytes } = await rootfs.export(blobDir);

let stale = 0;
let stored = 0;
for (const name of await readdir(blobDir)) {
  if (blobs.has(name)) {
    stored += (await stat(join(blobDir, name))).size;
  } else {
    await rm(join(blobDir, name));
    stale++;
  }
}

const fsJson = JSON.stringify(json);
await writeManifest({
  hostname: config.hostname,
  arch: "i686",
  alpine,
  kernel: kernel.release,
  fish: release(repo.lookup("fish").version),
  // Exactly what went in: the workbench's disk is built against these.
  packages: Object.fromEntries(packages.map((pkg) => [pkg.name, pkg.version]).sort(([a], [b]) => a!.localeCompare(b!))),
  files: { fsJson: await putHashed("fs.json", Buffer.from(fsJson)), bios: biosFile, vgaBios: vgaBiosFile, kernel: kernelFile },
  // Neither the disk nor the snapshots match a new image; their builders add new ones.
  snapshots: {},
});

info(
  `${blobs.size} blobs · ${size(bytes)} → ${size(stored)} compressed${stale ? ` · ${stale} stale removed` : ""}`,
  `fs.json ${size(fsJson.length)}`,
);
