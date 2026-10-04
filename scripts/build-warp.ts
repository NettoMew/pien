// Builds the WARP client (warp/, Rust) for the browser and puts it where the
// page imports it from: src/warp/warp.wasm. Needs the wasm32-unknown-unknown
// target (rustup target add wasm32-unknown-unknown).

// WebAssembly's types come with the DOM's.
/// <reference lib="dom" />

import { spawnSync } from "node:child_process";
import { copyFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { info, size, step } from "./lib/log.ts";

const ROOT = join(import.meta.dirname, "..");
const TARGET = "wasm32-unknown-unknown";
const BUILT = join(ROOT, "warp/target", TARGET, "release/warp.wasm");
const OUT = join(ROOT, "src/warp/warp.wasm");

step(`Building warp/ for ${TARGET}`);
const cargo = spawnSync("cargo", ["build", "--release", "--target", TARGET, "--manifest-path", join(ROOT, "warp/Cargo.toml")], {
  stdio: "inherit",
});
if (cargo.status !== 0) process.exit(cargo.status ?? 1);

await copyFile(BUILT, OUT);
const wasm = await readFile(OUT);
const gzip = gzipSync(wasm, { level: 9 }).length;
const brotli = brotliCompressSync(wasm, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
info(`${size(wasm.length)}, ${size(gzip)} gzip, ${size(brotli)} brotli → src/warp/warp.wasm`);

// Exactly the interface src/warp/core.ts expects, nothing more.
const module = new WebAssembly.Module(wasm);
const imports = WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`);
const exports = WebAssembly.Module.exports(module).map((e) => e.name);
info(`imports ${imports.join(" ")}`, `exports ${exports.join(" ")}`);
