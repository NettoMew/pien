// press's API (press/), as the page calls it: JSON both ways, the login as a
// bearer token, and press's refusals as the guest's Nos.

import { No } from "../ask.ts";
import { current } from "./login.ts";

/** press, behind the site's /api/ (deploy/nginx.conf; vite.config.ts in development). */
export const API = `${import.meta.env.BASE_URL}api`;

/** What press said no with: its words for the guest, and its HTTP status. */
export class Refused extends No {
  readonly http: number;
  constructor(message: string, http: number) {
    super(message);
    this.http = http;
  }
}

/** Calls press with `json` as the body, or with `data`, a picture's bytes, say. */
export async function api<T>(method: string, path: string, json?: unknown, data?: Uint8Array<ArrayBuffer>): Promise<T> {
  const login = current();
  const headers = new Headers();
  if (json !== undefined) headers.set("content-type", "application/json");
  else if (data) headers.set("content-type", "application/octet-stream");
  if (login) headers.set("authorization", `Bearer ${login.token}`);
  const body = json !== undefined ? JSON.stringify(json) : data;
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, { method, headers, ...(body !== undefined && { body }) });
  } catch {
    throw new No("Cannot reach the site's server.");
  }
  const answer = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Refused(answer.error ?? `The site's server answered ${response.status}.`, response.status);
  return answer;
}
