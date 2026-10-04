// Every post also exists as a plain web page — for search engines, for links
// people share, and for `open blog/<post>.md` in the terminal — plus an index
// and an RSS feed. Quiet pages in the terminal's palette; no JavaScript.

import { marked } from "marked";
import type { Post } from "./content.ts";

export interface Site {
  base: string; // where the site is served from, e.g. "/"
  url: string; // absolute origin for the feed, e.g. "https://example.com" (may be empty)
}

const TITLE = "guest@home";

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const excerpt = (post: Post) =>
  post.body
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[#>*`_[\]]|\(http[^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

const STYLE = `
:root{--bg:#0a0b0e;--fg:#e7e9ee;--muted:#7e8590;--line:#1f232b;--panel:#14161c;--cyan:#4de8ff;--amber:#ffb547}
*{box-sizing:border-box}
html{background:var(--bg);color:var(--fg);color-scheme:dark}
body{margin:0 auto;max-width:44rem;padding:clamp(24px,6vw,72px) clamp(20px,5vw,40px);
  font:17px/1.9 -apple-system,"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
code,pre,.prompt,.meta,footer{font-family:"Geist Mono",ui-monospace,"SF Mono",Menlo,Consolas,monospace}
a{color:var(--cyan);text-decoration:none}a:hover{text-decoration:underline}
.prompt{margin:0 0 3.5rem;font-size:14px;color:var(--muted)}.prompt a{color:var(--muted)}.prompt .path{color:var(--cyan)}
h1{margin:0;font-size:2rem;line-height:1.35;letter-spacing:.01em}
h2{margin:2.6em 0 .6em;font-size:1.3rem;color:var(--cyan)}h3{margin:2em 0 .5em;font-size:1.1rem}
.meta{margin:.6rem 0 2.6rem;font-size:13px;color:var(--muted)}
p,ul,ol{margin:0 0 1.2em}li{margin:.3em 0}
code{font-size:.88em;color:var(--amber)}
pre{margin:1.6em 0;padding:1.2em 1.4em;overflow-x:auto;background:var(--panel);border-radius:8px;line-height:1.7}
pre code{color:#c9ced6;font-size:14px}
blockquote{margin:1.6em 0;padding:0 0 0 1.2em;border-left:2px solid var(--cyan);color:var(--muted);font-style:italic}
hr{border:0;border-top:1px solid var(--line);margin:3em 0}
img{max-width:100%}
.posts{list-style:none;padding:0;margin-top:2.4rem}.posts li{display:flex;gap:1.4rem;align-items:baseline;margin:0;padding:.7rem 0;border-top:1px solid var(--line)}
.posts time{flex:none;font:13px "Geist Mono",ui-monospace,monospace;color:var(--muted)}
footer{margin-top:5rem;padding-top:1.4rem;border-top:1px solid var(--line);font-size:13px;color:var(--muted);display:flex;gap:1.4rem;flex-wrap:wrap}
footer a{color:var(--muted)}
`;

function page(site: Site, { title, description, prompt, body }: { title: string; description: string; prompt: string; body: string }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0a0b0e">
<title>${escape(title)}</title>
<meta name="description" content="${escape(description)}">
<link rel="icon" href="${site.base}favicon.svg" type="image/svg+xml">
<link rel="alternate" type="application/rss+xml" title="${TITLE}" href="${site.base}feed.xml">
<style>${STYLE}</style>
</head>
<body>
<p class="prompt"><a href="${site.base}">guest@home</a> ${prompt}</p>
${body}
<footer><a href="${site.base}">回到终端</a><a href="${site.base}blog/">全部文章</a><a href="${site.base}feed.xml">RSS</a></footer>
</body>
</html>
`;
}

export function postPage(site: Site, post: Post): string {
  return page(site, {
    title: `${post.title} — ${TITLE}`,
    description: excerpt(post),
    prompt: `<span class="path">~/blog</span> ❯ cat ${escape(post.file)}`,
    body: `<main><article>
<h1>${escape(post.title)}</h1>
<p class="meta">${[post.date, ...post.tags].map(escape).join(" · ")}</p>
${marked.parse(post.body, { async: false })}
</article></main>`,
  });
}

export function indexPage(site: Site, posts: Post[]): string {
  return page(site, {
    title: `博客 — ${TITLE}`,
    description: "文章列表",
    prompt: `<span class="path">~</span> ❯ blog`,
    body: `<main>
<h1>博客</h1>
<ul class="posts">
${posts.map((p) => `<li><time>${p.date}</time><a href="${site.base}blog/${p.slug}/">${escape(p.title)}</a></li>`).join("\n")}
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
<description>一台运行在浏览器里的 Linux，也是一个博客。</description>
${items.join("\n")}
</channel>
</rss>
`;
}

/** The posts as links, for the homepage's <noscript>. */
export function postLinks(site: Site, posts: Post[]): string {
  return `<ul>${posts.map((p) => `<li><a href="${site.base}blog/${p.slug}/">${escape(p.title)}</a> <time>${p.date}</time></li>`).join("")}</ul>`;
}
