import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { feed, indexPage, postLinks, postPage, type Site } from "./scripts/lib/blog.ts";
import { readPosts } from "./scripts/lib/content.ts";
import { warpPipes } from "./scripts/lib/warp-pipes.ts";

// The posts as web pages (blog/<slug>/), an index (blog/) and a feed
// (feed.xml): rendered per request in dev, written out by the build. The
// homepage's <noscript> lists them too.
function blog(): Plugin {
  let site: Site;
  const pages = async () => {
    const posts = await readPosts();
    return new Map([
      ["blog/index.html", indexPage(site, posts)],
      ...posts.map((post) => [`blog/${post.slug}/index.html`, postPage(site, post)] as const),
      ["feed.xml", feed(site, posts)],
    ]);
  };
  return {
    name: "blog",
    configResolved: (config) => void (site = { base: config.base, url: (process.env.SITE_URL ?? "").replace(/\/$/, "") }),
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = decodeURIComponent((req.url ?? "/").split("?")[0]!).slice(site.base.length);
        const all = await pages();
        const body = all.get(path) ?? all.get(`${path.replace(/\/$/, "")}/index.html`);
        if (!body) return next();
        res.setHeader("Content-Type", path.endsWith(".xml") ? "application/rss+xml; charset=utf-8" : "text/html; charset=utf-8");
        res.end(body);
      });
    },
    async generateBundle() {
      for (const [fileName, source] of await pages()) this.emitFile({ type: "asset", fileName, source });
    },
    transformIndexHtml: async (html) => html.replace("<!-- posts -->", postLinks(site, await readPosts())),
  };
}

// The page imports "virtual:vm-manifest" — public/vm/manifest.json, baked into
// the bundle — so it knows the content-hashed name of every artifact without
// asking the server first. Rebuilding the machine reloads the dev server. The
// built site then has no use for the file itself, so it is left out.
function vmManifest(): Plugin {
  const id = "virtual:vm-manifest";
  const file = join(import.meta.dirname, "public/vm/manifest.json");
  let outDir = "";
  return {
    name: "vm-manifest",
    configResolved: (config) => void (outDir = config.build.outDir),
    resolveId: (source) => (source === id ? `\0${id}` : undefined),
    load(resolved) {
      if (resolved !== `\0${id}`) return;
      this.addWatchFile(file);
      return `export default ${readFileSync(file, "utf8")}`;
    },
    closeBundle: () => rmSync(join(outDir, "vm/manifest.json"), { force: true }),
  };
}

// `net on` reaches the relay (relay/) at <base>relay; in development, one
// running here — or, through an SSH forward, somewhere else (RELAY=host:port).
const relay = { [`/relay`]: { target: `ws://${process.env.RELAY ?? "127.0.0.1:8095"}`, ws: true } };

export default defineConfig({
  plugins: [vmManifest(), blog(), warpPipes()],
  server: { proxy: relay },
  preview: { proxy: relay },
  build: {
    target: "es2022", // top-level await
    assetsInlineLimit: 0, // keep v86.wasm a separate, cacheable file
    chunkSizeWarningLimit: 1024, // v86 and xterm.js are needed up front; splitting buys nothing
  },
});
