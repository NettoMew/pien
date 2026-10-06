import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configure } from "../src/config.ts";

/** press's environment, with a session key of its own, and `more`. */
async function env(more: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "press-config-"));
  await writeFile(join(dir, "session.key"), randomBytes(32).toString("hex"));
  return { PRESS_DATA: dir, PRESS_SESSION_KEY_FILE: join(dir, "session.key"), ...more };
}

test("passkeys belong to the site's host, or to a domain above it", async () => {
  assert.equal((await configure(await env({ PRESS_SITE: "https://www.arc.moe" }))).rpId, "www.arc.moe");
  const moved = await configure(await env({ PRESS_SITE: "https://www.arc.moe", PRESS_RP_ID: "arc.moe" }));
  assert.deepEqual([moved.site, moved.rpId], ["https://www.arc.moe", "arc.moe"]);
  await assert.rejects(configure(await env({ PRESS_SITE: "https://www.arc.moe", PRESS_RP_ID: "example.com" })), /PRESS_RP_ID/);
  await assert.rejects(configure(await env({ PRESS_SITE: "https://www.arc.moe", PRESS_RP_ID: "c.moe" })), /PRESS_RP_ID/);
});
