// The guest's questions to the page, and the page's answers. The guest's
// __ask (image/rootfs/etc/fish/functions/__ask.fish) prints
//
//   ESC ] 7337 ; ask ; <secret> ; <id> ; <topic> ; <word> … BEL
//
// with every word URL-escaped. The topic's module works it out (topics.ts
// lists them), and the answer goes back over the control line (hostd):
// `said <id> <line>` for each line of it, then `done <id> <status>`. The secret is new with every
// page and kept in the guest where only the guest's own commands read it,
// so text shown in the terminal, a file being read say, cannot ask anything.

import type { Machine } from "./machine.ts";
import { No } from "./no.ts";

export { No };

/** A topic's module answers its questions: lines to print, or a No. */
export type Answers = (words: string[], machine: Machine) => Promise<string[] | void>;

/** What answers each topic, loaded the first time the guest asks about it. */
export type Topics = Record<string, () => Promise<Answers>>;

/** What the guest must know to ask: given to hostd when the page greets the machine. */
export const secret = [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** Answers what the guest asked in `fields` (the escape sequence after `ask;`), by the topics given. */
export async function ask(fields: string[], machine: Machine, topics: Topics): Promise<void> {
  const [given, id = "", topic = "", ...rest] = fields;
  if (given !== secret || !/^\d+$/.test(id)) return;
  let lines: string[];
  let status = 0;
  try {
    const words = rest.map((word) => decodeURIComponent(word));
    const load = topics[decodeURIComponent(topic)];
    if (!load) throw new No(`Nothing here knows about ${topic}.`);
    lines = (await (await load())(words, machine)) ?? [];
  } catch (error) {
    if (!(error instanceof No)) console.error("ask:", error);
    lines = [error instanceof No ? error.message : `Something went wrong: ${(error as Error).message}`];
    status = error instanceof No ? error.status : 1;
  }
  for (const line of lines.flatMap((line) => line.split("\n"))) machine.control(`said ${id} ${line}`);
  machine.control(`done ${id} ${status}`);
}
