// A WARP device for development, outside the browser.
//
//   node scripts/warp.ts register   writes .cache/warp/device.json and open.bin
//   node scripts/warp.ts delete     deletes that device again
//
// open.bin is what the tunnel's open() takes, for the native check:
//   cargo run --manifest-path warp/Cargo.toml --example edge -- .cache/warp/open.bin

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Call, type Device, openBytes, register, remove } from "../src/warp/api.ts";
import { info, step } from "./lib/log.ts";

const DIR = join(import.meta.dirname, "../.cache/warp");
const DEVICE = join(DIR, "device.json");

// The browser cannot set User-Agent; the page's proxy adds it, and so do we.
const call: Call = (path, init) =>
  fetch(`https://api.cloudflareclient.com${path}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), "user-agent": "WARP for Android" },
  });

switch (process.argv[2]) {
  case "register": {
    step("Registering an anonymous WARP device");
    const device = await register(call, "guest@home dev");
    await mkdir(DIR, { recursive: true });
    await writeFile(DEVICE, JSON.stringify(device, null, 2));
    await writeFile(join(DIR, "open.bin"), openBytes(device));
    info(`id ${device.id.slice(0, 8)}…  ${device.v4}  ${device.v6}`, `→ ${DEVICE}`);
    break;
  }
  case "delete": {
    const device: Device = JSON.parse(await readFile(DEVICE, "utf8"));
    step(`Deleting WARP device ${device.id.slice(0, 8)}…`);
    await remove(call, device);
    await rm(DIR, { recursive: true });
    info("deleted");
    break;
  }
  default:
    console.error("usage: node scripts/warp.ts register | delete");
    process.exit(1);
}
