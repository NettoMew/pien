import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import type { ContentIndex } from "../../scripts/lib/content.ts";
import { Refusal, router } from "../src/http.ts";
import { issue, verify } from "../src/tokens.ts";
import { type Places, writing } from "../src/writing.ts";

const SITE = { base: "/", url: "https://arc.moe" };

/** press's writing over a store seeded with one post and one moment; a login to use it with. */
async function press() {
  const root = await mkdtemp(join(tmpdir(), "press-writing-"));
  const places: Places = {
    store: join(root, "store"),
    drafts: join(root, "drafts"),
    pictures: join(root, "pictures"),
    public: join(root, "public"),
    dist: join(root, "dist"),
  };
  await mkdir(join(places.store, "blog"), { recursive: true });
  await mkdir(join(places.store, "moments"), { recursive: true });
  await writeFile(join(places.store, "blog/hello.md"), "---\ntitle: Hello\ndate: 2026-10-04\n---\n\nThe first.\n");
  await writeFile(join(places.store, "moments/2026-10-04.md"), "---\ndate: 2026-10-04\n---\n\nNow.\n");
  await mkdir(join(places.dist, ".vite"), { recursive: true });
  await writeFile(join(places.dist, ".vite/manifest.json"), JSON.stringify({ "src/blog.css": { file: "assets/blog-test.css" } }));

  const key = randomBytes(32);
  const { token } = issue(key, Math.floor(Date.now() / 1000));
  const mustBeLoggedIn = (request: Request) => {
    const given = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    if (verify(key, given, Math.floor(Date.now() / 1000)) === undefined) throw new Refusal(401, "Not logged in.");
  };
  const writes = writing(places, SITE, mustBeLoggedIn);
  await writes.open();
  const app = router(writes.routes);

  const call = async (method: string, path: string, { json, data, anyone }: { json?: unknown; data?: Buffer; anyone?: boolean } = {}) => {
    const headers = new Headers();
    if (!anyone) headers.set("authorization", `Bearer ${token}`);
    if (json !== undefined) headers.set("content-type", "application/json");
    const body = json !== undefined ? JSON.stringify(json) : data && new Uint8Array(data);
    const response = await app(new Request(`${SITE.url}${path}`, { method, headers, ...(body !== undefined && { body }) }));
    return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, unknown> };
  };
  const index = async () => JSON.parse(await readFile(join(places.public, "content/index.json"), "utf8")) as ContentIndex;
  const page = (path: string) => readFile(join(places.public, "pages", path), "utf8");
  const history = () => execFileSync("git", ["-C", places.store, "log", "--format=%s"]).toString().trim().split("\n").reverse();

  return { places, call, index, page, history };
}

test("the writing as it was: a repository, the index, the pages", async () => {
  const { index, page, history, call } = await press();
  assert.deepEqual(history(), ["Begins the writing"]);
  const { files, posts } = await index();
  assert.deepEqual(files.map((each) => each.path), ["blog/hello.md", "moments/2026-10-04.md"]);
  assert.deepEqual(posts, [["2026-10-04", "hello.md", "Hello"]]);
  assert.match(await page("blog/hello/index.html"), /<link rel="stylesheet" href="\/assets\/blog-test.css">/);
  assert.match(await page("moments/index.html"), /Now\./);
  assert.match(await page("feed.xml"), /<link>https:\/\/arc.moe\/blog\/hello\/<\/link>/);
  assert.equal((await call("GET", "/content/index.json", { anyone: true })).status, 200);
  assert.equal((await call("GET", "/content/../../etc/passwd", { anyone: true })).status, 404);
});

test("drafts are the owner's alone, and kept out of the repository", async () => {
  const { call, places, history } = await press();
  assert.equal((await call("GET", "/api/drafts", { anyone: true })).status, 401);
  assert.equal((await call("PUT", "/api/drafts/new-one", { json: { text: "---\r\ntitle: New\r\n---\r\n\r\nSoon." } })).status, 200);
  assert.equal(await readFile(join(places.drafts, "new-one.md"), "utf8"), "---\ntitle: New\n---\n\nSoon.\n");
  const listed = (await call("GET", "/api/drafts")).body as unknown as { name: string; title: string }[];
  assert.deepEqual(listed.map(({ name, title }) => [name, title]), [["new-one", "New"]]);
  assert.equal((await call("GET", "/api/drafts/new-one")).body.text, "---\ntitle: New\n---\n\nSoon.\n");
  assert.equal((await call("PUT", "/api/drafts/../escape", { json: { text: "x" } })).status, 404);
  assert.equal((await call("PUT", "/api/drafts/Not_A_Name", { json: { text: "x" } })).status, 400);
  assert.deepEqual(history(), ["Begins the writing"]);
});

test("a picture, then a post with it: published, on the web at every width, in the guest at one", async () => {
  const { call, places, index, page, history } = await press();
  const photo = await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#7dcfff" } })
    .jpeg()
    .withExif({ IFD0: { Make: "A camera that should not show" } })
    .toBuffer();
  const picture = await call("POST", "/api/pictures", { data: photo });
  assert.equal(picture.status, 200);
  const name = picture.body.name as string;
  assert.match(name, /^[0-9a-f]{12}\.jpg$/);
  assert.deepEqual([picture.body.width, picture.body.height], [1200, 800]);
  const kept = await readFile(join(places.pictures, name));
  assert.equal((await sharp(kept).metadata()).exif, undefined, "nothing of the camera kept");
  assert.equal(existsSync(join(places.store, "media", name)), false, "not public before what shows it is");
  assert.equal((await call("POST", "/api/pictures", { data: Buffer.from("not a picture") })).status, 415);

  await call("PUT", "/api/drafts/sky", { json: { text: "draft" } });
  const text = `---\ntitle: The sky\n---\n\nBlue.\n\n![The sky](../media/${name})\n`;
  const published = await call("PUT", "/api/posts/sky", { json: { text, today: "2026-10-05" } });
  assert.equal(published.status, 200);
  assert.equal(published.body.url, "https://arc.moe/blog/sky/");
  assert.equal(await readFile(join(places.store, "blog/sky.md"), "utf8"), `---\ndate: 2026-10-05\ntitle: The sky\n---\n\nBlue.\n\n![The sky](../media/${name})\n`);
  assert.equal(existsSync(join(places.drafts, "sky.md")), false, "the draft is gone");
  assert.ok(existsSync(join(places.store, "media", name)), "the picture published with it");
  assert.equal(existsSync(join(places.pictures, name)), false);

  const stem = name.replace(".jpg", "");
  for (const width of [480, 960, 1200]) assert.ok(existsSync(join(places.public, `content/media/${stem}-${width}.webp`)), `${width} wide`);
  assert.match(await page("blog/sky/index.html"), new RegExp(`srcset="/content/media/${stem}-480.webp 480w, /content/media/${stem}-960.webp 960w, /content/media/${stem}-1200.webp 1200w"`));
  assert.match(await page("blog/sky/index.html"), /width="1200" height="800" alt="The sky"/);

  const { files, posts } = await index();
  const guest = files.find((each) => each.path === `media/${name}`)!;
  const copy = await readFile(join(places.public, `content/media/${name}`));
  assert.equal(guest.size, copy.length, "the guest's picture is its JPEG copy");
  const { format, width } = await sharp(copy).metadata();
  assert.deepEqual([format, width], ["jpeg", 960], "which the terminal can show, at most 960 wide");
  assert.ok(existsSync(join(places.public, "content/files", guest.sha256)));
  assert.deepEqual(posts[0], ["2026-10-05", "sky.md", "The sky"]);

  assert.deepEqual(history(), ["Begins the writing", "Publishes sky"]);
  assert.equal(execFileSync("git", ["-C", places.store, "show", "--stat", "--format=", "HEAD"]).toString().includes(`media/${name}`), true, "in the same commit");
  assert.equal((await call("PUT", "/api/posts/sky", { json: { text } })).status, 200);
  assert.equal(history().at(-1), "Publishes sky", "the same text again changes nothing");
  assert.equal((await call("PUT", "/api/posts/sky", { json: { text: text.replace("Blue.", "Bluer.") } })).status, 200);
  assert.equal(history().at(-1), "Revises sky");
});

test("a post wants a title and its pictures; withdrawn, it is a draft again", async () => {
  const { call, places, page, history } = await press();
  assert.equal((await call("PUT", "/api/posts/untitled", { json: { text: "No front matter." } })).status, 422);
  const missing = await call("PUT", "/api/posts/lost", { json: { text: "---\ntitle: Lost\n---\n\n![](../media/000000000000.jpg)" } });
  assert.equal(missing.status, 422);
  assert.match(String(missing.body.error), /000000000000\.jpg/);

  assert.equal((await call("DELETE", "/api/posts/hello")).status, 200);
  assert.ok(existsSync(join(places.drafts, "hello.md")));
  assert.equal(existsSync(join(places.store, "blog/hello.md")), false);
  await assert.rejects(page("blog/hello/index.html"), "its page is gone");
  assert.equal(history().at(-1), "Withdraws hello");
  assert.equal((await call("DELETE", "/api/posts/hello")).status, 404);
});

test("moments: posted at the poster's minute, one name each, and deleted", async () => {
  const { call, index, page, history } = await press();
  assert.equal((await call("POST", "/api/moments", { json: { text: "  " } })).status, 400);
  const first = await call("POST", "/api/moments", { json: { text: "Tea.", now: "2026-10-05 12:30" } });
  const second = await call("POST", "/api/moments", { json: { text: "More tea.", now: "2026-10-05 12:30" } });
  assert.deepEqual([first.body.id, second.body.id], ["2026-10-05-1230", "2026-10-05-1230-2"]);
  assert.ok((await index()).files.some((each) => each.path === "moments/2026-10-05-1230.md"));
  const moments = await page("moments/index.html");
  assert.ok(moments.indexOf("More tea.") < moments.indexOf("Tea.</p>") && moments.indexOf("Tea.</p>") < moments.indexOf("Now."), "newest first");

  const tea = await sharp({ create: { width: 300, height: 300, channels: 3, background: "#9ece6a" } }).png().toBuffer();
  assert.equal((await call("POST", "/api/moments", { json: { text: "![](../media/aaaaaaaaaaaa.jpg)" } })).status, 422, "a picture never sent");
  const picture = (await call("POST", "/api/pictures", { data: tea })).body.name as string;
  const third = await call("POST", "/api/moments", { json: { text: `Green.\n\n![tea](../media/${picture})`, now: "2026-10-05 13:00" } });
  assert.equal(third.status, 200);
  assert.ok((await index()).files.some((each) => each.path === `media/${picture}`), "its picture published with it");

  assert.equal((await call("DELETE", "/api/moments/2026-10-05-1230")).status, 200);
  assert.equal((await call("DELETE", "/api/moments/2026-10-05-1230")).status, 404);
  assert.equal((await call("DELETE", "/api/moments/..%2Fblog%2Fhello")).status, 400);
  assert.deepEqual(history().slice(1), [
    "Posts the moment 2026-10-05-1230",
    "Posts the moment 2026-10-05-1230-2",
    "Posts the moment 2026-10-05-1300",
    "Deletes the moment 2026-10-05-1230",
  ]);
});
