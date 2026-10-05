// Lends a pretend serial port to a machine and drives its ttyS2 with the
// guest's own tools, through the page's bridge (src/serial/) just as a browser
// runs it. Only Web Serial is pretended: the port stands in for a USB serial
// adapter, an FTDI by its IDs, with its output wired back to its input, and
// it writes down every setting it is given.
//
//   npm run check:serial                  the home machine
//   npm run check:serial -- workbench
//
// Checked: the port lent and named; the speeds and framings the guest sets
// reaching the real port exactly, 1500000 baud among them; bytes out and back
// at speed; DTR, RTS and break as the guest drives them; CTS, DSR and DCD as
// it reads them; tio; and letting go.

import { serial } from "../src/serial/index.ts";
import { Checks, guest, sleep, timed } from "./lib/guest.ts";
import { info, step } from "./lib/log.ts";

/** A USB serial adapter with its TX wired to its RX, as Web Serial shows one. */
class PretendPort extends EventTarget {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  /** Every open's options, and every change to the lines, in order. */
  readonly opens: SerialOptions[] = [];
  readonly signals: SerialOutputSignals[] = [];
  status: SerialInputSignals = { dataCarrierDetect: false, clearToSend: true, ringIndicator: false, dataSetReady: true };
  /** The latest bytes to arrive, as text. */
  arrived = "";

  getInfo(): SerialPortInfo {
    return { usbVendorId: 0x0403, usbProductId: 0x6001 };
  }

  async open(options: SerialOptions) {
    if (this.readable) throw new DOMException("The port is already open.", "InvalidStateError");
    this.opens.push(options);
    let looped!: ReadableStreamDefaultController<Uint8Array>;
    this.readable = new ReadableStream({ start: (controller) => void (looped = controller) });
    this.writable = new WritableStream({
      write: (chunk) => {
        this.arrived = (this.arrived + new TextDecoder().decode(chunk)).slice(-64);
        try {
          looped.enqueue(chunk.slice());
        } catch {
          // Nobody reading any more: the bytes fall on the floor, as on a wire.
        }
      },
    });
  }

  async close() {
    this.readable = null;
    this.writable = null;
  }

  async setSignals(signals: SerialOutputSignals) {
    this.signals.push(signals);
  }

  async getSignals(): Promise<SerialInputSignals> {
    return this.status;
  }

  /** Whether DTR and RTS were ever as given at once, by the lines' changes so far. */
  saw(dtr: boolean, rts: boolean) {
    let now: { dtr?: boolean; rts?: boolean } = {};
    return this.signals.some((change) => {
      now = { dtr: change.dataTerminalReady ?? now.dtr, rts: change.requestToSend ?? now.rts };
      return now.dtr === dtr && now.rts === rts;
    });
  }
}

/** navigator.serial, with nothing but the pretend port ever plugged in. */
class PretendSerial extends EventTarget {
  ports: PretendPort[] = [];
  async getPorts() {
    return this.ports;
  }
  async requestPort(): Promise<PretendPort> {
    throw new DOMException("No port selected by the user.", "NotFoundError");
  }
}

const port = new PretendPort();
const bus = new PretendSerial();
bus.ports = [port];
Object.defineProperty(globalThis.navigator, "serial", { value: bus });

const { name, machine, run } = await guest((verb, argument, machine) => {
  if (verb === "serial") void serial(argument, machine);
});
const checks = new Checks();
const check = checks.check.bind(checks);

/** The line's modem bits, as the guest's TIOCMGET reads them, after it drops DTR and raises RTS. */
const LINES = [
  "python3 -c \"import fcntl, os, struct, termios, time",
  "fd = os.open('/dev/ttyUSB0', os.O_RDWR | os.O_NOCTTY)",
  "bits = lambda n: struct.pack('I', n)",
  "fcntl.ioctl(fd, termios.TIOCMBIC, bits(termios.TIOCM_DTR))",
  "fcntl.ioctl(fd, termios.TIOCMBIS, bits(termios.TIOCM_RTS))",
  "time.sleep(0.3)",
  "print(struct.unpack('I', fcntl.ioctl(fd, termios.TIOCMGET, bits(0)))[0])\"",
].join("; ");
const BREAK = "python3 -c \"import os, termios; fd = os.open('/dev/ttyUSB0', os.O_RDWR | os.O_NOCTTY); termios.tcsendbreak(fd, 0)\"";
const CTS = 0x20;
const CAR = 0x40;
const DSR = 0x100;

step(`the ${name} machine, with a USB serial adapter plugged in`);
let output = await run("serial");
check("serial", output.includes("/dev/ttyUSB0") && output.includes("FTDI (0403:6001)"), output.split("\n")[0]);
output = await run("readlink /dev/ttyUSB0; stat -c %U /dev/ttyS2");
check("/dev/ttyUSB0 is ttyS2, and the visitor's", output === "ttyS2\nguest", output.split("\n").join(" · "));

step("speed and framing");
const last = () => port.opens.at(-1)!;
for (const speed of [1500000, 115200, 921600, 3000000, 9600]) {
  await run(`stty -F /dev/ttyUSB0 ${speed} cs8 -parenb -cstopb raw -echo`);
  await sleep(200);
  check(`${speed} baud`, last().baudRate === speed, `the port opened at ${last().baudRate}`);
}
await run("stty -F /dev/ttyUSB0 115200 cs7 parenb -parodd cstopb");
await sleep(200);
check("7 data bits, even parity, 2 stop bits", last().dataBits === 7 && last().parity === "even" && last().stopBits === 2, JSON.stringify(last()));
await run("stty -F /dev/ttyUSB0 1500000 cs8 -parenb -cstopb raw -echo");

step("bytes");
const [back, took] = await timed(() =>
  run("head -c 65536 /dev/urandom > /tmp/sent; head -c 65536 /dev/ttyUSB0 > /tmp/back & sleep 0.3; cat /tmp/sent > /dev/ttyUSB0; wait; md5sum < /tmp/sent; md5sum < /tmp/back"),
);
// fish reports the background job's end on a line of its own; the sums are the lines md5sum ends with " -".
const [sent, received] = back.split("\n").filter((line) => line.endsWith(" -"));
check("64 KB out and back at 1500000 baud", !!sent && sent === received, took);
await run("printf 'zutto issho' > /dev/ttyUSB0");
await sleep(200);
check("text arrives as written", port.arrived.endsWith("zutto issho"), JSON.stringify(port.arrived.slice(-11)));

step("modem lines");
output = await run(LINES);
await sleep(200);
check("DTR down, RTS up", port.saw(false, true), `${port.signals.length} changes`);
let bits = Number(output.split("\n").at(-1));
check("CTS and DSR up, DCD down", (bits & (CTS | DSR)) === (CTS | DSR) && !(bits & CAR), `0x${bits.toString(16)}`);
port.status = { ...port.status, dataCarrierDetect: true };
await sleep(400);
bits = Number((await run(LINES)).split("\n").at(-1));
check("DCD up when the far end raises it", !!(bits & CAR), `0x${bits.toString(16)}`);
const before = port.signals.length;
await run(BREAK);
await sleep(200);
const breaks = port.signals.slice(before).map((change) => change.break).filter((value) => value !== undefined);
check("a break", breaks.join() === "true,false", breaks.join(" then "));

step("tio and letting go");
output = await run("tio --version | head -1");
check("tio", /^tio v?\d/.test(output), output);
output = await run("serial off; cat /run/serial/state; test -e /dev/ttyUSB0; or echo gone");
check("serial off", output.endsWith("down off\ngone") && port.readable === null, output.split("\n").join(" · "));
info(`the port was opened ${port.opens.length} times and its lines changed ${port.signals.length} times`);

await machine.destroy();
checks.done();
