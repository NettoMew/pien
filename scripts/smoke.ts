// End-to-end check in a real browser: the machine resumes, a visitor types,
// a post is fetched on demand. Screenshots land in .cache/smoke/.
//
//   npm run dev            # in another terminal
//   npm run smoke [url]

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { info, size, step } from "./lib/log.ts";

const URL = process.argv[2] ?? "http://localhost:5173/";
const OUT = join(import.meta.dirname, "../.cache/smoke");
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ channel: process.env.BROWSER ?? "chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });

let bytes = 0;
const fetched: string[] = [];
page.on("requestfinished", async (req) => {
  const { responseBodySize } = await req.sizes();
  bytes += responseBodySize;
  fetched.push(`${new globalThis.URL(req.url()).pathname}  ${size(responseBodySize)}`);
});
page.on("pageerror", (err) => console.error("page error:", err.message));

const shot = (name: string) => page.screenshot({ path: join(OUT, `${name}.png`) });
const type = async (text: string, settle = 1200) => {
  await page.keyboard.type(text, { delay: 25 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(settle);
};

step(`visit ${URL}`);
const t0 = Date.now();
await page.goto(URL);
await page.waitForSelector("body[data-state=running]", { timeout: 60e3 });
info(`first prompt after ${((Date.now() - t0) / 1000).toFixed(1)} s · ${size(bytes)} transferred`);
await page.waitForTimeout(500);
await shot("1-greeting");

step("a visitor types");
await type("ls -l blog");
const before = fetched.length;
await type("cat blog/hello.md", 2500);
info(`status: ${await page.textContent("#activity")}`);
info(...fetched.slice(before));
await shot("2-cat");

await type("clear; help; blog");
await shot("3-help");

await type("clear; fastfetch", 6000);
await shot("4-fastfetch");

step("phone");
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(800);
await type("clear; cat blog/markdown.md", 2500);
await shot("5-phone");

step("network");
info(...fetched);

await browser.close();
