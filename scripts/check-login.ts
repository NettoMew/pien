// Logging in, end to end in a real browser. A relay and press run here with
// fresh keys and an empty account, the built site in `vite preview` in front
// of them, and Chrome's virtual authenticator holds the passkeys. In the
// guest: the first passkey, with a code from `press enroll`; out and back
// in; the list; online through this site's relay with the login; through a
// relay of one's own with its key, and turned away with a wrong one; and a
// question the guest's commands did not ask, ignored.
//
//   npm run build && npm run check:login
//
// The relay is built first if need be (cargo, relay/).

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { Checks } from "./lib/guest.ts";
import { info, step } from "./lib/log.ts";

const ROOT = join(import.meta.dirname, "..");
const PORTS = { site: 4174, press: 18096, relay: 18095 };
const SITE = `http://localhost:${PORTS.site}`;

const checks = new Checks();
const check = checks.check.bind(checks);
const children: ChildProcess[] = [];
const quit = () => children.forEach((child) => child.kill());
process.on("exit", quit);

/** Starts `command`, and waits until it prints `ready`. */
async function start(name: string, command: string, args: string[], ready: RegExp, env: Record<string, string> = {}) {
  const child = spawn(command, args, { cwd: ROOT, env: { ...process.env, ...env } });
  children.push(child);
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

step("the relay, press and the site");
execFileSync("cargo", ["build", "--release", "--quiet", "--manifest-path", "relay/Cargo.toml"], { cwd: ROOT, stdio: "inherit" });
const data = await mkdtemp(join(tmpdir(), "check-login-"));
const [sessionKey, ownKey] = [randomBytes(32).toString("hex"), randomBytes(32).toString("hex")];
await writeFile(join(data, "session.key"), sessionKey);
await writeFile(join(data, "relay.toml"), `listen = "127.0.0.1:${PORTS.relay}"\nkey = "${ownKey}"\nsession_key = "${sessionKey}"\n`);
const pressEnv = {
  PRESS_SITE: SITE,
  PRESS_LISTEN: `127.0.0.1:${PORTS.press}`,
  PRESS_DATA: data,
  PRESS_SESSION_KEY_FILE: join(data, "session.key"),
};
await start("the relay", join(ROOT, "relay/target/release/relay"), [join(data, "relay.toml")], /listening/);
await start("press", process.execPath, ["press/src/main.ts"], /listening/, pressEnv);
await start("the site", process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--port", String(PORTS.site), "--strictPort"], /localhost/, {
  PRESS: `127.0.0.1:${PORTS.press}`,
  RELAY: `127.0.0.1:${PORTS.relay}`,
});

const browser = await chromium.launch({ channel: process.env.BROWSER ?? "chrome" });
const page = await browser.newPage();
page.on("pageerror", (error) => console.error("page error:", error.message));
const cdp = await page.context().newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
});
await page.goto(SITE);
await page.waitForSelector("[data-state=running]", { timeout: 60e3 });

page.on("console", (message) => message.type() === "error" && console.error("page:", message.text()));

const screen = () => page.evaluate(() => (document.querySelector(".xterm-rows")?.textContent ?? "").trimEnd());

/**
 * Types `line` and Enter, then waits for any of `until` in what the screen
 * shows after it; that, when it does.
 */
async function type(line: string, until: (string | RegExp)[], timeout = 30e3): Promise<string> {
  const before = (await screen()).length;
  await page.keyboard.type(line, { delay: 10 });
  await page.keyboard.press("Enter");
  const started = Date.now();
  let text = "";
  while (Date.now() - started < timeout) {
    text = (await screen()).slice(before);
    if (until.some((want) => (typeof want === "string" ? text.includes(want) : want.test(text)))) break;
    await page.waitForTimeout(100);
  }
  return text;
}

/** Clears the screen, once the last command is done, then runs `command` as type() does. */
async function run(command: string, until: (string | RegExp)[], timeout?: number): Promise<string> {
  for (let tries = 0; (await screen()).replace(/\s+/g, " ").trim().length > 40; tries++) {
    if (tries === 100) throw new Error(`the prompt never came back: ${await screen()}`);
    await page.keyboard.press("Control+L");
    await page.waitForTimeout(300);
  }
  return type(command, until, timeout);
}

step("the first passkey, with a code from the server");
const code = execFileSync(process.execPath, ["press/src/main.ts", "enroll"], { cwd: ROOT, env: { ...process.env, ...pressEnv } })
  .toString()
  .split("\n")[0]!;
let said = await run("net passkey add laptop", ["Code:"]);
check("asks for the server's code", said.includes("press enroll"));
said = await type(code, ["Added", "wrong", "Cancelled"]);
check("adds the passkey, and logs in", said.includes("Added laptop") && said.includes("Logged in until"), said.slice(-80));

step("out, and back in");
said = await run("net logout", ["Logged out."]);
said = await run("net", ["net on · net off"]);
check("logged out", said.includes("Not logged in."));
said = await run("net login", ["Logged in", "Cancelled", "not"]);
check("logs in with the passkey", /Logged in, until \d{4}-\d\d-\d\d/.test(said), said.slice(-80));
said = await run("net passkey", ["remove <n>"]);
check("lists it", said.includes("laptop") && said.includes("made") && said.includes("GitHub: not linked"), said.slice(-160));

step("a question the guest's commands did not ask");
await run("printf '\\e]7337;ask;0123456789abcdef0123456789abcdef;1;net;logout\\a'; echo print''ed", ["printed"]);
await page.waitForTimeout(500);
said = await run("net", ["net on · net off"]);
check("is ignored: still logged in", said.includes("Logged in until"));

step("online through this site's relay, with the login");
said = await run("net on", ["Try curl", "Offline"], 60e3);
check("online", said.includes("Online through the relay"), said.slice(-120));
said = await run("net off", ["Off."]);

step("a relay of one's own");
const own = `ws://127.0.0.1:${PORTS.relay}/`;
said = await run(`net relay ${own}`, ["Its key"]);
said = await type(ownKey, ["from now on", "64 hex"]);
check("takes its key", said.includes(`Through ${own} from now on.`), said.slice(-80));
said = await run("net on", ["Try curl", "Offline"], 60e3);
check("online through it", said.includes("Online through the relay"), said.slice(-120));
await run("net off", ["Off."]);

const wrong = `ws://localhost:${PORTS.relay}/`;
await run(`net relay ${wrong}`, ["Its key"]);
await type(randomBytes(32).toString("hex"), ["from now on"]);
said = await run("net on", ["did not take", "Online"], 60e3);
check("a wrong key is turned away", said.includes("The relay did not take its key"), said.slice(-120));
said = await run("net on", ["needs its key", "Online"], 60e3);
check("… and forgotten", said.includes("Your relay needs its key"), said.slice(-120));

said = await run("net relay reset", ["from now on"]);
said = await run("net", ["net on · net off"]);
check("back to this site's relay", said.includes("Relay: this site's"));

await browser.close();
quit();
checks.done();
