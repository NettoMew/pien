// The two fixed routes `net warp` needs from the site (docs/warp.md), for
// `vite dev` and `vite preview`. In production websockify and nginx serve them.
//
//   <base>warp/edge   WebSocket ⇄ TCP to the WARP edge, and nowhere else
//   <base>warp/api/   the device registration API, only its own paths
//
// WARP_EDGE overrides the edge (host:port) — say, an SSH forward through a
// machine that can reach it.

import { connect } from "node:net";
import type { IncomingMessage } from "node:http";
import type { Plugin, PreviewServer, ViteDevServer } from "vite";
import { WebSocketServer } from "ws";

const EDGE = process.env.WARP_EDGE ?? "162.159.198.2:443";
const API = "https://api.cloudflareclient.com";
const PATHS = /^\/v0a\d+\/reg(\/[0-9a-f-]{36})?$/;
const FORWARDED = ["authorization", "cf-client-version", "content-type"];

export function warpPipes(): Plugin {
  let base = "/";
  const routes = (server: ViteDevServer | PreviewServer) => {
    const sockets = new WebSocketServer({ noServer: true });
    server.httpServer?.on("upgrade", (req: IncomingMessage, socket, head) => {
      if (req.url?.split("?")[0] !== `${base}warp/edge`) return; // Vite's own, say
      sockets.handleUpgrade(req, socket, head, (ws) => {
        const [host, port] = [EDGE.slice(0, EDGE.lastIndexOf(":")), Number(EDGE.slice(EDGE.lastIndexOf(":") + 1))];
        const tcp = connect(port, host);
        ws.on("message", (data: Buffer) => tcp.write(data));
        tcp.on("data", (data) => ws.send(data));
        ws.on("close", () => tcp.destroy());
        tcp.on("close", () => ws.close());
        tcp.on("error", () => ws.close());
      });
    });

    server.middlewares.use(`${base}warp/api`, async (req, res) => {
      const path = (req.url ?? "").split("?")[0]!;
      if (!PATHS.test(path)) {
        res.statusCode = 404;
        return res.end();
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      const headers: Record<string, string> = { "user-agent": "WARP for Android" };
      for (const name of FORWARDED) {
        const value = req.headers[name];
        if (typeof value === "string") headers[name] = value;
      }
      try {
        const upstream = await fetch(`${API}${path}`, { method: req.method, headers, body: body.length ? body : undefined });
        res.statusCode = upstream.status;
        res.setHeader("content-type", upstream.headers.get("content-type") ?? "application/json");
        res.end(Buffer.from(await upstream.arrayBuffer()));
      } catch {
        res.statusCode = 502;
        res.end();
      }
    });
  };
  return {
    name: "warp-pipes",
    configResolved: (config) => void (base = config.base),
    configureServer: routes,
    configurePreviewServer: routes,
  };
}
