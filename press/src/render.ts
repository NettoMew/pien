// Everything the writing shows the world, written under PRESS_PUBLIC for
// nginx to serve (deploy/nginx.conf), anew whenever the writing changes:
//
//   content/index.json              the writing's index (scripts/lib/content.ts):
//                                   the page lays into its machine what is newer
//   content/files/<sha256>          every file of it as the guest's home holds it
//   content/media/<name>-<w>.webp   pictures at the widths the web asks for
//   content/media/<name>.jpg        and at the guest's (pictures.ts)
//   pages/                          blog/, moments/, feed.xml (scripts/lib/blog.ts)
//
// Files named by their content are written once and kept. The pages are made
// whole beside the ones being served, then put in their place.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pages, type Picture, pictureUrl, type Site } from "../../scripts/lib/blog.ts";
import { type ContentIndex, indexOf, type Written } from "../../scripts/lib/content.ts";
import { guestCopy, size, webCopy, widths } from "./pictures.ts";

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/** Writes `path`, unless it is there already: whole, or not at all. */
async function once(path: string, make: () => Uint8Array | Promise<Uint8Array>) {
  if (existsSync(path)) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.new`, await make());
  await rename(`${path}.new`, path);
}

export async function render(writing: Written[], out: string, site: Site, stylesheet: string): Promise<ContentIndex> {
  // Pictures: the web's copies, and the guest's in place of the one kept.
  const pictures = new Map<string, Picture>();
  const guest: Written[] = [];
  for (const file of writing) {
    const name = /^media\/([^/]+\.jpg)$/.exec(file.path)?.[1];
    if (!name) {
      guest.push(file);
      continue;
    }
    const kept = Buffer.from(file.data);
    const { width, height } = await size(kept);
    const served = widths(width);
    for (const each of served) await once(join(out, pictureUrl("", name, each)), () => webCopy(kept, each));
    pictures.set(name, { width, height, widths: served });
    const guestAt = join(out, "content/media", name);
    await once(guestAt, () => guestCopy(kept, width));
    guest.push({ path: file.path, data: await readFile(guestAt) });
  }

  const index = indexOf(guest);
  for (const file of guest) await once(join(out, "content/files", sha256(file.data)), () => file.data);

  const fresh = join(out, "pages.new");
  await rm(fresh, { recursive: true, force: true });
  for (const [path, html] of pages(site, stylesheet, writing, (name) => pictures.get(name))) {
    await mkdir(dirname(join(fresh, path)), { recursive: true });
    await writeFile(join(fresh, path), html);
  }
  await rm(join(out, "pages.old"), { recursive: true, force: true });
  if (existsSync(join(out, "pages"))) await rename(join(out, "pages"), join(out, "pages.old"));
  await rename(fresh, join(out, "pages"));
  await rm(join(out, "pages.old"), { recursive: true, force: true });

  await writeFile(join(out, "content/index.json.new"), JSON.stringify(index));
  await rename(join(out, "content/index.json.new"), join(out, "content/index.json"));
  return index;
}
