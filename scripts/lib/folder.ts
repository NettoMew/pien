// A folder as the File System Access API hands one over, kept in memory as
// the origin private file system keeps one: directories, files, and writes
// that land on a copy of the file until they are committed, as Chromium's
// do. For checks of src/share/ (check-files.ts).

type Child = PretendFile | PretendDirectory;

abstract class Handle {
  name: string;
  parent?: PretendDirectory;
  /** What the browser would let the page do with it. */
  allows: "read" | "readwrite" = "readwrite";

  constructor(name: string) {
    this.name = name;
  }

  async queryPermission({ mode = "read" }: { mode?: "read" | "readwrite" } = {}): Promise<PermissionState> {
    return mode === "read" || this.allows === "readwrite" ? "granted" : "denied";
  }

  async move(into: PretendDirectory, name: string) {
    this.parent?.children.delete(this.name);
    this.name = name;
    this.parent = into;
    into.children.set(name, this as unknown as Child);
  }
}

export class PretendFile extends Handle {
  readonly kind = "file";
  bytes: Uint8Array;
  lastModified = Date.now();
  /** How often what was written was committed. */
  commits = 0;

  constructor(name: string, bytes: Uint8Array | string = new Uint8Array(0)) {
    super(name);
    this.bytes = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  }

  get text() {
    return new TextDecoder().decode(this.bytes);
  }

  async getFile() {
    return new File([this.bytes.slice()], this.name, { lastModified: this.lastModified });
  }

  async createWritable({ keepExistingData = false } = {}) {
    let swap = keepExistingData ? this.bytes.slice() : new Uint8Array(0);
    let position = 0;
    const resize = (size: number) => {
      const next = new Uint8Array(size);
      next.set(swap.subarray(0, size));
      swap = next;
    };
    const put = (data: Uint8Array) => {
      if (position + data.length > swap.length) resize(position + data.length);
      swap.set(data, position);
      position += data.length;
    };
    return {
      write: async (chunk: Uint8Array | { type: string; position?: number; size?: number; data?: Uint8Array }) => {
        if (chunk instanceof Uint8Array) return put(chunk);
        if (chunk.type === "truncate") return resize(chunk.size!);
        if (chunk.type === "seek") return void (position = chunk.position!);
        position = chunk.position ?? position;
        put(chunk.data!);
      },
      truncate: async (size: number) => resize(size),
      close: async () => {
        this.bytes = swap;
        this.lastModified = Date.now();
        this.commits++;
      },
      abort: async () => {},
    };
  }
}

export class PretendDirectory extends Handle {
  readonly kind = "directory";
  readonly children = new Map<string, Child>();

  constructor(name: string, tree: Record<string, string | Record<string, unknown>> = {}) {
    super(name);
    for (const [child, value] of Object.entries(tree)) {
      const made = typeof value === "string" ? new PretendFile(child, value) : new PretendDirectory(child, value as Record<string, string>);
      made.parent = this;
      this.children.set(child, made);
    }
  }

  async *entries(): AsyncGenerator<[string, Child]> {
    for (const entry of [...this.children]) yield entry;
  }

  async getDirectoryHandle(name: string, { create = false } = {}) {
    return this.child(name, create, () => new PretendDirectory(name), PretendDirectory);
  }

  async getFileHandle(name: string, { create = false } = {}) {
    return this.child(name, create, () => new PretendFile(name), PretendFile);
  }

  async removeEntry(name: string, { recursive = false } = {}) {
    const child = this.children.get(name);
    if (!child) throw new DOMException(`${name} is not there.`, "NotFoundError");
    if (child instanceof PretendDirectory && child.children.size && !recursive) throw new DOMException(`${name} is not empty.`, "InvalidModificationError");
    this.children.delete(name);
  }

  /** What is at `path` below this directory, if anything. */
  at(path: string): Child | undefined {
    return path
      .split("/")
      .filter(Boolean)
      .reduce<Child | undefined>((here, name) => (here instanceof PretendDirectory ? here.children.get(name) : undefined), this);
  }

  private child<T extends Child>(name: string, create: boolean, make: () => T, kind: new (...args: never[]) => T): T {
    const found = this.children.get(name);
    if (found instanceof kind) return found;
    if (found) throw new DOMException(`${name} is of another kind.`, "TypeMismatchError");
    if (!create) throw new DOMException(`${name} is not there.`, "NotFoundError");
    const made = make();
    made.parent = this;
    this.children.set(name, made);
    return made;
  }
}
