// The WARP client (warp/, Rust) as the page sees it: bytes in; bytes, frames
// and events out — through the few integer functions of warp/src/abi.rs.

export type Event = { kind: "up" } | { kind: "down"; code: Down; detail: number };

/** Why a tunnel went down: the codes of `Event::encode` in warp/src/tunnel.rs. */
export const DOWN = { tls: 1, pin: 2, refused: 3, goAway: 4, reset: 5, timeout: 6, closed: 7, protocol: 8 } as const;
export type Down = (typeof DOWN)[keyof typeof DOWN];

/** Bytes handed out are copies, the page's to keep. */
export interface Host {
  toSocket(bytes: Uint8Array<ArrayBuffer>): void;
  toGuest(frame: Uint8Array<ArrayBuffer>): void;
  event(event: Event): void;
}

interface Exports {
  memory: WebAssembly.Memory;
  input(len: number): number;
  open(): number;
  from_socket(): void;
  from_guest(): void;
  tick(): void;
  close(): void;
}

export class Core {
  private readonly wasm: Exports;

  private constructor(wasm: Exports) {
    this.wasm = wasm;
  }

  static async load(url: string, host: Host): Promise<Core> {
    let memory: WebAssembly.Memory | undefined;
    const view = (ptr: number, len: number) => new Uint8Array(memory!.buffer, ptr, len);
    const { instance } = await WebAssembly.instantiateStreaming(fetch(url), {
      host: {
        random: (ptr: number, len: number) => void crypto.getRandomValues(view(ptr, len)),
        now: () => Date.now(),
        // Copies: the views die with the next call into the module.
        to_socket: (ptr: number, len: number) => host.toSocket(view(ptr, len).slice()),
        to_guest: (ptr: number, len: number) => host.toGuest(view(ptr, len).slice()),
        event: (kind: number, code: number, detail: number) =>
          host.event(kind === 1 ? { kind: "up" } : { kind: "down", code: code as Down, detail }),
      },
    });
    const wasm = instance.exports as unknown as Exports;
    memory = wasm.memory;
    return new Core(wasm);
  }

  /** Starts a tunnel: the device key, then the edge's key (api.ts, openBytes). */
  open(device: Uint8Array): boolean {
    this.put(device);
    return this.wasm.open() !== 0;
  }

  fromSocket(bytes: Uint8Array) {
    this.put(bytes);
    this.wasm.from_socket();
  }

  fromGuest(frame: Uint8Array) {
    this.put(frame);
    this.wasm.from_guest();
  }

  /** Every ten seconds while connected. */
  tick() {
    this.wasm.tick();
  }

  close() {
    this.wasm.close();
  }

  private put(bytes: Uint8Array) {
    const ptr = this.wasm.input(bytes.length);
    new Uint8Array(this.wasm.memory.buffer, ptr, bytes.length).set(bytes);
  }
}
