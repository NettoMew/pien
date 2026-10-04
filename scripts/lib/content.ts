// The writing in content/, read the same way by the image builder (which puts
// it in the guest's home) and by the site build (which renders posts as HTML).

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const CONTENT = join(import.meta.dirname, "../../content");

export interface Post {
  slug: string; // hello
  file: string; // hello.md
  title: string;
  date: string; // 2026-10-04
  tags: string[];
  body: string; // Markdown, front matter removed
}

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

/** Posts in content/blog/, newest first. */
export async function readPosts(): Promise<Post[]> {
  const dir = join(CONTENT, "blog");
  const posts: Post[] = [];
  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".md"))) {
    const { meta, body } = frontMatter(await readFile(join(dir, file), "utf8"));
    if (!meta.title) continue;
    posts.push({
      slug: file.slice(0, -3),
      file,
      title: meta.title,
      date: meta.date ?? "",
      tags: (meta.tags ?? "").replace(/^\[|\]$/g, "").split(/,\s*/).filter(Boolean),
      body,
    });
  }
  return posts.sort((a, b) => b.date.localeCompare(a.date));
}
