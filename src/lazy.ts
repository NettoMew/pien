// Watches the guest's files arrive. Each file is a blob fetched the first time
// the guest reads it; the browser's resource timing tells us when, and the
// filesystem tree (fs.json) tells us which file a blob is.

type FsNode = [name: string, size: number, mtime: number, mode: number, uid: number, gid: number, target: FsNode[] | string];

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;

export async function watchFetches(
  blobBase: string,
  fsJsonUrl: string,
  onFetch: (path: string, bytes: number, ms: number, cached: boolean) => void,
): Promise<void> {
  const names = new Map<string, string>();
  const pending: PerformanceResourceTiming[] = [];

  const report = (entry: PerformanceResourceTiming) => {
    const blob = entry.name.slice(entry.name.lastIndexOf("/") + 1);
    const path = names.get(blob);
    if (!path) return void pending.push(entry);
    onFetch(path.replace(/^\/home\/guest/, "~"), entry.encodedBodySize, entry.duration, entry.transferSize === 0);
  };

  new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as PerformanceResourceTiming[]) {
      if (new URL(entry.name).pathname.startsWith(blobBase)) report(entry);
    }
  }).observe({ type: "resource" });

  // The tree is only needed for labels, so it loads after everything else.
  const { fsroot } = (await (await fetch(fsJsonUrl, { priority: "low" })).json()) as { fsroot: FsNode[] };
  const walk = (nodes: FsNode[], dir: string) => {
    for (const [name, , , mode, , , target] of nodes) {
      if (Array.isArray(target)) walk(target, `${dir}/${name}`);
      else if ((mode & S_IFMT) === S_IFREG) names.set(target, `${dir}/${name}`);
    }
  };
  walk(fsroot, "");
  pending.splice(0).forEach(report);
}
