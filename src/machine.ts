// The guest, as both the page and the snapshot builder see it: a terminal
// stream on the virtio console (hvc0), a line-based control channel on the
// second serial port (ttyS1; see image/rootfs/usr/libexec/home/hostd), and a
// network card whose frames go wherever the page sends them (src/warp/).

import { V86, type V86Options } from "v86";

/** v86's internal event bus. Not in its typings, but it is what add_listener itself is built on. */
interface Bus {
  send(event: string, data: unknown): void;
}

const CHUNK = 4096; // one guest receive buffer

export class Machine {
  readonly emulator: V86;
  private readonly bus: Bus;
  private readonly encoder = new TextEncoder();
  private pending = "";

  constructor(options: V86Options) {
    this.emulator = new V86(options);
    this.bus = (this.emulator as unknown as { bus: Bus }).bus;
  }

  /** Resolves once the machine is running (booting, or resumed from a snapshot). */
  loaded(): Promise<void> {
    return new Promise((resolve) => this.emulator.add_listener("emulator-loaded", () => resolve()));
  }

  onOutput(listener: (bytes: Uint8Array) => void): void {
    this.emulator.add_listener("virtio-console0-output-bytes", listener);
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
    const bytes = typeof data === "string" ? this.encoder.encode(data) : data;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      this.bus.send("virtio-console0-input-bytes", bytes.subarray(i, i + CHUNK));
    }
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
}
