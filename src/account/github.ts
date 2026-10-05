// GitHub, the way back in from a device without a passkey. It opens in a
// window of its own, a popup on a computer and a tab on a phone, so this page
// and the machine in it stay put; on a phone, the visitor's tap on the
// offered key is what lets it open (gesture.ts). press's last page there
// (press/src/auth.ts) says how it went over a BroadcastChannel, and also
// leaves its word in localStorage (login.ts), for this page if it was frozen
// meanwhile, or for the page that replaced it.

import { LogIn } from "lucide-react";
import { No } from "../ask.ts";
import { gesture, NeedsTouch } from "../gesture.ts";
import { API, api } from "./api.ts";
import { current, type GitHubWord, keep, type Login, takeWord } from "./login.ts";

/** How long to wait for GitHub and the visitor, in milliseconds: a little under the guest's own wait. */
const PATIENCE = 280_000;
const CHANNEL = "press-github";

/** Logs in as the GitHub account linked to the site. */
export async function logIn(): Promise<Login> {
  const word = await trip(Promise.resolve(`${API}/auth/github`));
  if (!("login" in word)) throw new No("error" in word ? word.error : "GitHub said something else.");
  keep(word.login);
  return word.login;
}

/** Links the GitHub account the visitor signs in as; logged in already. The account's name. */
export async function link(): Promise<string> {
  const word = await trip(api<{ url: string }>("POST", "/auth/github/link").then(({ url }) => url));
  if (!("linked" in word)) throw new No("error" in word ? word.error : "GitHub said something else.");
  return word.linked;
}

/** A window sent to `url` once it is known; press's word from its last page. */
async function trip(url: Promise<string>): Promise<GitHubWord> {
  const before = current()?.token;
  // Opened blank and at once, within the touch that allows it; sent on when
  // the address is known.
  const opened = await gesture("Continue with GitHub", LogIn, () => {
    const opened = window.open("about:blank", "github", "popup,width=520,height=720");
    if (!opened) throw new NeedsTouch();
    return opened;
  }).catch((error) => {
    throw error instanceof NeedsTouch ? new No("The browser blocked the GitHub window: allow pop-ups for this site.") : error;
  });
  try {
    opened.location.href = await url;
    return await word(before);
  } catch (error) {
    opened.close();
    throw error;
  }
}

/**
 * press's word: as it is told, or as this page finds it left when it is in
 * view again. A login that arrived some other way (taken from where it was
 * left by another part of this page) counts too.
 */
function word(before: string | undefined): Promise<GitHubWord> {
  const { promise, resolve, reject } = Promise.withResolvers<GitHubWord>();
  const any = (word: GitHubWord): word is GitHubWord => !!word;
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = ({ data }: MessageEvent<GitHubWord>) => {
    takeWord(any); // told: what was left is the same word
    resolve(data);
  };
  const look = () => {
    const left = takeWord(any);
    const now = current();
    if (left) resolve(left);
    else if (now && now.token !== before) resolve({ login: now });
  };
  addEventListener("storage", look);
  document.addEventListener("visibilitychange", look);
  const timeout = setTimeout(() => reject(new No("No word from GitHub.")), PATIENCE);
  return promise.finally(() => {
    clearTimeout(timeout);
    channel.close();
    removeEventListener("storage", look);
    document.removeEventListener("visibilitychange", look);
  });
}
