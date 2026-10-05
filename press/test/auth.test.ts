import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Account, auth, emptyAccount, enrol, type GitHubResult } from "../src/auth.ts";
import type { Config } from "../src/config.ts";
import { router } from "../src/http.ts";
import { Store } from "../src/store.ts";
import { verify } from "../src/tokens.ts";
import { Authenticator } from "./authenticator.ts";

const SITE = "https://arc.moe";
const ALSO = "https://test-demo.arc.moe";

/** press with a fresh account, its own clock, and a pretend GitHub where `who` is logged in. */
async function press() {
  const data = await mkdtemp(join(tmpdir(), "press-"));
  const config: Config = {
    site: SITE,
    origins: [SITE, ALSO],
    rpId: "arc.moe",
    owner: "owner",
    listen: { host: "127.0.0.1", port: 0 },
    data,
    sessionKey: randomBytes(32),
    github: { clientId: "client", clientSecret: "secret" },
  };
  const account = new Store<Account>(join(data, "account.json"), emptyAccount);
  const world = { clock: 1_790_000_000, who: { id: 42, login: "owner-on-github" }, revoked: [] as string[] };
  const github: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://github.com/login/oauth/access_token") {
      const { code } = JSON.parse(String(init?.body)) as { code: string };
      return Response.json(code === "good" ? { access_token: "gho_token" } : { error: "bad_verification_code" });
    }
    if (url === "https://api.github.com/user") return Response.json(world.who);
    if (url.endsWith("/token") && init?.method === "DELETE") world.revoked.push(JSON.parse(String(init.body)).access_token);
    return new Response(null, { status: 204 });
  };
  const app = router(auth(config, account, { now: () => world.clock, fetch: github }).routes);

  const call = async (method: string, path: string, { json, token, cookie }: { json?: unknown; token?: string; cookie?: string } = {}) => {
    const headers = new Headers();
    if (json !== undefined) headers.set("content-type", "application/json");
    if (token) headers.set("authorization", `Bearer ${token}`);
    if (cookie) headers.set("cookie", cookie);
    const response = await app(new Request(`${SITE}${path}`, { method, headers, ...(json !== undefined && { body: JSON.stringify(json) }) }));
    return response;
  };
  /** A response's status and body: a login, a passkey's name, or why not. */
  const answer = async (response: Response) =>
    ({ status: response.status, ...(await response.json()) }) as { status: number; token?: string; key?: string; expires?: number; name?: string; error?: string };

  /** Makes a passkey on `authenticator`, the way `net passkey add` does. */
  const register = async (authenticator: Authenticator, { code, token, origin = SITE }: { code?: string; token?: string; origin?: string }) => {
    const options = await call("POST", "/api/auth/passkey/register/options", { json: { code }, token });
    if (options.status !== 200) return answer(options);
    const response = authenticator.create(await options.json(), origin);
    return answer(await call("POST", "/api/auth/passkey/register", { json: { response, name: "test key", code }, token }));
  };

  /** Logs in with `authenticator`, the way `net login` does. */
  const logIn = async (authenticator: Authenticator, origin = SITE) => {
    const options = await (await call("POST", "/api/auth/passkey/options", { json: {} })).json();
    return answer(await call("POST", "/api/auth/passkey/login", { json: { response: authenticator.get(options, origin) } }));
  };

  return { config, account, world, call, answer, register, logIn };
}

test("the first passkey takes a code from the server, once", async () => {
  const { config, account, world, register } = await press();
  const key = new Authenticator();
  assert.equal((await register(key, {})).status, 401);

  await enrol(account, "ABCD-EFGH-JKLM-NPQR", world.clock);
  const first = await register(key, { code: "abcd efgh jklm npqr" });
  assert.equal(first.status, 200);
  assert.equal(verify(config.sessionKey, first.token!, world.clock), first.expires);
  assert.equal((await register(new Authenticator(), { code: "ABCD-EFGH-JKLM-NPQR" })).status, 401, "used up");
});

test("a code takes five wrong guesses, and fifteen minutes", async () => {
  const { account, world, register } = await press();
  await enrol(account, "ABCD-EFGH-JKLM-NPQR", world.clock);
  for (let i = 0; i < 5; i++) assert.equal((await register(new Authenticator(), { code: "WRONG" })).status, 401);
  assert.equal((await register(new Authenticator(), { code: "ABCD-EFGH-JKLM-NPQR" })).status, 401, "out of guesses");

  await enrol(account, "ABCD-EFGH-JKLM-NPQR", world.clock);
  world.clock += 15 * 60;
  assert.equal((await register(new Authenticator(), { code: "ABCD-EFGH-JKLM-NPQR" })).status, 401, "too old");
});

test("a passkey logs in, from the site or the other origin, and its answer only once", async () => {
  const { config, account, world, register, logIn, call, answer } = await press();
  const key = new Authenticator();
  await enrol(account, "CODE", world.clock);
  await register(key, { code: "CODE" });

  const login = await logIn(key);
  assert.equal(login.status, 200);
  assert.equal(verify(config.sessionKey, login.token!, world.clock), login.expires);
  assert.equal((await logIn(key, ALSO)).status, 200);
  assert.equal((await logIn(key, "https://evil.example")).status, 401);
  assert.equal((await logIn(new Authenticator())).status, 401, "a passkey the site does not know");

  const options = await (await call("POST", "/api/auth/passkey/options", { json: {} })).json();
  const response = key.get(options, SITE);
  assert.equal((await call("POST", "/api/auth/passkey/login", { json: { response } })).status, 200);
  assert.equal((await answer(await call("POST", "/api/auth/passkey/login", { json: { response } }))).status, 401, "replayed");
});

test("more passkeys need a login; the last way in stays", async () => {
  const { account, world, register, logIn, call } = await press();
  const [laptop, phone] = [new Authenticator(), new Authenticator()];
  await enrol(account, "CODE", world.clock);
  const { token } = await register(laptop, { code: "CODE" });
  assert.equal((await register(phone, {})).status, 401);
  assert.equal((await register(phone, { token })).status, 200);
  assert.equal((await register(phone, { token })).status, 409, "the same passkey twice");

  const list = (await (await call("GET", "/api/auth/passkeys", { token })).json()) as { passkeys: { id: string }[]; github: string | null };
  assert.equal(list.passkeys.length, 2);
  assert.equal(list.github, null);
  assert.equal((await call("GET", "/api/auth/passkeys")).status, 401);

  const [first, second] = list.passkeys;
  assert.equal((await call("DELETE", `/api/auth/passkeys/${first!.id}`, { token })).status, 200);
  assert.equal((await logIn(laptop)).status, 401, "removed");
  assert.equal((await call("DELETE", `/api/auth/passkeys/${second!.id}`, { token })).status, 409, "the only way in");
  assert.equal((await logIn(phone)).status, 200);
});

test("GitHub: linked by a login, then a way in for that account alone", async () => {
  const { config, account, world, register, call } = await press();
  await enrol(account, "CODE", world.clock);
  const { token } = await register(new Authenticator(), { code: "CODE" });

  /** The popup's round trip: to GitHub and back, with the browser's cookie; what it tells the page. */
  const trip = async (start: string, code = "good"): Promise<GitHubResult> => {
    const away = await call("GET", start);
    assert.equal(away.status, 302);
    const to = new URL(away.headers.get("location")!);
    assert.equal(to.origin + to.pathname, "https://github.com/login/oauth/authorize");
    assert.equal(to.searchParams.get("redirect_uri"), `${SITE}/api/auth/github/callback`);
    const state = to.searchParams.get("state")!;
    const cookie = away.headers.getSetCookie()[0]!.split(";")[0]!;
    const back = await call("GET", `/api/auth/github/callback?code=${code}&state=${state}`, { cookie });
    const page = await back.text();
    return JSON.parse(/postMessage\((.*)\); setTimeout/.exec(page)![1]!) as GitHubResult;
  };

  assert.deepEqual(await trip("/api/auth/github"), { error: "owner-on-github on GitHub is not the owner of this site." });
  assert.equal((await call("POST", "/api/auth/github/link")).status, 401);
  const { url } = (await (await call("POST", "/api/auth/github/link", { token })).json()) as { url: string };
  assert.deepEqual(await trip(url), { linked: "owner-on-github" });
  assert.deepEqual((await account.read()).github, { id: 42, login: "owner-on-github" });
  assert.equal((await call("GET", url)).status, 400, "a link is followed once");

  const result = await trip("/api/auth/github");
  assert.ok("login" in result);
  assert.equal(verify(config.sessionKey, result.login.token, world.clock), result.login.expires);
  assert.deepEqual(world.revoked, ["gho_token", "gho_token", "gho_token"], "every token given back");

  world.who = { id: 7, login: "someone-else" };
  assert.deepEqual(await trip("/api/auth/github"), { error: "someone-else on GitHub is not the owner of this site." });
  assert.ok("error" in (await trip("/api/auth/github", "bad")));

  const away = await call("GET", "/api/auth/github");
  const state = new URL(away.headers.get("location")!).searchParams.get("state");
  const page = await (await call("GET", `/api/auth/github/callback?code=good&state=${state}`)).text();
  assert.match(page, /used or too old/, "no cookie, no login: the trip must start in this browser");
});
