// Bluetooth's UUIDs, as Web Serial names RFCOMM services (src/serial/) and
// Web Bluetooth names GATT services and characteristics (src/ble/). A 16- or
// 32-bit number the Bluetooth SIG assigns stands for a whole UUID on its
// base; all are compared in full, in lower case.

/** Whether `id` is a Bluetooth UUID: 16 or 32 bits in hex, or all 128. */
export const isUuid = (id: string) => /^([0-9a-f]{4}|[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(id);

/** A UUID in full, from a 16- or 32-bit one (a number, or in hex) or a whole one. */
export function uuid(id: number | string): string {
  if (typeof id === "string" && !/^[0-9a-f]{1,8}$/i.test(id)) return id.toLowerCase();
  const short = typeof id === "number" ? id.toString(16) : id.toLowerCase();
  return `${short.padStart(8, "0")}-0000-1000-8000-00805f9b34fb`;
}
