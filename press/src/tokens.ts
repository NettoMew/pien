// Login tokens: what press hands the page when its owner logs in, and what
// the relay checks on its own (relay/src/token.rs, the same bytes). Nothing
// keeps a list of them: a token is good until it expires, and the session
// key that signs them is the only thing to guard.
//
//   body      version 1 (1) ‖ expiry, Unix seconds (8, big-endian) ‖ id (16, random)
//   token     body ‖ HMAC-SHA256(session key, "guest@home session v1" ‖ body)
//   channel   HMAC-SHA256(session key, "guest@home channel v1" ‖ body)
//
// The channel key opens the relay's channel. The page gets it beside the
// token; the relay derives it from the token. A token seen passing by, in
// a log say, opens no channel.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const VERSION = 1;
const BODY = 1 + 8 + 16;
const LENGTH = BODY + 32;
const SESSION = "guest@home session v1";
const CHANNEL = "guest@home channel v1";

/** How long a login lasts. */
export const LIFETIME = 30 * 24 * 60 * 60;

/** A login, as the page keeps it: the token, its channel key, and when both expire. */
export interface Login {
  token: string;
  key: string;
  /** Unix seconds. */
  expires: number;
}

const mac = (sessionKey: Uint8Array, label: string, body: Uint8Array) =>
  createHmac("sha256", sessionKey).update(label).update(body).digest();

/** A new login, good for LIFETIME from `now` (Unix seconds). */
export function issue(sessionKey: Uint8Array, now: number, id: Uint8Array = randomBytes(16)): Login {
  const expires = now + LIFETIME;
  const body = Buffer.alloc(BODY);
  body[0] = VERSION;
  body.writeBigUInt64BE(BigInt(expires), 1);
  body.set(id, 9);
  return {
    token: Buffer.concat([body, mac(sessionKey, SESSION, body)]).toString("base64url"),
    key: mac(sessionKey, CHANNEL, body).toString("base64url"),
    expires,
  };
}

/** When `token` expires, if the session key made it and it has not yet at `now`. */
export function verify(sessionKey: Uint8Array, token: string, now: number): number | undefined {
  const bytes = Buffer.from(token, "base64url");
  if (bytes.length !== LENGTH || bytes.toString("base64url") !== token) return undefined;
  const body = bytes.subarray(0, BODY);
  if (!timingSafeEqual(bytes.subarray(BODY), mac(sessionKey, SESSION, body)) || body[0] !== VERSION) return undefined;
  const expires = Number(body.readBigUInt64BE(1));
  return now < expires ? expires : undefined;
}
