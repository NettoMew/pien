// Puts pretend USB devices on a machine and runs the guest's own tools
// against them, over USB/IP, through the page's usbipd (src/usb/) just as a
// browser runs it. Only WebUSB and IndexedDB are pretended: each device
// answers as a real one would, down to its descriptors, so the guest's
// kernel enumerates it; a phone runs a small adbd, then a small bootloader,
// and a third device is a DFU bootloader. fake-indexeddb keeps the
// browser's adb key.
//
//   npm run check:usb                  the home machine
//   npm run check:usb -- workbench
//
// Checked: the phone lent and enumerated, the browser's key reaching adb
// (the phone verifies adb's signature with the key the browser keeps), a
// shell, a large read and a large push; a reboot into the bootloader, the
// phone coming back as another device, and fastboot there: a variable, and
// the download of a file dropped onto the page; a device that comes back as
// itself, lent again unasked; dfu-util's download and upload, with a device
// the visitor chooses; letting go.

import "fake-indexeddb/auto";
import { constants, createHash, createPrivateKey, createPublicKey, type KeyObject, publicDecrypt, randomBytes } from "node:crypto";
import AdbWebCredentialStore from "@yume-chan/adb-credential-web";
import { Bytes } from "../src/bytes.ts";
import { put } from "../src/drop.ts";
import { usb } from "../src/usb/index.ts";
import { Checks, guest, sleep, timed } from "./lib/guest.ts";
import { info, size, step } from "./lib/log.ts";

const md5 = (bytes: Uint8Array) => createHash("md5").update(bytes).digest("hex");
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

// A device -----------------------------------------------------------------

interface InterfaceSpec {
  class: number;
  subclass: number;
  protocol: number;
  name?: string;
  /** Bulk endpoints, by number: one each way. */
  bulk?: number;
  /** Class descriptors after the interface's, such as DFU's functional one. */
  extra?: Uint8Array;
}

interface DeviceSpec {
  vendorId: number;
  productId: number;
  manufacturerName: string;
  productName: string;
  serialNumber: string;
  interfaces: InterfaceSpec[];
}

/** What a device does past its descriptors: its own requests, and the bytes that come to it. */
interface Firmware {
  /** A class or vendor request on the control endpoint: what to read back, true for done, or undefined for a stall. */
  control?(setup: USBControlTransferParameters, data: Uint8Array, length: number): Uint8Array | true | undefined;
  receive?(transfer: Uint8Array<ArrayBuffer>): void;
}

const GET_DESCRIPTOR = 6;
const [DEVICE, CONFIGURATION, STRING] = [1, 2, 3];
const BULK_PACKET = 512;

/**
 * A device as WebUSB shows one, and as a USB device answers: its
 * descriptors, standard requests, and bulk endpoints for its firmware.
 */
class Device {
  readonly vendorId: number;
  readonly productId: number;
  readonly manufacturerName: string;
  readonly productName: string;
  readonly serialNumber: string;
  readonly deviceClass = 0;
  readonly deviceSubclass = 0;
  readonly deviceProtocol = 0;
  readonly usbVersionMajor = 2;
  readonly usbVersionMinor = 0;
  readonly usbVersionSubminor = 0;
  readonly deviceVersionMajor = 1;
  readonly deviceVersionMinor = 0;
  readonly deviceVersionSubminor = 0;
  readonly configurations: USBConfiguration[];
  configuration: USBConfiguration | null = null;
  opened = false;
  firmware?: Firmware;
  /** Every configuration the guest set, and every standard request it made, in order. */
  readonly asked: string[] = [];
  private readonly spec: DeviceSpec;
  private readonly strings: string[];
  private readonly transfers: Uint8Array[] = [];
  private reading?: (transfer?: Uint8Array) => void;

  constructor(spec: DeviceSpec) {
    this.spec = spec;
    ({ vendorId: this.vendorId, productId: this.productId, manufacturerName: this.manufacturerName, productName: this.productName, serialNumber: this.serialNumber } = spec);
    this.strings = [spec.manufacturerName, spec.productName, spec.serialNumber, ...spec.interfaces.map(({ name }) => name ?? "")];
    const interfaces = spec.interfaces.map((one, interfaceNumber): USBInterface => {
      const endpoints: USBEndpoint[] = one.bulk
        ? (["in", "out"] as const).map((direction) => ({ endpointNumber: one.bulk!, direction, type: "bulk", packetSize: BULK_PACKET }))
        : [];
      const alternate: USBAlternateInterface = {
        alternateSetting: 0,
        interfaceClass: one.class,
        interfaceSubclass: one.subclass,
        interfaceProtocol: one.protocol,
        interfaceName: one.name ?? null,
        endpoints,
      };
      return { interfaceNumber, alternate, alternates: [alternate], claimed: false };
    });
    this.configurations = [{ configurationValue: 1, configurationName: null, interfaces }];
  }

  /** The descriptor the guest asks for, as the device keeps it. */
  private descriptor(type: number, index: number): Uint8Array | undefined {
    const word = (n: number) => [n & 0xff, n >> 8];
    if (type === DEVICE) {
      return Uint8Array.of(18, DEVICE, ...word(0x0200), 0, 0, 0, 64, ...word(this.vendorId), ...word(this.productId), ...word(0x0100), 1, 2, 3, 1);
    }
    if (type === CONFIGURATION && index === 0) {
      const body = this.spec.interfaces.flatMap((one, number) => [
        ...[9, 4, number, 0, one.bulk ? 2 : 0, one.class, one.subclass, one.protocol, one.name ? 4 + number : 0],
        ...(one.extra ?? []),
        ...(one.bulk ? [7, 5, 0x80 | one.bulk, 2, ...word(BULK_PACKET), 0, 7, 5, one.bulk, 2, ...word(BULK_PACKET), 0] : []),
      ]);
      return Uint8Array.of(9, CONFIGURATION, ...word(9 + body.length), this.spec.interfaces.length, 1, 0, 0x80, 250, ...body);
    }
    if (type === STRING && index === 0) return Uint8Array.of(4, STRING, 0x09, 0x04);
    const string = type === STRING ? this.strings[index - 1] : undefined;
    if (!string) return undefined;
    const utf16 = new Uint8Array(Buffer.from(string, "utf16le"));
    return Uint8Array.of(2 + utf16.length, STRING, ...utf16);
  }

  async open() {
    this.opened = true;
  }
  async close() {
    this.opened = false;
    for (const one of this.configuration?.interfaces ?? []) Object.assign(one, { claimed: false });
    this.reading?.();
  }
  async selectConfiguration(value: number) {
    this.asked.push(`configuration ${value}`);
    this.configuration = this.configurations.find(({ configurationValue }) => configurationValue === value) ?? null;
  }
  async claimInterface(number: number) {
    Object.assign(this.configuration!.interfaces[number]!, { claimed: true });
  }
  async releaseInterface(number: number) {
    Object.assign(this.configuration!.interfaces[number]!, { claimed: false });
  }
  async selectAlternateInterface() {}
  async clearHalt() {}
  async reset() {}
  async forget() {}

  async controlTransferIn(setup: USBControlTransferParameters, length: number): Promise<USBInTransferResult> {
    if (setup.requestType === "standard") {
      this.asked.push(`standard ${setup.request} ${setup.value.toString(16)}`);
      const found = setup.request === GET_DESCRIPTOR ? this.descriptor(setup.value >> 8, setup.value & 0xff) : undefined;
      return found ? { status: "ok", data: view(found.slice(0, length)) } : { status: "stall" };
    }
    const answer = this.firmware?.control?.(setup, new Uint8Array(0), length);
    return answer instanceof Uint8Array ? { status: "ok", data: view(answer.slice(0, length)) } : { status: "stall" };
  }

  async controlTransferOut(setup: USBControlTransferParameters, data?: BufferSource): Promise<USBOutTransferResult> {
    const bytes = data ? new Uint8Array(ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data) : new Uint8Array(0);
    if (setup.requestType === "standard") return { status: "stall", bytesWritten: 0 };
    return this.firmware?.control?.(setup, bytes, 0) ? { status: "ok", bytesWritten: bytes.length } : { status: "stall", bytesWritten: 0 };
  }

  async transferOut(_endpoint: number, data: ArrayBufferView): Promise<USBOutTransferResult> {
    const bytes = new Uint8Array(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    if (bytes.length) this.firmware?.receive?.(bytes);
    return { status: "ok", bytesWritten: bytes.length };
  }

  async transferIn(_endpoint: number, length: number): Promise<USBInTransferResult> {
    const transfer = this.transfers.shift() ?? (await new Promise<Uint8Array | undefined>((resolve) => (this.reading = resolve)));
    this.reading = undefined;
    if (!transfer) throw new DOMException("The transfer was cancelled.", "AbortError");
    if (transfer.length > length) throw new Error(`a ${transfer.length}-byte transfer, read with room for ${length}`);
    return { status: "ok", data: view(transfer.slice()) };
  }

  /** A transfer to the host. */
  send(transfer: Uint8Array) {
    // A read is satisfied once: the next transfer waits for the next read.
    const reading = this.reading;
    this.reading = undefined;
    if (reading) reading(transfer);
    else this.transfers.push(transfer);
  }
}

/** navigator.usb: devices the site may use, and the one the visitor chooses when asked. */
class Usb extends EventTarget {
  devices: Device[] = [];
  /** What the visitor picks from the browser's list, if it is of a kind offered. */
  chooses?: Device;
  readonly asked: USBDeviceRequestOptions[] = [];

  async getDevices() {
    return this.devices;
  }

  async requestDevice(options: USBDeviceRequestOptions): Promise<Device> {
    this.asked.push(options);
    const chosen = this.chooses;
    const offered = chosen && options.filters.some((filter) => (filter.vendorId ?? chosen.vendorId) === chosen.vendorId &&
      chosen.configurations[0]!.interfaces.some(({ alternate }) => (filter.classCode ?? alternate.interfaceClass) === alternate.interfaceClass && (filter.subclassCode ?? alternate.interfaceSubclass) === alternate.interfaceSubclass));
    if (!chosen || !offered) throw new DOMException("No device selected.", "NotFoundError");
    this.devices.push(chosen);
    return chosen;
  }

  plug(device: Device) {
    if (!this.devices.includes(device)) this.devices.push(device);
    this.dispatchEvent(Object.assign(new Event("connect"), { device }));
  }

  unplug(device: Device) {
    this.devices = this.devices.filter((one) => one !== device);
    this.dispatchEvent(Object.assign(new Event("disconnect"), { device }));
  }
}

// A phone ------------------------------------------------------------------

const phone = (mode: "adb" | "fastboot") =>
  new Device({
    vendorId: 0x18d1,
    productId: mode === "adb" ? 0x4ee7 : 0x4ee0,
    manufacturerName: "Pretend",
    productName: "Pretend Phone",
    serialNumber: "PRETEND01",
    interfaces: [{ class: 0xff, subclass: 0x42, protocol: mode === "adb" ? 1 : 3, name: mode === "adb" ? "ADB Interface" : "fastboot", bulk: 1 }],
  });

const CNXN = 0x4e584e43;
const AUTH = 0x48545541;
const OPEN = 0x4e45504f;
const OKAY = 0x59414b4f;
const CLSE = 0x45534c43;
const WRTE = 0x45545257;

/** What `adb shell cat big` reads: 4 MB that are easy to tell apart. */
const BIG = Uint8Array.from({ length: 4 << 20 }, (_, i) => (i * 31 + (i >> 12)) & 0xff);

interface Stream {
  host: number;
  input: Bytes;
  acked?: () => void;
  sync?: { path?: string; hash?: ReturnType<typeof createHash> };
}

/**
 * An adbd: authentication, shell, sync (stat and push) and reboot. Packets
 * arrive as a stream: a header, then its payload, in transfers of whatever
 * size the host's USB stack makes them.
 */
class Adbd implements Firmware {
  verified = false;
  pushed = new Map<string, string>();
  rebooting = false;
  private readonly incoming = new Bytes();
  private header?: { command: number; arg0: number; arg1: number; length: number };
  private token = randomBytes(20);
  private payload = 256 << 10;
  private next = 1;
  private readonly streams = new Map<number, Stream>();
  private readonly device: Device;
  private readonly key: () => Promise<KeyObject>;

  constructor(device: Device, key: () => Promise<KeyObject>) {
    this.device = device;
    this.key = key;
  }

  receive(transfer: Uint8Array<ArrayBuffer>) {
    this.incoming.push(transfer);
    for (;;) {
      if (!this.header) {
        if (this.incoming.length < 24) return;
        const head = view(this.incoming.take(24));
        this.header = { command: head.getUint32(0, true), arg0: head.getUint32(4, true), arg1: head.getUint32(8, true), length: head.getUint32(12, true) };
      }
      if (this.incoming.length < this.header.length) return;
      const { command, arg0, arg1, length } = this.header;
      this.header = undefined;
      void this.handle(command, arg0, arg1, this.incoming.take(length).slice());
    }
  }

  private packet(command: number, arg0: number, arg1: number, payload = new Uint8Array(0)) {
    const header = new Uint8Array(24);
    const out = view(header);
    [command, arg0, arg1, payload.length, 0, ~command >>> 0].forEach((value, i) => out.setUint32(i * 4, value, true));
    this.device.send(header);
    if (payload.length) this.device.send(payload);
  }

  private async handle(command: number, arg0: number, arg1: number, payload: Uint8Array<ArrayBuffer>) {
    switch (command) {
      case CNXN:
        this.payload = Math.min(arg1, this.payload);
        return this.packet(AUTH, 1, 0, this.token);
      case AUTH:
        if (arg0 === 2) {
          // adb signs the token as if it were a SHA-1 digest: it ends what the signature decrypts to.
          const signed = publicDecrypt({ key: await this.key(), padding: constants.RSA_PKCS1_PADDING }, payload);
          this.verified = Buffer.compare(signed.subarray(-20), this.token) === 0;
          if (!this.verified) return this.packet(AUTH, 1, 0, (this.token = randomBytes(20)));
        }
        return this.packet(CNXN, 0x01000001, this.payload, new TextEncoder().encode("device::ro.product.name=pretend;ro.product.model=Pretend;ro.product.device=pretend;features="));
      case OPEN: {
        const id = this.next++;
        const stream: Stream = { host: arg0, input: new Bytes() };
        this.streams.set(id, stream);
        this.packet(OKAY, id, arg0);
        return this.serve(id, stream, text(payload).replace(/\0$/, ""));
      }
      case OKAY:
        return this.streams.get(arg1)?.acked?.();
      case WRTE: {
        const stream = this.streams.get(arg1);
        if (!stream) return;
        this.packet(OKAY, arg1, arg0);
        stream.input.push(payload);
        return this.sync(arg1, stream);
      }
      case CLSE:
        return this.streams.delete(arg1);
    }
  }

  private async write(id: number, stream: Stream, data: Uint8Array<ArrayBuffer>) {
    for (let at = 0; at < data.length; at += this.payload) {
      const acked = new Promise<void>((resolve) => (stream.acked = resolve));
      this.packet(WRTE, id, stream.host, data.subarray(at, at + this.payload));
      await acked;
    }
  }

  private close(id: number, stream: Stream) {
    this.streams.delete(id);
    this.packet(CLSE, id, stream.host);
  }

  private async serve(id: number, stream: Stream, service: string) {
    if (service === "sync:") {
      stream.sync = {};
      return;
    }
    if (service === "shell:echo hello") await this.write(id, stream, new TextEncoder().encode("hello\n"));
    else if (service === "shell:cat big") await this.write(id, stream, BIG);
    else if (service === "reboot:bootloader") this.rebooting = true;
    else await this.write(id, stream, new TextEncoder().encode(`pretend: no ${service}\n`));
    this.close(id, stream);
  }

  /** The sync protocol's requests, as they complete: STAT, STA2/LST2, SEND with its DATA and DONE, QUIT. */
  private sync(id: number, stream: Stream) {
    const { input, sync } = stream;
    if (!sync) return;
    while (input.length >= 8) {
      const head = input.peek(8);
      const request = text(head.subarray(0, 4));
      const length = view(head).getUint32(4, true);
      if (request === "DONE") {
        input.take(8);
        this.pushed.set(sync.path!, sync.hash!.digest("hex"));
        void this.write(id, stream, Uint8Array.of(0x4f, 0x4b, 0x41, 0x59, 0, 0, 0, 0)); // OKAY
        continue;
      }
      if (input.length < 8 + length) return;
      input.take(8);
      const body = input.take(length);
      // Nothing is there yet: a mode of 0 says so to STAT, ENOENT to STA2 and LST2.
      if (request === "STAT") void this.write(id, stream, reply(request, 16));
      if (request === "STA2" || request === "LST2") {
        const stat = reply(request, 72);
        new DataView(stat.buffer).setUint32(4, 2, true);
        void this.write(id, stream, stat);
      }
      if (request === "SEND") {
        sync.path = text(body).replace(/,\d+$/, "");
        sync.hash = createHash("md5");
      }
      if (request === "DATA") sync.hash!.update(body);
      if (request === "QUIT") this.close(id, stream);
    }
  }
}

/** A sync reply: its id, and zeros for the rest. */
function reply(id: string, length: number) {
  const bytes = new Uint8Array(length);
  bytes.set(new TextEncoder().encode(id));
  return bytes;
}

/** A bootloader: getvar, download, reboot. */
class Bootloader implements Firmware {
  downloaded?: string;
  private left = 0;
  private hash = createHash("md5");
  private readonly device: Device;

  constructor(device: Device) {
    this.device = device;
  }

  private say(response: string) {
    this.device.send(new TextEncoder().encode(response));
  }

  receive(transfer: Uint8Array<ArrayBuffer>) {
    if (this.left) {
      this.hash.update(transfer);
      this.left -= transfer.length;
      if (this.left <= 0) {
        this.downloaded = this.hash.digest("hex");
        this.say("OKAY");
      }
      return;
    }
    const command = text(transfer);
    if (command === "getvar:product") this.say("OKAYpretend");
    else if (command === "getvar:max-download-size") this.say("OKAY0x10000000");
    else if (command.startsWith("getvar:")) this.say("FAILunknown variable");
    else if (command.startsWith("download:")) {
      this.left = parseInt(command.slice(9), 16);
      this.hash = createHash("md5");
      this.say(`DATA${command.slice(9)}`);
    } else if (command === "reboot") this.say("OKAY");
    else this.say("FAILunknown command");
  }
}

// A DFU bootloader -----------------------------------------------------------

const [DETACH, DNLOAD, UPLOAD, GETSTATUS, CLRSTATUS, GETSTATE, ABORT] = [0, 1, 2, 3, 4, 5, 6];
const [dfuIDLE, dfuDNLOAD_IDLE, dfuMANIFEST_SYNC, dfuUPLOAD_IDLE, dfuERROR] = [2, 5, 6, 9, 10];
/** What a DFU request carries at most: the functional descriptor says so. */
const TRANSFER = 1024;

const dfuDevice = () =>
  new Device({
    vendorId: 0x0483,
    productId: 0xdf11,
    manufacturerName: "Pretend",
    productName: "Pretend DFU",
    serialNumber: "DFU0001",
    interfaces: [
      {
        class: 0xfe,
        subclass: 0x01,
        protocol: 0x02,
        name: "Flash",
        // Its functional descriptor: it downloads and uploads, survives manifestation, takes 1 KB at a time, DFU 1.1.
        extra: Uint8Array.of(9, 0x21, 0b0111, 0xe8, 0x03, TRANSFER & 0xff, TRANSFER >> 8, 0x10, 0x01),
      },
    ],
  });

/** DFU 1.1's state machine, without the waits: what is downloaded is kept, and uploaded back. */
class Dfu implements Firmware {
  image = new Uint8Array(0);
  private state = dfuIDLE;
  private incoming: Uint8Array[] = [];

  control({ requestType, request, value }: USBControlTransferParameters, data: Uint8Array, length: number) {
    if (requestType !== "class") return undefined;
    switch (request) {
      case DNLOAD:
        if (data.length) {
          this.incoming.push(data);
          this.state = dfuDNLOAD_IDLE;
        } else {
          this.image = Uint8Array.from(Buffer.concat(this.incoming));
          this.incoming = [];
          this.state = dfuMANIFEST_SYNC;
        }
        return true;
      case UPLOAD: {
        const block = this.image.subarray(value * TRANSFER, value * TRANSFER + length);
        this.state = block.length < length ? dfuIDLE : dfuUPLOAD_IDLE;
        return block;
      }
      case GETSTATUS: {
        // Manifestation tolerant: done with it the moment it is asked.
        if (this.state === dfuMANIFEST_SYNC) this.state = dfuIDLE;
        return Uint8Array.of(0, 0, 0, 0, this.state, 0);
      }
      case GETSTATE:
        return Uint8Array.of(this.state);
      case CLRSTATUS:
      case ABORT:
        this.state = dfuIDLE;
        return true;
      case DETACH:
        return true;
    }
    this.state = dfuERROR;
    return undefined;
  }
}

// The machine -------------------------------------------------------------

const bus = new Usb();
Object.defineProperty(globalThis.navigator, "usb", { value: bus });
// The page's address: Tango's key store names the browser's key after it.
Object.defineProperty(globalThis, "location", { value: new URL("https://check.invalid/") });

/** The browser's adb key, as src/usb/key.ts made and kept it: the phone checks adb's signatures with it. */
async function browserKey(): Promise<KeyObject> {
  for await (const key of new AdbWebCredentialStore("guest").iterateKeys()) {
    return createPublicKey(createPrivateKey({ key: Buffer.from(key.buffer), format: "der", type: "pkcs8" }));
  }
  throw new Error("the browser keeps no adb key");
}

const { name, machine, run } = await guest((verb, [what = "", kinds], machine) => {
  if (verb === "usb") void usb(what, machine, kinds);
});
const checks = new Checks();
const check = checks.check.bind(checks);

step(`the ${name} machine, with a phone plugged in`);
const android = phone("adb");
const adbd = new Adbd(android, browserKey);
android.firmware = adbd;
bus.plug(android);
info("pretend phone in, in Android, USB debugging on");

step("adb, over USB/IP");
let [output, took] = await timed(() => run("adb shell echo hello"));
check("adb shell echo hello", output.includes("hello"), took);
output = await run("cat /sys/bus/usb/devices/1-1/bConfigurationValue /sys/bus/usb/devices/1-1/product");
check(
  "enumerated by the guest's kernel, and configured",
  output === "1\nPretend Phone" && android.asked.some((one) => one.startsWith("standard 6 3")),
  `${android.asked.length} requests · ${output.split("\n").join(" · ")}`,
);
check("adb signs with the browser's key", adbd.verified);
output = await run("adb devices; lsusb -d 18d1:4ee7");
check("adb devices, lsusb", /PRETEND01\s+device/.test(output) && output.includes("ID 18d1:4ee7"), output.split("\n").slice(-2).join(" · "));
[output, took] = await timed(() => run("time adb shell cat big | md5sum"));
check(`a ${size(BIG.length)} read`, output.includes(md5(BIG)), `${took} · fish: ${output.match(/Executed in\s+(.+?)\s+fish/)?.[1]}`);
const sent = (await run("head -c 8388608 /dev/urandom > /tmp/up; md5sum /tmp/up")).split(/\s/)[0]!;
[output, took] = await timed(() => run("adb push /tmp/up /sdcard/up"));
check("an 8 MB push", adbd.pushed.get("/sdcard/up") === sent, `${took} · adb: ${output.match(/\(.*\)/)?.[0]}`);

step("into the bootloader");
await run("adb reboot bootloader");
check("adb reboot bootloader", adbd.rebooting);
bus.unplug(android);
await sleep(1000);
output = await run("cat /run/usb/1; lsusb -d 18d1:4ee7; or echo unplugged");
check("the phone unplugged from the guest too", output.startsWith("down gone") && output.endsWith("unplugged"), output.split("\n").join(" · "));
const bootloader = phone("fastboot");
const firmware = new Bootloader(bootloader);
bootloader.firmware = firmware;
bus.plug(bootloader);
info("the phone is back, as a bootloader");

step("fastboot");
output = await run("fastboot devices");
check("fastboot devices", /PRETEND01\s+fastboot/.test(output), output.split("\n").at(-1));
output = await run("fastboot getvar product");
check("fastboot getvar product", output.includes("product: pretend"), output.split("\n")[0]);
const image = Uint8Array.from({ length: 16 << 20 }, (_, i) => (i * 7 + (i >> 16)) & 0xff);
put([new File([image], "image.bin")], machine);
output = await run("while test (cat /run/drop/state) = none; sleep 0.1; end; md5sum ~/drop/image.bin");
check("a 16 MB file dropped onto the page", output.startsWith(md5(image)));
[output, took] = await timed(() => run("fastboot stage ~/drop/image.bin"));
check("its download to the phone", firmware.downloaded === md5(image), `${took} · fastboot: ${output.match(/OKAY \[\s*(.+?)\]/)?.[1]}`);
// Reset, say: gone a moment, and back as itself.
bus.unplug(bootloader);
await sleep(500);
bus.plug(bootloader);
await sleep(3000);
output = await run("usb; lsusb -d 18d1:4ee0");
check("a device back as itself, lent again unasked", output.includes("Pretend Phone (18d1:4ee0)") && output.includes("ID 18d1:4ee0"), output.split("\n")[0]);

step("dfu-util, with a device the visitor chooses");
const dfu = dfuDevice();
const bootrom = new Dfu();
dfu.firmware = bootrom;
bus.chooses = dfu;
const flash = randomBytes(100_000);
// The visitor drops the firmware onto the page; the last drop said so already.
await run("echo none > /run/drop/state");
put([new File([flash], "fw.bin")], machine);
await run("while test (cat /run/drop/state) = none; sleep 0.1; end");
[output, took] = await timed(() => run("dfu-util -D ~/drop/fw.bin"));
check("chosen from devices of DFU's kind", bus.asked.at(-1)?.filters.some((filter) => filter.classCode === 0xfe && filter.subclassCode === 1) ?? false, JSON.stringify(bus.asked.at(-1)?.filters));
check("dfu-util -D", md5(bootrom.image) === md5(flash) && output.includes("Done!"), `${took} · ${bootrom.image.length} bytes`);
[output, took] = await timed(() => run("rm -f /tmp/back.bin; dfu-util -U /tmp/back.bin; md5sum /tmp/back.bin"));
check("dfu-util -U", output.includes(md5(flash)), took);
output = await run("usb");
check("two devices lent at once", output.split("\n").filter((line) => /^\s*1-\d+ /.test(line)).length === 2, output.split("\n").slice(0, 2).join(" · "));

step("the rest of the tools, asking for no device when they need none");
const asked = bus.asked.length;
const versions = {
  rkdeveloptool: ["rkdeveloptool -v", /rkdeveloptool ver \d/],
  "sunxi-fel": ["sunxi-fel", /sunxi-fel v1\.4/],
  picotool: ["picotool version", /picotool v2\.3\.1/],
  openocd: ["openocd --version", /Open On-Chip Debugger 0\.12/],
  flashrom: ["flashrom --version", /flashrom v1\.6/],
  avrdude: ["avrdude -c '?'", /Valid programmers are/],
  mtk: ["mtk --help", /usage: mtk/],
  edl: ["edl --help", /Usage:/],
} as const;
for (const [tool, [command, expected]] of Object.entries(versions)) {
  output = await run(`${command} 2>&1 | head -40`);
  check(tool, expected.test(output), output.split("\n").find((line) => expected.test(line))?.trim() ?? output.split("\n")[0]);
}
check("none of them asked for a device", bus.asked.length === asked, `${bus.asked.length - asked} asked`);

step("letting go");
// The kernel lets the devices go a moment after, as from cables pulled.
output = await run("usb off; cat /run/usb/1 /run/usb/2 /run/usb/3; sleep 1; lsusb | count");
check("usb off", output.includes("down off") && output.endsWith("2"), output.split("\n").join(" · "));

await machine.destroy();
checks.done();
