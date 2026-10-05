// The Bluetooth LE side of /dev/ttyBLE0: a device's serial service over Web
// Bluetooth, lent to the guest as its ttyS3, a fourth 16550 v86 emulates.
// BLE has no serial profile of its own. Each maker defines a GATT service,
// with a characteristic the device notifies its bytes on and one it is
// written to: the services below are found by themselves, and `ble --uuid`
// names any other, whose two characteristics are told apart by what they
// allow. Bytes alone go across: speed and framing are the module's own, at
// its UART, and there are no modem lines.
//
// A device that goes, out of range or restarted, is tried again a while, as
// long as the guest wants one; ttyS3 stays as it was all the while.

import { BluetoothSearching } from "lucide-react";
import { isUuid, uuid } from "../bluetooth.ts";
import { gesture } from "../gesture.ts";
import type { Machine, SerialLine } from "../machine.ts";

/** A serial service: its UUID, and the characteristic for each way, unless the two go by what they allow. */
interface Profile {
  name: string;
  service: string;
  /** The device's bytes, notified. */
  notify?: string;
  /** Bytes for the device, written. */
  write?: string;
}

const nordic = (n: number) => `6e40000${n}-b5a3-f393-e0a9-e50e24dcca9e`;
const microchip = (id: string) => `49535343-${id}`;
const ezurio = (n: string) => `569a${n}-b87f-490c-92cb-11ba5ea5167c`;
const ublox = (n: number) => `2456e1b9-26e2-8f83-e744-f34f01e9d70${n}`;

/** The serial services known here, in the order they are looked for. */
const PROFILES: Profile[] = [
  // Nordic's, and what follows it: Zephyr, ESP32's examples, MicroPython's BLE REPL, Adafruit's Bluefruit.
  { name: "Nordic UART", service: nordic(1), write: nordic(2), notify: nordic(3) },
  // HM-10 and the TI CC2541 modules like it (HC-08, JDY-08, BT05, AT-09): one characteristic both ways.
  { name: "HM-10", service: uuid(0xffe0), write: uuid(0xffe1), notify: uuid(0xffe1) },
  // WCH's CH9141 and CH9143.
  { name: "CH9141", service: uuid(0xfff0), notify: uuid(0xfff1), write: uuid(0xfff2) },
  // Microchip's RN4870, BM70 and their kin, ISSC's before.
  { name: "Microchip Transparent UART", service: microchip("fe7d-4ae5-8fa9-9fafd205e455"), notify: microchip("1e4d-4bd9-ba61-23c647249616"), write: microchip("8841-43f4-a8d4-ecbe34729bb3") },
  // Ezurio's BL65x modules, Laird's before.
  { name: "Ezurio VSP", service: ezurio("1101"), notify: ezurio("2000"), write: ezurio("2001") },
  // u-blox's NINA-B and ANNA-B, without credits: one characteristic both ways.
  { name: "u-blox SPS", service: ublox(1), notify: ublox(3), write: ublox(3) },
];

/**
 * What one write carries, sure to fit: the least MTU BLE allows, 23 bytes,
 * less the 3 of its header. Web Bluetooth does not tell the MTU agreed.
 */
const CHUNK = 20;

/** How often, and how many times, to try a device lost: two minutes, in all. */
const AGAIN_MS = 3000;
const AGAIN_TRIES = 40;

/** A device's serial service, its two characteristics found. */
interface Found {
  profile: Profile;
  notify: BluetoothRemoteGATTCharacteristic;
  write: BluetoothRemoteGATTCharacteristic;
}

/** A device's serial service, lent to the guest's ttyS3. */
class Link {
  readonly device: BluetoothDevice;
  readonly profile: Profile;
  private readonly notify: BluetoothRemoteGATTCharacteristic;
  private readonly write: BluetoothRemoteGATTCharacteristic;
  private readonly line: SerialLine;
  private readonly broken: (error: unknown) => void;
  private outgoing: number[] = [];
  private work: Promise<unknown> = Promise.resolve();
  private stop?: () => void;
  private closed = false;

  constructor(device: BluetoothDevice, { profile, notify, write }: Found, line: SerialLine, broken: (error: unknown) => void) {
    this.device = device;
    this.profile = profile;
    this.notify = notify;
    this.write = write;
    this.line = line;
    this.broken = broken;
  }

  async open() {
    this.notify.addEventListener("characteristicvaluechanged", this.heard);
    await this.notify.startNotifications();
    this.stop = this.line.onData((byte) => {
      if (this.outgoing.push(byte) === 1) queueMicrotask(() => this.handOver());
    });
  }

  /** The device's bytes, to the guest. */
  private readonly heard = (event: Event) => {
    const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
    if (value) this.line.write(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  };

  /** The guest's bytes so far, to the device, in writes BLE carries, one after another. */
  private handOver() {
    const bytes = Uint8Array.from(this.outgoing);
    this.outgoing = [];
    for (let at = 0; at < bytes.length; at += CHUNK) {
      const chunk = bytes.subarray(at, at + CHUNK);
      this.work = this.work.then(() => this.send(chunk)).catch((error) => this.closed || this.broken(error));
    }
  }

  /** Without a response where the device allows it: the next write need not wait for the last one's. */
  private send(chunk: Uint8Array<ArrayBuffer>) {
    return this.write.properties.writeWithoutResponse ? this.write.writeValueWithoutResponse(chunk) : this.write.writeValueWithResponse(chunk);
  }

  async close() {
    this.closed = true;
    this.stop?.();
    this.notify.removeEventListener("characteristicvaluechanged", this.heard);
    await this.work.catch(() => {});
    this.device.gatt?.disconnect();
  }
}

/**
 * Connects to `device` and finds its serial service: the one asked for, or
 * the first known here that it has. Web Bluetooth lists only the services
 * the device was chosen for.
 */
async function serviceOf(device: BluetoothDevice, wanted?: string): Promise<Found | undefined> {
  const services = await (await device.gatt!.connect()).getPrimaryServices();
  const profiles = wanted ? [PROFILES.find((profile) => profile.service === wanted) ?? { name: `service ${wanted}`, service: wanted }] : PROFILES;
  for (const profile of profiles) {
    const service = services.find((service) => uuid(service.uuid) === profile.service);
    if (!service) continue;
    const characteristics = await service.getCharacteristics();
    const find = (id: string | undefined, allows: (can: BluetoothCharacteristicProperties) => boolean) =>
      characteristics.find((characteristic) => (id ? uuid(characteristic.uuid) === id : allows(characteristic.properties)));
    const notify = find(profile.notify, (can) => can.notify || can.indicate);
    const write = find(profile.write, (can) => can.write || can.writeWithoutResponse);
    if (notify && write) return { profile, notify, write };
  }
  return undefined;
}

let link: Link | undefined;

/** The machine that asked for a device, while it wants one: a device that comes back is lent to it again. */
let asking: Machine | undefined;

/** The device the visitor chose, and the services it was chosen for: the next `ble` asks no more, until `ble off`. */
let chosen: { device: BluetoothDevice; services: string[] } | undefined;

/** The joins so far, one after another: the visitor's `ble`, and a device back again. */
let joining = Promise.resolve();

/**
 * Lends the guest a device's serial service: the device chosen before, or
 * one the visitor chooses, from all those the browser hears. The list cannot
 * be narrowed to serial devices: many do not say which services they have
 * until they are connected to.
 */
export async function open(machine: Machine, id?: string) {
  const bluetooth = navigator.bluetooth as Bluetooth | undefined;
  if (!bluetooth) return down(machine, "unsupported");
  if (id && !isUuid(id)) return down(machine, "invalid");
  if (!(await bluetooth.getAvailability())) return down(machine, "unavailable");
  asking = machine;
  if (link) return up(machine, link);

  const wanted = id && uuid(id);
  if (!chosen || (wanted && !chosen.services.includes(wanted))) {
    const services = [...new Set([...PROFILES.map((profile) => profile.service), ...(wanted ? [wanted] : [])])];
    try {
      // The browser lists devices only as the visitor touches the page.
      const device = await gesture("Choose a Bluetooth device", BluetoothSearching, () =>
        bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: services }),
      );
      device.addEventListener("gattserverdisconnected", () => {
        if (link?.device === device) void broken(link, new DOMException("The device went away.", "NetworkError"));
      });
      chosen = { device, services };
    } catch {
      return down(machine, "cancelled");
    }
  }
  await join(chosen.device, machine, wanted);
}

/** Lets go of the device, and forgets it: for `ble off`, saying so, or quietly as the machine goes. */
export async function release(machine?: Machine) {
  asking = undefined;
  chosen = undefined;
  await drop();
  if (machine) down(machine, "off");
}

/**
 * Lends `device` to the guest, unless a device is lent already; whether one
 * is. `quietly`, a failure goes unsaid: the guest heard already why it has none.
 */
function join(device: BluetoothDevice, machine: Machine, wanted?: string, quietly = false) {
  const turn = joining.then(async () => {
    if (link) return true;
    try {
      const found = await serviceOf(device, wanted);
      if (!found) {
        // No use asking it again: the next `ble` lets the visitor choose another.
        device.gatt?.disconnect();
        if (chosen?.device === device) chosen = undefined;
        if (!quietly) down(machine, wanted ? `missing ${wanted}` : "unknown");
        return false;
      }
      const joined: Link = new Link(device, found, machine.serial(3), (error) => void broken(joined, error));
      await joined.open();
      link = joined;
      up(machine, joined);
      return true;
    } catch (error) {
      device.gatt?.disconnect();
      if (!quietly) down(machine, `error ${describe(error)}`);
      return false;
    }
  });
  joining = turn.then(() => {});
  return turn;
}

async function drop(why?: string) {
  const dropping = link;
  link = undefined;
  await dropping?.close();
  if (why && asking) down(asking, why);
}

/** The device went, or a write to it failed: said so, and the device tried again. */
async function broken(failed: Link, error: unknown) {
  if (link !== failed) return;
  await drop(`error ${describe(error)}`);
  for (let tries = 0; tries < AGAIN_TRIES; tries++) {
    await sleep(AGAIN_MS);
    if (!asking || link || chosen?.device !== failed.device) return;
    if (await join(failed.device, asking, failed.profile.service, true)) return;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Tells hostd: ble up <name>, the device's own and its service's. A device
 * names itself, and anyone near can name one anything: none of it may run
 * on into a line of its own.
 */
function up(machine: Machine, { device, profile }: Link) {
  // oxlint-disable-next-line no-control-regex
  const name = (device.name ?? "").replace(/[\0-\x1f\x7f]+/g, " ").trim().slice(0, 64) || "a device with no name";
  machine.control(`ble up ${name} (${profile.name})`);
}

function down(machine: Machine, why: string) {
  machine.control(`ble down ${why}`);
}

function describe(error: unknown) {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).replace(/\s+/g, " ").slice(0, 160);
}
