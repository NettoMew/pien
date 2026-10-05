// Logging in, end to end in a real browser (lib/site.ts): a relay and press
// with fresh keys and an empty account, and Chrome's virtual authenticator
// holding the passkeys. In the guest: the first passkey, with a code from
// `press enroll`; out and back in; the list; online through this site's relay
// with the login; through a relay of one's own with its key, and turned away
// with a wrong one; and a question the guest's commands did not ask, ignored.
//
//   npm run build && npm run check:login
//
// The relay is built first if need be (cargo, relay/).

import { randomBytes } from "node:crypto";
import { Checks } from "./lib/guest.ts";
import { step } from "./lib/log.ts";
import { RELAY, site } from "./lib/site.ts";

const checks = new Checks();
const check = checks.check.bind(checks);

step("the relay, press and the site");
const { run, type, enrolmentCode, ownKey, close } = await site({ relay: true });

step("the first passkey, with a code from the server");
let said = await run("net passkey add laptop", ["Code:"]);
check("asks for the server's code", said.includes("press enroll"));
said = await type(enrolmentCode(), ["Added", "wrong", "Cancelled"]);
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

await close();
checks.done();
