// The guest, as both the page and the snapshot builder see it: a terminal
// stream on the virtio console (hvc0) and three more ports beside it
// (/dev/virtio-ports/virtio-1 to -3, for adb and fastboot: src/usb/), a
// line-based control channel on the second serial port (ttyS1; see
// image/rootfs/usr/libexec/home/hostd), and a network card whose frames go
// wherever the page sends them (src/net/).

import { V86, type V86Options } from "v86";
import { Bytes } from "./bytes.ts";

declare module "v86" {
  interface Event {
    "virtio-console1-output-bytes": Uint8Array;
    "virtio-console2-output-bytes": Uint8Array;
    "virtio-console3-output-bytes": Uint8Array;
    "serial2-data-terminal-ready-output": boolean;
    "serial2-request-to-send-output": boolean;
  }
}

// v86's internals behind the console's ports, none of them in its typings:
// the event bus add_listener itself is built on, and the device's queues.
interface Bus {
  send(event: string, data: unknown): void;
}
interface Request {
  length_readable: number;
  get_next_blob(into: Uint8Array): number;
}
interface Queue {
  has_request(): boolean;
  pop_request(): Request;
}
interface Console {
  virtio: { queues: Queue[] };
  Ack(queue: number, request: Request): void;
  SendEvent(port: number, event: number, value: number): void;
}

/** VIRTIO_CONSOLE_CONSOLE_PORT: the host telling the guest a port is a console. */
const CONSOLE_PORT = 4;

/** The console's ports: 0 is the terminal, 1-3 are /dev/virtio-ports/virtio-1 to -3. */
export type PortNumber = 0 | 1 | 2 | 3;

/** One guest receive buffer: a page, in Linux's virtio_console. */
const BUFFER = 4096;
/** How soon to look again while the guest has no buffer free. */
const RETRY_MS = 2;

/**
 * A port of the virtio console. Bytes for the guest wait here until it has a
 * buffer free to take them (v86 drops whatever arrives while it has none),
 * and the guest's own output can be held back while whatever reads it
 * catches up: the guest's writes then block, as on a real line.
 */
export class Port {
  private readonly queued = new Bytes();
  private readonly waiting: { below: number; resolve: () => void }[] = [];
  private retry?: ReturnType<typeof setTimeout>;
  private held = false;
  private gated = false;
  private readonly machine: Machine;
  readonly number: PortNumber;

  constructor(machine: Machine, number: PortNumber) {
    this.machine = machine;
    this.number = number;
  }

  /** Bytes written and not yet taken by the guest. */
  get backlog(): number {
    return this.queued.length;
  }

  private get receiveQueue() {
    return this.number === 0 ? 0 : 2 * this.number + 2;
  }

  /** Queues `bytes` for the guest; the port keeps the array. */
  write(bytes: Uint8Array<ArrayBuffer>): void {
    this.queued.push(bytes);
    this.pump();
  }

  /** Bytes the guest wrote; returns the way to stop listening. */
  onData(listener: (bytes: Uint8Array<ArrayBuffer>) => void): () => void {
    const event = `virtio-console${this.number}-output-bytes` as const;
    // v86 copies what the guest wrote into an array of its own each time.
    const forward = (bytes: Uint8Array) => listener(bytes as Uint8Array<ArrayBuffer>);
    this.machine.emulator.add_listener(event, forward);
    return () => this.machine.emulator.remove_listener(event, forward);
  }

  /** Resolves once fewer than `below` bytes wait for the guest. */
  room(below: number): Promise<void> {
    if (this.backlog < below) return Promise.resolve();
    return new Promise((resolve) => this.waiting.push({ below, resolve }));
  }

  /** Holds the guest's output back (true), or lets it, and what it wrote meanwhile, through. */
  hold(held: boolean): void {
    const queue = this.machine.console()?.virtio.queues[this.receiveQueue + 1];
    if (!queue || held === this.held) return;
    if (!this.gated) {
      // v86 takes the guest's output only while the queue says it has some.
      const has = queue.has_request.bind(queue);
      queue.has_request = () => !this.held && has();
      this.gated = true;
    }
    this.held = held;
    if (held) return;
    while (queue.has_request()) {
      const request = queue.pop_request();
      const bytes = new Uint8Array(request.length_readable);
      request.get_next_blob(bytes);
      this.machine.bus.send(`virtio-console${this.number}-output-bytes`, bytes);
      this.machine.console()!.Ack(this.receiveQueue + 1, request);
    }
  }

  /** Forgets whatever still waits, and lets the guest's output through again. */
  reset(): void {
    this.queued.clear();
    this.hold(false);
    this.settle();
  }

  close(): void {
    clearTimeout(this.retry);
    this.retry = undefined;
    this.queued.clear();
  }

  private pump = () => {
    this.retry = undefined;
    const queue = this.machine.console()?.virtio.queues[this.receiveQueue];
    while (this.backlog && queue?.has_request()) {
      this.machine.bus.send(`virtio-console${this.number}-input-bytes`, this.queued.take(Math.min(BUFFER, this.backlog)));
    }
    if (this.backlog) this.retry ??= setTimeout(this.pump, RETRY_MS);
    this.settle();
  };

  private settle() {
    for (let i = this.waiting.length - 1; i >= 0; i--) {
      const waiter = this.waiting[i]!;
      if (this.backlog < waiter.below) {
        this.waiting.splice(i, 1);
        waiter.resolve();
      }
    }
  }
}

/** v86's 16550, as far as the visitor's serial port reaches into it. */
interface Uart {
  /** The divisor latch: DLL, and DLM above it. */
  baud_rate: number;
  line_control: number;
  modem_control: number;
}

/** Line control: the divisor latch is open while the driver sets the speed. */
const DIVISOR_LATCH = 0x80;

/** The far end's modem lines, as the guest reads them. */
export interface ModemStatus {
  cts: boolean;
  dsr: boolean;
  dcd: boolean;
  ri: boolean;
}

/**
 * The guest's ttyS2, a 16550 UART v86 emulates, seen from outside: the bytes
 * it sends and is sent, the settings its driver gives it (the speed as a
 * divisor, the framing and break in the line control register), DTR and RTS
 * as the driver drives them, and the modem lines it reads.
 */
export class SerialLine {
  private readonly machine: Machine;
  private readonly settled = new Set<(divisor: number, lineControl: number) => void>();
  private watching = false;

  constructor(machine: Machine) {
    this.machine = machine;
  }

  private get uart(): Uart | undefined {
    return this.machine.devices()?.uart2;
  }

  /** The divisor and the line control register as the driver last left them. */
  get divisor(): number {
    return this.uart?.baud_rate ?? 0;
  }
  get lineControl(): number {
    return this.uart?.line_control ?? 0;
  }
  get dtr(): boolean {
    return !!((this.uart?.modem_control ?? 0) & 1);
  }
  get rts(): boolean {
    return !!((this.uart?.modem_control ?? 0) & 2);
  }

  /**
   * Calls `listener` whenever the driver has set the line up: each time it
   * writes the line control register with the divisor latch closed, which it
   * does last when changing the speed or framing, and to start or end a break.
   */
  onSettings(listener: (divisor: number, lineControl: number) => void): () => void {
    const uart = this.uart;
    if (uart && !this.watching) {
      // v86 keeps the register in a plain field; one that tells when it is written.
      let value = uart.line_control;
      Object.defineProperty(uart, "line_control", {
        configurable: true,
        enumerable: true,
        get: () => value,
        set: (next: number) => {
          value = next;
          if (next & DIVISOR_LATCH) return;
          for (const settled of this.settled) settled(uart.baud_rate, next);
        },
      });
      this.watching = true;
    }
    this.settled.add(listener);
    return () => this.settled.delete(listener);
  }

  /** Bytes the guest sends, one at a time, as the UART does. */
  onData(listener: (byte: number) => void): () => void {
    this.machine.emulator.add_listener("serial2-output-byte", listener);
    return () => this.machine.emulator.remove_listener("serial2-output-byte", listener);
  }

  onDtr(listener: (on: boolean) => void): () => void {
    this.machine.emulator.add_listener("serial2-data-terminal-ready-output", listener);
    return () => this.machine.emulator.remove_listener("serial2-data-terminal-ready-output", listener);
  }

  onRts(listener: (on: boolean) => void): () => void {
    this.machine.emulator.add_listener("serial2-request-to-send-output", listener);
    return () => this.machine.emulator.remove_listener("serial2-request-to-send-output", listener);
  }

  /** Bytes for the guest; the UART holds as many as it is sent. */
  write(bytes: Uint8Array): void {
    this.machine.emulator.serial_send_bytes(2, bytes);
  }

  /** The far end's modem lines changed. */
  status({ cts, dsr, dcd, ri }: ModemStatus): void {
    this.machine.bus.send("serial2-clear-to-send-input", cts);
    this.machine.bus.send("serial2-data-set-ready-input", dsr);
    this.machine.bus.send("serial2-carrier-detect-input", dcd);
    this.machine.bus.send("serial2-ring-indicator-input", ri);
  }
}

export class Machine {
  readonly emulator: V86;
  readonly bus: Bus;
  private readonly encoder = new TextEncoder();
  private readonly ports = new Map<PortNumber, Port>();
  private line?: SerialLine;
  private pending = "";

  constructor(options: V86Options) {
    this.emulator = new V86(options);
    this.bus = (this.emulator as unknown as { bus: Bus }).bus;
    // v86 tells the guest that every port is a console, which turns 1-3 into
    // terminals (hvc) whose devices cannot be opened as byte pipes. Only the
    // first is one. The guest hears this as it boots; a snapshot keeps it.
    this.emulator.add_listener("emulator-loaded", () => {
      const device = this.console();
      if (!device) return;
      const send = device.SendEvent.bind(device);
      device.SendEvent = (port, event, value) => {
        if (event !== CONSOLE_PORT || port === 0) send(port, event, value);
      };
    });
  }

  /** v86's devices, once the machine is up. */
  devices(): { virtio_console?: Console; uart2?: Uart } | undefined {
    return (this.emulator as unknown as { v86?: { cpu: { devices: { virtio_console?: Console; uart2?: Uart } } } }).v86?.cpu.devices;
  }

  /** The virtio console, once the machine is up. */
  console(): Console | undefined {
    return this.devices()?.virtio_console;
  }

  port(number: PortNumber): Port {
    let port = this.ports.get(number);
    if (!port) this.ports.set(number, (port = new Port(this, number)));
    return port;
  }

  /** The serial port the visitor lends: the guest's ttyS2. */
  serial(): SerialLine {
    return (this.line ??= new SerialLine(this));
  }

  /** Resolves once the machine is running (booting, or resumed from a snapshot). */
  loaded(): Promise<void> {
    return new Promise((resolve) => this.emulator.add_listener("emulator-loaded", () => resolve()));
  }

  onOutput(listener: (bytes: Uint8Array) => void): void {
    this.port(0).onData(listener);
  }

  onControl(listener: (line: string) => void): void {
    this.emulator.add_listener("serial1-output-byte", (byte) => {
      if (byte === 10) {
        listener(this.pending.replace(/\r$/, ""));
        this.pending = "";
      } else {
        this.pending += String.fromCharCode(byte);
      }
    });
  }

  write(data: string | Uint8Array): void {
    this.port(0).write(typeof data === "string" ? this.encoder.encode(data) : data.slice());
  }

  resize(cols: number, rows: number): void {
    // v86 lays out the resize message as (rows, cols), the order older Linux
    // kernels read. Newer ones follow the virtio spec, (cols, rows) — so hand
    // v86 the two swapped and the guest reads them the right way round.
    this.bus.send("virtio-console0-resize", [rows, cols]);
  }

  /** Ethernet frames the guest sends from its network card (eth0). */
  onFrame(listener: (frame: Uint8Array) => void): void {
    this.emulator.add_listener("net0-send", listener);
  }

  sendFrame(frame: Uint8Array): void {
    this.bus.send("net0-receive", frame);
  }

  control(line: string): void {
    this.emulator.serial_send_bytes(1, this.encoder.encode(`${line}\n`));
  }

  /**
   * Tells the guest a visitor is here: sets its clock (and time zone, an IANA
   * name such as Asia/Shanghai) and starts the login session.
   */
  attach(zone?: string): void {
    this.control(`attach ${Math.floor(Date.now() / 1000)}${zone ? ` ${zone}` : ""}`);
  }

  /** The browser's clock again: the guest follows it if it has drifted. */
  clock(): void {
    this.control(`clock ${Math.floor(Date.now() / 1000)}`);
  }

  async destroy(): Promise<void> {
    for (const port of this.ports.values()) port.close();
    await this.emulator.destroy();
  }
}
