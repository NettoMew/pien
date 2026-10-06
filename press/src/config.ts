// What press needs to know, from its environment (deploy/press.env.example):
//
//   PRESS_SITE                 where the site lives, https://www.arc.moe:
//                              GitHub comes back to it
//   PRESS_RP_ID                the domain passkeys belong to: the site's host,
//                              or a domain above it, arc.moe for www.arc.moe,
//                              so that they work wherever under it the site is
//   PRESS_ORIGINS              other origins whose pages may log in too,
//                              comma-separated: pages on the site's subdomains
//   PRESS_OWNER                the name passkeys carry in password managers
//   PRESS_LISTEN               host:port, by default 127.0.0.1:8096
//   PRESS_DATA                 press's own directory: passkeys, the GitHub link
//   PRESS_SESSION_KEY_FILE     64 hex digits, the relay's session_key too
//   PRESS_GITHUB_CLIENT_ID     the GitHub OAuth app; without, no GitHub login
//   PRESS_GITHUB_SECRET_FILE   its client secret
//   PRESS_GITHUB_URL           GitHub itself, https://github.com, and its API,
//   PRESS_GITHUB_API           https://api.github.com: a stand-in's, for tests
//   PRESS_CONTENT              the published writing, a git repository;
//                              without, no writing from the machine
//   PRESS_PUBLIC               where press renders what nginx serves
//   PRESS_DIST                 the built site, for its posts' stylesheet

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Places } from "./writing.ts";

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
  github?: { clientId: string; clientSecret: string; url: string; api: string };
  writing?: Places;
}

const secret = async (file: string) => (await readFile(file, "utf8")).trim();

export async function configure(env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  const need = (name: string) => env[name] || fail(`${name} is not set`);
  const site = new URL(need("PRESS_SITE")).origin;
  const [, host = "", port = ""] = /^(.+):(\d+)$/.exec(env.PRESS_LISTEN || "127.0.0.1:8096") ?? fail("PRESS_LISTEN: host:port");
  const sessionKey = Buffer.from(await secret(need("PRESS_SESSION_KEY_FILE")), "hex");
  if (sessionKey.length !== 32) fail("PRESS_SESSION_KEY_FILE: 64 hex digits, from `relay key`");
  const clientId = env.PRESS_GITHUB_CLIENT_ID;
  const siteHost = new URL(site).hostname;
  const rpId = env.PRESS_RP_ID || siteHost;
  if (rpId !== siteHost && !siteHost.endsWith(`.${rpId}`)) fail(`PRESS_RP_ID: ${rpId} is neither ${siteHost} nor a domain above it`);
  return {
    site,
    origins: [site, ...(env.PRESS_ORIGINS ?? "").split(",").filter(Boolean).map((origin) => new URL(origin).origin)],
    rpId,
    owner: env.PRESS_OWNER || "owner",
    listen: { host, port: Number(port) },
    data: need("PRESS_DATA"),
    sessionKey,
    ...(clientId && {
      github: {
        clientId,
        clientSecret: await secret(need("PRESS_GITHUB_SECRET_FILE")),
        url: env.PRESS_GITHUB_URL || "https://github.com",
        api: env.PRESS_GITHUB_API || "https://api.github.com",
      },
    }),
    ...(env.PRESS_CONTENT && {
      writing: {
        store: env.PRESS_CONTENT,
        drafts: join(need("PRESS_DATA"), "drafts"),
        pictures: join(need("PRESS_DATA"), "pictures"),
        public: need("PRESS_PUBLIC"),
        dist: need("PRESS_DIST"),
      },
    }),
  };
}

function fail(message: string): never {
  throw new Error(`press: ${message}`);
}
