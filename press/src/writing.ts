// Writing from inside the machine. What is published lives in a git
// repository (PRESS_CONTENT), laid out as the guest's home has it
// (scripts/lib/content.ts), one commit for every change; drafts live apart,
// in press's own data, kept from the world and from that history, and so do
// the pictures sent for them, until something that shows them is published.
// Every change renders the site anew (render.ts), one change at a time.
//
//   GET    /api/drafts                  the drafts: name, title, when last saved
//   GET    /api/drafts/:name            { text }
//   PUT    /api/drafts/:name            { text }
//   DELETE /api/drafts/:name
//   GET    /api/posts/:slug             { text }, to edit what is published
//   PUT    /api/posts/:slug             { text, today } → published, its draft gone
//   DELETE /api/posts/:slug             back to being a draft
//   POST   /api/pictures                the picture itself → { name, width, height },
//                                       to show as ../media/<name>
//   POST   /api/moments                 { text, now } → { id }
//   DELETE /api/moments/:id
//
// Every one of them wants the owner's login.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Site } from "../../scripts/lib/blog.ts";
import { type ContentIndex, frontMatter, readWriting } from "../../scripts/lib/content.ts";
import { body, bytes, file, json, Refusal, type Route } from "./http.ts";
import { keep } from "./pictures.ts";
import { render } from "./render.ts";

export interface Places {
  /** The published writing: a git repository. */
  store: string;
  /** Drafts, as `<name>.md`. */
  drafts: string;
  /** Pictures sent for drafts, until what shows them is published. */
  pictures: string;
  /** What nginx serves: render.ts writes it. */
  public: string;
  /** The built site, for its posts' stylesheet (.vite/manifest.json). */
  dist: string;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MOMENT = /^\d{4}-\d\d-\d\d(?:-\d{4}(?:-\d+)?)?$/;
const MINUTE = /^\d{4}-\d\d-\d\d \d\d:\d\d$/;
const DAY = /^\d{4}-\d\d-\d\d$/;
const PICTURE = /!\[[^\]]*\]\(\.\.\/media\/([^)\s]+)\)/g;

const run = promisify(execFile);

/** git in the store, as press: author and committer alike. */
function git(places: Places, ...args: string[]) {
  const who = { GIT_AUTHOR_NAME: "press", GIT_AUTHOR_EMAIL: "press@localhost", GIT_COMMITTER_NAME: "press", GIT_COMMITTER_EMAIL: "press@localhost" };
  return run("git", ["-C", places.store, ...args], { env: { ...process.env, ...who } });
}

/** Commits whatever changed in the store as `message`, if anything did. */
async function commit(places: Places, message: string) {
  await git(places, "add", "-A");
  if ((await git(places, "status", "--porcelain")).stdout.trim()) await git(places, "commit", "-q", "-m", message);
}

const named = (name: string | undefined, kind: string) => {
  if (!name || !NAME.test(name)) throw new Refusal(400, `A ${kind}'s name is lower-case letters, digits and dashes.`);
  return name;
};

/** Markdown as it is kept: Unix line endings, one at the end. */
const tidy = (text: string) => `${text.replace(/\r\n/g, "\n").trimEnd()}\n`;

/** `text` with `date: <day>` in its front matter, unless it has a date already. */
function dated(text: string, day: string): string {
  const { meta } = frontMatter(text);
  if (meta.date) return text;
  return text.replace(/^---\n/, `---\ndate: ${day}\n`);
}

/** The stylesheet the built site gives its posts. */
async function stylesheet(places: Places, site: Site): Promise<string> {
  try {
    const manifest = JSON.parse(await readFile(join(places.dist, ".vite/manifest.json"), "utf8")) as Record<string, { file: string }>;
    return `${site.base}${manifest["src/blog.css"]!.file}`;
  } catch {
    return `${site.base}src/blog.css`; // a development server's
  }
}

export function writing(places: Places, site: Site, mustBeLoggedIn: (request: Request) => void) {
  let queue: Promise<unknown> = Promise.resolve();
  /** Runs `change` after every change before it, then renders the site; what `change` returned. */
  const change = <T>(work: () => Promise<T>): Promise<T> => {
    const done = queue.then(async () => {
      const result = await work();
      await publish();
      return result;
    });
    queue = done.catch(() => {});
    return done;
  };

  const publish = async (): Promise<ContentIndex> => render(await readWriting(places.store), places.public, site, await stylesheet(places, site));

  /** Makes the store a repository if it is not one yet, and renders the site. */
  const open = () =>
    change(async () => {
      await mkdir(places.store, { recursive: true });
      await mkdir(places.drafts, { recursive: true });
      if (!existsSync(join(places.store, ".git"))) {
        await git(places, "init", "-q", "-b", "main");
        await commit(places, "Begins the writing");
      }
    });

  const guarded =
    (handler: Route["handler"]): Route["handler"] =>
    (request, params) => {
      mustBeLoggedIn(request);
      return handler(request, params);
    };

  /** The pictures `markdown` shows; refused if any is neither published nor among those sent. */
  const pictured = (markdown: string) => {
    const names = [...new Set([...markdown.matchAll(PICTURE)].map((found) => found[1]!))];
    const lost = names.filter((name) => !existsSync(join(places.store, "media", name)) && !existsSync(join(places.pictures, name)));
    if (lost.length) throw new Refusal(422, `These pictures are not on the server: ${lost.join(", ")}.`);
    return names;
  };

  /** Brings those of the pictures `names` not published yet into the published writing. */
  const bring = async (names: string[]) => {
    await mkdir(join(places.store, "media"), { recursive: true });
    for (const name of names) {
      const published = join(places.store, "media", name);
      if (existsSync(published)) continue;
      // Copied, not renamed: press's data and the store may be on different disks.
      await copyFile(join(places.pictures, name), published);
      await rm(join(places.pictures, name));
    }
  };

  const draftFile = (name: string) => join(places.drafts, `${named(name, "draft")}.md`);
  const postFile = (slug: string) => join(places.store, "blog", `${named(slug, "post")}.md`);

  const routes: Route[] = [
    // nginx serves these on the live site; here for development and tests.
    { method: "GET", path: "/content/*", handler: (_, params) => file(join(places.public, "content"), params["*"]!) },
    {
      method: "GET",
      path: "/api/drafts",
      handler: guarded(async () => {
        const names = (await readdir(places.drafts).catch(() => [])).filter((file) => file.endsWith(".md"));
        const drafts = await Promise.all(
          names.map(async (file) => {
            const path = join(places.drafts, file);
            const { meta } = frontMatter(await readFile(path, "utf8"));
            return { name: file.slice(0, -3), title: meta.title ?? "", saved: Math.floor((await stat(path)).mtimeMs / 1000) };
          }),
        );
        return json(drafts.sort((a, b) => b.saved - a.saved));
      }),
    },
    {
      method: "GET",
      path: "/api/drafts/:name",
      handler: guarded(async (_, { name }) => {
        const text = await readFile(draftFile(name!), "utf8").catch(() => {
          throw new Refusal(404, `There is no draft called ${name}.`);
        });
        return json({ text });
      }),
    },
    {
      method: "PUT",
      path: "/api/drafts/:name",
      handler: guarded(async (request, { name }) => {
        const { text } = await body<{ text?: string }>(request);
        if (typeof text !== "string") throw new Refusal(400, "No text.");
        await writeFile(draftFile(name!), tidy(text));
        return json({ name });
      }),
    },
    {
      method: "DELETE",
      path: "/api/drafts/:name",
      handler: guarded(async (_, { name }) => {
        await rm(draftFile(name!), { force: true });
        return json({ name });
      }),
    },
    {
      method: "GET",
      path: "/api/posts/:slug",
      handler: guarded(async (_, { slug }) => {
        const text = await readFile(postFile(slug!), "utf8").catch(() => {
          throw new Refusal(404, `There is no post called ${slug}.`);
        });
        return json({ text });
      }),
    },
    {
      method: "PUT",
      path: "/api/posts/:slug",
      handler: guarded(async (request, { slug }) => {
        const { text, today } = await body<{ text?: string; today?: string }>(request);
        if (typeof text !== "string") throw new Refusal(400, "No text.");
        const { meta, body: markdown } = frontMatter(text);
        if (!meta.title) throw new Refusal(422, "A post needs a title: `title:` in the front matter at its top.");
        const pictures = pictured(markdown);
        const file = postFile(slug!);
        return change(async () => {
          const revising = existsSync(file);
          await bring(pictures);
          await mkdir(join(places.store, "blog"), { recursive: true });
          await writeFile(file, tidy(dated(text, today && DAY.test(today) ? today : new Date().toISOString().slice(0, 10))));
          await rm(draftFile(slug!), { force: true });
          await commit(places, `${revising ? "Revises" : "Publishes"} ${slug}`);
          return json({ url: `${site.url}${site.base}blog/${slug}/` });
        });
      }),
    },
    {
      method: "DELETE",
      path: "/api/posts/:slug",
      handler: guarded(async (_, { slug }) => {
        const file = postFile(slug!);
        if (!existsSync(file)) throw new Refusal(404, `There is no post called ${slug}.`);
        return change(async () => {
          await rename(file, draftFile(slug!));
          await commit(places, `Withdraws ${slug}`);
          return json({ draft: slug });
        });
      }),
    },
    {
      method: "POST",
      path: "/api/pictures",
      handler: guarded(async (request) => {
        const picture = await keep(await bytes(request, 40 << 20));
        if (!existsSync(join(places.store, "media", picture.name))) {
          await mkdir(places.pictures, { recursive: true });
          await writeFile(join(places.pictures, picture.name), picture.data);
        }
        return json({ name: picture.name, width: picture.width, height: picture.height });
      }),
    },
    {
      method: "POST",
      path: "/api/moments",
      handler: guarded(async (request) => {
        const { text, now } = await body<{ text?: string; now?: string }>(request);
        if (!text?.trim()) throw new Refusal(400, "A moment needs something in it.");
        const minute = now && MINUTE.test(now) ? now : new Date().toISOString().slice(0, 16).replace("T", " ");
        const pictures = pictured(text);
        return change(async () => {
          await bring(pictures);
          await mkdir(join(places.store, "moments"), { recursive: true });
          const base = minute.replace(" ", "-").replace(":", "");
          let id = base;
          for (let n = 2; existsSync(join(places.store, "moments", `${id}.md`)); n++) id = `${base}-${n}`;
          await writeFile(join(places.store, "moments", `${id}.md`), tidy(`---\ndate: ${minute}\n---\n\n${text.trim()}`));
          await commit(places, `Posts the moment ${id}`);
          return json({ id });
        });
      }),
    },
    {
      method: "DELETE",
      path: "/api/moments/:id",
      handler: guarded(async (_, { id }) => {
        if (!id || !MOMENT.test(id)) throw new Refusal(400, "That is not a moment's name.");
        const file = join(places.store, "moments", `${id}.md`);
        if (!existsSync(file)) throw new Refusal(404, `There is no moment ${id}.`);
        return change(async () => {
          await rm(file);
          await commit(places, `Deletes the moment ${id}`);
          return json({ id });
        });
      }),
    },
  ];

  return { routes, open, rendered: () => queue };
}
