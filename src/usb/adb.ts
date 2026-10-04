// adb across the bridge. The guest's adb server talks to the phone as to a
// device on the network: packets, each a 24-byte header and its payload,
// back to back. Over USB they are the very same packets, the header and the
// payload each a transfer of its own, and Tango takes care of that side:
// the interface, the transfers, and the empty one a transfer of whole USB
// packets needs after it. Nothing is changed on the way, checksums included.

import { type AdbPacket, AdbPacketHeader } from "@yume-chan/adb";
import { AdbDaemonWebUsbDevice, type UsbInterfaceIdentifier } from "@yume-chan/adb-daemon-webusb";
import { Consumable } from "@yume-chan/stream-extra";
import { Bytes } from "../bytes.ts";
import type { Port } from "../machine.ts";
import type { Broken, Link } from "./devices.ts";

const HEADER = AdbPacketHeader.size;
/** No adb sends more in one packet (its own limit is 1 MB). */
const LARGEST = 16 << 20;
/** How much may wait on either side before the other is held back. */
const HIGH = 4 << 20;
const LOW = 1 << 20;

export async function open(device: USBDevice, found: UsbInterfaceIdentifier, port: Port, broken: Broken): Promise<Link> {
  const connection = await new AdbDaemonWebUsbDevice(device, found, navigator.usb).connect();
  const writer = connection.writable.getWriter();
  const reader = connection.readable.getReader();
  let closed = false;

  // The guest's packets, one at a time, to the phone. A header that does not
  // hold together means the stream is out of step — the server dropped a
  // connection halfway through a packet — so look for the next one that does.
  const incoming = new Bytes();
  let sending = Promise.resolve();
  let unsent = 0;
  const stop = port.onData((bytes) => {
    incoming.push(bytes);
    while (incoming.length >= HEADER) {
      const view = viewOf(incoming.peek(HEADER));
      const command = view.getUint32(0, true);
      const length = view.getUint32(12, true);
      if (view.getUint32(20, true) !== ~command >>> 0 || length > LARGEST) {
        incoming.take(1);
        continue;
      }
      if (incoming.length < HEADER + length) break;
      incoming.take(HEADER);
      const packet = {
        command,
        arg0: view.getUint32(4, true),
        arg1: view.getUint32(8, true),
        payloadLength: length,
        checksum: view.getUint32(16, true),
        magic: view.getInt32(20, true),
        payload: incoming.take(length),
      };
      unsent += HEADER + length;
      if (unsent > HIGH) port.hold(true);
      sending = sending
        .then(() => Consumable.WritableStream.write(writer, packet))
        .then(() => {
          unsent -= HEADER + length;
          if (unsent < LOW) port.hold(false);
        })
        .catch((error) => {
        if (!closed) broken(error);
      });
    }
  });

  // The phone's packets to the guest, read only as fast as it takes them.
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const packet = value as AdbPacket;
        const bytes = new Uint8Array(HEADER + packet.payload.length);
        const view = viewOf(bytes);
        view.setUint32(0, packet.command, true);
        view.setUint32(4, packet.arg0, true);
        view.setUint32(8, packet.arg1, true);
        view.setUint32(12, packet.payload.length, true);
        view.setUint32(16, packet.checksum, true);
        view.setInt32(20, packet.magic, true);
        bytes.set(packet.payload, HEADER);
        port.write(bytes);
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
      await reader.cancel().catch(() => {});
      await writer.close().catch(() => {});
      await device.close().catch(() => {});
    },
  };
}

const viewOf = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
