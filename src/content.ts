// The site's writing, when it is newer than what the machine was built with:
// laid into the guest's home as files whose bytes come from the site when
// first read (elsewhere.ts), as the image's own do, so what was published a
// minute ago is there in a machine built last week.
//
// The page compares the site's index (/content/index.json, press/src/render.ts)
// with what the guest has (at first the image's own, from the manifest) and
// lays only the difference in /.content/<n>, for hostd to put in place (see
// its `content`):
//
//   home/<path>   the files new or changed, as they go in the guest's home
//   gone          the paths of those the site no longer has, a line each
//   posts         the list `blog` shows, when it changed

import manifest from "virtual:vm-manifest";
import type { ContentIndex } from "../vm.config.ts";
import { directory, held, lend, type Reader } from "./elsewhere.ts";
import type { Machine } from "./machine.ts";

const SITE = `${import.meta.env.BASE_URL}content/`;

/** What each machine's home has: the last index laid into it. */
const laid = new WeakMap<Machine, ContentIndex>();
let batches = 0;

/** The site's files, each fetched once, the first time the guest reads it. */
const fetched = new Map<string, Promise<Uint8Array>>();

const fromSite =
  (sha256: string): Reader =>
  async (offset, count) => {
    let bytes = fetched.get(sha256);
    if (!bytes) {
      bytes = fetch(`${SITE}files/${sha256}`).then(async (response) => {
        if (!response.ok) throw new Error(`content/files/${sha256}: ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      });
      fetched.set(sha256, bytes);
      bytes.catch(() => fetched.delete(sha256)); // to try again on the next read
    }
    return (await bytes).subarray(offset, offset + count);
  };

/** The site's index, unless this site has none (no press behind it, say). */
async function siteIndex(): Promise<ContentIndex | undefined> {
  try {
    const response = await fetch(`${SITE}index.json`, { cache: "no-cache" });
    return response.ok ? ((await response.json()) as ContentIndex) : undefined;
  } catch {
    return undefined;
  }
}

/** Brings the guest's writing up to the site's; whether there was anything to bring. */
export async function lay(machine: Machine): Promise<boolean> {
  const site = await siteIndex();
  const had = laid.get(machine) ?? manifest.content;
  if (!site || site.id === had.id) return false;

  const before = new Map(had.files.map(({ path, sha256 }) => [path, sha256]));
  const batch = ++batches;
  const at = `/.content/${batch}`;
  directory(machine, `${at}/home`);
  for (const { path, sha256, size } of site.files) {
    if (before.get(path) === sha256) continue;
    const slash = path.lastIndexOf("/");
    const parent = directory(machine, `${at}/home/${path.slice(0, slash + 1)}`);
    lend(machine, parent, path.slice(slash + 1), size, `content/${batch}/${path}`, fromSite(sha256));
  }

  const listed = (lines: string[]) => new TextEncoder().encode(lines.map((line) => `${line}\n`).join(""));
  const here = new Set(site.files.map(({ path }) => path));
  const gone = listed(had.files.filter(({ path }) => !here.has(path)).map(({ path }) => path));
  lend(machine, directory(machine, at), "gone", gone.length, `content/${batch}/gone`, held(gone));
  if (JSON.stringify(site.posts) !== JSON.stringify(had.posts)) {
    const posts = listed(site.posts.map((post) => post.join("\t")));
    lend(machine, directory(machine, at), "posts", posts.length, `content/${batch}/posts`, held(posts));
  }

  machine.control(`content ${batch}`);
  laid.set(machine, site);
  return true;
}
