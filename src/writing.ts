// Writing from inside the machine: what blog.fish and moments.fish ask the
// page. The page reads what the guest wrote straight from its filesystem
// (the guest has synced it first), sends the pictures it shows to press,
// rewriting them as ../media/<name>, and, once press has published, lays the
// new writing into the guest's home (content.ts). Text going back into the
// guest travels as base64, a line at a time, to arrive byte for byte.
//
//   blog drafts              <name> <title> <saved>, newest first
//   blog fetch <name>        the draft, or else the post, as base64   3: neither
//   blog save <name>         the draft as base64, if its pictures were sent
//   blog publish <name>      <address on the web>
//   blog withdraw <name>
//   moments post             <id>
//   moments delete <id>

import { api, Refused } from "./account/api.ts";
import { No } from "./ask.ts";
import { lay } from "./content.ts";
import type { Machine } from "./machine.ts";

const HOME = "/home/guest";
const DRAFTS = `${HOME}/drafts`;

/** The status that says: nothing by that name, so a new one. */
const NEW = 3;

const pad = (n: number) => String(n).padStart(2, "0");
/** Today, by the visitor's clock: 2026-10-05. */
const today = (at = new Date()) => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
/** This minute, by the visitor's clock: 2026-10-05 12:30. */
const minute = (at = new Date()) => `${today(at)} ${pad(at.getHours())}:${pad(at.getMinutes())}`;

/** `text` as base64, in lines short enough for the control line. */
function base64Lines(text: string): string[] {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary).match(/.{1,76}/g) ?? [];
}

/** A file the guest has, if it has it. */
async function guestFile(machine: Machine, path: string): Promise<Uint8Array | undefined> {
  return machine.emulator.read_file(path).catch(() => undefined);
}

/**
 * `text` with every picture it shows from the guest's files sent to press,
 * and shown as ../media/<name> from then on. Pictures are found from `dir`,
 * the way the guest would: relative to it, from /, or from ~.
 */
async function sendPictures(machine: Machine, text: string, dir: string): Promise<string> {
  const found = [...text.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)];
  let out = text;
  for (const [whole, alt, src] of found) {
    if (/^\.\.\/media\/[^/]+$/.test(src!) || /^[a-z][a-z0-9+.-]*:/i.test(src!)) continue;
    const path = decodeURIComponent(new URL(src!.replace(/^~\//, `${HOME}/`), `file://${dir}/`).pathname);
    const data = await guestFile(machine, path);
    // Dropped files last as long as the page: after a reload, they are gone.
    if (!data) throw new No(`There is no picture at ${src}${path.startsWith(`${HOME}/drop/`) ? ": drop it again" : ""}.`);
    const { name } = await api<{ name: string }>("POST", "/pictures", undefined, new Uint8Array(data));
    out = out.replace(whole, `![${alt}](../media/${name})`);
  }
  return out;
}

/** The draft `name` as the guest has it, or else as press keeps it. */
async function draft(machine: Machine, name: string): Promise<string> {
  const local = await guestFile(machine, `${DRAFTS}/${name}.md`);
  if (local) return new TextDecoder().decode(local);
  return (await api<{ text: string }>("GET", `/drafts/${name}`)).text;
}

export async function blog([verb = "", name = ""]: string[], machine: Machine): Promise<string[]> {
  switch (verb) {
    case "drafts": {
      const drafts = await api<{ name: string; title: string; saved: number }[]>("GET", "/drafts");
      return drafts.map(({ name, title, saved }) => [name, title || "-", today(new Date(saved * 1000))].join("\t"));
    }
    case "fetch": {
      for (const from of [`/drafts/${name}`, `/posts/${name}`]) {
        try {
          return base64Lines((await api<{ text: string }>("GET", from)).text);
        } catch (error) {
          if (!(error instanceof Refused && error.http === 404)) throw error;
        }
      }
      throw new No("new", NEW);
    }
    case "save": {
      const text = await draft(machine, name);
      const sent = await sendPictures(machine, text, DRAFTS);
      await api("PUT", `/drafts/${name}`, { text: sent });
      return sent === text ? [] : base64Lines(sent);
    }
    case "publish": {
      const text = await sendPictures(machine, await draft(machine, name), DRAFTS);
      const { url } = await api<{ url: string }>("PUT", `/posts/${name}`, { text, today: today() });
      await lay(machine);
      return [url];
    }
    case "withdraw":
      await api("DELETE", `/posts/${name}`);
      await lay(machine);
      return [];
  }
  throw new No(`blog: no such question: ${verb}`);
}

export async function moments([verb = "", id = ""]: string[], machine: Machine): Promise<string[]> {
  switch (verb) {
    case "post": {
      const written = await guestFile(machine, `${DRAFTS}/moment.md`);
      if (!written) throw new No("Nothing in ~/drafts/moment.md to post.");
      const text = await sendPictures(machine, new TextDecoder().decode(written), DRAFTS);
      const posted = await api<{ id: string }>("POST", "/moments", { text, now: minute() });
      await lay(machine);
      return [posted.id];
    }
    case "delete":
      await api("DELETE", `/moments/${encodeURIComponent(id)}`);
      await lay(machine);
      return [];
  }
  throw new No(`moments: no such question: ${verb}`);
}
