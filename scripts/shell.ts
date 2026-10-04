// A terminal into the machine, from your own shell. Restores the snapshot,
// exactly as a visitor would.
//
//   npm run shell                       interactive; Ctrl-] quits
//   npm run shell -- -c "uname -a"      run one command and print its output
//   npm run shell -- --trace -c "..."   also list the files the guest reads over 9p
//   npm run shell -- --put image/rootfs/usr/libexec/home/md.awk=/mnt/md.awk -c "..."
//                                       drop a local file into the guest first, to try changes
//                                       without rebuilding the image
//   npm run shell -- --cold             boot the kernel instead of restoring the snapshot
//   npm run shell -- --machine workbench
//                                       the workbench rather than the home machine

import { readFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { parseArgs } from "node:util";
import { Machine } from "../src/machine.ts";
import { type MachineName, machines, v86Options } from "../vm.config.ts";
import { readManifest, VM } from "./lib/manifest.ts";

const { values: args } = parseArgs({
  options: {
    command: { type: "string", short: "c" },
    put: { type: "string", multiple: true, default: [] },
    trace: { type: "boolean" },
    cold: { type: "boolean" },
    machine: { type: "string", default: "home" },
  },
});
if (!(args.machine in machines)) throw new Error(`no machine called ${args.machine}; there is ${Object.keys(machines).join(" and ")}`);
const name = args.machine as MachineName;

const ROOT = join(import.meta.dirname, "..");
const at = (file: string) => join(VM, file).split(sep).join("/") + (file.endsWith("/") ? "/" : "");
const manifest = await readManifest();
const machine = new Machine({
  ...v86Options(at, manifest, name, { cold: args.cold }),
  wasm_path: join(ROOT, "node_modules/v86/build/v86.wasm"),
});

const PROMPT = "\x1b]133;B"; // fish: prompt drawn, input starts here
const reads: string[] = [];
if (args.trace) machine.emulator.add_listener("9p-read-start", ([name]) => reads.push(name));

let tail = "";
let prompts = 0;
let lastOutput = performance.now();
const listeners: ((bytes: Uint8Array) => void)[] = [];
machine.onOutput((bytes) => {
  lastOutput = performance.now();
  tail = (tail + new TextDecoder().decode(bytes)).slice(-64);
  if (tail.includes(PROMPT)) {
    prompts++;
    tail = "";
  }
  listeners.forEach((listen) => listen(bytes));
});

const until = async (test: () => boolean) => {
  while (!test()) await new Promise((resolve) => setTimeout(resolve, 20));
};

await machine.loaded();
for (const spec of args.put) {
  const [local, remote] = spec.split("=") as [string, string];
  await machine.emulator.create_file(remote, new Uint8Array(await readFile(local)));
}
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone; // as the page does
machine.onControl((line) => line === "ready" && machine.attach(zone));
machine.resize(process.stdout.columns || 100, process.stdout.rows || 30);
machine.attach(zone);

// Restored, fish already sits at its prompt (and redraws it for the new size);
// cold, it has yet to start. Either way, wait for the dust to settle.
if (args.cold) await until(() => prompts > 0);
await until(() => performance.now() - lastOutput > 300);

if (args.command !== undefined) {
  // Done once fish reports the command finished (OSC 133;D) and prompts again.
  let since = "";
  const decoder = new TextDecoder();
  reads.length = 0;
  listeners.push((bytes) => {
    process.stdout.write(bytes);
    since += decoder.decode(bytes, { stream: true });
  });
  machine.write(` ${args.command}\r`);
  // fish marks the end of the command (OSC 133;D), then its next prompt (133;B).
  // oxlint-disable-next-line no-control-regex
  await until(() => /\x1b\]133;D[\s\S]*\x1b\]133;B/.test(since));
  if (args.trace) console.log(`\n9p reads: ${reads.join(" ")}`);
  process.exit(0);
} else {
  const screen = manifest.snapshots[name]?.screen;
  if (!args.cold && screen) process.stdout.write(await readFile(join(VM, screen)));
  listeners.push((bytes) => process.stdout.write(bytes));
  machine.resize(process.stdout.columns, process.stdout.rows);
  process.stdin.setRawMode(true);
  process.stdin.on("data", (data) => (data[0] === 0x1d ? process.exit(0) : machine.write(data)));
  process.stdout.on("resize", () => machine.resize(process.stdout.columns, process.stdout.rows));
}
