// What `net` in the guest (net.fish) asks the page: logging in and out,
// passkeys, GitHub, and which relay to go through. Answers are lines of
// tab-separated fields for net.fish to lay out; status 3 asks for one more
// thing first (a code, a key), anything else non-zero is no.
//
//   status                       relay <site | address>, login <until | ->
//   login [github]               <until>
//   logout
//   passkeys                     <n> <name> <made> <used | -> …, github <account | ->
//   passkey add <name> [code]    <name> [login <until>]       3: the code
//   passkey remove <n>           <name>
//   github                       <account>
//   relay [reset | <address> [key]]   <site | address>       3: the key

import { No } from "../ask.ts";
import { current, keep } from "../account/login.ts";
import { chosen, choose, reset, SITE } from "./relays.ts";

/** The status that asks for one more thing before trying again. */
const MORE = 3;

/** A day, the way the guest writes them. */
const day = (seconds: number) => {
  const date = new Date(seconds * 1000);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((part) => String(part).padStart(2, "0")).join("-");
};

const relayName = () => (chosen().own ? chosen().url : "site");

export async function answer([verb = "", ...words]: string[]): Promise<string[]> {
  switch (verb) {
    case "status": {
      const login = current();
      return [`relay\t${relayName()}`, `login\t${login ? day(login.expires) : "-"}`];
    }
    case "login": {
      const via = words[0] === "github" ? await import("../account/github.ts") : await import("../account/passkey.ts");
      return [day((await via.logIn()).expires)];
    }
    case "logout":
      keep(undefined);
      return [];
    case "passkeys": {
      const { passkeys, github } = await (await import("../account/passkey.ts")).list();
      return [
        ...passkeys.map(({ name, created, used }, i) => [i + 1, name, day(created), used ? day(used) : "-"].join("\t")),
        `github\t${github ?? "-"}`,
      ];
    }
    case "passkey":
      return passkey(words);
    case "github":
      return [await (await import("../account/github.ts")).link()];
    case "relay":
      return relay(words);
  }
  throw new No(`net: no such question: ${verb}`);
}

async function passkey([action = "", ...words]: string[]): Promise<string[]> {
  const passkeys = await import("../account/passkey.ts");
  if (action === "add") {
    const [name = "", code] = words;
    if (!current() && !code) throw new No("code", MORE);
    const added = await passkeys.add(name.trim() || passkeys.here(), code);
    const login = current();
    return [added, ...(code && login ? [`login\t${day(login.expires)}`] : [])];
  }
  if (action === "remove") {
    const { passkeys: all } = await passkeys.list();
    const which = all[Number(words[0]) - 1];
    if (!which) throw new No(`There is no passkey ${words[0] ?? ""}: net passkey lists them.`);
    return [(await passkeys.remove(which.id)).name];
  }
  throw new No("net passkey: add [name] | remove <n>");
}

function relay([address, key]: string[]): string[] {
  if (!address) return [relayName()];
  if (address === "reset") {
    reset();
    return ["site"];
  }
  let url: string | undefined;
  try {
    url = choose(address, key);
  } catch (error) {
    throw new No((error as Error).message);
  }
  if (!url) throw new No("key", MORE);
  return [url === SITE ? "site" : url];
}
