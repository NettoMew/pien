// End-to-end check in a real browser: the machine powers on and resumes, a
// visitor types, a post is fetched on demand, a file is written in Edit, and a
// phone gets its keys, the paste key among them.
// Screenshots land in .cache/smoke/.
//
//   npm run dev            # in another terminal
//   npm run smoke [url]

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, devices, type Page } from "playwright-core";
import { info, size, step } from "./lib/log.ts";

const URL = process.argv[2] ?? "http://localhost:5173/";
const OUT = join(import.meta.dirname, "../.cache/smoke");
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ channel: process.env.BROWSER ?? "chrome" });
const desktop = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });

let bytes = 0;
const fetched: string[] = [];
desktop.on("requestfinished", async (req) => {
  const { responseBodySize } = await req.sizes();
  if (responseBodySize < 0) return; // blob: URLs, made in the page, fetch nothing
  bytes += responseBodySize;
  fetched.push(`${new globalThis.URL(req.url()).pathname}  ${size(responseBodySize)}`);
});

const shot = (page: Page, name: string) => page.screenshot({ path: join(OUT, `${name}.png`) });
const type = async (text: string, settle = 1200) => {
  await desktop.keyboard.type(text, { delay: 25 });
  await desktop.keyboard.press("Enter");
  await desktop.waitForTimeout(settle);
};
const atPrompt = (page: Page) => page.waitForSelector("[data-state=running]", { timeout: 60e3 });
/** Waits for `text` on the screen (the DOM renderer's rows), or throws after a while. */
const onScreen = (page: Page, text: string) =>
  page.waitForFunction((text) => document.querySelector(".xterm-rows")?.textContent?.includes(text), text, { timeout: 30e3 });
const report = (page: Page) => page.on("pageerror", (err) => console.error("page error:", err.message));
report(desktop);

step(`visit ${URL}`);
const t0 = Date.now();
await desktop.goto(URL);
// The power-on, caught on its way: the beam's sweep, then the machine reporting in.
await desktop.waitForSelector("[role=status]");
await desktop.waitForTimeout(500);
await shot(desktop, "1-beam");
await desktop.waitForTimeout(700);
await shot(desktop, "2-report");
await atPrompt(desktop);
info(`at the prompt after ${((Date.now() - t0) / 1000).toFixed(1)} s · ${size(bytes)} transferred`);
await desktop.waitForTimeout(300);
await shot(desktop, "3-prompt");

step("a visitor types");
await type("ls -l blog");
const before = fetched.length;
await type("cat blog/hello.md", 2500);
info(...fetched.slice(before));
await shot(desktop, "4-cat");

await type("clear; help; blog");
await shot(desktop, "5-help");

await type("clear; fastfetch", 6000);
await shot(desktop, "6-fastfetch");

step("an editor");
const opened = bytes;
await type("clear; edit /tmp/note.txt", 3000);
info(`Edit read ${size(bytes - opened)}`);
await desktop.keyboard.type("written in Edit", { delay: 25 });
await shot(desktop, "7-edit");
await desktop.keyboard.press("Control+S");
await desktop.keyboard.press("Control+Q");
await desktop.waitForTimeout(500);
await type("clear; cat /tmp/note.txt");
await onScreen(desktop, "written in Edit");

step("phone");
const phone = await browser.newPage({ ...devices["Pixel 7"], permissions: ["clipboard-read", "clipboard-write"] });
report(phone);
await phone.goto(URL);
await atPrompt(phone);
await phone.getByRole("button", { name: "blog", exact: true }).tap();
await phone.waitForTimeout(1500);
await shot(phone, "8-phone");
await phone.evaluate(() => navigator.clipboard.writeText("echo pasted-(math 40 + 2)"));
await phone.getByRole("button", { name: "Paste" }).tap();
await onScreen(phone, "echo pasted-(math 40 + 2)"); // the clipboard is read asynchronously
await phone.keyboard.press("Enter");
await onScreen(phone, "pasted-42"); // what it printed, not what was typed

step("network");
info(...fetched);

await browser.close();
