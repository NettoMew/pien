// press: the site's side of logging in (auth.ts), and of writing from inside
// the machine (writing.ts). Configured by its environment (config.ts).
//
//   node src/main.ts           serves the API on PRESS_LISTEN, behind nginx's /api/
//   node src/main.ts enroll    prints a one-time code for the first passkey,
//                              which `net passkey add` in the machine asks for

import { join } from "node:path";
import { type Account, auth, emptyAccount, enrol, enrolmentCode } from "./auth.ts";
import { configure } from "./config.ts";
import { router, serve } from "./http.ts";
import { Store } from "./store.ts";
import { writing } from "./writing.ts";

const config = await configure();
const account = new Store<Account>(join(config.data, "account.json"), emptyAccount);
const now = () => Math.floor(Date.now() / 1000);

if (process.argv[2] === "enroll") {
  const code = enrolmentCode();
  await enrol(account, code, now());
  console.log(`${code}\n\nGood once, for 15 minutes: in the machine, net passkey add, and type it when asked.`);
} else {
  const { routes, mustBeLoggedIn } = auth(config, account, { now, fetch });
  const site = { base: "/", url: config.site };
  const writes = config.writing && writing(config.writing, site, mustBeLoggedIn);
  await writes?.open();
  const server = serve(router([...routes, ...(writes?.routes ?? [])]), config.listen.port, config.listen.host);
  server.on("listening", () => console.log(`press: listening on ${config.listen.host}:${config.listen.port} for ${config.origins.join(", ")}`));
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => server.close(() => process.exit(0)));
}
