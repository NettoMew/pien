// Logging in, end to end in a real browser (lib/site.ts): a relay and press
// with fresh keys and an empty account, and Chrome's virtual authenticator
// holding the passkeys. In the guest: the first passkey, with a code from
// `press enroll`; out and back in; the list; online through this site's relay
// with the login, IPv6 too; through a relay of one's own with its key, and
// turned away with a wrong one; and a question the guest's commands did not
// ask, ignored.
//
//   npm run build && npm run check:login
//
// The relay is built first if need be (cargo, relay/).

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { Checks } from "./lib/guest.ts";
import { step } from "./lib/log.ts";
import { GITHUB_USER, PRESS6, RELAY, SITE, site } from "./lib/site.ts";

const checks = new Checks();
const check = checks.check.bind(checks);

step("the relay, press, a stand-in GitHub and the site");
const { run, type, enrolmentCode, ownKey, phone, close } = await site({ relay: true, github: true });

step("the first passkey, with a code from the server");
let said = await run("net passkey add laptop", ["Code:"]);
check("asks for the server's code", said.includes("press enroll"));
said = await type(enrolmentCode(), ["Logged in until", "wrong", "Cancelled"]);
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
await new Promise((resolve) => setTimeout(resolve, 500));
said = await run("net", ["net on · net off"]);
check("is ignored: still logged in", said.includes("Logged in until"));

step("online through this site's relay, with the login");
said = await run("net on", ["Try curl", "Offline"], 60e3);
check("online", said.includes("Online through the relay"), said.slice(-120));

step("IPv6 through the relay, an address of the session's own by DHCPv6");
check("an address in the relay's network", said.includes(" and fdca:c697:4c23:"), said.slice(-160));
said = await run("ip -6 addr show dev eth0 scope global; ip -6 route show default; echo list''ed", ["listed"]);
check("held as itself alone, a /128", /inet6 fdca:c697:4c23:[0-9a-f:]+\/128/.test(said), said.slice(-240));
check("the gateway the way out", said.includes("default via fe80::2"), said.slice(-240));
said = await run("ping -6 -c 1 -W 5 fdca:c697:4c23::2", ["packet loss", "ping:"]);
check("the gateway answers", said.includes("1 packets received"), said.slice(-120));
const status = [..."012345"].map((digit) => `HTTP ${digit}`); // not "HTTP ": the command says that
said = await run(`curl -g -s -o /dev/null -w 'HTTP %{http_code}\\n' http://${PRESS6}/`, status, 30e3);
check("a connection through the relay", /HTTP [1-5]\d\d/.test(said), said.slice(-80));
said = await run("ip -6 route show default; echo list''ed", ["listed"]);
check("still the way out, once asked after", said.includes("default via fe80::2"), said.slice(-120));
said = await run("net off", ["Off."]);

step("a relay of one's own");
said = await run(`net relay ${RELAY}`, ["Its key"]);
said = await type(ownKey, ["from now on", "64 hex"]);
check("takes its key", said.includes(`Through ${RELAY} from now on.`), said.slice(-80));
said = await run("net on", ["Try curl", "Offline"], 60e3);
check("online through it", said.includes("Online through the relay"), said.slice(-120));
await run("net off", ["Off."]);

const wrong = RELAY.replace("127.0.0.1", "localhost");
await run(`net relay ${wrong}`, ["Its key"]);
await type(randomBytes(32).toString("hex"), ["from now on"]);
said = await run("net on", ["did not take", "Online"], 60e3);
check("a wrong key is turned away", said.includes("The relay did not take its key"), said.slice(-120));
said = await run("net on", ["needs its key", "Online"], 60e3);
check("… and forgotten", said.includes("Your relay needs its key"), said.slice(-120));

said = await run("net relay reset", ["from now on"]);
said = await run("net", ["net on · net off"]);
check("back to this site's relay", said.includes("Relay: this site's"));

step("GitHub, from a computer, where a window opens at once");
said = await run("net github", ["logs in here now", "Cancelled", "blocked", "No word"], 60e3);
check("links the account", said.includes(`${GITHUB_USER} on GitHub logs in here now`), said.slice(-120));
await run("net logout", ["Logged out."]);
said = await run("net login github", ["Logged in", "Cancelled", "blocked", "not the owner"], 60e3);
check("logs in with it", /Logged in, until \d{4}-\d\d-\d\d/.test(said), said.slice(-120));

step("GitHub on a phone, where a window opens only on a tap");
const handset = await phone();
await handset.run("net login github", ["Log in with GitHub"]);
const offered = handset.page.getByRole("button", { name: "Continue with GitHub" });
await offered.waitFor({ timeout: 15e3 });
check("the screen offers a key", await offered.isVisible());
await handset.page.screenshot({ path: join(import.meta.dirname, "../.cache/smoke/offer-phone.png") });
await offered.tap();
said = await handset.wait(["Logged in", "Cancelled", "blocked"], 60e3);
check("a tap on it logs in", /Logged in, until \d{4}-\d\d-\d\d/.test(said), said.slice(-120));

step("a phone page thrown away while at GitHub");
await handset.run("net logout", ["Logged out."]);
// GitHub in a tab of its own; the page that would have waited for it is gone.
const away = await handset.page.context().newPage();
await away.goto(`${SITE}/api/auth/github`);
await away.waitForURL(/\/api\/auth\/github\/callback/);
await away.close();
await handset.open();
said = await handset.run("net", ["net on · net off"]);
check("the page loaded anew finds the login left for it", said.includes("Logged in until"), said.slice(-120));

await close();
checks.done();
