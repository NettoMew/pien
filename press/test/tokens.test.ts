import assert from "node:assert/strict";
import { test } from "node:test";
import { issue, LIFETIME, verify } from "../src/tokens.ts";

const key = Uint8Array.from({ length: 32 }, (_, i) => i);
const now = 1_790_000_000;

test("the same bytes as the relay (relay/src/token.rs)", () => {
  const id = Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i);
  const login = issue(key, 2_000_000_000 - LIFETIME, id);
  assert.equal(
    Buffer.from(login.token, "base64url").toString("hex"),
    "01" + "0000000077359400" + "a0a1a2a3a4a5a6a7a8a9aaabacadaeaf" + "cab540784ee16f9fa56bac71966d409539bc2097cc148c8fd6a108590de1c127",
  );
  assert.equal(Buffer.from(login.key, "base64url").toString("hex"), "35f7a8c0e5731324e0e6f63709195a237b4857755c87d7e663791af728fda40d");
  assert.equal(login.expires, 2_000_000_000);
});

test("a token is good until it expires, and only with its key", () => {
  const { token, expires } = issue(key, now);
  assert.equal(verify(key, token, now), expires);
  assert.equal(verify(key, token, expires - 1), expires);
  assert.equal(verify(key, token, expires), undefined);
  assert.equal(verify(new Uint8Array(32), token, now), undefined);
});

test("a changed token is no token", () => {
  const { token } = issue(key, now);
  const bytes = Buffer.from(token, "base64url");
  for (const at of [0, 1, 9, 24, 25, bytes.length - 1]) {
    const forged = Buffer.from(bytes);
    forged[at]! ^= 1;
    assert.equal(verify(key, forged.toString("base64url"), now), undefined, `byte ${at}`);
  }
  assert.equal(verify(key, token.slice(1), now), undefined);
  assert.equal(verify(key, `${token}A`, now), undefined);
  assert.equal(verify(key, "", now), undefined);
});
