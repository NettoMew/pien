/** Bytes as they arrive, in pieces of any size, read from the front. */
export class Bytes {
  length = 0;
  private readonly chunks: Uint8Array<ArrayBuffer>[] = [];

  push(chunk: Uint8Array<ArrayBuffer>): void {
    if (!chunk.length) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  /** The first `count` bytes, left where they are. */
  peek(count: number): Uint8Array<ArrayBuffer> {
    return this.read(count, false);
  }

  /** The first `count` bytes, taken off. */
  take(count: number): Uint8Array<ArrayBuffer> {
    return this.read(count, true);
  }

  clear(): void {
    this.chunks.length = 0;
    this.length = 0;
  }

  private read(count: number, take: boolean): Uint8Array<ArrayBuffer> {
    if (count > this.length) throw new RangeError(`${count} bytes asked for, ${this.length} there`);
    const first = this.chunks[0];
    if (!first || first.length >= count) {
      const bytes = first ? first.subarray(0, count) : new Uint8Array(0);
      if (take) this.drop(count);
      return bytes;
    }
    const bytes = new Uint8Array(count);
    let filled = 0;
    for (const chunk of this.chunks) {
      const part = chunk.subarray(0, count - filled);
      bytes.set(part, filled);
      filled += part.length;
      if (filled === count) break;
    }
    if (take) this.drop(count);
    return bytes;
  }

  private drop(count: number) {
    this.length -= count;
    while (count) {
      const first = this.chunks[0]!;
      if (first.length > count) {
        this.chunks[0] = first.subarray(count);
        return;
      }
      this.chunks.shift();
      count -= first.length;
    }
  }
}
