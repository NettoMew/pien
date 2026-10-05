// Logging in. The site has one account, its owner's, and no password: a
// passkey is the way in, and GitHub the way back in from a device that has
// none yet. The first passkey needs a one-time code from the server itself
// (`press enroll`); later ones need a login. A login is a token (tokens.ts)
// the page sends as `Authorization: Bearer`, and that the relay checks too.
//
//   POST   /api/auth/passkey/options             what a passkey should sign to log in
//   POST   /api/auth/passkey/login               { response } → a login
//   POST   /api/auth/passkey/register/options    { code? } what a new passkey should sign
//   POST   /api/auth/passkey/register            { response, name, code? } → a login, with a code
//   GET    /api/auth/passkeys                    the passkeys, and the GitHub account
//   DELETE /api/auth/passkeys/:id
//   GET    /api/auth/github                      to GitHub, to log in (a popup's first page)
//   POST   /api/auth/github/link                 where to send a popup that links an account
//   GET    /api/auth/github/callback             back from GitHub: tells the page, closes
//
// GitHub runs in a popup, so the page, and the machine running in it, stay
// put; its last page tells the site's other pages over a BroadcastChannel.

import { createHash, randomBytes } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { Config } from "./config.ts";
import { body, cookie, json, Refusal, type Route } from "./http.ts";
import type { Store } from "./store.ts";
import { issue, type Login, verify } from "./tokens.ts";

export interface Account {
  /** The user handle every passkey is made for, base64url: random, made with the first. */
  user?: string;
  passkeys: Passkey[];
  github?: { id: number; login: string };
  /** The one-time code for a first passkey: its hash, its expiry, the guesses left. */
  enrolment?: { hash: string; expires: number; guesses: number };
}

export interface Passkey {
  /** The credential's id, base64url. */
  id: string;
  /** Its COSE public key, base64url. */
  publicKey: string;
  counter: number;
  transports?: string[];
  name: string;
  /** Unix seconds. */
  created: number;
  used?: number;
}

export const emptyAccount = (): Account => ({ passkeys: [] });

/** What a login is checked against beside the request: the clock, and the network (for GitHub). */
export interface World {
  /** Unix seconds. */
  now(): number;
  fetch: typeof fetch;
}

/** How long a challenge, an enrolment code, or a trip to GitHub stays good, in seconds. */
const PATIENCE = { challenge: 300, code: 15 * 60, github: 600 };
const GUESSES = 5;
const STATE_COOKIE = "press-github";
/** Where the GitHub popup reports back (src/account/github.ts listens). */
const CHANNEL = "press-github";

/** Things to remember for a while, each taken once. */
class Pending<T> {
  private readonly items = new Map<string, { value: T; until: number }>();
  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  add(key: string, value: T, seconds: number) {
    const now = this.now();
    for (const [old, { until }] of this.items) if (until <= now) this.items.delete(old);
    if (this.items.size >= 1000) this.items.delete(this.items.keys().next().value!);
    this.items.set(key, { value, until: now + seconds });
  }

  take(key: string): T | undefined {
    const item = this.items.get(key);
    this.items.delete(key);
    return item && item.until > this.now() ? item.value : undefined;
  }
}

const random = (bytes: number) => randomBytes(bytes).toString("base64url");
const hash = (code: string) => createHash("sha256").update(normalise(code)).digest("hex");
/** A code as typed: any case, with or without its dashes and spaces. */
const normalise = (code: string) => code.toUpperCase().replace(/[^0-9A-Z]/g, "");

/** A one-time code to type into the page: 16 letters and digits none could mistake for another. */
export function enrolmentCode(): string {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const letters = [...randomBytes(16)].map((byte) => alphabet[byte % alphabet.length]).join("");
  return letters.match(/.{4}/g)!.join("-");
}

/** Lets `code` enrol a first passkey for the next while. */
export async function enrol(account: Store<Account>, code: string, now: number) {
  await account.update((document) => {
    document.enrolment = { hash: hash(code), expires: now + PATIENCE.code, guesses: GUESSES };
  });
}

export function auth(config: Config, account: Store<Account>, world: World) {
  const challenges = new Pending<"login" | "register">(world.now);
  const trips = new Pending<"login" | "link">(world.now);
  const login = (): Login => issue(config.sessionKey, world.now());

  /** Whether the request carries a good login. */
  const loggedIn = (request: Request) => {
    const [kind, token] = request.headers.get("authorization")?.split(" ") ?? [];
    return kind === "Bearer" && !!token && verify(config.sessionKey, token, world.now()) !== undefined;
  };

  const mustBeLoggedIn = (request: Request) => {
    if (!loggedIn(request)) throw new Refusal(401, "Not logged in: net login.");
  };

  /** Whether `code` is the enrolment code; a wrong one uses up a guess. */
  const codeIsGood = (code: string, use: boolean) =>
    account.update((document) => {
      const enrolment = document.enrolment;
      if (!enrolment || enrolment.expires <= world.now() || enrolment.guesses <= 0) return false;
      if (enrolment.hash !== hash(code)) {
        enrolment.guesses -= 1;
        return false;
      }
      if (use) delete document.enrolment;
      return true;
    });

  /** A login, or else a good enrolment code; which of the two it was. */
  const mayRegister = async (request: Request, code: string | undefined, use: boolean) => {
    if (loggedIn(request)) return "login";
    if (code && (await codeIsGood(code, use))) return "code";
    throw new Refusal(401, code ? "That code is wrong, used or too old." : "Not logged in: net login, or a code from `press enroll`.");
  };

  const routes: Route[] = [
    {
      method: "POST",
      path: "/api/auth/passkey/options",
      handler: async () => {
        const options = await generateAuthenticationOptions({ rpID: config.rpId, userVerification: "preferred", timeout: 120_000 });
        challenges.add(options.challenge, "login", PATIENCE.challenge);
        return json(options);
      },
    },
    {
      method: "POST",
      path: "/api/auth/passkey/login",
      handler: async (request) => {
        const { response } = await body<{ response?: AuthenticationResponseJSON }>(request);
        const passkey = (await account.read()).passkeys.find((each) => each.id === response?.id);
        if (!response || !passkey) throw new Refusal(401, "This site does not know that passkey.");
        const checked = await verifyAuthenticationResponse({
          response,
          expectedChallenge: (challenge) => challenges.take(challenge) === "login",
          expectedOrigin: config.origins,
          expectedRPID: config.rpId,
          credential: {
            id: passkey.id,
            publicKey: Buffer.from(passkey.publicKey, "base64url"),
            counter: passkey.counter,
            ...(passkey.transports && { transports: passkey.transports }),
          },
          requireUserVerification: false,
        }).catch((error: Error) => {
          throw new Refusal(401, `The passkey's answer did not check out: ${error.message}`);
        });
        if (!checked.verified) throw new Refusal(401, "The passkey's answer did not check out.");
        await account.update((document) => {
          const used = document.passkeys.find((each) => each.id === passkey.id);
          if (used) Object.assign(used, { counter: checked.authenticationInfo.newCounter, used: world.now() });
        });
        return json(login());
      },
    },
    {
      method: "POST",
      path: "/api/auth/passkey/register/options",
      handler: async (request) => {
        const { code } = await body<{ code?: string }>(request);
        await mayRegister(request, code, false);
        const document = await account.update((document) => {
          document.user ??= random(16);
          return document;
        });
        const options = await generateRegistrationOptions({
          rpName: config.rpId,
          rpID: config.rpId,
          userName: config.owner,
          userID: Buffer.from(document.user!, "base64url"),
          excludeCredentials: document.passkeys.map(({ id, transports }) => ({ id, ...(transports && { transports }) })),
          authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
          attestationType: "none",
          timeout: 300_000,
        });
        challenges.add(options.challenge, "register", PATIENCE.challenge);
        return json(options);
      },
    },
    {
      method: "POST",
      path: "/api/auth/passkey/register",
      handler: async (request) => {
        const { response, name, code } = await body<{ response?: RegistrationResponseJSON; name?: string; code?: string }>(request);
        if (!response) throw new Refusal(400, "No passkey in the request.");
        const checked = await verifyRegistrationResponse({
          response,
          expectedChallenge: (challenge) => challenges.take(challenge) === "register",
          expectedOrigin: config.origins,
          expectedRPID: config.rpId,
          requireUserVerification: false,
        }).catch((error: Error) => {
          throw new Refusal(400, `The new passkey did not check out: ${error.message}`);
        });
        if (!checked.verified) throw new Refusal(400, "The new passkey did not check out.");
        // Checked, and the code used up, only once the passkey is good.
        const by = await mayRegister(request, code, true);
        const { credential } = checked.registrationInfo;
        const passkey: Passkey = {
          id: credential.id,
          publicKey: Buffer.from(credential.publicKey).toString("base64url"),
          counter: credential.counter,
          ...(credential.transports && { transports: credential.transports }),
          name: (name ?? "").trim().slice(0, 60) || "a passkey",
          created: world.now(),
        };
        await account.update((document) => {
          if (document.passkeys.some((each) => each.id === passkey.id)) throw new Refusal(409, "That passkey is here already.");
          document.passkeys.push(passkey);
        });
        return json({ name: passkey.name, ...(by === "code" && login()) });
      },
    },
    {
      method: "GET",
      path: "/api/auth/passkeys",
      handler: async (request) => {
        mustBeLoggedIn(request);
        const { passkeys, github } = await account.read();
        return json({
          passkeys: passkeys.map(({ id, name, created, used }) => ({ id, name, created, used })),
          github: github?.login ?? null,
        });
      },
    },
    {
      method: "DELETE",
      path: "/api/auth/passkeys/:id",
      handler: async (request, { id }) => {
        mustBeLoggedIn(request);
        const name = await account.update((document) => {
          const passkey = document.passkeys.find((each) => each.id === id);
          if (!passkey) throw new Refusal(404, "There is no such passkey.");
          if (document.passkeys.length === 1 && !document.github) {
            throw new Refusal(409, "It is the only way in: add another passkey, or link GitHub, first.");
          }
          document.passkeys = document.passkeys.filter((each) => each !== passkey);
          return passkey.name;
        });
        return json({ name });
      },
    },
    {
      method: "GET",
      path: "/api/auth/github",
      handler: (request) => {
        const github = config.github;
        if (!github) throw new Refusal(404, "GitHub login is not set up here.");
        // A link was asked for by a login (below); anything else is a login.
        const asked = new URL(request.url).searchParams.get("state");
        const purpose = asked ? trips.take(asked) : "login";
        if (!purpose) throw new Refusal(400, "That link is used or too old. Try again.");
        const state = random(24);
        trips.add(state, purpose, PATIENCE.github);
        const to = new URL("https://github.com/login/oauth/authorize");
        to.search = new URLSearchParams({
          client_id: github.clientId,
          redirect_uri: `${config.site}/api/auth/github/callback`,
          state,
          allow_signup: "false",
        }).toString();
        const headers = new Headers({ location: to.href });
        headers.append("set-cookie", `${STATE_COOKIE}=${state}; Path=/api/auth/github; Max-Age=${PATIENCE.github}; HttpOnly; Secure; SameSite=Lax`);
        return new Response(null, { status: 302, headers });
      },
    },
    {
      method: "POST",
      path: "/api/auth/github/link",
      handler: (request) => {
        mustBeLoggedIn(request);
        if (!config.github) throw new Refusal(404, "GitHub login is not set up here.");
        const state = random(24);
        trips.add(state, "link", PATIENCE.github);
        return json({ url: `/api/auth/github?state=${state}` });
      },
    },
    {
      method: "GET",
      path: "/api/auth/github/callback",
      handler: async (request) => {
        const url = new URL(request.url);
        const state = url.searchParams.get("state") ?? "";
        const purpose = state && state === cookie(request, STATE_COOKIE) ? trips.take(state) : undefined;
        const tell = (message: GitHubResult) => popupEnd(message);
        if (!purpose) return tell({ error: "That GitHub round trip is used or too old. Try again." });
        if (url.searchParams.has("error")) return tell({ error: "GitHub was told no." });
        try {
          const user = await whoOnGitHub(config, world, url.searchParams.get("code") ?? "");
          if (purpose === "link") {
            await account.update((document) => {
              document.github = user;
            });
            return tell({ linked: user.login });
          }
          const owner = (await account.read()).github;
          if (owner?.id !== user.id) return tell({ error: `${user.login} on GitHub is not the owner of this site.` });
          return tell({ login: login() });
        } catch (error) {
          console.error("press: GitHub:", error);
          return tell({ error: "GitHub did not say who you are. Try again." });
        }
      },
    },
  ];

  return { routes, loggedIn };
}

/** What the GitHub popup tells the page. */
export type GitHubResult = { login: Login } | { linked: string } | { error: string };

/** The GitHub account behind an OAuth `code`. The token that tells is given back at once. */
async function whoOnGitHub(config: Config, world: World, code: string): Promise<{ id: number; login: string }> {
  const { clientId, clientSecret } = config.github!;
  const exchanged = await world.fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: `${config.site}/api/auth/github/callback` }),
  });
  const { access_token: token } = (await exchanged.json()) as { access_token?: string };
  if (!token) throw new Error(`no token (HTTP ${exchanged.status})`);
  const api = { accept: "application/vnd.github+json", "user-agent": "press", "x-github-api-version": "2022-11-28" };
  try {
    const answer = await world.fetch("https://api.github.com/user", { headers: { ...api, authorization: `Bearer ${token}` } });
    const { id, login } = (await answer.json()) as { id?: number; login?: string };
    if (typeof id !== "number" || !login) throw new Error(`no user (HTTP ${answer.status})`);
    return { id, login };
  } finally {
    await world
      .fetch(`https://api.github.com/applications/${clientId}/token`, {
        method: "DELETE",
        headers: { ...api, authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}` },
        body: JSON.stringify({ access_token: token }),
      })
      .catch(() => {});
  }
}

/** The popup's last page: tells the site's pages how it went, then closes. */
function popupEnd(message: GitHubResult): Response {
  const data = JSON.stringify(message).replace(/</g, "\\u003c");
  const said = "error" in message ? message.error : "Done. This window closes itself.";
  const html = `<!doctype html>
<meta charset="utf-8">
<meta name="color-scheme" content="dark">
<title>GitHub</title>
<p style="font: 15px/1.6 ui-monospace, monospace; margin: 2rem">${said.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)}</p>
<script>new BroadcastChannel(${JSON.stringify(CHANNEL)}).postMessage(${data}); setTimeout(close, ${"error" in message ? 4000 : 300});</script>
`;
  const headers = new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  headers.append("set-cookie", `${STATE_COOKIE}=; Path=/api/auth/github; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
  return new Response(html, { headers });
}
