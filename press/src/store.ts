// A JSON document on disk, for the little press has to remember. Changes
// happen one after another and land whole: written beside the file, then
// renamed over it.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class Store<T> {
  private readonly file: string;
  private readonly empty: () => T;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(file: string, empty: () => T) {
    this.file = file;
    this.empty = empty;
  }

  async read(): Promise<T> {
    await this.queue.catch(() => {});
    return this.load();
  }

  /** Changes the document; `change` may mutate it or return a new one. What it returns is the result. */
  update<R>(change: (document: T) => R | Promise<R>): Promise<R> {
    const done = this.queue.then(async () => {
      const document = await this.load();
      const result = await change(document);
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(`${this.file}.new`, JSON.stringify(document, null, 2) + "\n", { mode: 0o600 });
      await rename(`${this.file}.new`, this.file);
      return result;
    });
    this.queue = done.catch(() => {});
    return done;
  }

  private async load(): Promise<T> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.empty();
      throw error;
    }
  }
}
