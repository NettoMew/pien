// The writing as plain web pages — for search engines, for links people
// share, and for `open blog/<post>.md` in the terminal: every post, their
// index, the moments, an RSS feed and a sitemap. Quiet pages in the
// terminal's palette, typeset by Tailwind Typography (src/blog.css), code
// coloured by the rules `cat` colours it with (syntax.ts); no JavaScript.
// Each page carries the card a link to it shows where it is shared
// (card.ts). The site build writes them from content/ (vite.config.ts);
// press, from its store, whenever the writing changes (press/src/render.ts).

import { Marked } from "marked";
import image from "../../image/image.config.ts";
import { theme, themeCss } from "../../src/theme.ts";
import { type Card, draw } from "./card.ts";
import { type Moment, moments, type Post, posts, type Written } from "./content.ts";
import { highlight } from "./syntax.ts";

export interface Site {
  base: string; // where the site is served from, e.g. "/"
  url: string; // absolute origin for the feed, e.g. "https://example.com" (may be empty)
}

/** What press knows of a picture: its size, and the widths it is served at (press/src/pictures.ts). */
export interface Picture {
  width: number;
  height: number;
  widths: number[];
}

/** A picture by its name in media/, if press has made it ready for the web. */
export type Pictures = (name: string) => Picture | undefined;

/** The site goes by its prompt's name. */
const TITLE = `guest@${image.hostname}`;

/** What the site says of itself: the homepage's description, and its card's line. */
export const TAGLINE = "A real Linux, running in your browser.";

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const excerpt = (body: string) =>
  body
    .replace(/```[\s\S]*?```/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/[#>*`_[\]|]|\(http[^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

/** A path under the site, made whole: absolute when the site knows its address. */
const address = (site: Site, path: string) => `${site.url}${site.base}${path}`;

/** Where a picture's web copies live: `<stem>-<width>.webp` under /content/media/. */
export const pictureUrl = (prefix: string, name: string, width: number) => `${prefix}content/media/${name.replace(/\.[^.]+$/, "")}-${width}.webp`;

/**
 * Markdown to HTML, its pictures (../media/<name>, as the guest's home has
 * them) at their web copies under `prefix`: the site's base for its pages,
 * the whole address for the feed. Code is coloured; tables are GFM's.
 */
function markdown(prefix: string, pictures: Pictures): (md: string) => string {
  const marked = new Marked({
    renderer: {
      image({ href, text }) {
        const name = /^\.\.\/media\/([^/]+)$/.exec(href)?.[1];
        if (!name) return false;
        const picture = pictures(name);
        if (!picture) return `<img src="${pictureUrl(prefix, name, 960)}" alt="${escape(text)}" loading="lazy" decoding="async">`;
        const largest = Math.max(...picture.widths);
        const srcset = picture.widths.map((width) => `${pictureUrl(prefix, name, width)} ${width}w`).join(", ");
        return `<img src="${pictureUrl(prefix, name, Math.min(960, largest))}" srcset="${srcset}" sizes="(min-width: 44rem) 40rem, 100vw" width="${picture.width}" height="${picture.height}" alt="${escape(text)}" loading="lazy" decoding="async">`;
      },
      code({ text, lang = "" }) {
        const name = lang.trim().split(/\s/)[0]!;
        return `<pre${name ? ` data-lang="${escape(name)}"` : ""}><code>${highlight(text, lang)}</code></pre>\n`;
      },
    },
  });
  return (md) => marked.parse(md, { async: false }) as string;
}

/** Prose in the terminal's colours, as md.awk sets it there. */
const PROSE =
  "prose prose-terminal max-w-none text-[17px]/[1.9] prose-headings:phosphor prose-h2:text-cyan prose-a:no-underline prose-a:hover:underline prose-code:font-normal prose-code:before:content-none prose-code:after:content-none prose-pre:font-mono prose-img:rounded-md [&_blockquote_p]:before:content-none [&_blockquote_p]:after:content-none";

/** How a page shows where it is shared (Open Graph), and the card it shows. */
interface Share {
  /** The page's path under the site: "" for its home, "blog/<slug>/" … */
  path: string;
  title: string;
  description: string;
  /** The card's path under the site. */
  card: string;
  type: "website" | "article";
  locale?: string;
  published?: string;
  tags?: string[];
}

/** The head's lines for sharing: the page's one address, and its card. */
function shareTags(site: Site, share: Share): string {
  const property = (name: string, content: string) => `<meta property="${name}" content="${escape(content)}">`;
  return [
    site.url && `<link rel="canonical" href="${escape(address(site, share.path))}">`,
    property("og:site_name", TITLE),
    property("og:type", share.type),
    property("og:title", share.title),
    property("og:description", share.description),
    property("og:url", address(site, share.path)),
    property("og:image", address(site, share.card)),
    property("og:image:width", "1200"),
    property("og:image:height", "630"),
    property("og:image:alt", share.title),
    share.locale && property("og:locale", share.locale),
    share.published && property("article:published_time", share.published),
    ...(share.tags ?? []).map((tag) => property("article:tag", tag)),
    `<meta name="twitter:card" content="summary_large_image">`,
  ]
    .filter(Boolean)
    .join("\n");
}

interface Page {
  title: string;
  description: string;
  /** Where the prompt stands, and what it typed to get here. */
  cwd: string;
  command: string;
  body: string;
  share: Share;
}

/** A page around `body`, headed by the prompt that would have printed it, as fish draws it. */
function page(site: Site, stylesheet: string, { title, description, cwd, command, body, share }: Page) {
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
${shareTags(site, share)}
<link rel="icon" href="${site.base}favicon.svg" type="image/svg+xml">
<link rel="alternate" type="application/rss+xml" title="${TITLE}" href="${site.base}feed.xml">
<link rel="stylesheet" href="${stylesheet}">
</head>
<body class="mx-auto max-w-176 px-[clamp(20px,5vw,40px)] py-[clamp(24px,6vw,72px)] font-sans text-[17px]/[1.9] text-ink antialiased">
<p class="phosphor mb-14 font-mono text-sm"><a href="${site.base}"><span class="text-green">guest</span>@${image.hostname}</a> <span class="text-green">${cwd}</span>&gt; ${command}</p>
${body}
<footer class="mt-20 flex flex-wrap gap-x-6 border-t border-line pt-6 font-mono text-[13px] text-faint *:hover:text-ink"><a href="${site.base}">Back to the terminal</a><a href="${site.base}blog/">All posts</a><a href="${site.base}moments/">Moments</a><a href="${site.base}feed.xml">RSS</a></footer>
</body>
</html>
`;
}

/** Every file of a page: the page in `dir`, and its card beside it. */
type Files = [path: string, data: string | Uint8Array][];

async function withCard(dir: string, card: Card, make: (cardPath: string) => string): Promise<Files> {
  const { name, png } = await draw(card);
  return [
    [`${dir}index.html`, make(`${dir}${name}`)],
    [`${dir}${name}`, png],
  ];
}

function postPage(site: Site, stylesheet: string, post: Post, html: (md: string) => string): Promise<Files> {
  const dir = `blog/${post.slug}/`;
  const command = `cat ${escape(post.file)}`;
  const meta = [post.date, ...post.tags].filter(Boolean).join(" · ");
  return withCard(dir, { cwd: "~/blog", command: `cat ${post.file}`, title: post.title, meta }, (card) =>
    page(site, stylesheet, {
      title: `${post.title} — ${TITLE}`,
      description: excerpt(post.body),
      cwd: "~/blog",
      command,
      body: `<main><article class="${PROSE}">
<h1 class="mb-0 text-[2rem]/[1.35] font-semibold">${escape(post.title)}</h1>
<p class="mt-2 mb-10 font-mono text-[13px] text-faint">${[post.date, ...post.tags].map(escape).join(" · ")}</p>
${html(post.body)}
</article></main>`,
      share: {
        path: dir,
        title: post.title,
        description: excerpt(post.body),
        card,
        type: "article",
        locale: "zh_CN",
        published: post.date || undefined,
        tags: post.tags,
      },
    }),
  );
}

function indexPage(site: Site, stylesheet: string, all: Post[]): Promise<Files> {
  const count = `${all.length} ${all.length === 1 ? "post" : "posts"}`;
  return withCard("blog/", { cwd: "~", command: "blog", title: "Blog", meta: count }, (card) =>
    page(site, stylesheet, {
      title: `Blog — ${TITLE}`,
      description: "All posts",
      cwd: "~",
      command: "blog",
      body: `<main>
<h1 class="phosphor text-[2rem]/[1.35] font-semibold">Blog</h1>
<ul class="mt-10 divide-y divide-line border-y border-line">
${all.map((p) => `<li class="flex items-baseline gap-6 py-3"><time class="flex-none font-mono text-[13px] text-faint">${p.date}</time><a class="hover:text-cyan" href="${site.base}blog/${p.slug}/">${escape(p.title)}</a></li>`).join("\n")}
</ul>
</main>`,
      share: { path: "blog/", title: "Blog", description: `All posts: ${count}`, card, type: "website" },
    }),
  );
}

function momentsPage(site: Site, stylesheet: string, all: Moment[], html: (md: string) => string): Promise<Files> {
  const description = all[0] ? excerpt(all[0].body) : "Moments";
  return withCard("moments/", { cwd: "~", command: "moments", title: "Moments", meta: all[0]?.date }, (card) =>
    page(site, stylesheet, {
      title: `Moments — ${TITLE}`,
      description,
      cwd: "~",
      command: "moments",
      body: `<main>
<h1 class="phosphor text-[2rem]/[1.35] font-semibold">Moments</h1>
<ol class="mt-10 divide-y divide-line border-y border-line">
${all.map((m) => `<li id="${escape(m.id)}" class="py-8"><a href="#${escape(m.id)}" class="font-mono text-[13px] text-faint hover:text-ink"><time>${escape(m.date)}</time></a>
<div class="${PROSE} mt-3">${html(m.body)}</div></li>`).join("\n")}
</ol>
</main>`,
      share: { path: "moments/", title: "Moments", description, card, type: "website", locale: "zh_CN" },
    }),
  );
}

function feed(site: Site, all: Post[], html: (md: string) => string): string {
  const home = address(site, "");
  const items = all.map((p) => {
    const link = `${home}blog/${p.slug}/`;
    return `<item>
<title>${escape(p.title)}</title>
<link>${link}</link>
<guid>${link}</guid>
${p.date ? `<pubDate>${new Date(`${p.date}T00:00:00Z`).toUTCString()}</pubDate>` : ""}
<description><![CDATA[${html(p.body).replaceAll("]]>", "]]]]><![CDATA[>")}]]></description>
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

/** Every page there is to find, with the day each last changed: for search engines, which want whole addresses. */
function sitemap(site: Site, all: Post[], latest: Moment | undefined): string {
  const day = (date: string | undefined) => (date && /^\d{4}-\d\d-\d\d/.test(date) ? date.slice(0, 10) : undefined);
  const entry = (path: string, changed?: string) =>
    `<url><loc>${escape(address(site, path))}</loc>${changed ? `<lastmod>${changed}</lastmod>` : ""}</url>`;
  return `<?xml version="1.0" encoding="utf-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${[
  entry(""),
  entry("blog/", day(all[0]?.date)),
  ...all.map((p) => entry(`blog/${p.slug}/`, day(p.date))),
  entry("moments/", day(latest?.date)),
].join("\n")}
</urlset>
`;
}

/** Every file of the writing on the web, by its path under the site: pages, their cards, the feed, the sitemap. */
export async function pages(site: Site, stylesheet: string, writing: Written[], pictures: Pictures = () => undefined): Promise<Map<string, string | Uint8Array>> {
  const all = posts(writing);
  const brief = moments(writing);
  const html = markdown(site.base, pictures);
  const files: Files = [
    ...(await indexPage(site, stylesheet, all)),
    ...(await Promise.all(all.map((post) => postPage(site, stylesheet, post, html)))).flat(),
    ...(await momentsPage(site, stylesheet, brief, html)),
    ["feed.xml", feed(site, all, markdown(address(site, ""), pictures))],
  ];
  if (site.url) files.push(["sitemap.xml", sitemap(site, all, brief[0])]);
  return new Map(files);
}

/** The homepage's share tags, and its card: the cursor at an empty prompt. */
export async function homepage(site: Site): Promise<{ head: string; card: { path: string; png: Uint8Array } }> {
  const { name, png } = await draw({ cwd: "~", command: "", title: TAGLINE });
  const head = shareTags(site, { path: "", title: TITLE, description: TAGLINE, card: name, type: "website" });
  return { head, card: { path: name, png } };
}

/** What crawlers may fetch: not the machine's blocks, nor the services; and where the sitemap is. */
export function robots(site: Site): string {
  const off = ["api/", "relay", "vm/", "content/files/"].map((path) => `Disallow: ${site.base}${path}\n`).join("");
  return `User-agent: *\n${off}${site.url ? `\nSitemap: ${address(site, "sitemap.xml")}\n` : ""}`;
}

/** The posts as links, for the homepage's <noscript>. */
export function postLinks(site: Site, writing: Written[]): string {
  return `<ul>${posts(writing)
    .map((p) => `<li><a href="${site.base}blog/${p.slug}/">${escape(p.title)}</a> <time>${p.date}</time></li>`)
    .join("")}</ul>`;
}
