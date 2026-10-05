// The serial port's side: Web Serial, with the computer's own driver behind it
// (FTDI, CP210x, CH34x, PL2303, CDC-ACM). The guest's 8250 driver sets ttyS2
// up as on any computer, and this does the same to the real port: speed and
// framing, by opening it afresh, as Web Serial has it; break, DTR and RTS as
// they happen, so a board's auto-reset into its bootloader works. Bytes go
// both ways, and CTS, DSR, DCD and RI come back to the guest.

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

/** A real port lent to the guest's ttyS2. */
class Link {
  readonly port: SerialPort;
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
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(port: SerialPort, line: SerialLine, broken: (error: unknown) => void) {
    this.port = port;
    this.line = line;
    this.broken = broken;
  }

  async open() {
    await this.start(settings(this.line.divisor, this.line.lineControl));
    this.stops.push(
      this.line.onData((byte) => {
        if (this.outgoing.push(byte) === 1) queueMicrotask(() => this.handOver());
      }),
      this.line.onSettings((divisor, lineControl) => this.settle(settings(divisor, lineControl), !!(lineControl & BREAK))),
      this.line.onDtr((on) => this.then(() => this.port.setSignals({ dataTerminalReady: on }))),
      this.line.onRts((on) => this.then(() => this.port.setSignals({ requestToSend: on }))),
    );
    this.timer = setInterval(() => void this.watchStatus(), STATUS_MS);
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
    await this.port.setSignals({ dataTerminalReady: this.line.dtr, requestToSend: this.line.rts, break: this.breaking });
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
   * one stream, and Web Serial hands a fresh one over: read on from that.
   */
  private async read() {
    while (this.port.readable && !this.closed) {
      const reader = (this.reader = this.port.readable.getReader());
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          this.line.write(value);
        }
      } catch {
        // The stream ended on an error; the loop takes up the next one, if any.
      } finally {
        reader.releaseLock();
      }
    }
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

/** The machine that asked for a port, while it wants one: a port plugged back in is lent to it again. */
let asking: Machine | undefined;

export async function open(machine: Machine) {
  const serial = navigator.serial as Serial | undefined;
  if (!serial) return down(machine, "unsupported");
  watch(serial);
  asking = machine;
  if (link) return up(machine, link.port);

  let port = (await serial.getPorts())[0];
  if (!port) {
    try {
      port = await serial.requestPort();
    } catch (error) {
      // The browser lists ports only right after a key press or a tap.
      return down(machine, named(error, "SecurityError") ? "activation" : "cancelled");
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

async function join(port: SerialPort, machine: Machine) {
  const joining: Link = new Link(port, machine.serial(), (error) => void broken(joining, error));
  try {
    await joining.open();
  } catch (error) {
    // Opening fails so when another program has the port.
    return down(machine, named(error, "NetworkError") || named(error, "InvalidStateError") ? "busy" : `error ${describe(error)}`);
  }
  link = joining;
  up(machine, port);
}

async function drop(why?: string) {
  const dropping = link;
  link = undefined;
  await dropping?.close();
  if (why && asking) down(asking, why);
}

/** A transfer failed: if the port was unplugged, the disconnect event says so in a moment; else it is an error. */
async function broken(failed: Link, error: unknown) {
  await new Promise((resolve) => setTimeout(resolve, 200));
  if (link === failed) await drop(`error ${describe(error)}`);
}

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

/** Tells hostd: serial up <name>, the name the maker's and the USB IDs. */
function up(machine: Machine, port: SerialPort) {
  const { usbVendorId: vendor, usbProductId: product } = port.getInfo();
  const hex = (n: number) => n.toString(16).padStart(4, "0");
  const name = vendor === undefined ? "serial port" : `${MAKERS[vendor] ?? "USB serial"} (${hex(vendor)}:${hex(product ?? 0)})`;
  machine.control(`serial up ${name}`);
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
