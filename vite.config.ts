import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { pages, postLinks, type Site } from "./scripts/lib/blog.ts";
import { readWriting } from "./scripts/lib/content.ts";
import { theme, themeCss } from "./src/theme.ts";

// The terminal's palette (src/theme.ts) at the top of the page's head, as
// custom properties for the stylesheets to name: the colours are in place
// from the first paint, the browser's own chrome included.
function palette(): Plugin {
  return {
    name: "palette",
    transformIndexHtml: () => [
      { tag: "style", children: themeCss, injectTo: "head-prepend" },
      { tag: "meta", attrs: { name: "theme-color", content: theme.background }, injectTo: "head" },
    ],
  };
}

// The writing in content/ as web pages (blog/, blog/<slug>/, moments/) and a
// feed (feed.xml): rendered per request in dev, written out by the build. On
// the server, press renders them anew from its store whenever the writing
// changes, with this build's stylesheet, which it finds in Vite's manifest
// (below). The homepage's <noscript> lists the posts too.
const BLOG_CSS = "src/blog.css";

function blog(): Plugin {
  let site: Site;
  const all = async (stylesheet: string) => pages(site, stylesheet, await readWriting());
  return {
    name: "blog",
    configResolved: (config) => void (site = { base: config.base, url: (process.env.SITE_URL ?? "").replace(/\/$/, "") }),
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = decodeURIComponent((req.url ?? "/").split("?")[0]!).slice(site.base.length);
        const rendered = await all(`${site.base}${BLOG_CSS}`);
        const body = rendered.get(path) ?? rendered.get(`${path.replace(/\/$/, "")}/index.html`);
        if (!body) return next();
        res.setHeader("Content-Type", path.endsWith(".xml") ? "application/rss+xml; charset=utf-8" : "text/html; charset=utf-8");
        res.end(body);
      });
    },
    async generateBundle(_, bundle) {
      const css = Object.values(bundle).find((file) => file.type === "asset" && file.originalFileNames.includes(BLOG_CSS));
      if (!css) return this.error(`${BLOG_CSS} did not come out of the build`);
      for (const [fileName, source] of await all(`${site.base}${css.fileName}`)) {
        this.emitFile({ type: "asset", fileName, source });
      }
    },
    transformIndexHtml: async (html) => html.replace("<!-- posts -->", postLinks(site, await readWriting())),
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

// The site's two services, as the live site reaches them (deploy/nginx.conf):
// the relay (relay/) at <base>relay, for `net on`, and press (press/) at
// <base>api/, for logging in and writing, with the writing it renders at
// <base>content/ (which nginx serves itself). In development, ones running
// here — or, through an SSH forward, somewhere else (RELAY=host:port,
// PRESS=host:port).
const press = { target: `http://${process.env.PRESS ?? "127.0.0.1:8096"}` };
const services = {
  "/relay": { target: `ws://${process.env.RELAY ?? "127.0.0.1:8095"}`, ws: true },
  "/api": press,
  "/content": press,
};

export default defineConfig({
  plugins: [react(), tailwindcss(), palette(), vmManifest(), blog()],
  server: { proxy: services },
  preview: { proxy: services },
  build: {
    assetsInlineLimit: 0, // keep v86.wasm a separate, cacheable file
    // Nearly everything is needed up front, but the libraries change far less
    // often than the page, and the machine's (v86, xterm.js) on another clock
    // than the interface's: each set in a chunk of its own stays cached
    // across releases of the others. The adb key's (Tango's) waits for the
    // first USB device.
    rolldownOptions: {
      input: { index: "index.html", blog: BLOG_CSS },
      output: {
        codeSplitting: {
          groups: [
            { name: "machine", test: /node_modules\/(v86|@xterm)\//, priority: 2 },
            { name: "usb", test: /node_modules\/@yume-chan\//, priority: 2 },
            { name: "interface", test: /node_modules/, priority: 1 },
          ],
        },
      },
    },
    chunkSizeWarningLimit: 1024, // the machine's chunk is most of a megabyte by itself
    manifest: true, // .vite/manifest.json: where press finds the posts' stylesheet
  },
});
