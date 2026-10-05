// GitHub, the way back in from a device without a passkey. It runs in a
// popup, so this page and the machine in it stay put; press's last page in
// the popup says how it went over a BroadcastChannel, which reaches this page
// however GitHub's pages had the popup cut off from it.

import { No } from "../ask.ts";
import { API, api } from "./api.ts";
import { keep, type Login } from "./login.ts";

/** What press's last page says (press/src/auth.ts). */
type Result = { login: Login } | { linked: string } | { error: string };

/** How long to wait for GitHub and the visitor, in milliseconds: a little under the guest's own wait. */
const PATIENCE = 280_000;

/** Logs in as the GitHub account linked to the site. */
export async function logIn(): Promise<Login> {
  const result = await popup(Promise.resolve(`${API}/auth/github`));
  if (!("login" in result)) throw new No("error" in result ? result.error : "GitHub said something else.");
  keep(result.login);
  return result.login;
}

/** Links the GitHub account the visitor signs in as; logged in already. The account's name. */
export async function link(): Promise<string> {
  const result = await popup(api<{ url: string }>("POST", "/auth/github/link").then(({ url }) => url));
  if (!("linked" in result)) throw new No("error" in result ? result.error : "GitHub said something else.");
  return result.linked;
}

/** A popup sent to `url` once it is known; what press's last page in it says. */
async function popup(url: Promise<string>): Promise<Result> {
  // Opened at once, blank, while the key press that asked is fresh enough
  // for the browser to allow a window; sent on when the address is known.
  const opened = window.open("about:blank", "github", "popup,width=520,height=720");
  if (!opened) throw new No("The browser blocked the GitHub window: allow pop-ups for this site.");
  const channel = new BroadcastChannel("press-github");
  try {
    opened.location.href = await url;
    return await new Promise<Result>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new No("No word from GitHub.")), PATIENCE);
      channel.onmessage = ({ data }: MessageEvent<Result>) => {
        clearTimeout(timeout);
        resolve(data);
      };
    });
  } catch (error) {
    opened.close();
    throw error;
  } finally {
    channel.close();
  }
}
