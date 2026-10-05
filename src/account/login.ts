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

/** What press's last page of a GitHub round trip says (press/src/auth.ts). */
export type GitHubWord = { login: Login } | { linked: string } | { error: string };

const STORE = "login";
/**
 * Where press's last GitHub page also leaves its word, for a page that was
 * frozen while the visitor was at GitHub, or thrown away and loaded anew.
 */
const LEFT = "github";
/** How long word left there stays good, in milliseconds. */
const FRESH = 10 * 60_000;

/** This visit's own copy: all there is when the browser keeps nothing (a private window). */
let held: Login | undefined;

/** The login, unless there is none or it has expired. Another tab's counts too, and one GitHub left. */
export function current(): Login | undefined {
  const left = takeWord((word): word is { login: Login } => "login" in word);
  if (left) keep(left.login);
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

/** press's GitHub word, if fresh word of the kind `wanted` was left; taken, so that it counts once. */
export function takeWord<T extends GitHubWord>(wanted: (word: GitHubWord) => word is T): T | undefined {
  try {
    const left = JSON.parse(localStorage.getItem(LEFT) ?? "null") as (GitHubWord & { at: number }) | null;
    if (!left) return undefined;
    const { at, ...word } = left;
    if (Date.now() - at > FRESH) localStorage.removeItem(LEFT);
    else if (wanted(word)) {
      localStorage.removeItem(LEFT);
      return word;
    }
  } catch {
    // Nothing a page may read: nothing left.
  }
  return undefined;
}
