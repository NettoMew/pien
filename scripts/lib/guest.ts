// A machine for the checks (check-usb.ts, check-serial.ts): restored from its
// snapshot in Node, behind a headless xterm.js that stands in for the page's
// terminal. It answers what fish asks of its terminal after every command,
// and hands the guest's private escape sequences to whatever the check wires
// up, as the page's terminal does. Commands run at fish's prompt.

import { join, sep } from "node:path";
import xterm from "@xterm/headless"; // CommonJS: no named exports
import { Machine } from "../../src/machine.ts";
import { type MachineName, machines, v86Options } from "../../vm.config.ts";
import { info } from "./log.ts";
import { readManifest, VM } from "./manifest.ts";

const ROOT = join(import.meta.dirname, "../..");
const at = (file: string) => join(VM, file).split(sep).join("/") + (file.endsWith("/") ? "/" : "");
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The terminal's escape sequences: commands to it (OSC), and the rest (CSI).
// oxlint-disable-next-line no-control-regex
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// oxlint-disable-next-line no-control-regex
const CSI = /\x1b\[[0-9;?<>=]*[a-zA-Z~]/g;
const plain = (raw: string) => raw.replace(OSC, "").replace(CSI, "").replace(/\r/g, "").trim();

/** The machine named on the command line (home unless told otherwise), up at its prompt. */
export async function guest(onPrivate: (verb: string, fields: string[], machine: Machine) => void) {
  const name = process.argv[2] ?? "home";
  if (!(name in machines)) throw new Error(`no machine called ${name}; there is ${Object.keys(machines).join(" and ")}`);
  const machine = new Machine({
    ...v86Options(at, await readManifest(), name as MachineName, { cold: false }),
    wasm_path: join(ROOT, "node_modules/v86/build/v86.wasm"),
  });

  const term = new xterm.Terminal({ cols: 100, rows: 32, allowProposedApi: true });
  term.onData((data) => machine.write(data));
  term.parser.registerOscHandler(7337, (data) => {
    const [verb, ...rest] = data.split(";");
    onPrivate(verb ?? "", rest, machine);
    return true;
  });
  const decoder = new TextDecoder();
  let screen = "";
  machine.onOutput((bytes) => {
    term.write(bytes);
    screen += decoder.decode(bytes, { stream: true });
  });

  await machine.loaded();
  machine.resize(100, 32);
  machine.attach("UTC");
  await sleep(1500);

  const until = async (what: string, test: () => boolean, ms = 180_000) => {
    const deadline = performance.now() + ms;
    while (!test()) {
      if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await sleep(20);
    }
  };

  /** Runs a command at fish's prompt; resolves with what it printed. */
  async function run(command: string) {
    const from = screen.length;
    machine.write(` ${command}\r`);
    // oxlint-disable-next-line no-control-regex
    const done = () => /\x1b\]133;D[^\x07]*\x07[\s\S]*\x1b\]133;B/.test(screen.slice(from));
    await until(`"${command}"`, done);
    const output = screen.slice(from);
    return plain(output.slice(output.indexOf("\x07", output.indexOf("\x1b]133;C")) + 1, output.indexOf("\x1b]133;D")));
  }

  return { name, machine, run, until };
}

/** Says how one check went, and keeps count of the ones that failed. */
export class Checks {
  failed = 0;

  check(what: string, ok: boolean, detail = "") {
    if (!ok) this.failed++;
    info(`${ok ? "ok    " : "FAILED"}  ${what}${detail && `  ·  ${detail}`}`);
  }

  /** Ends the run: 0 if every check held. */
  done(): never {
    console.log(this.failed ? `\n${this.failed} failed` : "\nall well");
    process.exit(this.failed ? 1 : 0);
  }
}

/** Runs `work`, and says how long it took. */
export async function timed<T>(work: () => Promise<T>): Promise<[T, string]> {
  const started = performance.now();
  const result = await work();
  return [result, `${((performance.now() - started) / 1000).toFixed(1)} s`];
}
