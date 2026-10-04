// fastboot across the bridge. The guest's fastboot talks to the phone as to
// a device on the network: a handshake, "FB01" each way, then messages, each
// an 8-byte big-endian length and that many bytes. Over USB the same
// conversation is bare transfers: a command a transfer, a response a
// transfer, and downloads in pieces of any size. This turns the one into
// the other, both ways.

import { findUsbEndpoints, type UsbInterfaceIdentifier } from "@yume-chan/adb-daemon-webusb";
import { Bytes } from "../bytes.ts";
import type { Port } from "../machine.ts";
import type { Broken, Link } from "./devices.ts";

/** The version this speaks; fastboot accepts it or anything later. */
const HELLO = new TextEncoder().encode("FB01");
/** The largest piece of a message handed to the phone in one transfer. */
const PIECE = 1 << 20;
/** How much one transfer from the phone may bring; a response ends it sooner. */
const READ = 1 << 20;
/** How much may wait on either side before the other is held back. */
const HIGH = 8 << 20;
const LOW = 2 << 20;

export async function open(device: USBDevice, found: UsbInterfaceIdentifier, port: Port, broken: Broken): Promise<Link> {
  const { configuration, interface_, alternate } = found;
  await device.open();
  if (device.configuration?.configurationValue !== configuration.configurationValue) {
    await device.selectConfiguration(configuration.configurationValue);
  }
  await device.claimInterface(interface_.interfaceNumber);
  if (interface_.alternate.alternateSetting !== alternate.alternateSetting) {
    await device.selectAlternateInterface(interface_.interfaceNumber, alternate.alternateSetting);
  }
  const { inEndpoint, outEndpoint } = findUsbEndpoints(alternate.endpoints);
  let closed = false;

  // The guest's messages to the phone. Each new connection opens with the
  // handshake, which cannot be mistaken for a length: no message is long
  // enough for its first byte to be an "F".
  const incoming = new Bytes();
  const piece = new Bytes();
  let left = 0; // of the message under way
  let sending = Promise.resolve();
  let unsent = 0;

  const send = () => {
    const data = piece.take(piece.length);
    unsent += data.length;
    if (unsent > HIGH) port.hold(true);
    sending = sending
      .then(() => device.transferOut(outEndpoint.endpointNumber, data))
      .then(() => {
        unsent -= data.length;
        if (unsent < LOW) port.hold(false);
      })
      .catch((error) => {
        if (!closed) broken(error);
      });
  };

  const stop = port.onData((bytes) => {
    incoming.push(bytes);
    for (;;) {
      if (left === 0) {
        if (incoming.length < HELLO.length) return;
        if (isHello(incoming.peek(HELLO.length))) {
          incoming.take(HELLO.length);
          port.write(HELLO.slice());
          continue;
        }
        if (incoming.length < 8) return;
        left = Number(viewOf(incoming.take(8)).getBigUint64(0));
        continue;
      }
      if (!incoming.length) return;
      const part = incoming.take(Math.min(left, incoming.length, PIECE - piece.length));
      piece.push(part);
      left -= part.length;
      // A command goes whole, in a transfer of its own; a download in pieces.
      if (left === 0 || piece.length === PIECE) send();
    }
  });

  // The phone's transfers to the guest, a message each, read only as fast
  // as the guest takes them.
  void (async () => {
    try {
      while (!closed) {
        const result = await device.transferIn(inEndpoint.endpointNumber, READ);
        if (result.status === "stall") {
          await device.clearHalt("in", inEndpoint.endpointNumber);
          continue;
        }
        if (result.status !== "ok") throw new Error(`transfer ended in ${result.status}`);
        const data = result.data!;
        if (!data.byteLength) continue;
        const message = new Uint8Array(8 + data.byteLength);
        viewOf(message).setBigUint64(0, BigInt(data.byteLength));
        message.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), 8);
        port.write(message);
        await port.room(HIGH);
      }
    } catch (error) {
      if (!closed) broken(error);
    }
  })();

  return {
    device,
    async close() {
      closed = true;
      stop();
      port.reset();
      await device.releaseInterface(interface_.interfaceNumber).catch(() => {});
      await device.close().catch(() => {});
    },
  };
}

const isHello = (bytes: Uint8Array) =>
  bytes[0] === 0x46 && bytes[1] === 0x42 && bytes.subarray(2, 4).every((byte) => byte >= 0x30 && byte <= 0x39);

const viewOf = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
