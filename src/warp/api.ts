// The WARP device API, the way the official client uses it (docs/warp.md):
// register a device, enrol a P-256 key for MASQUE, delete the device again.
// The page calls it through /warp/api/; scripts/warp.ts calls it directly.

export const API = "/v0a4471/reg";
export const CLIENT_VERSION = "a-6.35-4471";

/** What we keep about a device: enough to connect, and to delete it. */
export interface Device {
  id: string;
  token: string;
  /** The device's P-256 private key: 32 bytes, base64. */
  key: string;
  /** The edge's SubjectPublicKeyInfo, base64. */
  edge: string;
  /** The device's addresses inside the tunnel. */
  v4: string;
  v6: string;
}

/** Sends one request; `path` starts with `API`. */
export type Call = (path: string, init: RequestInit) => Promise<Response>;

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, body: string) {
    super(`WARP API ${status}: ${body.slice(0, 200)}`);
    this.status = status;
  }
}

interface Registration {
  id: string;
  token: string;
  config: {
    peers: { public_key: string }[];
    interface: { addresses: { v4: string; v6: string } };
  };
}

export async function register(call: Call, name = "guest@zutto-issho"): Promise<Device> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const { d } = await crypto.subtle.exportKey("jwk", pair.privateKey);

  // A device the way the WireGuard client registers one, with a throwaway key …
  const device = await request<Registration>(call, API, "POST", undefined, {
    key: base64(random(32)),
    install_id: "",
    fcm_token: "",
    tos: new Date().toISOString().replace("Z", "+00:00"),
    model: "PC",
    serial_number: hex(random(8)),
    os_version: "",
    key_type: "curve25519",
    tunnel_type: "wireguard",
    locale: "en_US",
  });
  // … then switched over to MASQUE with our key.
  const enrolled = await request<Registration>(call, `${API}/${device.id}`, "PATCH", device.token, {
    key: base64(spki),
    key_type: "secp256r1",
    tunnel_type: "masque",
    name,
  });

  const { peers, interface: link } = enrolled.config;
  if (!d || !peers[0]) throw new Error("WARP API: unexpected registration");
  return {
    id: device.id,
    token: device.token,
    key: d.replace(/-/g, "+").replace(/_/g, "/").padEnd(44, "="),
    edge: peers[0].public_key.replace(/-----[^-]+-----|\s/g, ""),
    v4: link.addresses.v4,
    v6: link.addresses.v6,
  };
}

export async function remove(call: Call, device: Pick<Device, "id" | "token">) {
  await request(call, `${API}/${device.id}`, "DELETE", device.token);
}

/** What the tunnel's open() takes: the device key, then the edge's key. */
export function openBytes(device: Device) {
  return concat(fromBase64(device.key), fromBase64(device.edge));
}

async function request<T>(call: Call, path: string, method: string, token?: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "cf-client-version": CLIENT_VERSION };
  if (body) headers["content-type"] = "application/json; charset=UTF-8";
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await call(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const concat = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};
