// The owner's login, as press issued it (press/src/tokens.ts): a token to
// show press and the relay, the key that opens the relay's channel, and when
// both expire. Kept in this browser until then, or until `net logout`.

export interface Login {
  token: string;
  /** base64url. */
  key: string;
  /** Unix seconds. */
  expires: number;
}

const STORE = "login";

/** This visit's own copy: all there is when the browser keeps nothing (a private window). */
let held: Login | undefined;

/** The login, unless there is none or it has expired. Another tab's counts too. */
export function current(): Login | undefined {
  let kept = held;
  try {
    kept = (JSON.parse(localStorage.getItem(STORE) ?? "null") as Login | null) ?? undefined;
  } catch {
    // Nothing kept; this visit's copy stands.
  }
  return kept && kept.expires > Date.now() / 1000 ? kept : undefined;
}

/** Keeps `login`, or forgets the one kept. */
export function keep(login: Login | undefined) {
  held = login;
  try {
    if (login) localStorage.setItem(STORE, JSON.stringify(login));
    else localStorage.removeItem(STORE);
  } catch {
    // Refused: this visit's copy will do.
  }
}
