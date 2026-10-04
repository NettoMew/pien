// The machine behind the terminal, one at a time. The first starts loading
// the moment the page does; after that the guest's `workbench` and `home` ask
// for the other one, and the screen powers down and up around the switch
// (App.tsx). Whatever draws it watches it come up through the store.

import wasm from "v86/build/v86.wasm?url";
import manifest from "virtual:vm-manifest";
import { type MachineName, machines, v86Options } from "../vm.config.ts";
import { pick, put } from "./drop.ts";
import { Machine } from "./machine.ts";
import { known, net, unwire as unwireNet } from "./net/index.ts";
import { useMachine } from "./store.ts";
import { opened, openLink, term } from "./terminal.ts";
import { introduce, usb, unwire as unwireUsb } from "./usb/index.ts";

const vm = (file: string) => `${import.meta.env.BASE_URL}vm/${file}`;
const params = new URLSearchParams(location.search);

/** `?cold` boots the kernel instead of resuming a snapshot. */
export const cold = params.has("cold");

/** The machine on screen; input reaches it once its screen is back (live). */
let machine: Machine | undefined;
let live = false;

// The terminal is wired once and speaks to whichever machine is live.
term.onData((data) => live && machine?.write(data));
term.onBinary((data) => live && machine?.write(Uint8Array.from(data, (c) => c.charCodeAt(0))));
term.onResize(({ cols, rows }) => live && machine?.resize(cols, rows));

// The guest's `open`, `net`, `drop`, `workbench`/`home`, and on the workbench
// `adb`, `fastboot` and `usb`, print a private escape sequence; see open.fish,
// net.fish, drop.fish, workbench.fish and the workbench's __usb.fish.
term.parser.registerOscHandler(7337, (data) => {
  const [verb, ...rest] = data.split(";");
  if (verb === "open") openLink(rest.join(";"));
  if (verb === "net" && machine) void net(rest[0] ?? "", rest.slice(1).join(";"), machine);
  if (verb === "usb" && machine) void usb(rest[0] ?? "", machine);
  if (verb === "drop" && machine) pick(machine);
  if (verb === "machine" && (rest[0] === "home" || rest[0] === "workbench") && rest[0] !== useMachine.getState().machine) {
    useMachine.setState({ next: rest[0] });
  }
  return true;
});

// An emulated clock drifts, and stops while the tab sleeps: keep it honest.
setInterval(() => live && machine?.clock(), 60_000);
document.addEventListener("visibilitychange", () => document.hidden || (live && machine?.clock()));

/** Starts the machine `name`: from its snapshot, or from the kernel up with ?cold. */
export function start(name: MachineName) {
  useMachine.setState({ machine: name, phase: "loading", progress: 0, problem: undefined, next: undefined });
  remember(name);

  let started: Machine;
  try {
    started = new Machine({ ...v86Options(vm, manifest, name, { cold }), wasm_path: wasm });
  } catch (error) {
    // Most likely the memory: the workbench asks the browser for all of its at once.
    const problem = error instanceof RangeError ? `Not enough memory here for the ${name}: it needs ${machines[name].memoryMB} MB.` : String(error);
    useMachine.setState({ phase: "failed", problem });
    return;
  }
  machine = started;
  void resume(started, name);
}

/** Files dropped onto the page, into the guest's ~/drop; false if no machine is up to take them. */
export function dropFiles(files: File[]): boolean {
  if (!live || !machine) return false;
  put(files, machine);
  return true;
}

/** Keeps the machine in the address (?workbench), so a reload comes back to it. */
function remember(name: MachineName) {
  const others = new URLSearchParams(location.search);
  others.delete("workbench");
  const query = [name === "workbench" ? "workbench" : "", others.toString()].filter(Boolean).join("&");
  history.replaceState(history.state, "", `${location.pathname}${query && `?${query}`}${location.hash}`);
}

/** Powers the machine down and clears the screen, ready for the next. */
export async function stop() {
  const stopping = machine;
  machine = undefined;
  live = false;
  unwireNet();
  await unwireUsb();
  term.reset();
  await stopping?.destroy();
}

async function resume(started: Machine, name: MachineName) {
  const snapshot = manifest.snapshots[name];
  const screen = cold || !snapshot ? null : fetch(vm(snapshot.screen)).then((res) => res.arrayBuffer());

  // How much has arrived, across every file the machine asked for. Behind a
  // compressing server the browser may count decoded bytes against an
  // encoded total, so the ratio is clamped rather than trusted.
  const downloads = new Map<string, { loaded: number; total: number }>();
  started.emulator.add_listener("download-progress", ({ file_name, loaded, total }) => {
    downloads.set(file_name, { loaded, total });
    let done = 0;
    let all = 0;
    for (const file of downloads.values()) {
      done += file.loaded;
      all += file.total;
    }
    useMachine.setState({ progress: all ? Math.min(1, done / all) : 0 });
  });
  started.emulator.add_listener("download-error", ({ file_name }) =>
    useMachine.setState({ phase: "failed", problem: `Could not load ${file_name}. Try reloading.` }),
  );

  // Sets the guest's clock and time zone to the browser's (and, on a cold
  // boot, starts the session); tells it whether this browser already has a
  // WARP device, and the workbench this browser's adb key. A cold-booted
  // guest opens its control line after we got here, and says so: it is
  // greeted again then.
  const greet = () => {
    started.attach(Intl.DateTimeFormat().resolvedOptions().timeZone);
    if (known()) started.control("net known");
    if (name === "workbench") void introduce(started);
  };
  started.onControl((line) => line === "ready" && greet());

  // The snapshot was taken with fish already at its prompt, so put back what
  // its terminal showed. Input is wired only afterwards: the recording holds
  // fish's startup queries, whose answers it already got when it was made.
  await Promise.all([started.loaded(), opened]);
  if (machine !== started) return; // switched away while it loaded
  if (screen) {
    const recorded = new Uint8Array(await screen);
    await new Promise<void>((done) => term.write(recorded, done));
  }
  started.onOutput((bytes) => machine === started && term.write(bytes));
  live = true;
  started.resize(term.cols, term.rows); // fish redraws its prompt to fit
  greet();
  useMachine.setState({ phase: "running" });
}

start(params.has("workbench") ? "workbench" : "home");

if (import.meta.env.DEV) Object.assign(globalThis, { term, machine: () => machine });
