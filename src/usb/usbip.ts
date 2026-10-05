// A usbipd of sorts, on the page. The guest's kernel takes the visitor's USB
// device over USB/IP, through its vhci-hcd, `usbip attach` and a port of the
// console (see hostd), and every request it makes of the device, an URB, is
// made of the real one through WebUSB. One device to a port: the guest asks
// to import it, and from then on the port carries URBs and their replies, as
// the protocol has them (https://docs.kernel.org/usb/usbip_protocol.html).
//
// WebUSB has its say over a few requests. The configuration, an interface's
// alternate setting and clearing a halt go through calls of its own; an
// interface is claimed the first time it is used, and one the browser keeps
// for itself (HID, mass storage) answers with a stall. Everything else
// passes through as it is.
//
// A write to a bulk or interrupt endpoint is answered as it arrives and made
// behind, up to a window of bytes an endpoint may have on the way: each
// request is a trip through the emulated machine and back, and a write that
// waited for its own would leave the device idle in between. Past the window
// a write waits, so the guest goes no faster than the device; a write that
// fails after its answer fails the endpoint's next, as a USB stack reports
// what it finds late.
//
// The guest may give up on a request, as libusb does when a read times out;
// WebUSB cannot take one back. What a read given up on brings in all the
// same is kept for the endpoint's next read, so nothing from the device is
// lost; and the guest never hears of the request again, which it would
// take for a broken connection.

import { Bytes } from "../bytes.ts";
import type { Port } from "../machine.ts";

const VERSION = 0x0111;
const OP_REQ_IMPORT = 0x8003;
const OP_REP_IMPORT = 0x0003;
const CMD_SUBMIT = 1;
const CMD_UNLINK = 2;
const RET_SUBMIT = 3;
const RET_UNLINK = 4;

/** An import request: the operation's header, and the bus ID asked for. */
const IMPORT = 8 + 32;
/** Every URB's header and reply's, whatever it carries after. */
const HEADER = 48;
/** How much an endpoint's writes may have on the way, answered already. */
const WINDOW = 1 << 20;
/** An isochronous packet's descriptor, after the data. */
const PACKET = 16;
const NOT_ISOCHRONOUS = 0xffffffff;
const ZERO_PACKET = 0x40;

/** Errors, negated, as URBs carry them. */
const ENODEV = -19;
const EINVAL = -22;
const EPIPE = -32;
const EPROTO = -71;
const EOVERFLOW = -75;
const ECONNRESET = -104;

const SET_CONFIGURATION = 0x09;
const SET_INTERFACE = 0x0b;
const CLEAR_FEATURE = 0x01;
const ENDPOINT_HALT = 0;

const TYPES = ["standard", "class", "vendor"] as const;
const RECIPIENTS = ["device", "interface", "endpoint", "other"] as const;

/** The device as the guest is told of it on import: the platform's speed values. */
const SPEEDS = { low: 1, full: 2, high: 3, super: 5 };

/** A request this device cannot take: the guest hears a stall, as from a device that refuses one. */
class Refused extends Error {}

/** What a transfer came to. */
interface Done {
  status: number;
  /** For a read: what was read. */
  data?: Uint8Array<ArrayBuffer>;
  /** For a write: how much went. */
  written?: number;
}

/** A request the guest made and has not had answered. */
interface Urb {
  seqnum: number;
  /** Given up on: answered already, by the unlink. */
  dropped: boolean;
}

/** An endpoint of the configuration as it stands. */
interface Endpoint {
  interfaceNumber: number;
  type: USBEndpointType;
  packetSize: number;
}

/** Whoever looks after the session: told once the guest has configured the device, and if it breaks. */
export interface Watcher {
  configured(): void;
  broken(error: unknown): void;
}

export class Session {
  readonly device: USBDevice;
  readonly busid: string;
  private readonly port: Port;
  private readonly watcher: Watcher;
  private readonly incoming = new Bytes();
  private imported = false;
  private configured = false;
  private closed = false;
  private readonly stop: () => void;
  /** Requests not yet answered, by sequence number. */
  private readonly pending = new Map<number, Urb>();
  /** Each endpoint's requests, one after another: WebUSB keeps no order between them. */
  private readonly lanes = new Map<string, Promise<void>>();
  /** What reads given up on brought in, by endpoint, for the next reads there. */
  private readonly kept = new Map<string, Bytes>();
  /** Bytes of writes answered and not yet made, by endpoint. */
  private readonly ahead = new Map<string, number>();
  /** How an endpoint's last write answered ahead came out, when it failed: its next write's answer. */
  private readonly failed = new Map<string, number>();

  constructor(device: USBDevice, busid: string, port: Port, watcher: Watcher) {
    this.device = device;
    this.busid = busid;
    this.port = port;
    this.watcher = watcher;
    port.reset();
    this.stop = port.onData((bytes) => {
      this.incoming.push(bytes);
      try {
        this.take();
      } catch (error) {
        this.fail(error);
      }
    });
  }

  close() {
    this.closed = true;
    this.stop();
    this.port.reset();
  }

  private fail(error: unknown) {
    if (!this.closed) this.watcher.broken(error);
  }

  /** Whatever has arrived whole: the import first, then requests. */
  private take() {
    for (;;) {
      if (!this.imported) {
        if (this.incoming.length < IMPORT) return;
        this.import(view(this.incoming.take(IMPORT)));
        continue;
      }
      if (this.incoming.length < HEADER) return;
      const header = view(this.incoming.peek(HEADER));
      const command = header.getUint32(0);
      if (command === CMD_UNLINK) {
        this.incoming.take(HEADER);
        this.unlink(header.getUint32(4), header.getUint32(20));
        continue;
      }
      if (command !== CMD_SUBMIT) throw new Error(`usbip: no such command as ${command}`);
      const inward = header.getUint32(12) === 1;
      const length = header.getUint32(24);
      const packets = header.getUint32(32);
      const isochronous = packets !== 0 && packets !== NOT_ISOCHRONOUS;
      const size = HEADER + (inward ? 0 : length) + (isochronous ? packets * PACKET : 0);
      if (this.incoming.length < size) return;
      const urb = this.incoming.take(size).slice();
      this.submit(view(urb), urb.subarray(HEADER, HEADER + (inward ? 0 : length)), isochronous);
    }
  }

  /** The guest asks for the device by its bus ID, and is told of it. */
  private import(request: DataView) {
    if (request.getUint16(0) !== VERSION || request.getUint16(2) !== OP_REQ_IMPORT) throw new Error("usbip: not an import");
    const asked = new TextDecoder().decode(new Uint8Array(request.buffer, request.byteOffset + 8, 32)).replace(/\0.*$/s, "");
    const reply = new Uint8Array(8 + 312);
    const out = view(reply);
    out.setUint16(0, VERSION);
    out.setUint16(2, OP_REP_IMPORT);
    out.setUint32(4, asked === this.busid ? 0 : 1);
    if (asked === this.busid) {
      const { device } = this;
      const configuration = device.configuration;
      const [bus, number] = this.busid.split("-").map(Number) as [number, number];
      const text = (at: number, value: string) => reply.set(new TextEncoder().encode(value), 8 + at);
      text(0, `/sys/devices/usbip/${this.busid}`);
      text(256, this.busid);
      out.setUint32(8 + 288, bus);
      out.setUint32(8 + 292, number);
      out.setUint32(8 + 296, SPEEDS[speedOf(device)]);
      out.setUint16(8 + 300, device.vendorId);
      out.setUint16(8 + 302, device.productId);
      out.setUint16(8 + 304, (device.deviceVersionMajor << 8) | (device.deviceVersionMinor << 4) | device.deviceVersionSubminor);
      out.setUint8(8 + 306, device.deviceClass);
      out.setUint8(8 + 307, device.deviceSubclass);
      out.setUint8(8 + 308, device.deviceProtocol);
      out.setUint8(8 + 309, configuration?.configurationValue ?? 0);
      out.setUint8(8 + 310, device.configurations.length);
      out.setUint8(8 + 311, configuration?.interfaces.length ?? 0);
    }
    this.port.write(reply);
    if (asked !== this.busid) throw new Error(`usbip: ${asked} asked for, ${this.busid} here`);
    this.imported = true;
  }

  private submit(header: DataView, data: Uint8Array<ArrayBuffer>, isochronous: boolean) {
    const seqnum = header.getUint32(4);
    const inward = header.getUint32(12) === 1;
    const number = header.getUint32(16);
    const flags = header.getUint32(20);
    const length = header.getUint32(24);
    const packets = header.getUint32(32);
    const setup = new DataView(header.buffer, header.byteOffset + 40, 8);
    const urb: Urb = { seqnum, dropped: false };
    this.pending.set(seqnum, urb);

    const lane = number === 0 ? "control" : `${inward ? "in" : "out"} ${number}`;
    if (number !== 0 && !inward && !isochronous) return this.writeAhead(urb, lane, number, data, !!(flags & ZERO_PACKET), packets);
    const turn = (this.lanes.get(lane) ?? Promise.resolve()).then(async () => {
      if (urb.dropped || this.closed) return;
      let done: Done;
      try {
        if (isochronous) done = { status: EINVAL };
        else if (number === 0) done = await this.control(setup, data);
        else if (inward) done = this.keptFor(lane, length) ?? (await this.read(number, length));
        else done = await this.write(number, data, !!(flags & ZERO_PACKET));
      } catch (error) {
        done = { status: errno(error) };
      }
      if (urb.dropped) {
        // Read all the same: kept for the next read here.
        if (!done.data?.length) return;
        let kept = this.kept.get(lane);
        if (!kept) this.kept.set(lane, (kept = new Bytes()));
        kept.push(done.data);
        return;
      }
      this.pending.delete(seqnum);
      this.answer(seqnum, done, isochronous ? 0 : packets);
    });
    this.lanes.set(lane, turn);
  }

  /** A write, answered now if the endpoint's window has room for it, and made in its turn. */
  private writeAhead(urb: Urb, lane: string, number: number, data: Uint8Array<ArrayBuffer>, zero: boolean, packets: number) {
    const failure = this.failed.get(lane);
    if (failure !== undefined) {
      this.failed.delete(lane);
      this.pending.delete(urb.seqnum);
      return this.answer(urb.seqnum, { status: failure }, packets);
    }
    const ahead = this.ahead.get(lane) ?? 0;
    const early = ahead + data.length <= WINDOW;
    if (early) {
      this.ahead.set(lane, ahead + data.length);
      this.pending.delete(urb.seqnum);
      this.answer(urb.seqnum, { status: 0, written: data.length }, packets);
    }
    const turn = (this.lanes.get(lane) ?? Promise.resolve()).then(async () => {
      if (urb.dropped || this.closed) return;
      let done: Done;
      try {
        done = await this.write(number, data, zero);
      } catch (error) {
        done = { status: errno(error) };
      }
      if (early) {
        this.ahead.set(lane, this.ahead.get(lane)! - data.length);
        if (done.status !== 0) this.failed.set(lane, done.status);
        return;
      }
      if (urb.dropped) return;
      this.pending.delete(urb.seqnum);
      this.answer(urb.seqnum, done, packets);
    });
    this.lanes.set(lane, turn);
  }

  /** What reads given up on brought in, for this read: as much as it has room for. */
  private keptFor(lane: string, length: number): Done | undefined {
    const kept = this.kept.get(lane);
    if (!kept?.length) return undefined;
    return { status: 0, data: kept.take(Math.min(length, kept.length)).slice() };
  }

  private answer(seqnum: number, { status, data, written }: Done, packets: number) {
    const reply = new Uint8Array(HEADER + (data?.length ?? 0));
    const out = view(reply);
    out.setUint32(0, RET_SUBMIT);
    out.setUint32(4, seqnum);
    out.setInt32(20, status);
    out.setUint32(24, data?.length ?? written ?? 0);
    out.setUint32(32, packets);
    if (data) reply.set(data, HEADER);
    this.port.write(reply);
  }

  /** The guest gives up on a request: unanswered yet, it never will be, but for this. */
  private unlink(seqnum: number, of: number) {
    const urb = this.pending.get(of);
    if (urb) {
      urb.dropped = true;
      this.pending.delete(of);
    }
    const reply = new Uint8Array(HEADER);
    const out = view(reply);
    out.setUint32(0, RET_UNLINK);
    out.setUint32(4, seqnum);
    out.setInt32(20, urb ? ECONNRESET : 0);
    this.port.write(reply);
  }

  /** A request on the control endpoint: a few through WebUSB's own calls, the rest as they come. */
  private async control(setup: DataView, data: Uint8Array<ArrayBuffer>): Promise<Done> {
    const bits = setup.getUint8(0);
    const request = setup.getUint8(1);
    const value = setup.getUint16(2, true);
    const index = setup.getUint16(4, true);
    const length = setup.getUint16(6, true);
    const requestType = TYPES[(bits >> 5) & 3];
    const recipient = RECIPIENTS[bits & 0x1f];
    if (!requestType || !recipient) return { status: EPIPE };

    if (requestType === "standard" && request === SET_CONFIGURATION && recipient === "device") {
      if (value && this.device.configuration?.configurationValue !== value) await this.device.selectConfiguration(value);
      if (!this.configured) {
        this.configured = true;
        this.watcher.configured();
      }
      return { status: 0, written: 0 };
    }
    if (requestType === "standard" && request === SET_INTERFACE && recipient === "interface") {
      await this.claim(index);
      await this.device.selectAlternateInterface(index, value);
      return { status: 0, written: 0 };
    }
    if (requestType === "standard" && request === CLEAR_FEATURE && recipient === "endpoint" && value === ENDPOINT_HALT) {
      const direction = index & 0x80 ? "in" : "out";
      await this.claimFor(index & 0x0f, direction);
      await this.device.clearHalt(direction, index & 0x0f);
      return { status: 0, written: 0 };
    }

    if (recipient === "interface") await this.claim(index & 0xff);
    if (recipient === "endpoint") await this.claimFor(index & 0x0f, index & 0x80 ? "in" : "out");
    const parameters: USBControlTransferParameters = { requestType, recipient, request, value, index };
    if (bits & 0x80) return received(await this.device.controlTransferIn(parameters, length));
    return sent(await this.device.controlTransferOut(parameters, data));
  }

  private async read(number: number, length: number): Promise<Done> {
    await this.claimFor(number, "in");
    return received(await this.device.transferIn(number, length));
  }

  /** A write; and after it, if the guest asks, the empty packet that ends a transfer of whole packets. */
  private async write(number: number, data: Uint8Array<ArrayBuffer>, zero: boolean): Promise<Done> {
    const endpoint = await this.claimFor(number, "out");
    const done = sent(await this.device.transferOut(number, data));
    if (zero && done.status === 0 && data.length && data.length % endpoint.packetSize === 0) await this.device.transferOut(number, new Uint8Array(0));
    return done;
  }

  /** Claims the interface an endpoint belongs to, in the configuration as it stands, and says what the endpoint is. */
  private async claimFor(number: number, direction: USBDirection): Promise<Endpoint> {
    for (const { interfaceNumber, alternate } of this.device.configuration?.interfaces ?? []) {
      const endpoint = alternate.endpoints.find((endpoint) => endpoint.endpointNumber === number && endpoint.direction === direction);
      if (!endpoint) continue;
      await this.claim(interfaceNumber);
      return { interfaceNumber, type: endpoint.type, packetSize: endpoint.packetSize };
    }
    throw new Refused(`no endpoint ${number} ${direction} in this configuration`);
  }

  private async claim(interfaceNumber: number) {
    const found = this.device.configuration?.interfaces.find((candidate) => candidate.interfaceNumber === interfaceNumber);
    if (found && !found.claimed) await this.device.claimInterface(interfaceNumber);
  }
}

/**
 * How fast the device runs, which WebUSB does not say: told by the packets
 * of its endpoints, as the standard bounds them (64 bytes at most at full
 * speed, 512 for a bulk endpoint at high speed, 1024 at super speed).
 */
function speedOf(device: USBDevice): keyof typeof SPEEDS {
  const endpoints = device.configurations.flatMap((configuration) =>
    configuration.interfaces.flatMap(({ alternates }) => alternates.flatMap(({ endpoints }) => endpoints)),
  );
  const largest = Math.max(0, ...endpoints.filter(({ type }) => type === "bulk").map(({ packetSize }) => packetSize));
  if (largest >= 1024) return "super";
  if (largest > 64 || endpoints.some(({ packetSize }) => packetSize > 64)) return "high";
  return "full";
}

function received({ status, data }: USBInTransferResult): Done {
  const bytes = data ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice() : new Uint8Array(0);
  return { status: status === "ok" ? 0 : status === "stall" ? EPIPE : EOVERFLOW, data: bytes };
}

function sent({ status, bytesWritten }: USBOutTransferResult): Done {
  return { status: status === "ok" ? 0 : EPIPE, written: bytesWritten };
}

/** What a failed call means to the guest: the device gone, the transfer broken on the way, or refused (a stall). */
function errno(error: unknown): number {
  if (error instanceof Refused) return EPIPE;
  if (!(error instanceof Error)) return EPROTO;
  if (error.name === "NotFoundError") return ENODEV;
  if (error.name === "NetworkError" || error.name === "AbortError") return EPROTO;
  // SecurityError: an interface the browser keeps for itself; InvalidStateError and the rest: refused.
  return EPIPE;
}

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
