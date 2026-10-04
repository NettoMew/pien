// One description of the machine, shared by the builders (Node) and the page.
// A saved state only restores into an identical machine, so they must never
// drift apart — hence a single source.

import type { V86Options } from "v86";

export const machine = {
  // v86 reserves the top 16 MB of RAM: 80 MB gives the guest a usable 64 MB.
  memoryMB: 80,
  cmdline: [
    // The kernel mounts the browser's filesystem as its root by itself.
    // v86 reports every file at version 0, which makes Linux refuse to cache
    // anything over 9p; ignoreqv lets the page cache do its job.
    "root=host9p",
    "rootfstype=9p",
    "rootflags=trans=virtio,version=9p2000.L,cache=loose,ignoreqv",
    "rw",
    "console=ttyS0",
    "quiet",
    "loglevel=3",
    "tsc=reliable",
    "mitigations=off",
    "random.trust_cpu=on",
    "init_on_free=1", // freed pages are zeroed, so the saved state compresses well
  ].join(" "),
};

/** File contents, one blob per file, named by hash (see scripts/lib/rootfs.ts). */
export const BLOBS = "fs/";

/** What the builders produced (public/vm/manifest.json). Paths are relative to /vm/ and content-hashed. */
export interface Manifest {
  arch: string;
  alpine: string;
  kernel: string;
  fish: string;
  files: {
    fsJson: string;
    bios: string;
    vgaBios: string;
    kernel: string;
    state?: string; // these two come from build-state
    screen?: string;
  };
}

/**
 * v86 options for this machine. `at` maps an artifact path to a URL (page) or
 * a file path (Node). A cold boot starts the kernel; otherwise the saved state
 * is restored and the machine resumes where the builder left it.
 */
export function v86Options(at: (file: string) => string, files: Manifest["files"], { cold = false } = {}): V86Options {
  if (!cold && !files.state) throw new Error("no snapshot yet: npm run build:state");
  return {
    memory_size: machine.memoryMB << 20,
    vga_memory_size: 256 << 10,
    bios: { url: at(files.bios) },
    vga_bios: { url: at(files.vgaBios) },
    virtio_console: { type: "none" }, // hvc0: the visitor's terminal, with real window-size events; we render it
    uart1: true, // ttyS1: a quiet control line between page and guest
    // eth0, wired to nothing until `net warp` (src/warp/). The MTU fits inside
    // WARP's tunnel. On restore v86 would pick a new MAC behind the guest's
    // back; keep the one the snapshot has.
    net_device: { type: "virtio", mtu: 1280 },
    preserve_mac_from_state_image: true,
    disable_keyboard: true,
    disable_mouse: true,
    disable_speaker: true,
    autostart: true,
    filesystem: { baseurl: at(BLOBS), ...(cold && { basefs: at(files.fsJson) }) },
    ...(cold
      ? { bzimage: { url: at(files.kernel) }, cmdline: machine.cmdline }
      : { initial_state: { url: at(files.state!) } }),
  };
}
