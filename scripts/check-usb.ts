// Puts a pretend phone on a machine's USB and runs the guest's own adb and
// fastboot against it, through the page's bridge (src/usb/) just as a
// browser runs it. Only WebUSB and IndexedDB are pretended: the phone stands
// in for the browser's device, with a small adbd and a small bootloader
// behind it, and fake-indexeddb keeps the browser's adb key.
//
//   npm run check:usb                  the home machine
//   npm run check:usb -- workbench
//
// Checked: the browser's key reaching adb (the phone verifies adb's
// signature with the key the browser keeps), a shell, a large read and a
// large push, a reboot into the bootloader with the phone coming back as
// another device, and fastboot there: a variable, and the download of a file
// dropped onto the page.

import "fake-indexeddb/auto";
import { constants, createHash, createPrivateKey, createPublicKey, type KeyObject, publicDecrypt, randomBytes } from "node:crypto";
import { join, sep } from "node:path";
import xterm from "@xterm/headless"; // CommonJS: no named exports
import AdbWebCredentialStore from "@yume-chan/adb-credential-web";
import { Bytes } from "../src/bytes.ts";
import { Machine } from "../src/machine.ts";
import { put } from "../src/drop.ts";
import { usb } from "../src/usb/index.ts";
import { type MachineName, machines, v86Options } from "../vm.config.ts";
import { info, size, step } from "./lib/log.ts";
import { readManifest, VM } from "./lib/manifest.ts";

const ROOT = join(import.meta.dirname, "..");
const at = (file: string) => join(VM, file).split(sep).join("/") + (file.endsWith("/") ? "/" : "");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const md5 = (bytes: Uint8Array) => createHash("md5").update(bytes).digest("hex");
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

// The phone ---------------------------------------------------------------

type Mode = "adb" | "fastboot";

interface Firmware {
  receive(transfer: Uint8Array<ArrayBuffer>): void;
}

/** The parts of a WebUSB device the bridge and Tango use, one interface, two bulk endpoints. */
class Phone {
  readonly vendorId = 0x18d1;
  readonly productId: number;
  readonly serialNumber = "PRETEND01";
  readonly productName = "Pretend Phone";
  readonly configurations;
  opened = false;
  configuration: unknown = null;
  firmware?: Firmware;
  private readonly interface;
  private readonly transfers: Uint8Array[] = [];
  private reading?: (transfer?: Uint8Array) => void;

  constructor(mode: Mode) {
    this.productId = mode === "adb" ? 0x4ee7 : 0x4ee0;
    const endpoints = (["in", "out"] as const).map((direction) => ({ endpointNumber: 1, direction, type: "bulk", packetSize: 512 }));
    const alternate = {
      alternateSetting: 0,
      interfaceClass: 0xff,
      interfaceSubclass: 0x42,
      interfaceProtocol: mode === "adb" ? 1 : 3,
      interfaceName: null,
      endpoints,
    };
    this.interface = { interfaceNumber: 0, claimed: false, alternate, alternates: [alternate] };
    this.configurations = [{ configurationValue: 1, configurationName: null, interfaces: [this.interface] }];
  }

  async open() {
    this.opened = true;
    this.configuration = this.configurations[0];
  }
  async close() {
    this.opened = false;
    this.interface.claimed = false;
    this.reading?.();
  }
  async claimInterface() {
    this.interface.claimed = true;
  }
  async releaseInterface() {
    this.interface.claimed = false;
  }
  async selectConfiguration() {}
  async selectAlternateInterface() {}
  async clearHalt() {}

  async transferOut(_endpoint: number, data: ArrayBufferView) {
    const bytes = new Uint8Array(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    if (bytes.length) this.firmware?.receive(bytes);
    return { status: "ok", bytesWritten: bytes.length };
  }

  async transferIn(_endpoint: number, length: number) {
    const transfer = this.transfers.shift() ?? (await new Promise<Uint8Array | undefined>((resolve) => (this.reading = resolve)));
    this.reading = undefined;
    if (!transfer) throw new DOMException("The transfer was cancelled.", "AbortError");
    if (transfer.length > length) throw new Error(`a ${transfer.length}-byte transfer, read with room for ${length}`);
    // A buffer of its own, as WebUSB gives: Tango reads the whole of it.
    return { status: "ok", data: new DataView(transfer.slice().buffer) };
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

/** navigator.usb, with nothing but the pretend phone ever plugged in. */
class Usb extends EventTarget {
  devices: Phone[] = [];
  async getDevices() {
    return this.devices;
  }
  async requestDevice(): Promise<Phone> {
    throw new DOMException("No device selected.", "NotFoundError");
  }
  plug(phone: Phone) {
    this.devices = [phone];
    this.dispatchEvent(Object.assign(new Event("connect"), { device: phone }));
  }
  unplug(phone: Phone) {
    this.devices = [];
    this.dispatchEvent(Object.assign(new Event("disconnect"), { device: phone }));
  }
}

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

/** An adbd: authentication, shell, sync (stat and push) and reboot, over a USB interface. */
class Adbd implements Firmware {
  verified = false;
  pushed = new Map<string, string>();
  rebooting = false;
  private header?: { command: number; arg0: number; arg1: number; length: number };
  private token = randomBytes(20);
  private payload = 256 << 10;
  private next = 1;
  private readonly streams = new Map<number, Stream>();
  private readonly phone: Phone;
  private readonly key: () => Promise<KeyObject>;

  constructor(phone: Phone, key: () => Promise<KeyObject>) {
    this.phone = phone;
    this.key = key;
  }

  receive(transfer: Uint8Array<ArrayBuffer>) {
    if (!this.header) {
      const view = new DataView(transfer.buffer, transfer.byteOffset, 24);
      this.header = { command: view.getUint32(0, true), arg0: view.getUint32(4, true), arg1: view.getUint32(8, true), length: view.getUint32(12, true) };
      if (this.header.length) return;
      transfer = new Uint8Array(0);
    }
    const { command, arg0, arg1 } = this.header;
    this.header = undefined;
    void this.handle(command, arg0, arg1, transfer);
  }

  private packet(command: number, arg0: number, arg1: number, payload = new Uint8Array(0)) {
    const header = new Uint8Array(24);
    const view = new DataView(header.buffer);
    [command, arg0, arg1, payload.length, 0, ~command >>> 0].forEach((value, i) => view.setUint32(i * 4, value, true));
    this.phone.send(header);
    if (payload.length) this.phone.send(payload);
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
      const length = new DataView(head.buffer, head.byteOffset, 8).getUint32(4, true);
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
  private readonly phone: Phone;

  constructor(phone: Phone) {
    this.phone = phone;
  }

  private say(response: string) {
    this.phone.send(new TextEncoder().encode(response));
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

// The machine -------------------------------------------------------------

const bus = new Usb();
Object.defineProperty(globalThis.navigator, "usb", { value: bus });
// The page's address: Tango names the browser's key after it.
Object.defineProperty(globalThis, "location", { value: new URL("https://check.invalid/") });

/** The browser's adb key, as src/usb/key.ts made and kept it: the phone checks adb's signatures with it. */
async function browserKey(): Promise<KeyObject> {
  for await (const key of new AdbWebCredentialStore("guest").iterateKeys()) {
    return createPublicKey(createPrivateKey({ key: Buffer.from(key.buffer), format: "der", type: "pkcs8" }));
  }
  throw new Error("the browser keeps no adb key");
}

const name = process.argv[2] ?? "home";
if (!(name in machines)) throw new Error(`no machine called ${name}; there is ${Object.keys(machines).join(" and ")}`);
const machine = new Machine({
  ...v86Options(at, await readManifest(), name as MachineName, { cold: false }),
  wasm_path: join(ROOT, "node_modules/v86/build/v86.wasm"),
});

// A headless xterm.js stands in for the page's terminal: it answers what fish
// asks of its terminal after every command, and passes the guest's private
// escape sequences on, here just usb's, as the page's does.
const term = new xterm.Terminal({ cols: 100, rows: 32, allowProposedApi: true });
term.onData((data) => machine.write(data));
term.parser.registerOscHandler(7337, (data) => {
  const [verb, tool] = data.split(";");
  if (verb === "usb") void usb(tool ?? "", machine);
  return true;
});
const decoder = new TextDecoder();
let screen = "";
machine.onOutput((bytes) => {
  term.write(bytes);
  screen += decoder.decode(bytes, { stream: true });
});

const until = async (what: string, test: () => boolean, ms = 180_000) => {
  const deadline = performance.now() + ms;
  while (!test()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
};

// The terminal's escape sequences: commands to it (OSC), and the rest (CSI).
// oxlint-disable-next-line no-control-regex
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// oxlint-disable-next-line no-control-regex
const CSI = /\x1b\[[0-9;?<>=]*[a-zA-Z~]/g;
const plain = (raw: string) => raw.replace(OSC, "").replace(CSI, "").replace(/\r/g, "").trim();

/** Runs a command at fish's prompt; resolves with what it printed. */
async function run(command: string) {
  const from = screen.length;
  machine.write(` ${command}\r`);
  // oxlint-disable-next-line no-control-regex
  const done = () => /\x1b\]133;D[^\x07]*\x07[\s\S]*\x1b\]133;B/.test(screen.slice(from));
  await until(`"${command}"`, done);
  const output = screen.slice(from);
  return plain(output.slice(output.indexOf("\x07", output.indexOf("\x1b]133;C")) + 1, output.indexOf("\x1b]133;D")));
}

let failed = 0;
function check(what: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  info(`${ok ? "ok    " : "FAILED"}  ${what}${detail && `  ·  ${detail}`}`);
}

async function timed<T>(work: () => Promise<T>): Promise<[T, string]> {
  const started = performance.now();
  const result = await work();
  return [result, `${((performance.now() - started) / 1000).toFixed(1)} s`];
}

step(`the ${name} machine, with a phone plugged in`);
await machine.loaded();
machine.resize(100, 32);
machine.attach("UTC");
await sleep(1500);

const android = new Phone("adb");
const adbd = new Adbd(android, browserKey);
android.firmware = adbd;
bus.plug(android);
info("pretend phone in, in Android, USB debugging on");

step("adb");
let [output, took] = await timed(() => run("adb shell echo hello"));
check("adb shell echo hello", output.includes("hello"), took);
check("adb signs with the browser's key", adbd.verified);
output = await run("adb devices");
check("adb devices", /127\.0\.0\.1:6555\s+device/.test(output), output.split("\n").at(-1));
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
const bootloader = new Phone("fastboot");
const firmware = new Bootloader(bootloader);
bootloader.firmware = firmware;
bus.plug(bootloader);
info("the phone is back, as a bootloader");

step("fastboot");
output = await run("fastboot devices");
check("fastboot devices", /PRETEND01\s+fastboot/.test(output), output);
output = await run("fastboot getvar product");
check("fastboot getvar product", output.includes("product: pretend"), output.split("\n")[0]);
const image = Uint8Array.from({ length: 16 << 20 }, (_, i) => (i * 7 + (i >> 16)) & 0xff);
put([new File([image], "image.bin")], machine);
output = await run("while test (cat /run/drop/state) = none; sleep 0.1; end; md5sum ~/drop/image.bin");
check("a 16 MB file dropped onto the page", output.startsWith(md5(image)));
[output, took] = await timed(() => run("fastboot stage ~/drop/image.bin"));
check("its download to the phone", firmware.downloaded === md5(image), `${took} · fastboot: ${output.match(/OKAY \[\s*(.+?)\]/)?.[1]}`);

step("letting go");
output = await run("usb off; cat /run/usb/adb /run/usb/fastboot");
check("usb off", output.endsWith("down off\ndown off"), output.split("\n").join(" · "));

await machine.destroy();
console.log(failed ? `\n${failed} failed` : "\nall well");
process.exit(failed ? 1 : 0);
