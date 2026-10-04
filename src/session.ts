// The machine behind the terminal, one per page. It starts loading the moment
// the page does; whatever draws it watches it come up through the store.

import wasm from "v86/build/v86.wasm?url";
import manifest from "virtual:vm-manifest";
import { v86Options } from "../vm.config.ts";
import { Machine } from "./machine.ts";
import { known, net } from "./net/index.ts";
import { useMachine } from "./store.ts";
import { opened, openLink, term } from "./terminal.ts";

const vm = (file: string) => `${import.meta.env.BASE_URL}vm/${file}`;
const { files } = manifest;

/** `?cold` boots the kernel instead of resuming the snapshot. */
export const cold = new URLSearchParams(location.search).has("cold");

export const machine = new Machine({ ...v86Options(vm, files, { cold }), wasm_path: wasm });
const screen = cold || !files.screen ? null : fetch(vm(files.screen)).then((res) => res.arrayBuffer());

// How much has arrived, across every file the machine asked for. Behind a
// compressing server the browser may count decoded bytes against an encoded
// total, so the ratio is clamped rather than trusted.
const downloads = new Map<string, { loaded: number; total: number }>();
machine.emulator.add_listener("download-progress", ({ file_name, loaded, total }) => {
  downloads.set(file_name, { loaded, total });
  let done = 0;
  let all = 0;
  for (const file of downloads.values()) {
    done += file.loaded;
    all += file.total;
  }
  useMachine.setState({ progress: all ? Math.min(1, done / all) : 0 });
});
machine.emulator.add_listener("download-error", ({ file_name }) =>
  useMachine.setState({ phase: "failed", missing: file_name }),
);

term.onTitleChange((title) => useMachine.setState({ title: title.trim() }));

// The guest's `open` and `net` print a private escape sequence; see open.fish, net.fish.
term.parser.registerOscHandler(7337, (data) => {
  const [verb, ...rest] = data.split(";");
  if (verb === "open") openLink(rest.join(";"));
  if (verb === "net") void net(rest[0] ?? "", rest.slice(1).join(";"), machine);
  return true;
});

// Sets the guest's clock and time zone to the browser's (and, on a cold boot,
// starts the session); tells it whether this browser already has a WARP device.
const greet = () => {
  machine.attach(Intl.DateTimeFormat().resolvedOptions().timeZone);
  if (known()) machine.control("net known");
};

// An emulated clock drifts, and stops while the tab sleeps: keep it honest.
setInterval(() => machine.clock(), 60_000);
document.addEventListener("visibilitychange", () => document.hidden || machine.clock());

// A cold-booted guest starts its control line after we got here; greet it again then.
machine.onControl((line) => line === "ready" && greet());

// The snapshot was taken with fish already at its prompt, so put back what its
// terminal showed. Input is wired only afterwards: the recording holds fish's
// startup queries, whose answers it already got when the recording was made.
async function resume() {
  await Promise.all([machine.loaded(), opened]);
  if (screen) {
    const recorded = new Uint8Array(await screen);
    await new Promise<void>((done) => term.write(recorded, done));
  }
  machine.onOutput((bytes) => term.write(bytes));
  term.onData((data) => machine.write(data));
  term.onBinary((data) => machine.write(Uint8Array.from(data, (c) => c.charCodeAt(0))));
  term.onResize(({ cols, rows }) => machine.resize(cols, rows));
  machine.resize(term.cols, term.rows); // fish redraws its prompt to fit
  greet();
  useMachine.setState({ phase: "running" });
}

void resume();

if (import.meta.env.DEV) Object.assign(globalThis, { term, machine });
