// Lends pretend Bluetooth LE devices to a machine and drives its ttyS3 with
// the guest's own tools, through the page's bridge (src/ble/) just as a
// browser runs it. Only Web Bluetooth is pretended: devices that send back
// what they are written, as a board echoing its UART would; one with
// Nordic's UART service, one with HM-10's, one with a service of its own,
// and one with no serial service at all. As in a browser, a device lists
// only the services it was chosen for.
//
//   npm run check:ble                  the home machine
//   npm run check:ble -- workbench
//
// Checked: the device chosen from all the browser hears, and its service
// found and named; bytes out and back, in writes of 20 bytes at most; a
// device lost and found again, with the port held open all the while;
// HM-10's one characteristic both ways; a service named by its UUID, its
// characteristics told apart by what they allow; a device with no serial
// service, and choosing another; letting go.

import { ble } from "../src/ble/index.ts";
import { uuid } from "../src/bluetooth.ts";
import { Checks, guest, sleep, timed } from "./lib/guest.ts";
import { info, step } from "./lib/log.ts";

type Can = Partial<BluetoothCharacteristicProperties>;

const bytes = (data: BufferSource) => (ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data)).slice();

/** A characteristic: what it allows, and what is written to it handed to its device. */
class PretendCharacteristic extends EventTarget {
  readonly uuid: string;
  readonly properties: Can;
  value?: DataView;
  device?: PretendDevice;
  private notifying = false;

  constructor(id: string, properties: Can) {
    super();
    this.uuid = id;
    this.properties = properties;
  }

  async startNotifications() {
    if (!this.properties.notify && !this.properties.indicate) throw new DOMException("GATT operation not permitted.", "NotSupportedError");
    this.notifying = true;
    return this;
  }

  async stopNotifications() {
    this.notifying = false;
    return this;
  }

  async writeValueWithoutResponse(data: BufferSource) {
    if (!this.properties.writeWithoutResponse) throw new DOMException("GATT operation not permitted.", "NotSupportedError");
    this.device!.written(this, bytes(data));
  }

  async writeValueWithResponse(data: BufferSource) {
    if (!this.properties.write) throw new DOMException("GATT operation not permitted.", "NotSupportedError");
    this.device!.written(this, bytes(data));
  }

  /** Bytes from the device, to whoever listens. */
  notify(chunk: Uint8Array) {
    if (!this.notifying) return;
    this.value = new DataView(chunk.slice().buffer);
    this.dispatchEvent(new Event("characteristicvaluechanged"));
  }
}

class PretendService {
  readonly uuid: string;
  readonly characteristics: PretendCharacteristic[];

  constructor(id: string, characteristics: PretendCharacteristic[]) {
    this.uuid = id;
    this.characteristics = characteristics;
  }

  async getCharacteristics() {
    return this.characteristics;
  }
}

class PretendServer {
  connected = false;
  private readonly device: PretendDevice;

  constructor(device: PretendDevice) {
    this.device = device;
  }

  async connect() {
    if (this.device.away) throw new DOMException("Connection attempt failed.", "NetworkError");
    this.connected = true;
    this.device.connects++;
    return this;
  }

  disconnect() {
    if (!this.connected) return;
    this.connected = false;
    this.device.dispatchEvent(new Event("gattserverdisconnected"));
  }

  async getPrimaryServices() {
    if (!this.connected) throw new DOMException("GATT Server is disconnected.", "NetworkError");
    return this.device.services.filter((service) => this.device.allowed.includes(service.uuid));
  }
}

/**
 * A device near, with the services given: what is written to the one
 * characteristic it reads, it sends back on the one it notifies on, 20
 * bytes at a time, as a board echoing its UART through a module would.
 */
class PretendDevice extends EventTarget {
  readonly id: string;
  readonly name: string;
  readonly services: PretendService[];
  readonly gatt = new PretendServer(this);
  /** The services the visitor chose it for: the only ones it lists. */
  allowed: string[] = [];
  /** Out of range: no connecting until it is back. */
  away = false;
  connects = 0;
  /** The size of every write, and the latest bytes to arrive, as text. */
  readonly writes: number[] = [];
  arrived = "";
  private readonly into?: PretendCharacteristic;
  private readonly back?: PretendCharacteristic;

  constructor(name: string, services: PretendService[], into?: PretendCharacteristic, back?: PretendCharacteristic) {
    super();
    this.id = name;
    this.name = name;
    this.services = services;
    for (const characteristic of services.flatMap((service) => service.characteristics)) characteristic.device = this;
    this.into = into;
    this.back = back;
  }

  written(characteristic: PretendCharacteristic, chunk: Uint8Array) {
    if (characteristic !== this.into || !this.gatt.connected) return;
    this.writes.push(chunk.length);
    this.arrived = (this.arrived + new TextDecoder().decode(chunk)).slice(-64);
    queueMicrotask(() => this.gatt.connected && this.back?.notify(chunk));
  }

  /** Out of range, of a sudden. */
  lose() {
    this.away = true;
    this.gatt.disconnect();
  }
}

/** A device whose serial service is `service`, written by `into` and notifying by `back` (the same, for HM-10's). */
function echoing(name: string, service: string, into: PretendCharacteristic, back: PretendCharacteristic, others: PretendCharacteristic[] = []) {
  return new PretendDevice(name, [new PretendService(service, [...new Set([...others, into, back])])], into, back);
}

/** navigator.bluetooth: the visitor chooses the device in `next`, or none. */
class PretendBluetooth extends EventTarget {
  next?: PretendDevice;
  readonly asked: RequestDeviceOptions[] = [];

  async getAvailability() {
    return true;
  }

  async requestDevice(options: RequestDeviceOptions) {
    this.asked.push(options);
    if (!this.next) throw new DOMException("User cancelled the requestDevice() chooser.", "NotFoundError");
    this.next.allowed = (options.optionalServices ?? []).map((service) => uuid(service));
    return this.next;
  }
}

const NUS = (n: number) => `6e40000${n}-b5a3-f393-e0a9-e50e24dcca9e`;
const nordic = echoing("Pretend NUS", NUS(1), new PretendCharacteristic(NUS(2), { write: true, writeWithoutResponse: true }), new PretendCharacteristic(NUS(3), { notify: true }));
const both = new PretendCharacteristic(uuid(0xffe1), { read: true, writeWithoutResponse: true, notify: true });
const hm10 = echoing("HMSoft", uuid(0xffe0), both, both);
const OWN = (n: number) => `a0e5f9d0-8c1f-4e4b-9c5e-2b7f3e6a1d4${n}`;
const own = echoing("Pretend Own", OWN(0), new PretendCharacteristic(OWN(3), { write: true }), new PretendCharacteristic(OWN(2), { indicate: true }), [
  // Read alone, ahead of the others: what they allow tells them apart, not their order.
  new PretendCharacteristic(OWN(1), { read: true }),
]);
const battery = new PretendDevice("Pretend Watch", [new PretendService(uuid(0x180f), [new PretendCharacteristic(uuid(0x2a19), { read: true, notify: true })])]);

const bus = new PretendBluetooth();
Object.defineProperty(globalThis.navigator, "bluetooth", { value: bus });

const { name, machine, run } = await guest((verb, [what = "", service], machine) => {
  if (verb === "ble") void ble(what, machine, service);
});
const checks = new Checks();
const check = checks.check.bind(checks);

/** `n` random bytes out through /dev/ttyBLE0 and back: whether they came back whole, and how long it took. */
async function roundTrip(n: number) {
  const [output, took] = await timed(() =>
    run(`head -c ${n} /dev/urandom > /tmp/sent; head -c ${n} /dev/ttyBLE0 > /tmp/back & sleep 0.3; cat /tmp/sent > /dev/ttyBLE0; wait; md5sum < /tmp/sent; md5sum < /tmp/back`),
  );
  // fish reports the background job's end on a line of its own; the sums are the lines md5sum ends with " -".
  const [sent, back] = output.split("\n").filter((line) => line.endsWith(" -"));
  return [!!sent && sent === back, took] as const;
}

step(`the ${name} machine, with a Nordic UART device near`);
bus.next = nordic;
let output = await run("ble");
check("ble", output.includes("/dev/ttyBLE0") && output.includes("Pretend NUS (Nordic UART)"), output.split("\n")[0]);
const [asked] = bus.asked;
check("chosen from all the browser hears", !!asked && "acceptAllDevices" in asked && asked.acceptAllDevices && !!asked.optionalServices?.includes(NUS(1)), `${asked?.optionalServices?.length} services asked for`);
output = await run("readlink /dev/ttyBLE0; stat -c %U /dev/ttyS3");
check("/dev/ttyBLE0 is ttyS3, and the visitor's", output === "ttyS3\nguest", output.split("\n").join(" · "));

step("bytes");
await run("stty -F /dev/ttyBLE0 raw -echo");
const [whole, took] = await roundTrip(8192);
check("8 KB out and back", whole, took);
check("in writes of 20 bytes at most", Math.max(...nordic.writes) <= 20 && nordic.writes.length >= 8192 / 20, `${nordic.writes.length} writes`);
await run("printf 'zutto issho' > /dev/ttyBLE0");
await sleep(200);
check("text arrives as written", nordic.arrived.endsWith("zutto issho"), JSON.stringify(nordic.arrived.slice(-11)));

step("a device lost and found again");
// Out of range a while, with the port held open all the while, as tio
// would: what holds it writes once the device is back.
await run("sh -c 'exec 3> /dev/ttyBLE0; sleep 6; printf held >&3' &; disown");
nordic.lose();
await sleep(1000);
output = await run("cat /run/ble/state; test -e /dev/ttyBLE0; or echo gone");
check("said so", output.startsWith("down error NetworkError: The device went away.") && output.endsWith("gone"), output.split("\n").join(" · "));
nordic.away = false;
await sleep(3000);
output = await run("cat /run/ble/state");
check("and lent again once it is back, unasked", output === "up /dev/ttyBLE0 Pretend NUS (Nordic UART)" && bus.asked.length === 1, output);
await sleep(3000);
check("what held the port open carries on", nordic.arrived.endsWith("held"), JSON.stringify(nordic.arrived.slice(-4)));
output = await run("ble off; cat /run/ble/state; test -e /dev/ttyBLE0; or echo gone");
check("ble off", output.endsWith("down off\ngone") && !nordic.gatt.connected, output.split("\n").join(" · "));

step("HM-10: one characteristic both ways");
bus.next = hm10;
output = await run("ble");
check("ble, a device chosen anew", output.includes("HMSoft (HM-10)") && bus.asked.length === 2, output.split("\n")[0]);
check("bytes out and back", ...(await roundTrip(1000)));
await run("ble off");

step("a service of a device's own");
bus.next = own;
output = await run("ble --uuid nonsense");
check("not a UUID, said so", output.includes("Not a Bluetooth UUID"), output);
output = await run("ble --uuid A0E5F9D0-8C1F-4E4B-9C5E-2B7F3E6A1D40");
check("named by its UUID", output.includes(`Pretend Own (service ${OWN(0)})`) && !!bus.asked.at(-1)?.optionalServices?.includes(OWN(0)), output.split("\n")[0]);
check("its characteristics told apart by what they allow", ...(await roundTrip(1000)));
await run("ble off");

step("a device with no serial service");
bus.next = battery;
output = await run("ble");
check("said so, and let go of", output.includes("no serial service known here") && !battery.gatt.connected, output);
bus.next = nordic;
output = await run("ble");
check("the next ble chooses another", output.includes("Pretend NUS (Nordic UART)"), output.split("\n")[0]);
output = await run("ble off; cat /run/ble/state");
check("ble off", output.endsWith("down off") && !nordic.gatt.connected, output.split("\n").join(" · "));
info(`${bus.asked.length} choices, ${nordic.connects} connections to the Nordic device, ${nordic.writes.length} writes`);

await machine.destroy();
checks.done();
