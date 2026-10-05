// The machines, shared by the builders (Node) and the page. A saved state
// only restores into an identical machine, so they must never drift apart —
// hence a single source.
//
// Both run the same kernel on the same image. The home machine is small and
// comes up in a moment; the workbench has the memory to compile, and a second
// disk of toolchains (docs/workbench.md) that /etc/rc lays over /usr.
//
// A sealed machine is kept whole, but neither built nor shipped, and the page
// neither starts it nor switches to it: the workbench, since 2026-10-05.
// Unsealing it is setting `sealed` to false, and the rest docs/workbench.md says.

import type { V86Options } from "v86";

export const machines = {
  // v86 reserves the top 16 MB of RAM: 80 MB gives the guest a usable 64 MB.
  home: { memoryMB: 80, disk: false, sealed: false },
  // A kernel without highmem addresses up to 896 MB; this stays under it.
  workbench: { memoryMB: 784, disk: true, sealed: true },
} as const satisfies Record<string, { memoryMB: number; disk: boolean; sealed: boolean }>;

export type MachineName = keyof typeof machines;

/** What the guest has of a machine's memory to use. */
export const usableMemoryMB = (name: MachineName) => machines[name].memoryMB - 16;

/** The machines that are built, shipped and started. */
export const inService = (Object.keys(machines) as MachineName[]).filter((name) => !machines[name].sealed);

/** Whether `name` names a machine in service. */
export const inServiceNamed = (name: string): name is MachineName => (inService as string[]).includes(name);

export const cmdline = [
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
].join(" ");

/** File contents, one blob per file, named by hash (see scripts/lib/rootfs.ts). */
export const BLOBS = "fs/";

/** The toolchain disk is read in chunks of this size, each one HTTP range request. */
const DISK_CHUNK = 256 << 10;

/** A saved machine: its state, and the screen it was saved at (build-state). */
export interface Snapshot {
  state: string;
  screen: string;
}

/** What the builders produced (public/vm/manifest.json). Paths are relative to /vm/ and content-hashed. */
export interface Manifest {
  hostname: string;
  arch: string;
  alpine: string;
  kernel: string;
  fish: string;
  /** The image's packages, name to version. */
  packages: Record<string, string>;
  files: {
    fsJson: string;
    bios: string;
    vgaBios: string;
    kernel: string;
  };
  /** The workbench's toolchain disk (build-workbench), and what is on it. */
  workbench?: {
    disk: string;
    size: number;
    versions: Record<string, string>;
  };
  snapshots: Partial<Record<MachineName, Snapshot>>;
}

/**
 * v86 options for the machine `name`. `at` maps an artifact path to a URL
 * (page) or a file path (Node). A cold boot starts the kernel; otherwise the
 * saved state is restored and the machine resumes where the builder left it.
 */
export function v86Options(at: (file: string) => string, manifest: Manifest, name: MachineName, { cold = false } = {}): V86Options {
  const { memoryMB, disk } = machines[name];
  const { files, workbench } = manifest;
  const snapshot = manifest.snapshots[name];
  if (!cold && !snapshot) throw new Error(`no snapshot of the ${name} machine yet: npm run build:state`);
  if (disk && !workbench) throw new Error("no toolchain disk yet: npm run build:workbench");
  return {
    memory_size: memoryMB << 20,
    vga_memory_size: 256 << 10,
    bios: { url: at(files.bios) },
    vga_bios: { url: at(files.vgaBios) },
    virtio_console: { type: "none" }, // hvc0: the visitor's terminal, with real window-size events; we render it
    uart1: true, // ttyS1: a quiet control line between page and guest
    uart2: true, // ttyS2: a serial port from the visitor's computer (src/serial/)
    // eth0, wired to nothing until `net on` or `net warp` (src/net/); hostd
    // sets its address and MTU then. On restore v86 would pick a new MAC
    // behind the guest's back; keep the one the snapshot has.
    net_device: { type: "virtio" },
    preserve_mac_from_state_image: true,
    disable_keyboard: true,
    disable_mouse: true,
    disable_speaker: true,
    autostart: true,
    filesystem: { baseurl: at(BLOBS), ...(cold && { basefs: at(files.fsJson) }) },
    // The workbench's toolchains: read-only, read as they are needed.
    ...(disk && workbench && { hda: { url: at(workbench.disk), async: true, size: workbench.size, fixed_chunk_size: DISK_CHUNK } }),
    ...(cold ? { bzimage: { url: at(files.kernel) }, cmdline } : { initial_state: { url: at(snapshot!.state) } }),
  };
}
