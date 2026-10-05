// The site as it runs on the server, here, for the checks that need all of it
// in a real browser (check-login.ts, check-writing.ts): press with fresh keys
// and an empty account, a relay and a stand-in GitHub if asked for, the
// built site in `vite preview` in front of them as nginx is on the server,
// and Chrome with its virtual authenticator holding the passkeys. Then the
// terminal, to type into and read back, on a computer or on a phone.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowserContext, chromium, devices, type Page } from "playwright-core";
import { CONTENT } from "./content.ts";
import { info } from "./log.ts";

const ROOT = join(import.meta.dirname, "../..");
const PORTS = { site: 4174, press: 18096, relay: 18095 };
export const SITE = `http://localhost:${PORTS.site}`;
export const RELAY = `ws://127.0.0.1:${PORTS.relay}/`;
/** Who the stand-in GitHub says is signed in. */
export const GITHUB_USER = "owner-on-github";

type Until = (string | RegExp)[];

/** Starts `command`, and waits until it says `ready`; stopped when this process ends. */
async function start(name: string, command: string, args: string[], ready: RegExp, env: Record<string, string> = {}) {
  const child: ChildProcess = spawn(command, args, { cwd: ROOT, env: { ...process.env, ...env } });
  process.on("exit", () => child.kill());
  await new Promise<void>((resolve, reject) => {
    let said = "";
    const listen = (chunk: Buffer) => {
      said += chunk;
      if (ready.test(said)) resolve();
    };
    child.stdout!.on("data", listen);
    child.stderr!.on("data", listen);
    child.on("exit", (code) => reject(new Error(`${name} stopped (${code}): ${said}`)));
  });
  info(`${name} is up`);
}

/**
 * GitHub as far as press uses it: a visitor who approves at once, the token
 * for the code, who that is, and the token given back. Its address.
 */
async function standInGitHub(): Promise<string> {
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://github");
    if (url.pathname === "/login/oauth/authorize") {
      const back = new URL(url.searchParams.get("redirect_uri")!);
      back.search = new URLSearchParams({ code: "approved", state: url.searchParams.get("state")! }).toString();
      response.writeHead(302, { location: back.href }).end();
    } else if (url.pathname === "/login/oauth/access_token") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "gho_stand_in" }));
    } else if (url.pathname === "/user") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: 4242, login: GITHUB_USER }));
    } else response.writeHead(204).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.on("exit", () => server.close());
  info("a stand-in GitHub is up");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The terminal on `page`, to type into and read back. */
function terminal(page: Page) {
  page.on("pageerror", (error) => console.error("page error:", error.message));
  // What the page logs as wrong, but for the lookups that are meant to miss.
  page.on("console", (message) => message.type() === "error" && !message.text().startsWith("Failed to load resource") && console.error("page:", message.text()));

  const screen = () => page.evaluate(() => (document.querySelector(".xterm-rows")?.textContent ?? "").trimEnd());

  /** Waits for any of `until` in what the screen shows past its first `from` characters; that, when it does. */
  async function wait(until: Until, timeout = 30e3, from = 0): Promise<string> {
    const started = Date.now();
    let text = "";
    while (Date.now() - started < timeout) {
      text = (await screen()).slice(from);
      if (until.some((want) => (typeof want === "string" ? text.includes(want) : want.test(text)))) break;
      await page.waitForTimeout(100);
    }
    return text;
  }

  /** Types `line` and Enter, then waits for any of `until` in what the screen shows after it; that, when it does. */
  async function type(line: string, until: Until, timeout = 30e3): Promise<string> {
    const before = (await screen()).length;
    await page.keyboard.type(line, { delay: 10 });
    await page.keyboard.press("Enter");
    return wait(until, timeout, before);
  }

  /** Clears the screen, once the last command is done, then runs `command` as type() does. */
  async function run(command: string, until: Until, timeout?: number): Promise<string> {
    for (let tries = 0; (await screen()).replace(/\s+/g, " ").trim().length > 40; tries++) {
      if (tries === 100) throw new Error(`the prompt never came back: ${await screen()}`);
      await page.keyboard.press("Control+L");
      await page.waitForTimeout(300);
    }
    return type(command, until, timeout);
  }

  /** Loads the page, or loads it again: a machine fresh from its snapshot. */
  async function open() {
    await page.goto(SITE);
    await page.waitForSelector("[data-state=running]", { timeout: 60e3 });
    await page.waitForTimeout(500); // the terminal takes focus a moment after
  }

  return { page, screen, wait, type, run, open };
}

/** A passkey in Chrome's virtual authenticator, for `page`'s context. */
async function authenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
  });
}

/**
 * A phone's strictness, in a browser that has none: a window opens, and the
 * page counts as touched, only within a tap itself, as on iOS. Applied to a
 * context before its pages load.
 */
async function strictAsAPhone(context: BrowserContext) {
  await context.addInitScript(() => {
    let tapping = false;
    addEventListener(
      "click",
      () => {
        tapping = true;
        setTimeout(() => (tapping = false));
      },
      true,
    );
    const open = window.open.bind(window);
    window.open = (...args) => (tapping ? open(...args) : null);
    Object.defineProperty(navigator, "userActivation", { get: () => ({ isActive: tapping, hasBeenActive: true }) });
  });
}

/**
 * Starts it all. With `relay`, a relay that takes both the site's logins and
 * a key of its own; with `github`, a stand-in GitHub press logs in through;
 * with `writing`, press keeps the writing too, a store seeded from content/
 * like the image, so the two start out the same.
 */
export async function site({ relay = false, github = false, writing = false } = {}) {
  const data = await mkdtemp(join(tmpdir(), "check-site-"));
  const [sessionKey, ownKey] = [randomBytes(32).toString("hex"), randomBytes(32).toString("hex")];
  await writeFile(join(data, "session.key"), sessionKey);
  await writeFile(join(data, "github.secret"), "stand-in");
  const githubAt = github ? await standInGitHub() : undefined;
  const pressEnv: Record<string, string> = {
    PRESS_SITE: SITE,
    PRESS_LISTEN: `127.0.0.1:${PORTS.press}`,
    PRESS_DATA: join(data, "press"),
    PRESS_SESSION_KEY_FILE: join(data, "session.key"),
    ...(githubAt && {
      PRESS_GITHUB_CLIENT_ID: "stand-in",
      PRESS_GITHUB_SECRET_FILE: join(data, "github.secret"),
      PRESS_GITHUB_URL: githubAt,
      PRESS_GITHUB_API: githubAt,
    }),
    ...(writing && { PRESS_CONTENT: join(data, "store"), PRESS_PUBLIC: join(data, "public"), PRESS_DIST: join(ROOT, "dist") }),
  };
  if (writing) await cp(CONTENT, join(data, "store"), { recursive: true });

  if (relay) {
    execFileSync("cargo", ["build", "--release", "--quiet", "--manifest-path", "relay/Cargo.toml"], { cwd: ROOT, stdio: "inherit" });
    await writeFile(join(data, "relay.toml"), `listen = "127.0.0.1:${PORTS.relay}"\nkey = "${ownKey}"\nsession_key = "${sessionKey}"\n`);
    await start("the relay", join(ROOT, "relay/target/release/relay"), [join(data, "relay.toml")], /listening/);
  }
  await start("press", process.execPath, ["press/src/main.ts"], /listening/, pressEnv);
  await start("the site", process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--port", String(PORTS.site), "--strictPort"], /localhost/, {
    PRESS: `127.0.0.1:${PORTS.press}`,
    RELAY: `127.0.0.1:${PORTS.relay}`,
  });

  const browser = await chromium.launch({ channel: process.env.BROWSER ?? "chrome" });
  const computer = terminal(await browser.newPage());
  await authenticator(computer.page);
  await computer.open();

  /** A phone beside the computer, as strict as one: a browser of its own, so logged in only if it logs in. */
  async function phone() {
    const context = await browser.newContext({ ...devices["Pixel 7"] });
    await strictAsAPhone(context);
    const phone = terminal(await context.newPage());
    await authenticator(phone.page);
    await phone.open();
    return phone;
  }

  /** A one-time code for the first passkey, as `press enroll` prints it. */
  const enrolmentCode = () =>
    execFileSync(process.execPath, ["press/src/main.ts", "enroll"], { cwd: ROOT, env: { ...process.env, ...pressEnv } })
      .toString()
      .split("\n")[0]!;

  return { ...computer, phone, data, ownKey, enrolmentCode, close: () => browser.close() };
}
