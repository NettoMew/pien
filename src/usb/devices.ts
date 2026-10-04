// The phone's side: WebUSB. A tool asks for a phone; this takes one the
// visitor has let the site use before, or has the browser offer the choice,
// claims the interface the tool speaks — adb's, or the bootloader's fastboot
// — and joins it to that tool's port. A phone that goes away and comes back
// (a reboot, into the bootloader or out of it) is taken again for the tools
// that have asked, as on any desk.

import { AdbDaemonWebUsbDevice, matchFilters } from "@yume-chan/adb-daemon-webusb";
import type { Machine, PortNumber } from "../machine.ts";
import * as adb from "./adb.ts";
import * as fastboot from "./fastboot.ts";
import type { Tool } from "./index.ts";

/** The interfaces the tools speak, as Google defines them. */
const INTERFACES = {
  adb: { classCode: 0xff, subclassCode: 0x42, protocolCode: 0x01 },
  fastboot: { classCode: 0xff, subclassCode: 0x42, protocolCode: 0x03 },
} as const satisfies Record<Tool, USBDeviceFilter>;

const TOOLS = Object.keys(INTERFACES) as Tool[];

/** /dev/virtio-ports/virtio-1 and -2 in the guest; hostd bridges them to the tools. */
const PORTS = { adb: 1, fastboot: 2 } as const satisfies Record<Tool, PortNumber>;

const PROTOCOLS = { adb, fastboot };

/** A phone joined to a tool's port. */
export interface Link {
  readonly device: USBDevice;
  close(): Promise<void>;
}

/** What a link calls when its transfers fail. */
export type Broken = (error: unknown) => void;

const links = new Map<Tool, Link>();

/** The machine whose tools asked for a phone, and which tools did. */
let asking: { machine: Machine; tools: Set<Tool> } | undefined;

export async function attach(tool: Tool, machine: Machine) {
  const usb = navigator.usb as USB | undefined;
  if (!usb) return down(machine, tool, "unsupported");
  watch(usb);
  if (asking?.machine !== machine) asking = { machine, tools: new Set() };
  asking.tools.add(tool);

  const link = links.get(tool);
  if (link) return up(machine, tool, link.device);

  let device = (await usb.getDevices()).find((device) => matchFilters(device, [INTERFACES[tool]]));
  if (!device) {
    try {
      device = await usb.requestDevice({ filters: Object.values(INTERFACES) });
    } catch (error) {
      // The browser lists devices only right after a key press or a tap.
      return down(machine, tool, named(error, "SecurityError") ? "activation" : "cancelled");
    }
  }
  await join(tool, device, machine);
}

/** Lets go of every phone: for `usb off`, saying so, or quietly as the machine goes. */
export async function release(machine?: Machine) {
  asking = undefined;
  for (const tool of [...links.keys()]) await drop(tool);
  if (machine) for (const tool of TOOLS) down(machine, tool, "off");
}

async function join(tool: Tool, device: USBDevice, machine: Machine) {
  const found = matchFilters(device, [INTERFACES[tool]]);
  if (!found) return down(machine, tool, "mode");
  let link: Link | undefined;
  try {
    link = await PROTOCOLS[tool].open(device, found, machine.port(PORTS[tool]), (error) => broken(tool, link, error));
  } catch (error) {
    // Claiming the interface fails so when another program has it.
    const busy = error instanceof AdbDaemonWebUsbDevice.DeviceBusyError || named(error, "NetworkError");
    return down(machine, tool, busy ? "busy" : `error ${describe(error)}`);
  }
  links.set(tool, link);
  up(machine, tool, device);
}

async function drop(tool: Tool, why?: string) {
  const link = links.get(tool);
  if (!link) return;
  links.delete(tool);
  await link.close();
  if (why && asking) down(asking.machine, tool, why);
}

/**
 * A transfer failed. If the phone was unplugged, the disconnect event says
 * so in a moment (on Windows the transfer fails first); anything else is an
 * error.
 */
function broken(tool: Tool, link: Link | undefined, error: unknown) {
  setTimeout(() => {
    if (link && links.get(tool) === link) void drop(tool, `error ${describe(error)}`);
  }, 200);
}

let watching = false;

function watch(usb: USB) {
  if (watching) return;
  watching = true;
  usb.addEventListener("disconnect", ({ device }) => {
    for (const [tool, link] of links) if (link.device === device) void drop(tool, "gone");
  });
  usb.addEventListener("connect", ({ device }) => {
    if (!asking) return;
    for (const tool of asking.tools) {
      if (!links.has(tool) && matchFilters(device, [INTERFACES[tool]])) void join(tool, device, asking.machine);
    }
  });
}

/** Tells hostd: usb up <tool> <serial> <name>, both safe for the control line. */
function up(machine: Machine, tool: Tool, device: USBDevice) {
  const plain = (text: string | null | undefined) => (text ?? "").replace(/[^\x21-\x7e]+/g, " ").trim();
  const hex = (n: number) => n.toString(16).padStart(4, "0");
  const serial = plain(device.serialNumber).replace(/ /g, "_") || `${hex(device.vendorId)}:${hex(device.productId)}`;
  machine.control(`usb up ${tool} ${serial} ${plain(device.productName) || "phone"}`);
}

function down(machine: Machine, tool: Tool, why: string) {
  machine.control(`usb down ${tool} ${why}`);
}

function named(error: unknown, name: string) {
  return error instanceof Error && error.name === name;
}

function describe(error: unknown) {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).replace(/\s+/g, " ").slice(0, 160);
}
