// Writing from inside the machine, end to end in a real browser (lib/site.ts):
// press keeps the writing in a store seeded from content/, and the owner logs
// in with a passkey. In the guest: a picture dropped in; a post written with
// it, kept on the server as a draft, its picture sent along; published, so
// that the post is in ~/blog, its picture in ~/media and the terminal shows
// it, and its page is on the web in every width; a fresh machine, which finds
// it all there; a moment posted and deleted; the post taken down; and, logged
// out, no writing at all.
//
//   npm run build && npm run check:writing

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { Checks } from "./lib/guest.ts";
import { step } from "./lib/log.ts";
import { SITE, site } from "./lib/site.ts";

const checks = new Checks();
const check = checks.check.bind(checks);

/** A PNG `width` by `height`, a sky-coloured gradient, made by hand. */
function png(width: number, height: number): Buffer {
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) rows.set([125, 207 - (y >> 3), 255 - (x >> 4)], y * (width * 3 + 1) + 1 + x * 3);
  }
  const crc = (data: Buffer) => {
    let c = ~0;
    for (const byte of data) {
      c ^= byte;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const framed = Buffer.alloc(body.length + 8);
    framed.writeUInt32BE(data.length);
    body.copy(framed, 4);
    framed.writeUInt32BE(crc(body), body.length + 4);
    return framed;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header.set([8, 2], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

step("press, with the writing, and the site");
const { page, run, type, open, enrolmentCode, data, close } = await site({ writing: true });
await run("net passkey add laptop", ["Code:"]);
let said = await type(enrolmentCode(), ["Added", "wrong", "Cancelled"]);
check("logged in", said.includes("Logged in until"), said.slice(-80));

step("a post with a picture, kept as a draft");
const chooser = page.waitForEvent("filechooser");
await run("drop", ["Choose"]);
await (await chooser).setFiles({ name: "sky.png", mimeType: "image/png", buffer: png(1200, 800) });
said = await run("ls ~/drop", ["sky.png"]);
check("the picture dropped in", said.includes("sky.png"));
// An editor that writes the post itself, for the test.
await run("function scribe; printf '%s\\n' --- 'title: The sky' --- '' 'Blue.' '' '![The sky](../drop/sky.png)' >$argv[1]; end; set -g EDITOR scribe; echo writ''ten", ["written"]);
said = await run("blog edit sky", ["Kept.", "No", "not"], 60e3);
check("kept on the server", said.includes("Kept."), said.slice(-120));
said = await run("command cat ~/drafts/sky.md", ["../media/"]);
const picture = /\.\.\/media\/([0-9a-f]{12}\.jpg)/.exec(said)?.[1];
check("its picture sent, and shown from ../media/ now", !!picture, said.slice(-80));
said = await run("blog drafts", ["saved", "No drafts"]);
check("among the drafts", said.includes("sky") && said.includes("The sky"));
check("the picture private until published", !existsSync(join(data, "store/media", picture ?? "-")));

step("published");
said = await run("blog publish sky", ["Published", "not", "No"], 60e3);
check("published, with its address", said.includes("Published") && said.includes(`${SITE}/blog/sky/`), said.slice(-120));
said = await run("blog", ["Read one"]);
check("in the list", said.includes("The sky") && said.includes("sky.md"));
said = await run("ls ~/media; ls ~/drafts; echo list''ed", ["listed"]);
check("its picture in ~/media, its draft gone", said.includes(picture ?? "-") && !said.includes("sky.md"), said.slice(-120));
said = await run("cat blog/sky.md; echo show''n", ["shown"]);
await page.screenshot({ path: join(import.meta.dirname, "../.cache/smoke/writing-picture.png") });
const drawn = await page.evaluate(() => {
  const layer = document.querySelector<HTMLCanvasElement>(".xterm-image-layer");
  const pixels = layer?.getContext("2d")?.getImageData(0, 0, layer.width, layer.height).data ?? [];
  return [...pixels].some((value, at) => at % 4 === 3 && value > 0);
});
check("the terminal shows the picture", drawn, said.slice(-80));
const web = await readFile(join(data, "public/pages/blog/sky/index.html"), "utf8").catch(() => "");
const stem = picture?.replace(".jpg", "") ?? "-";
check("its page on the web, in every width", web.includes(`${stem}-480.webp 480w`) && web.includes(`${stem}-1200.webp 1200w`));

step("a machine fresh from its snapshot");
await open();
said = await run("blog", ["Read one"]);
check("finds the post", said.includes("The sky"), said.slice(-160));
said = await run("cat blog/sky.md", ["Blue."]);
check("reads it, fetched from the site", said.includes("Blue."));
said = await run(`ls ~/media; echo list''ed`, ["listed"]);
check("and its picture", said.includes(picture ?? "-"), said.slice(-120));

step("a moment");
await run("function scribe; echo 'Tea, in the garden.' >$argv[1]; end; set -g EDITOR scribe; echo writ''ten", ["written"]);
said = await run("moments new", ["Post it?"]);
said = await type("", ["Posted", "not", "No"], 60e3);
const moment = /moments\/([0-9-]+)\.md/.exec(said)?.[1];
check("posted", !!moment, said.slice(-80));
said = await run("moments; echo show''n", ["shown"]);
check("newest first", said.indexOf("Tea, in the garden.") < said.indexOf("最近在做"));
said = await run(`moments delete ${moment}`, ["Deleted.", "usage", "not"]);
said = await run("moments", ["最近在做"]);
check("deleted", !said.includes("Tea, in the garden."));

step("taken down, and logged out");
said = await run("blog withdraw sky", ["Taken down", "not"]);
said = await run("blog", ["Read one"]);
check("the post is gone from the list", !said.includes("The sky"));
await run("net logout", ["Logged out."]);
said = await run("blog drafts", ["Not logged in", "saved", "No drafts"]);
check("no writing without a login", said.includes("Not logged in"));

await close();
checks.done();
