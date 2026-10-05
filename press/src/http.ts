// Routes as functions from a Request to a Response, the web's own types, so
// a test calls them directly; serve() puts them behind node:http.

import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";

export type Handler = (request: Request, params: Record<string, string>) => Response | Promise<Response>;

export interface Route {
  method: string;
  /** "/api/auth/passkeys/:id": a colon marks a part that becomes a parameter. */
  path: string;
  handler: Handler;
}

/** Something to tell the caller, with an HTTP status: thrown, it becomes the response. */
export class Refusal extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const json = (body: unknown, init: ResponseInit = {}) => Response.json(body, init);

/** The request's JSON body, refused past `limit` bytes. */
export async function body<T>(request: Request, limit = 64 << 10): Promise<T> {
  const text = await read(request, limit);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Refusal(400, "The request is not JSON.");
  }
}

async function read(request: Request, limit: number): Promise<string> {
  if (Number(request.headers.get("content-length") ?? 0) > limit) throw new Refusal(413, "Too large.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request.body ?? []) {
    size += chunk.length;
    if (size > limit) throw new Refusal(413, "Too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The value of cookie `name` in the request, if it has one. */
export function cookie(request: Request, name: string): string | undefined {
  for (const pair of request.headers.get("cookie")?.split(";") ?? []) {
    const [key, ...value] = pair.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

/** One function for all the routes: the first whose method and path match answers. */
export function router(routes: Route[]): (request: Request) => Promise<Response> {
  const compiled = routes.map(({ method, path, handler }) => ({ method, parts: path.split("/"), handler }));
  return async (request) => {
    const parts = new URL(request.url).pathname.split("/");
    let allowed = false;
    for (const route of compiled) {
      const params = match(route.parts, parts);
      if (!params) continue;
      if (route.method !== request.method) {
        allowed = true;
        continue;
      }
      try {
        return await route.handler(request, params);
      } catch (error) {
        if (error instanceof Refusal) return json({ error: error.message }, { status: error.status });
        console.error(`press: ${request.method} ${new URL(request.url).pathname}:`, error);
        return json({ error: "Something went wrong on the server." }, { status: 500 });
      }
    }
    return allowed ? json({ error: "Not like that." }, { status: 405 }) : json({ error: "Nothing here." }, { status: 404 });
  };
}

function match(pattern: string[], parts: string[]): Record<string, string> | undefined {
  if (pattern.length !== parts.length) return undefined;
  const params: Record<string, string> = {};
  for (const [i, want] of pattern.entries()) {
    const part = parts[i]!;
    if (want.startsWith(":")) {
      if (!part) return undefined;
      params[want.slice(1)] = decodeURIComponent(part);
    } else if (want !== part) return undefined;
  }
  return params;
}

/** Serves `app` on node:http. Behind nginx, which says where requests came from. */
export function serve(app: (request: Request) => Promise<Response>, port: number, host: string): Server {
  return createServer(async (incoming, outgoing) => {
    const method = incoming.method ?? "GET";
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      for (const each of [value ?? []].flat()) headers.append(name, each);
    }
    const request = new Request(new URL(incoming.url ?? "/", "http://press"), {
      method,
      headers,
      ...(method !== "GET" && method !== "HEAD" && { body: Readable.toWeb(incoming) as ReadableStream, duplex: "half" }),
    });
    const response = await app(request);
    const out: Record<string, string | string[]> = Object.fromEntries(response.headers);
    const cookies = response.headers.getSetCookie();
    if (cookies.length) out["set-cookie"] = cookies;
    outgoing.writeHead(response.status, out);
    if (response.body) Readable.fromWeb(response.body as import("node:stream/web").ReadableStream).pipe(outgoing);
    else outgoing.end();
  }).listen(port, host);
}
