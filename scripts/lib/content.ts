// The writing: posts, moments, the page about, and the pictures in them. The
// seed lives in content/ here; the writing itself in press's store on the
// server (press/src/store.ts). Either way it is read the same: by the image
// build into the guest's home, by the site build and press into web pages
// (blog.ts), and as an index (indexOf) that tells the page whether the
// server's writing is newer than what a machine was built with.
//
//   blog/<post>.md         title, date, tags
//   moments/<id>.md        date; the id is the date and time it was posted
//   media/<picture>        pictures the Markdown shows as ../media/<picture>
//   about.md

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { ContentIndex } from "../../vm.config.ts";

export type { ContentIndex };

export const CONTENT = join(import.meta.dirname, "../../content");

/** A file of the writing: its path in the guest's home, and its bytes. */
export interface Written {
  path: string;
  data: Uint8Array;
}

export interface Post {
  slug: string; // hello
  file: string; // hello.md
  title: string;
  date: string; // 2026-10-04
  tags: string[];
  body: string; // Markdown, front matter removed
}

export interface Moment {
  id: string; // 2026-10-05-1230
  date: string; // 2026-10-05 12:30, the poster's own clock
  body: string;
}

/** The parts of the writing, by where they go. */
export const WHERE = /^(?:blog\/[^/]+\.md|moments\/[^/]+\.md|media\/[^/]+|about\.md)$/;

/** Splits `key: value` front matter (between two `---` lines) from the body. */
export function frontMatter(md: string): { meta: Record<string, string>; body: string } {
  const text = md.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta = Object.fromEntries(
    match[1]!.split("\n").flatMap((line) => {
      const m = /^(\w+):\s*(.*)$/.exec(line);
      return m ? [[m[1]!, m[2]!]] : [];
    }),
  );
  return { meta, body: text.slice(match[0].length) };
}

const text = (data: Uint8Array) => new TextDecoder().decode(data);
const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

/** The writing in `dir`, Markdown with any Windows line endings undone; anything else there is left out. */
export async function readWriting(dir = CONTENT): Promise<Written[]> {
  const files: Written[] = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const at = join(entry.parentPath, entry.name);
    const path = relative(dir, at).split(sep).join("/");
    if (!WHERE.test(path)) continue;
    const data = await readFile(at);
    files.push({ path, data: path.endsWith(".md") ? Buffer.from(text(data).replace(/\r\n/g, "\n")) : data });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** The posts, newest first. */
export function posts(writing: Written[]): Post[] {
  return writing
    .flatMap(({ path, data }) => {
      const file = /^blog\/([^/]+\.md)$/.exec(path)?.[1];
      if (!file) return [];
      const { meta, body } = frontMatter(text(data));
      if (!meta.title) return [];
      const tags = (meta.tags ?? "").replace(/^\[|\]$/g, "").split(/,\s*/).filter(Boolean);
      return [{ slug: file.slice(0, -3), file, title: meta.title, date: meta.date ?? "", tags, body }];
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** The moments, newest first. */
export function moments(writing: Written[]): Moment[] {
  return writing
    .flatMap(({ path, data }) => {
      const id = /^moments\/([^/]+)\.md$/.exec(path)?.[1];
      if (!id) return [];
      const { meta, body } = frontMatter(text(data));
      return [{ id, date: meta.date ?? id, body }];
    })
    .sort((a, b) => (a.id < b.id ? 1 : -1));
}

export function indexOf(writing: Written[]): ContentIndex {
  const files = writing.map(({ path, data }) => ({ path, sha256: sha256(data), size: data.length }));
  return {
    id: sha256(files.map(({ path, sha256 }) => `${path}\t${sha256}\n`).join("")).slice(0, 16),
    files,
    posts: posts(writing).map(({ date, file, title }) => [date, file, title]),
  };
}
