// What press needs to know, from its environment (deploy/press.env.example):
//
//   PRESS_SITE                 where the site lives, https://arc.moe: passkeys
//                              belong to its host, GitHub comes back to it
//   PRESS_ORIGINS              other origins whose pages may log in too,
//                              comma-separated: https://test-demo.arc.moe
//   PRESS_OWNER                the name passkeys carry in password managers
//   PRESS_LISTEN               host:port, by default 127.0.0.1:8096
//   PRESS_DATA                 press's own directory: passkeys, the GitHub link
//   PRESS_SESSION_KEY_FILE     64 hex digits, the relay's session_key too
//   PRESS_GITHUB_CLIENT_ID     the GitHub OAuth app; without, no GitHub login
//   PRESS_GITHUB_SECRET_FILE   its client secret

import { readFile } from "node:fs/promises";

export interface Config {
  site: string;
  /** Every origin whose pages may log in, the site's first. */
  origins: string[];
  /** The relying party passkeys belong to: the site's host. */
  rpId: string;
  owner: string;
  listen: { host: string; port: number };
  data: string;
  sessionKey: Uint8Array;
  github?: { clientId: string; clientSecret: string };
}

const secret = async (file: string) => (await readFile(file, "utf8")).trim();

export async function configure(env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  const need = (name: string) => env[name] || fail(`${name} is not set`);
  const site = new URL(need("PRESS_SITE")).origin;
  const [, host = "", port = ""] = /^(.+):(\d+)$/.exec(env.PRESS_LISTEN || "127.0.0.1:8096") ?? fail("PRESS_LISTEN: host:port");
  const sessionKey = Buffer.from(await secret(need("PRESS_SESSION_KEY_FILE")), "hex");
  if (sessionKey.length !== 32) fail("PRESS_SESSION_KEY_FILE: 64 hex digits, from `relay key`");
  const clientId = env.PRESS_GITHUB_CLIENT_ID;
  return {
    site,
    origins: [site, ...(env.PRESS_ORIGINS ?? "").split(",").filter(Boolean).map((origin) => new URL(origin).origin)],
    rpId: new URL(site).hostname,
    owner: env.PRESS_OWNER || "owner",
    listen: { host, port: Number(port) },
    data: need("PRESS_DATA"),
    sessionKey,
    ...(clientId && { github: { clientId, clientSecret: await secret(need("PRESS_GITHUB_SECRET_FILE")) } }),
  };
}

function fail(message: string): never {
  throw new Error(`press: ${message}`);
}
