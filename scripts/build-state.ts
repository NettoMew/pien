// Boots each machine once in Node, rehearses a visit, and saves a snapshot.
//
//   npm run build:state              # both machines
//   npm run build:state workbench    # just the one
//
// A visitor restores the snapshot instead of booting, and lands on a prompt
// that is already there:
//
//   1. A first, throwaway session runs what a visitor's first commands touch,
//      leaving fish and its helpers in the guest's page cache. The posts stay
//      cold, to be fetched the moment someone reads them.
//   2. A second session starts fresh and is recorded from its first byte.
//      When it settles at the prompt, the machine is saved — and the recording
//      becomes the screen the page replays instead of waiting for fish to
//      start up all over again.
//
// Both land in public/vm/ under content-hashed names, recorded in the manifest.

import { join, sep } from "node:path";
import { constants, zstdCompressSync } from "node:zlib";
import xterm from "@xterm/headless"; // CommonJS: no named exports
import { Machine } from "../src/machine.ts";
import { machines, type MachineName, v86Options } from "../vm.config.ts";
import { info, size, step } from "./lib/log.ts";
import { putHashed, readManifest, VM, writeManifest } from "./lib/manifest.ts";

const ROOT = join(import.meta.dirname, "..");
const at = (file: string) => join(VM, file).split(sep).join("/") + (file.endsWith("/") ? "/" : "");

const COLS = 100;
const ROWS = 32;
const PROMPT = "\x1b]133;B"; // fish marks "prompt drawn, input starts here" (OSC 133)
const TIMEOUT = 180e3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Where each machine's snapshot goes: the home machine's at the top, the others' in a folder of their own. */
const place = (name: MachineName, file: string) => (name === "home" ? file : `${name}/${file}`);

async function snapshot(name: MachineName) {
  const manifest = await readManifest();
  const started = performance.now();
  const elapsed = () => `${((performance.now() - started) / 1000).toFixed(1)} s`;

  const machine = new Machine({
    ...v86Options(at, manifest, name, { cold: true }),
    wasm_path: join(ROOT, "node_modules/v86/build/v86.wasm"),
  });

  // A headless xterm.js stands in for the visitor's terminal: it answers the
  // queries fish sends at startup, just as the page's will.
  const term = new xterm.Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
  term.onData((data) => machine.write(data));

  let output = "";
  let lastOutput = 0;
  let recording: Uint8Array[] | null = null;
  const decoder = new TextDecoder();
  machine.onOutput((bytes) => {
    term.write(bytes);
    output += decoder.decode(bytes, { stream: true });
    lastOutput = performance.now();
    recording?.push(bytes.slice());
  });

  const control = new Set<string>();
  machine.onControl((line) => control.add(line));

  async function until(what: string, test: () => boolean) {
    const deadline = performance.now() + TIMEOUT;
    while (!test()) {
      if (performance.now() > deadline) {
        console.error(`\nTimed out waiting for ${what}. Terminal so far:\n${output}`);
        process.exit(1);
      }
      await sleep(50);
    }
  }

  const prompts = () => output.split(PROMPT).length - 1;
  const settled = () => performance.now() - lastOutput > 500;

  /** Types a command and waits for the next prompt. The leading space keeps it out of fish's history. */
  async function run(command: string) {
    const before = prompts();
    machine.write(` ${command}\r`);
    await until(`"${command}"`, () => prompts() > before);
  }

  step(`${name}: boot`);
  await until("the control line", () => control.has("ready"));
  info(`kernel up, init done · ${elapsed()}`);

  step(`${name}: rehearsal`);
  machine.resize(COLS, ROWS);
  machine.attach();
  await until("the first prompt", () => prompts() > 0);
  await run("functions -q help blog cat open net workbench home fish_right_prompt");
  await run("printf '# warm\\n' | awk -v width=60 -f /usr/libexec/home/md.awk > /dev/null; ls -l ~ ~/blog > /dev/null");
  machine.control("detach"); // the next session waits for an attach again
  await until("detach", () => control.has("detached"));
  machine.write(" exit\r");
  await sleep(1000);
  info(`caches warm · ${elapsed()}`);

  step(`${name}: the visit`);
  const before = prompts();
  recording = [];
  machine.attach();
  await until("a fresh prompt", () => prompts() > before && settled());
  const screen = Buffer.concat(recording);
  info(`prompt · ${size(screen.length)} recorded · ${elapsed()}`);

  // What a visitor will see, for a quick look.
  const view = new xterm.Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
  await new Promise<void>((resolve) => view.write(screen, resolve));
  const lines = Array.from({ length: view.buffer.active.length }, (_, i) => view.buffer.active.getLine(i)?.translateToString(true) ?? "");
  console.log("\n" + lines.join("\n").trimEnd().split("\n").map((line) => `  │ ${line}`).join("\n"));

  step(`${name}: snapshot`);
  const emulator = machine.emulator;
  const raw = new Uint8Array(await emulator.save_state());
  const state = zstdCompressSync(raw, { params: { [constants.ZSTD_c_compressionLevel]: 19 } });
  // The manifest is read afresh: another machine's snapshot may have landed meanwhile.
  const saved = { state: await putHashed(place(name, "state.bin.zst"), state), screen: await putHashed(place(name, "screen.bin"), screen) };
  const latest = await readManifest();
  latest.snapshots[name] = saved;
  await writeManifest(latest);
  info(`${size(raw.length)} → ${size(state.length)} · ${elapsed()}`);

  await emulator.destroy();
}

const requested = process.argv.slice(2);
for (const name of requested.length ? requested : Object.keys(machines)) {
  if (!(name in machines)) throw new Error(`no machine called ${name}; there is ${Object.keys(machines).join(" and ")}`);
  await snapshot(name as MachineName);
}
process.exit(0);
