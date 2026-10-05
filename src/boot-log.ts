// What the screen prints while the machine loads: a boot log, made up every
// line of it (what a small i686 box might say on its way up), with the few
// facts it names filled in from the machine itself. Boot.tsx paces it by the
// real download.

/** A line from the kernel, so many seconds after it started. */
export interface KernelLine {
  kind: "kernel";
  time: number;
  text: string;
  warning?: boolean;
}

/** A service coming up, the way OpenRC prints one: ` * Starting … [ ok ]`. */
export interface ServiceLine {
  kind: "service";
  text: string;
}

export type LogLine = KernelLine | ServiceLine;

interface Machine {
  /** What uname -r says. */
  kernel: string;
  hostname: string;
  memoryMB: number;
  /** Booting the kernel, not resuming a snapshot. */
  cold: boolean;
}

const hex = (value: number, digits: number) => `0x${value.toString(16).padStart(digits, "0")}`;

export function bootLog({ kernel, hostname, memoryMB, cold }: Machine): LogLine[] {
  // The BIOS keeps the top 64 KB of memory; the rest is the kernel's.
  const top = (memoryMB << 20) - 0x10000;
  const total = (top >> 10) - 4;

  const lines: [number, string, boolean?][] = [
    [0, `Linux version ${kernel} (builder@arc) (gcc 15.2.0, GNU ld 2.45.1) #1 PREEMPT`],
    [0, "Command line: root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose quiet"],
    [0, "BIOS-provided physical RAM map:"],
    [0, "BIOS-e820: [mem 0x0000000000000000-0x000000000009fbff] usable"],
    [0, "BIOS-e820: [mem 0x000000000009fc00-0x000000000009ffff] reserved"],
    [0, `BIOS-e820: [mem 0x0000000000100000-${hex(top - 1, 16)}] usable`],
    [0, "NX (Execute Disable) protection: active"],
    [0, "DMI: v86 Virtual Machine, BIOS SeaBIOS 01/01/2011"],
    [0, "tsc: Detected 2899.998 MHz processor"],
    [0, `last_pfn = ${hex(top >> 12, 0)} max_arch_pfn = 0x100000`],
    [0, "found SMP MP-table at [mem 0x000f5a90-0x000f5a9f]"],
    [0, "ACPI: RSDP 0x00000000000F59D0 000014 (v00 BOCHS )"],
    [0, "ACPI BIOS Warning (bug): Incorrect checksum in table [DSDT] - 0x00, should be 0xD7", true],
    [0, "Zone ranges:"],
    [0, `  Normal   [mem 0x0000000000001000-${hex(top - 1, 16)}]`],
    [0, "Dentry cache hash table entries: 16384 (order: 4, 65536 bytes, linear)"],
    [0, `Memory: ${total - 20000}K/${total}K available (4113K kernel code, 412K rwdata)`],
    [0, "SLUB: HWalign=64, Order=0-3, MinObjects=0, CPUs=1, Nodes=1"],
    [0, "NR_IRQS: 2304, nr_irqs: 32, preallocated irqs: 16"],
    [0, "Console: colour dummy device 80x25"],
    [0.003118, "Calibrating delay loop (skipped), value calculated using timer frequency.. 5799.99 BogoMIPS"],
    [0.00842, "pid_max: default: 32768 minimum: 301"],
    [0.013657, "Mount-cache hash table entries: 1024 (order: 0, 4096 bytes, linear)"],
    [0.031204, "CPU0: Intel(R) Pentium(R) 4 CPU (family: 0xf, model: 0x2, stepping: 0x9)"],
    [0.04451, "Performance Events: no PMU driver, software events only."],
    [0.058133, "devtmpfs: initialized"],
    [0.066902, "clocksource: jiffies: mask: 0xffffffff max_cycles: 0xffffffff"],
    [0.081377, "NET: Registered PF_NETLINK/PF_ROUTE protocol family"],
    [0.098216, "PCI: PCI BIOS revision 2.10 entry at 0xfd1e1, last bus=0"],
    [0.11747, "PCI: Using configuration type 1 for base access"],
    [0.135022, "clocksource: Switched to clocksource tsc"],
    [0.151366, "virtio-pci 0000:00:05.0: enabling device (0000 -> 0003)"],
    [0.1639, "virtio-pci 0000:00:06.0: enabling device (0000 -> 0003)"],
    [0.179114, "Serial: 8250/16550 driver, 3 ports, IRQ sharing enabled"],
    [0.183255, "00:05: ttyS0 at I/O 0x3f8 (irq = 4, base_baud = 115200) is a 16550A"],
    [0.186901, "00:06: ttyS1 at I/O 0x2f8 (irq = 3, base_baud = 115200) is a 16550A"],
    [0.190037, "00:07: ttyS2 at I/O 0x3e8 (irq = 4, base_baud = 115200) is a 16550A"],
    [0.212694, "9pnet: Installing 9P2000 support"],
    [0.231808, "NET: Registered PF_INET protocol family"],
    [0.249316, "virtio_net virtio1 eth0: link down"],
    [0.276115, "random: crng init done"],
    [0.30155, "VFS: Mounted root (9p filesystem) on device 0:17."],
    [0.303002, "devtmpfs: mounted"],
    [0.31884, "Freeing unused kernel image (initmem) memory: 412K"],
    [0.320003, "Write protecting kernel text and read-only data: 4204k"],
    [0.321497, "Run /sbin/init as init process"],
  ];
  const services = [
    "Mounting /proc, /sys and /dev/pts ...",
    "Mounting tmpfs on /tmp and /run ...",
    `Setting hostname to ${hostname} ...`,
    "Bringing up loopback ...",
    "Starting hostd on ttyS1 ...",
    "Waiting for a browser ...",
    cold ? "Starting a new session ..." : "Restoring the last session ...",
  ];

  return [
    ...lines.map(([time, text, warning]): LogLine => ({ kind: "kernel", time, text, warning })),
    ...services.map((text): LogLine => ({ kind: "service", text })),
  ];
}
