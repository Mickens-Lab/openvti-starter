// Recipe, hardening level 1 (docs/SECURITY.md): the backend holds the app key; the page only calls this server.
// The key never reaches the browser or a bundle. Run:  npm run recipe:backend-signer   (needs `npm run up`; Ctrl-C stops it)
// Then from a page on an allowed origin:  fetch("http://127.0.0.1:8300/api/call", { method: "POST", body: JSON.stringify({ type, payload }) })
// A demo of the shape, not a hardened service: add your own sign-in for the page's users (this server trusts the Origin header
// only, which a non-browser client can forge), TLS, rate limits and logging.
import "../lib/cli.js";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { TASK, TrustTaskError, VtaClient } from "@starter/vta-client";

export interface Caller { call(type: string, payload: Record<string, unknown>): Promise<unknown> }
export interface Opts {
  caller: Caller;
  /** Exact origins allowed to use the backend (browser CORS and a server-side check). Never "*". */
  origins: string[];
  /** The Trust Task types the backend will sign. A backend that signs anything is the same as a key in the page. */
  allow: string[];
}
export interface Reply { status: number; headers: Record<string, string>; body: unknown }

/** Pure request handler: easy to test, no sockets. */
export async function handle(o: Opts, req: { method: string; path: string; origin?: string; body: string }): Promise<Reply> {
  const cors: Record<string, string> = o.origins.includes(req.origin ?? "") ? { "access-control-allow-origin": req.origin!, vary: "origin" } : {};
  const reply = (status: number, body: unknown): Reply => ({ status, headers: { "content-type": "application/json", ...cors }, body });
  if (req.method === "OPTIONS") return { status: 204, headers: { ...cors, "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type" }, body: undefined };
  if (req.path !== "/api/call" || req.method !== "POST") return reply(404, { error: "not found" });
  if (!o.origins.includes(req.origin ?? "")) return reply(403, { error: "origin not allowed" });
  let msg: { type?: unknown; payload?: unknown };
  try { msg = JSON.parse(req.body); } catch { return reply(400, { error: "body must be JSON" }); }
  if (typeof msg.type !== "string" || !o.allow.includes(msg.type)) return reply(403, { error: "task not allowed here" });
  try {
    return reply(200, await o.caller.call(msg.type, (msg.payload ?? {}) as Record<string, unknown>));
  } catch (e) {
    // Pass the service's refusal through (the page should still handle refusals); never echo the credential.
    if (e instanceof TrustTaskError) return reply(e.status >= 400 && e.status < 600 ? e.status : 502, { refused: e.body });
    return reply(502, { error: "upstream call failed" });
  }
}

async function main(): Promise<void> {
  const credential = process.env.VTA_CREDENTIAL; // server-side only; never put it in a VITE_ variable
  if (!credential) throw new Error("VTA_CREDENTIAL is not set (run `npm run up`, then export it from .env for this process)");
  const vta = await VtaClient.fromCredential(credential, process.env.VTA_URL);
  await vta.authenticate();
  const origins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173").split(",");
  const o: Opts = { caller: { call: (t, p) => vta.call(t, p) }, origins, allow: [TASK.whoami] };
  const port = Number(process.env.SIGNER_PORT ?? 8300);
  createServer(async (req, res) => {
    let body = "";
    for await (const c of req) { body += c; if (body.length > 1 << 20) { res.writeHead(413).end(); return; } }
    const r = await handle(o, { method: req.method ?? "", path: new URL(req.url ?? "/", "http://x").pathname, origin: req.headers.origin, body });
    res.writeHead(r.status, r.headers).end(r.body === undefined ? undefined : JSON.stringify(r.body));
  }).listen(port, "127.0.0.1", () => console.log(`backend signer on http://127.0.0.1:${port}/api/call for ${origins.join(", ")}; allowed tasks: ${o.allow.join(", ")}`));
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
