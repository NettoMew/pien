// Which relay `net on` goes through: this site's, which takes its owner's
// login, or one of the visitor's own (docs/relay.md), which takes the key it
// was set up with (`relay key`). That key is given once, at `net relay`, and
// kept in this browser for the relay's address.

const STORE = "relays";

/** This site's relay, unless the build was pointed at another. */
export const SITE = webSocket(import.meta.env.VITE_RELAY_URL || `${import.meta.env.BASE_URL}relay`);

interface Kept {
  /** The visitor's own relay in use; this site's when unset. */
  use?: string;
  /** Each own relay's key, 64 hex digits, by address. */
  keys: Record<string, string>;
}

/** The relay to use: its address, whether it is the visitor's own, and then its key, unless it was forgotten. */
export function chosen(): { url: string; own: boolean; key?: Uint8Array<ArrayBuffer> } {
  const { use, keys } = kept();
  if (!use) return { url: SITE, own: false };
  const key = keys[use];
  return { url: use, own: true, ...(key && { key: Uint8Array.from(key.match(/../g)!, (byte) => parseInt(byte, 16)) }) };
}

/** Forgets the key of the relay at `url`: it turned the key away. */
export function forget(url: string) {
  const store = kept();
  delete store.keys[url];
  save(store);
}

/**
 * Goes through the relay at `address` from now on, with `key` if given or
 * the one kept for it. Its normalised address, or undefined if there is no
 * key for it yet.
 */
export function choose(address: string, key?: string): string | undefined {
  const url = webSocket(address);
  const store = kept();
  if (key !== undefined) {
    if (!/^[0-9a-f]{64}$/i.test(key.trim())) throw new Error("A relay's key is 64 hex digits, as `relay key` prints it.");
    store.keys[url] = key.trim().toLowerCase();
  }
  if (!store.keys[url]) return undefined;
  save({ ...store, use: url });
  return url;
}

/** Back to this site's relay; the keys stay, for coming back. */
export function reset() {
  const { keys } = kept();
  save({ keys });
}

/** `address` as a WebSocket URL: wss:// unless it says otherwise, or the page is plain http. */
function webSocket(address: string): string {
  const relative = address.startsWith("/");
  const absolute = relative || /^[a-z][a-z0-9+.-]*:\/\//i.test(address) ? address : `wss://${address}`;
  const url = new URL(absolute, location.href);
  if (url.protocol === "https:" || url.protocol === "http:") url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (url.protocol !== "wss:" && url.protocol !== "ws:") throw new Error(`Not a relay's address: ${address}`);
  if (url.protocol === "ws:" && location.protocol === "https:") throw new Error("This page is https: the relay needs wss:// too.");
  return url.href;
}

/** This visit's own copy: all there is when the browser keeps nothing (a private window). */
let held: Kept = { keys: {} };

function kept(): Kept {
  try {
    return { keys: {}, ...(JSON.parse(localStorage.getItem(STORE) ?? "null") as Kept | null) };
  } catch {
    return structuredClone(held);
  }
}

function save(store: Kept) {
  held = store;
  try {
    localStorage.setItem(STORE, JSON.stringify(store));
  } catch {
    // Refused: this visit's copy will do.
  }
}
