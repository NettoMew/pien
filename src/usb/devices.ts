// The visitor's USB devices, lent to the guest over USB/IP (usbip.ts), each
// on a port of the console of its own: three at a time. A tool, or `usb
// attach`, asks for a device of a kind, by its vendor or its class; this
// takes one the visitor has let the site use before, or has the browser
// offer the choice, and hostd attaches it. From then on the guest's kernel
// has the device as if it were plugged in, and adb, fastboot, dfu-util and
// the rest find it as they would on any computer. A device that goes away
// and comes back as itself (a reboot, a reset) is lent again by itself, as
// on any desk; one that comes back as another device is the browser's to
// offer, and the visitor's to choose.

import { Usb } from "lucide-react";
import { gesture } from "../gesture.ts";
import type { Machine, PortNumber } from "../machine.ts";
import { adbKey } from "./key.ts";
import { Session } from "./usbip.ts";

/** The console's ports a device may be lent on: /dev/virtio-ports/virtio-1 to -3 in the guest. */
const PORTS = [1, 2, 3] as const satisfies PortNumber[];
type Lane = (typeof PORTS)[number];

/** adb's interface, as Google defines it: a device with it gets this browser's adb key first. */
const ADB = { classCode: 0xff, subclassCode: 0x42, protocolCode: 0x01 };

const sessions = new Map<Lane, Session>();

/** The machine the devices are lent to, while it wants them. */
let lending: Machine | undefined;

/** The devices lent this visit, by what makes each itself: one that comes back is lent again. */
const lent = new Set<string>();

/** Bus IDs, as the guest's `usbip` asks for a device: one bus, a number for each device lent. */
let lendings = 0;

/**
 * The kind of device the guest asked for: filters, each `vvvv[:pppp]`, a
 * vendor and maybe its product, or `cc[/ss[/pp]]`, a class and maybe its
 * subclass and protocol, all in hex; none, for any device at all.
 */
export function kinds(asked: string): USBDeviceFilter[] | undefined {
  const filters: USBDeviceFilter[] = [];
  for (const word of asked.split(/\s+/).filter(Boolean)) {
    const vendor = /^([0-9a-f]{4})(?::([0-9a-f]{4}))?$/i.exec(word);
    const kind = /^([0-9a-f]{2})(?:\/([0-9a-f]{2})(?:\/([0-9a-f]{2}))?)?$/i.exec(word);
    const hex = (digits: string | undefined) => (digits === undefined ? undefined : parseInt(digits, 16));
    if (vendor) filters.push({ vendorId: hex(vendor[1]), productId: hex(vendor[2]) });
    else if (kind) filters.push({ classCode: hex(kind[1]), subclassCode: hex(kind[2]), protocolCode: hex(kind[3]) });
    else return undefined;
  }
  return filters.map((filter) => Object.fromEntries(Object.entries(filter).filter(([, value]) => value !== undefined)));
}

/** Whether `device` is of a kind in `filters`, by itself or by one of its interfaces; any device, for none. */
function matches(device: USBDevice, filters: USBDeviceFilter[]) {
  const interfaces = device.configurations.flatMap(({ interfaces }) => interfaces.flatMap(({ alternates }) => alternates));
  const classes = [
    { classCode: device.deviceClass, subclassCode: device.deviceSubclass, protocolCode: device.deviceProtocol },
    ...interfaces.map(({ interfaceClass, interfaceSubclass, interfaceProtocol }) => ({ classCode: interfaceClass, subclassCode: interfaceSubclass, protocolCode: interfaceProtocol })),
  ];
  return (
    !filters.length ||
    filters.some(
      (filter) =>
        (filter.vendorId === undefined || filter.vendorId === device.vendorId) &&
        (filter.productId === undefined || filter.productId === device.productId) &&
        (filter.serialNumber === undefined || filter.serialNumber === device.serialNumber) &&
        classes.some(
          (kind) =>
            (filter.classCode === undefined || filter.classCode === kind.classCode) &&
            (filter.subclassCode === undefined || filter.subclassCode === kind.subclassCode) &&
            (filter.protocolCode === undefined || filter.protocolCode === kind.protocolCode),
        ),
    )
  );
}

/** What makes a device itself, as the browser keeps its permission: vendor, product and serial number. */
const itself = (device: USBDevice) => `${device.vendorId}:${device.productId}:${device.serialNumber ?? ""}`;

/** Lends the guest a device of the kind asked for: one lent already, one the site may use, or one the visitor chooses. */
export async function attach(machine: Machine, asked: string) {
  const usb = navigator.usb as USB | undefined;
  if (!usb) return down(machine, "unsupported");
  const filters = kinds(asked);
  if (!filters) return down(machine, "invalid");
  watch(usb);
  lending = machine;

  const already = [...sessions].find(([, session]) => matches(session.device, filters));
  if (already) return machine.control(`usb up ${already[0]}`);
  if (!PORTS.some((lane) => !sessions.has(lane))) return down(machine, "full");

  const free = (device: USBDevice) => ![...sessions.values()].some((session) => session.device === device);
  let device = (await usb.getDevices()).find((device) => free(device) && matches(device, filters));
  if (!device) {
    try {
      // The browser lists devices only as the visitor touches the page.
      device = await gesture("Choose a USB device", Usb, () => usb.requestDevice({ filters }));
    } catch {
      return down(machine, "cancelled");
    }
    const chosen = device;
    const lane = [...sessions].find(([, session]) => session.device === chosen)?.[0];
    if (lane) return machine.control(`usb up ${lane}`);
  }
  await lend(device, machine);
}

/** Lets go of every device: for `usb off`, saying so, or quietly as the machine goes. */
export async function release(machine?: Machine) {
  lending = undefined;
  lent.clear();
  for (const lane of [...sessions.keys()]) await drop(lane, machine, "off");
  if (machine) down(machine, "off");
}

async function lend(device: USBDevice, machine: Machine) {
  const lane = PORTS.find((lane) => !sessions.has(lane));
  if (!lane) return down(machine, "full");
  try {
    await device.open();
    if (!device.configuration) await device.selectConfiguration(device.configurations[0]!.configurationValue);
  } catch (error) {
    await device.close().catch(() => {});
    // Opening fails so when another program on this computer has the device.
    return down(machine, named(error, "SecurityError") || named(error, "NetworkError") || named(error, "InvalidStateError") ? "busy" : `error ${describe(error)}`);
  }
  const busid = `1-${++lendings}`;
  const session: Session = new Session(device, busid, machine.port(lane), {
    configured: () => machine.control(`usb up ${lane}`),
    broken: (error) => {
      if (sessions.get(lane) === session) void drop(lane, machine, `error ${describe(error)}`);
    },
  });
  sessions.set(lane, session);
  lent.add(itself(device));
  if (matches(device, [ADB])) await introduce(machine);
  machine.control(`usb attach ${lane} ${busid} ${nameOf(device)}`);
}

/** Takes a device back from the guest, which sees it unplugged, and tells it why; quietly, without a machine to tell. */
async function drop(lane: Lane, machine: Machine | undefined, why: string) {
  const session = sessions.get(lane);
  if (!session) return;
  sessions.delete(lane);
  session.close();
  await session.device.close().catch(() => {});
  machine?.control(`usb detach ${lane} ${why}`);
}

/** The machines that have this browser's adb key: adb reads it as its server starts. */
const keyed = new WeakSet<Machine>();

/**
 * Hands the guest this browser's adb key, made the first time a phone is
 * used at all, so a phone that has allowed this browser once allows it
 * again. Without storage to keep one in, adb makes its own, for this visit.
 */
async function introduce(machine: Machine) {
  if (keyed.has(machine)) return;
  keyed.add(machine);
  try {
    const key = await adbKey();
    machine.control(`usb key ${key.private} ${key.public} ${key.name}`);
  } catch (error) {
    console.warn("usb: no adb key kept in this browser:", error);
  }
}

let watching = false;

function watch(usb: USB) {
  if (watching) return;
  watching = true;
  usb.addEventListener("disconnect", ({ device }) => {
    for (const [lane, session] of sessions) if (session.device === device) void drop(lane, lending, "gone");
  });
  usb.addEventListener("connect", ({ device }) => {
    if (lending && lent.has(itself(device)) && ![...sessions.values()].some((session) => session.device === device)) void lend(device, lending);
  });
}

/** The device's name for the guest, as safe for the control line as its IDs: a device names itself. */
function nameOf(device: USBDevice) {
  const plain = (text: string | null | undefined) => (text ?? "").replace(/[^\x21-\x7e]+/g, " ").trim().slice(0, 64);
  const hex = (n: number) => n.toString(16).padStart(4, "0");
  return `${plain(device.productName) || "USB device"} (${hex(device.vendorId)}:${hex(device.productId)})`;
}

function down(machine: Machine, why: string) {
  machine.control(`usb down ${why}`);
}

function named(error: unknown, name: string) {
  return error instanceof Error && error.name === name;
}

function describe(error: unknown) {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).replace(/\s+/g, " ").slice(0, 160);
}
