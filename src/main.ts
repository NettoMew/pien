import "./style.css";
import wasm from "v86/build/v86.wasm?url";
import manifest from "virtual:vm-manifest";
import { BLOBS, v86Options } from "../vm.config.ts";
import { watchFetches } from "./lazy.ts";
import { Machine } from "./machine.ts";
import { formatBytes, status } from "./status.ts";
import { createTerminal, openLink } from "./terminal.ts";
import { ink, palette } from "./theme.ts";
import { known, net } from "./warp/index.ts";

const vm = (file: string) => `${import.meta.env.BASE_URL}vm/${file}`;
const cold = new URLSearchParams(location.search).has("cold"); // ?cold boots the kernel instead

const term = await createTerminal(document.getElementById("terminal")!);
const { files } = manifest;
const machine = new Machine({ ...v86Options(vm, files, { cold }), wasm_path: wasm });
const screen = cold || !files.screen ? null : fetch(vm(files.screen)).then((res) => res.arrayBuffer());

status.machine(`${manifest.arch} · Alpine ${manifest.alpine} · Linux ${manifest.kernel} · fish ${manifest.fish}`);

// ─── Loading, drawn in the terminal itself ───────────────────────────────────

const dim = ink(palette.muted);
const off = "\x1b[0m";
term.write(
  `\x1b[?25l\r\n  \x1b[1mguest@home${off}\r\n` +
    `  ${dim}${cold ? "正在冷启动这台机器 …" : "正在载入这台机器的内存快照 …"}${off}\r\n\r\n`,
);

const downloads = new Map<string, { loaded: number; total: number }>();
machine.emulator.add_listener("download-progress", ({ file_name, loaded, total }) => {
  downloads.set(file_name, { loaded, total });
  let done = 0;
  let all = 0;
  for (const d of downloads.values()) (done += d.loaded), (all += d.total);

  // Behind a compressing server the browser may count decoded bytes against an
  // encoded total, so the ratio is clamped rather than trusted.
  const ratio = all ? Math.min(1, done / all) : 0;
  const width = Math.max(12, Math.min(40, term.cols - 26));
  const filled = Math.round(ratio * width);
  term.write(
    `\x1b[2K\r  ${ink(palette.cyan)}${"━".repeat(filled)}${ink(palette.line)}${"━".repeat(width - filled)}${off}` +
      `  ${dim}${formatBytes(done)}${all && done <= all ? ` / ${formatBytes(all)}` : ""}${off}`,
  );
  status.set("loading", all ? `载入 ${Math.round(ratio * 100)}%` : "载入中");
});

machine.emulator.add_listener("download-error", ({ file_name }) => {
  status.set("error", "载入失败");
  term.write(`\r\n\r\n  ${ink(palette.red)}没能载入 ${file_name}，刷新试试。${off}\r\n`);
});

// ─── What the guest says to the page ─────────────────────────────────────────

term.onTitleChange((title) => (document.title = title.trim() ? `${title.trim()} — guest@home` : "guest@home"));

// The guest's `open` and `net` print a private escape sequence; see open.fish, net.fish.
term.parser.registerOscHandler(7337, (data) => {
  const [verb, ...rest] = data.split(";");
  if (verb === "open") openLink(rest.join(";"));
  if (verb === "net") void net(rest[0] ?? "", machine);
  return true;
});

// fish marks each prompt (OSC 133;B). The first one means the visit has begun.
let ready = false;
term.parser.registerOscHandler(133, (data) => {
  if (!ready && data.startsWith("B")) {
    ready = true;
    performance.mark("first prompt");
    status.set("running", `运行中 · ${(performance.now() / 1000).toFixed(1)} s`);
    const blobs = new URL(vm(BLOBS), location.href).pathname;
    watchFetches(blobs, vm(files.fsJson), (path, bytes, ms, cached) =>
      status.fetched(path, cached ? "缓存" : `${formatBytes(bytes)} · ${Math.round(ms)} ms`),
    );
  }
  return false;
});

// ─── Resume ──────────────────────────────────────────────────────────────────

await machine.loaded();
performance.mark("machine resumed");
term.write("\x1b[2J\x1b[3J\x1b[H\x1b[?25h");

// The snapshot was taken with fish already at its prompt, so put back what its
// terminal showed. Input is wired only afterwards: the recording holds fish's
// startup queries, whose answers it already got when the recording was made.
if (screen) {
  const recorded = new Uint8Array(await screen);
  await new Promise<void>((resolve) => term.write(recorded, resolve));
}

machine.onOutput((bytes) => term.write(bytes));
term.onData((data) => machine.write(data));
term.onBinary((data) => machine.write(Uint8Array.from(data, (c) => c.charCodeAt(0))));
term.onResize(({ cols, rows }) => machine.resize(cols, rows));

// Sets the guest's clock (and, on a cold boot, starts the session); tells it
// whether this browser already has a WARP device.
const greet = () => {
  machine.attach();
  if (known()) machine.control("net known");
};

// A cold-booted guest starts its control line after we got here; greet it again then.
machine.onControl((line) => line === "ready" && greet());

// The touch-screen key row. Acting on pointerdown, and cancelling it, keeps
// the terminal focused — so the on-screen keyboard stays up.
const KEYS: Record<string, string> = { tab: "\t", up: "\x1b[A", interrupt: "\x03" };
document.getElementById("keys")!.addEventListener("pointerdown", (event) => {
  const button = (event.target as HTMLElement).closest("button");
  if (!button) return;
  event.preventDefault();
  const { key, run } = button.dataset;
  term.input(key ? KEYS[key]! : `${run}\r`);
  term.focus();
});

machine.resize(term.cols, term.rows); // fish redraws its prompt to fit
greet();
term.focus();

if (import.meta.env.DEV) Object.assign(globalThis, { term, machine });
