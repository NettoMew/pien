// press's API (press/src/auth.ts), as the page calls it: JSON both ways, the
// login as a bearer token, and press's refusals as the guest's Nos.

import { No } from "../ask.ts";
import { current } from "./login.ts";

/** press, behind the site's /api/ (deploy/nginx.conf; vite.config.ts in development). */
export const API = `${import.meta.env.BASE_URL}api`;

export async function api<T>(method: string, path: string, json?: unknown): Promise<T> {
  const login = current();
  const headers = new Headers();
  if (json !== undefined) headers.set("content-type", "application/json");
  if (login) headers.set("authorization", `Bearer ${login.token}`);
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, { method, headers, ...(json !== undefined && { body: JSON.stringify(json) }) });
  } catch {
    throw new No("Cannot reach the site's server.");
  }
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new No(body.error ?? `The site's server answered ${response.status}.`);
  return body;
}
