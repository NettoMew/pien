// The serial port's side: Web Serial, with the computer's own driver behind it
// (FTDI, CP210x, CH34x, PL2303, CDC-ACM), or a paired Bluetooth device's
// serial service (RFCOMM: HC-05 and the like, SPP or a service of its own).
// The guest's 8250 driver sets ttyS2 up as on any computer, and for a wired
// port this does the same to the real one: speed and framing, by opening it
// afresh, as Web Serial has it; break, DTR and RTS as they happen, so a
// board's auto-reset into its bootloader works. Bytes go both ways, and CTS,
// DSR, DCD and RI come back to the guest. Over Bluetooth there are bytes
// alone: the rest means nothing to RFCOMM, and is let be.
//
// A port that goes comes back by itself while the guest wants one: a wire
// plugged in again, a Bluetooth device back in range or restarted. The
// guest's ttyS2 stays as it was all the while, so tio, say, carries on.

import { Cable } from "lucide-react";
import { isUuid, uuid } from "../bluetooth.ts";
import { gesture } from "../gesture.ts";
import type { Machine, ModemStatus, SerialLine } from "../machine.ts";

/** The UART's clock over 16, as /etc/rc sets it: the driver divides it down to the speed it wants. */
const BASE = 24_000_000;

/** Speeds a divisor of BASE lands near rather than on: within 1%, the real port gets the standard one. */
const SPEEDS = [
  1200, 2400, 4800, 9600, 14400, 19200, 28800, 38400, 57600, 74880, 115200, 230400, 250000, 460800, 500000, 576000, 921600,
  1000000, 1500000, 2000000, 3000000,
];

/** Line control: the break bit, and the framing below it. */
const BREAK = 0x40;

/** How often to look at the real port's modem lines: Web Serial has no event for them. */
const STATUS_MS = 100;

/** How often, and how many times, to try a Bluetooth device lost: two minutes, in all. */
const AGAIN_MS = 3000;
const AGAIN_TRIES = 40;

/** The makers of common USB serial chips, by USB vendor ID. */
const MAKERS: Record<number, string> = {
  0x0403: "FTDI",
  0x10c4: "Silicon Labs CP210x",
  0x1a86: "WCH CH34x",
  0x067b: "Prolific PL2303",
  0x2341: "Arduino",
  0x303a: "Espressif",
  0x2e8a: "Raspberry Pi",
  0x0483: "STMicroelectronics",
  0x239a: "Adafruit",
};

/** The real port's settings for what the guest's driver set: a divisor of BASE, and the line control register. */
export function settings(divisor: number, lineControl: number): SerialOptions {
  const speed = divisor ? BASE / divisor : 115200;
  const baudRate = SPEEDS.find((standard) => Math.abs(speed - standard) / standard < 0.01) ?? Math.round(speed);
  return {
    baudRate,
    // Web Serial frames 7 or 8 data bits; 5 and 6 are older than anything it reaches.
    dataBits: (lineControl & 3) === 2 ? 7 : 8,
    stopBits: lineControl & 4 ? 2 : 1,
    parity: !(lineControl & 8) ? "none" : lineControl & 16 ? "even" : "odd",
    bufferSize: 1 << 16,
  };
}

const sameFraming = (a: SerialOptions, b: SerialOptions) =>
  a.baudRate === b.baudRate && a.dataBits === b.dataBits && a.stopBits === b.stopBits && a.parity === b.parity;

/** The standard serial service, the serial port profile (SPP). */
const SPP = uuid(0x1101);

/** The Bluetooth service `port` is, in full, or nothing for a wire. */
const service = (port: SerialPort) => {
  const id = port.getInfo().bluetoothServiceClassId;
  return id === undefined ? undefined : uuid(id);
};

/** A real port lent to the guest's ttyS2. */
class Link {
  readonly port: SerialPort;
  /** A wire with a UART at its end: speed, framing and modem lines mean something. */
  readonly wired: boolean;
  private readonly line: SerialLine;
  private readonly broken: (error: unknown) => void;
  private readonly stops: (() => void)[] = [];
  private options!: SerialOptions;
  private breaking = false;
  private writer?: WritableStreamDefaultWriter<Uint8Array>;
  private reading = Promise.resolve();
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  /** The guest's bytes since the last hand-over, and everything for the port, in order. */
  private outgoing: number[] = [];
  private work: Promise<unknown> = Promise.resolve();
  private status?: ModemStatus;
  /** DTR and RTS as last passed on. */
  private dtr: boolean;
  private rts: boolean;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(port: SerialPort, line: SerialLine, broken: (error: unknown) => void) {
    this.port = port;
    this.wired = service(port) === undefined;
    this.line = line;
    this.broken = broken;
    [this.dtr, this.rts] = [line.dtr, line.rts];
  }

  async open() {
    await this.start(settings(this.line.divisor, this.line.lineControl));
    this.stops.push(
      this.line.onData((byte) => {
        if (this.outgoing.push(byte) === 1) queueMicrotask(() => this.handOver());
      }),
    );
    if (!this.wired) return;
    this.stops.push(
      this.line.onSettings((divisor, lineControl) => this.settle(settings(divisor, lineControl), !!(lineControl & BREAK))),
      this.line.onDtr(() => this.signal()),
      this.line.onRts(() => this.signal()),
    );
    this.timer = setInterval(() => void this.watchStatus(), STATUS_MS);
  }

  /**
   * DTR and RTS, both at once, as the guest's one write to the modem control
   * register set them: esptool's reset, or stm32flash's, wants the two to
   * move together. The register holds both by the first line's event, so the
   * second line's, of the same write, finds nothing new to pass on.
   */
  private signal() {
    const [dtr, rts] = [this.line.dtr, this.line.rts];
    if (dtr === this.dtr && rts === this.rts) return;
    [this.dtr, this.rts] = [dtr, rts];
    this.then(() => this.port.setSignals({ dataTerminalReady: dtr, requestToSend: rts }));
  }

  /** Queues `step` after everything before it, the guest's bytes so far first. */
  private then(step: () => Promise<unknown> | undefined) {
    this.handOver();
    this.work = this.work.then(step).catch((error) => this.closed || this.broken(error));
  }

  private handOver() {
    if (!this.outgoing.length) return;
    const bytes = Uint8Array.from(this.outgoing);
    this.outgoing = [];
    this.work = this.work.then(() => this.writer?.write(bytes)).catch((error) => this.closed || this.broken(error));
  }

  /** The driver set the line up: open the port afresh for a new speed or framing; start or end a break. */
  private settle(options: SerialOptions, breaking: boolean) {
    if (!sameFraming(options, this.options)) {
      this.options = options;
      this.then(() => this.restart(options));
    }
    if (breaking !== this.breaking) {
      this.breaking = breaking;
      this.then(() => this.port.setSignals({ break: breaking }));
    }
  }

  private async start(options: SerialOptions) {
    await this.port.open(options);
    this.options = options;
    if (this.wired) await this.port.setSignals({ dataTerminalReady: this.dtr, requestToSend: this.rts, break: this.breaking });
    this.writer = this.port.writable!.getWriter();
    this.reading = this.read();
  }

  private async restart(options: SerialOptions) {
    await this.stop();
    await this.start(options);
  }

  private async stop() {
    await this.reader?.cancel().catch(() => {});
    await this.reading;
    await this.writer?.close().catch(() => {});
    this.writer = undefined;
    await this.port.close().catch(() => {});
  }

  /**
   * The port's bytes, to the guest. A framing, parity or overrun error ends
   * one stream, and Web Serial hands a fresh one over: read on from that. A
   * device lost ends them all, and leaves none.
   */
  private async read() {
    let failure: unknown;
    while (this.port.readable && !this.closed) {
      const reader = (this.reader = this.port.readable.getReader());
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          this.line.write(value);
        }
      } catch (error) {
        failure = error;
      } finally {
        reader.releaseLock();
      }
    }
    if (!this.closed) this.broken(failure);
  }

  /** CTS, DSR, DCD and RI, passed on to the guest when one of them changes. */
  private async watchStatus() {
    if (!this.writer) return;
    try {
      const signals = await this.port.getSignals();
      const status = { cts: signals.clearToSend, dsr: signals.dataSetReady, dcd: signals.dataCarrierDetect, ri: signals.ringIndicator };
      if (this.status && Object.entries(status).every(([key, value]) => this.status![key as keyof ModemStatus] === value)) return;
      this.status = status;
      this.line.status(status);
    } catch {
      // Opening afresh, or gone: the next look will tell.
    }
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const stop of this.stops) stop();
    await this.work.catch(() => {});
    await this.stop();
  }
}

let link: Link | undefined;

/** The machine that asked for a port, while it wants one: a port that comes back is lent to it again. */
let asking: Machine | undefined;

/** The joins so far, one after another: the visitor's `serial`, a wire plugged back in, a Bluetooth device back. */
let joining = Promise.resolve();

/**
 * Lends the guest a port: one this page was given before, or one the visitor
 * chooses. The browser lists wired ports and paired Bluetooth devices with
 * the standard serial service (SPP); `id` asks for one with an RFCOMM
 * service of its own instead.
 */
export async function open(machine: Machine, id?: string) {
  const serial = navigator.serial as Serial | undefined;
  if (!serial) return down(machine, "unsupported");
  if (id && !isUuid(id)) return down(machine, "invalid");
  watch(serial);
  asking = machine;
  if (link) return up(machine, link.port);

  const wanted = id && uuid(id);
  const granted = await serial.getPorts();
  let port = wanted ? granted.find((port) => service(port) === wanted) : granted[0];
  if (!port) {
    const options = wanted ? { allowedBluetoothServiceClassIds: [wanted] } : {};
    try {
      // The browser lists ports only as the visitor touches the page.
      port = await gesture("Choose a serial port", Cable, () => serial.requestPort(options));
    } catch {
      return down(machine, "cancelled");
    }
  }
  await join(port, machine);
}

/** Lets go of the port: for `serial off`, saying so, or quietly as the machine goes. */
export async function release(machine?: Machine) {
  asking = undefined;
  await drop();
  if (machine) down(machine, "off");
}

/**
 * Lends `port` to the guest, unless a port is lent already; whether one is.
 * `quietly`, a failure goes unsaid: the guest heard already why it has none.
 */
function join(port: SerialPort, machine: Machine, quietly = false) {
  const turn = joining.then(async () => {
    if (link) return true;
    const joined: Link = new Link(port, machine.serial(2), (error) => void broken(joined, error));
    try {
      await joined.open();
    } catch (error) {
      // Opening fails so when another program has the port.
      if (!quietly) down(machine, named(error, "NetworkError") || named(error, "InvalidStateError") ? "busy" : `error ${describe(error)}`);
      return false;
    }
    link = joined;
    up(machine, port);
    return true;
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

/**
 * A transfer failed, or the port's bytes ended: if a wire was unplugged, the
 * disconnect event says so in a moment; else it is an error. A Bluetooth
 * device has no such event to come back with, and is tried again.
 */
async function broken(failed: Link, error: unknown) {
  await sleep(200);
  if (link !== failed) return;
  await drop(`error ${describe(error)}`);
  if (!failed.wired) await again(failed.port);
}

async function again(port: SerialPort) {
  for (let tries = 0; tries < AGAIN_TRIES; tries++) {
    await sleep(AGAIN_MS);
    if (!asking || link || (await join(port, asking, true))) return;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let watching = false;

function watch(serial: Serial) {
  if (watching) return;
  watching = true;
  serial.addEventListener("disconnect", (event) => {
    if (link && event.target === link.port) void drop("gone");
  });
  serial.addEventListener("connect", (event) => {
    if (asking && !link) void join(event.target as SerialPort, asking);
  });
}

/**
 * Tells hostd: serial up <device> <name>. The device is named as Linux names
 * the kind: ttyUSB0 for a wire, rfcomm0 for Bluetooth. The name is the
 * maker's and the USB IDs, or the Bluetooth service.
 */
function up(machine: Machine, port: SerialPort) {
  const bluetooth = service(port);
  if (bluetooth) return machine.control(`serial up rfcomm0 Bluetooth, ${bluetooth === SPP ? "serial port profile" : `service ${bluetooth}`}`);
  const { usbVendorId: vendor, usbProductId: product } = port.getInfo();
  const hex = (n: number) => n.toString(16).padStart(4, "0");
  const name = vendor === undefined ? "serial port" : `${MAKERS[vendor] ?? "USB serial"} (${hex(vendor)}:${hex(product ?? 0)})`;
  machine.control(`serial up ttyUSB0 ${name}`);
}

function down(machine: Machine, why: string) {
  machine.control(`serial down ${why}`);
}

function named(error: unknown, name: string) {
  return error instanceof Error && error.name === name;
}

function describe(error: unknown) {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).replace(/\s+/g, " ").slice(0, 160);
}
