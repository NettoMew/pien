// Every post also exists as a plain web page — for search engines, for links
// people share, and for `open blog/<post>.md` in the terminal — plus an index
// and an RSS feed. Quiet pages in the terminal's palette, typeset by Tailwind
// Typography (src/blog.css); no JavaScript.

import { marked } from "marked";
import image from "../../image/image.config.ts";
import { theme, themeCss } from "../../src/theme.ts";
import type { Post } from "./content.ts";

export interface Site {
  base: string; // where the site is served from, e.g. "/"
  url: string; // absolute origin for the feed, e.g. "https://example.com" (may be empty)
}

/** The site goes by its prompt's name. */
const TITLE = `guest@${image.hostname}`;

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const excerpt = (post: Post) =>
  post.body
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[#>*`_[\]]|\(http[^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

interface Page {
  title: string;
  description: string;
  /** Where the prompt stands, and what it typed to get here. */
  cwd: string;
  command: string;
  body: string;
}

/** A page around `body`, headed by the prompt that would have printed it, as fish draws it. */
function page(site: Site, stylesheet: string, { title, description, cwd, command, body }: Page) {
  return `<!doctype html>
<html lang="zh-CN" class="bg-screen">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="${theme.background}">
<style>${themeCss}</style>
<title>${escape(title)}</title>
<meta name="description" content="${escape(description)}">
<link rel="icon" href="${site.base}favicon.svg" type="image/svg+xml">
<link rel="alternate" type="application/rss+xml" title="${TITLE}" href="${site.base}feed.xml">
<link rel="stylesheet" href="${stylesheet}">
</head>
<body class="mx-auto max-w-176 px-[clamp(20px,5vw,40px)] py-[clamp(24px,6vw,72px)] font-sans text-[17px]/[1.9] text-ink antialiased">
<p class="phosphor mb-14 font-mono text-sm"><a href="${site.base}"><span class="text-green">guest</span>@${image.hostname}</a> <span class="text-green">${cwd}</span>&gt; ${command}</p>
${body}
<footer class="mt-20 flex flex-wrap gap-x-6 border-t border-line pt-6 font-mono text-[13px] text-faint *:hover:text-ink"><a href="${site.base}">Back to the terminal</a><a href="${site.base}blog/">All posts</a><a href="${site.base}feed.xml">RSS</a></footer>
</body>
</html>
`;
}

export function postPage(site: Site, stylesheet: string, post: Post): string {
  return page(site, stylesheet, {
    title: `${post.title} — ${TITLE}`,
    description: excerpt(post),
    cwd: "~/blog",
    command: `cat ${escape(post.file)}`,
    body: `<main><article class="prose prose-terminal max-w-none text-[17px]/[1.9] prose-headings:phosphor prose-h2:text-cyan prose-a:no-underline prose-a:hover:underline prose-code:font-normal prose-code:before:content-none prose-code:after:content-none prose-pre:font-mono [&_blockquote_p]:before:content-none [&_blockquote_p]:after:content-none">
<h1 class="mb-0 text-[2rem]/[1.35] font-semibold">${escape(post.title)}</h1>
<p class="mt-2 mb-10 font-mono text-[13px] text-faint">${[post.date, ...post.tags].map(escape).join(" · ")}</p>
${marked.parse(post.body, { async: false })}
</article></main>`,
  });
}

export function indexPage(site: Site, stylesheet: string, posts: Post[]): string {
  return page(site, stylesheet, {
    title: `Blog — ${TITLE}`,
    description: "All posts",
    cwd: "~",
    command: "blog",
    body: `<main>
<h1 class="phosphor text-[2rem]/[1.35] font-semibold">Blog</h1>
<ul class="mt-10 divide-y divide-line border-y border-line">
${posts.map((p) => `<li class="flex items-baseline gap-6 py-3"><time class="flex-none font-mono text-[13px] text-faint">${p.date}</time><a class="hover:text-cyan" href="${site.base}blog/${p.slug}/">${escape(p.title)}</a></li>`).join("\n")}
</ul>
</main>`,
  });
}

export function feed(site: Site, posts: Post[]): string {
  const home = `${site.url}${site.base}`;
  const items = posts.map((p) => {
    const link = `${home}blog/${p.slug}/`;
    const html = (marked.parse(p.body, { async: false }) as string).replaceAll("]]>", "]]]]><![CDATA[>");
    return `<item>
<title>${escape(p.title)}</title>
<link>${link}</link>
<guid>${link}</guid>
${p.date ? `<pubDate>${new Date(`${p.date}T00:00:00Z`).toUTCString()}</pubDate>` : ""}
<description><![CDATA[${html}]]></description>
</item>`;
  });
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
<channel>
<title>${TITLE}</title>
<link>${home}</link>
<description>A real Linux in your browser, and a blog.</description>
${items.join("\n")}
</channel>
</rss>
`;
}

/** The posts as links, for the homepage's <noscript>. */
export function postLinks(site: Site, posts: Post[]): string {
  return `<ul>${posts.map((p) => `<li><a href="${site.base}blog/${p.slug}/">${escape(p.title)}</a> <time>${p.date}</time></li>`).join("")}</ul>`;
}
