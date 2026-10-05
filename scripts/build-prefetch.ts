// Traces what Python's tools read as they start, for the page to fetch all
// of it at once the first time one runs (src/prefetch.ts). A program built
// for the machine names the libraries it needs, and build-image lists them;
// a Python program names nothing, and imports a few hundred modules, one
// after another, each a round trip to the site. So each is run here, in a
// machine restored from the snapshot as a visitor's is, and every file the
// guest reads from the site meanwhile goes in the list, under the program's
// own file: what the guest reads first when it runs it.
//
//   npm run build:prefetch    (after build:image and build:state; build:vm runs all three)
//
// Asked for help or a version, each touches no device, and imports what its
// work does.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { guest } from "./lib/guest.ts";
import { info, step } from "./lib/log.ts";
import { putHashed, readManifest, VM, writeManifest } from "./lib/manifest.ts";

/** The programs traced, and how each is run to start it. */
const TRACED: Record<string, string> = {
  "/usr/bin/esptool": "esptool version",
  "/usr/bin/espefuse": "espefuse --help",
  "/usr/bin/espsecure": "espsecure --help",
  "/usr/bin/mpremote": "mpremote version",
  "/usr/bin/mtk": "mtk --help",
  "/usr/bin/edl": "edl --help",
};

// v86's 9p filesystem, as far as this reaches into it.
interface Storage {
  read(key: string, offset: number, count: number, size: number): Promise<Uint8Array | null>;
}
interface Filesystem {
  inodes: { sha256sum: string }[];
  storage: Storage;
  SearchPath(path: string): { id: number };
}

const manifest = await readManifest();
const starts: Record<string, string[]> = JSON.parse(await readFile(join(VM, manifest.files.prefetch), "utf8"));

step("tracing what Python's tools read as they start");
for (const [path, command] of Object.entries(TRACED)) {
  // A machine of its own for each: what one program left in the guest's
  // page cache, the next would read without a word to the site.
  const { machine, run } = await guest(() => {});
  const fs = (machine.emulator as unknown as { fs9p: Filesystem }).fs9p;
  const program = fs.inodes[fs.SearchPath(path).id]?.sha256sum;
  if (!program) throw new Error(`build-prefetch: ${path} is not in the image`);
  const read = new Set<string>();
  const storage = fs.storage;
  fs.storage = Object.assign(Object.create(storage) as Storage, {
    read(key: string, offset: number, count: number, size: number) {
      if (key !== program) read.add(key);
      return storage.read(key, offset, count, size);
    },
  });
  // Straight to the program, past the function that would lend it a device.
  await run(`command ${command} > /dev/null 2>&1`);
  await machine.destroy();
  // A script, not a program built for the machine: no libraries listed for it but these.
  starts[program] = [...read];
  info(`${path.split("/").at(-1)}: ${read.size} files`);
}

await writeManifest({ ...manifest, files: { ...manifest.files, prefetch: await putHashed("prefetch.json", Buffer.from(JSON.stringify(starts))) } });
process.exit(0);
