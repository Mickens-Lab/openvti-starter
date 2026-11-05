// The same-origin dev proxy: config generation, then a real Vite dev server on a port outside any CORS list.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createServer as createVite } from "vite";
import { devProxy, normalizeTarget, proxyDownMessage, proxyEntry, VTA_PROXY, VTC_PROXY } from "../lib/dev-proxy.js";

test("devProxy: /__vta always, defaults to the local VTA, /__vtc only when given", () => {
  const p = devProxy({});
  assert.deepEqual(Object.keys(p), [VTA_PROXY]);
  assert.equal(p[VTA_PROXY].target, "http://localhost:8100");
  assert.equal(p[VTA_PROXY].changeOrigin, true);
  const q = devProxy({ vtaUrl: "https://vta.example.test/", vtcUrl: "http://localhost:8200" });
  assert.deepEqual(Object.keys(q), [VTA_PROXY, VTC_PROXY]);
  assert.equal(q[VTA_PROXY].target, "https://vta.example.test", "trailing slash dropped");
});

test("rewrite strips only the prefix", () => {
  const r = proxyEntry(VTA_PROXY, "http://localhost:8100").rewrite;
  assert.equal(r("/__vta/trust-tasks"), "/trust-tasks");
  assert.equal(r("/__vta/.well-known/did.jsonl?x=1"), "/.well-known/did.jsonl?x=1");
  assert.equal(r("/__vta"), "/");
  assert.equal(r("/__vta?x=1"), "/?x=1");
  assert.equal(r("/__vtax/y"), "/__vtax/y", "a longer name is not ours");
  assert.equal(r("/other/__vta/y"), "/other/__vta/y");
});

test("a bad URL is named in the error", () => {
  assert.throws(() => normalizeTarget("localhost:8100", "VTA_URL"), /VTA_URL must start with http/);
  assert.throws(() => normalizeTarget("not a url", "VTC_URL"), /VTC_URL is not a URL/);
  assert.throws(() => devProxy({ vtaUrl: "ftp://x" }), /VTA_URL must start with http/);
  assert.throws(() => devProxy({ vtcUrl: "nope" }), /VTC_URL is not a URL/);
});

test("configure: drops the Origin header and turns a dead upstream into a readable 502", () => {
  const ev = new EventEmitter();
  proxyEntry(VTA_PROXY, "http://localhost:8100").configure(ev as any);
  const removed: string[] = [];
  ev.emit("proxyReq", { removeHeader: (n: string) => removed.push(n) });
  assert.deepEqual(removed, ["origin"]);
  let status = 0, body = "";
  ev.emit("error", { code: "ECONNREFUSED" }, {}, { writeHead: (s: number) => { status = s; }, end: (b: string) => { body = b; } });
  assert.equal(status, 502);
  assert.match(body, /could not reach http:\/\/localhost:8100/);
  assert.match(body, /npm run doctor/);
  assert.match(body, /ECONNREFUSED/);
  assert.doesNotThrow(() => ev.emit("error", {}, {}, { /* a websocket socket has no writeHead */ }));
  assert.match(proxyDownMessage("/__vtc", "http://x"), /^The dev server could not reach http:\/\/x/);
});

/** A free port outside the CORS list. Vite treats `port: 0` as "unset" and falls back to 5173, so the port is chosen here. */
async function freePort(): Promise<number> {
  for (;;) {
    const s = createServer();
    const p = await new Promise<number>((ok) => s.listen(0, "127.0.0.1", () => ok((s.address() as AddressInfo).port)));
    await new Promise((ok) => s.close(ok));
    if (![3000, 5173, 8000].includes(p)) return p;
  }
}

const listen = (s: Server) => new Promise<number>((ok) => s.listen(0, "127.0.0.1", () => ok((s.address() as AddressInfo).port)));

test("a real Vite dev server forwards same-origin calls from a port no CORS list has, without the Origin header", async () => {
  const seen: { url?: string; origin?: string | string[]; host?: string }[] = [];
  const upstream = createServer((req, res) => { seen.push({ url: req.url, origin: req.headers.origin, host: req.headers.host }); res.end(`{"ok":true}`); });
  const up = await listen(upstream);
  const vite = await createVite({
    configFile: false, logLevel: "silent", root: process.cwd(),
    server: { port: await freePort(), strictPort: true, host: "127.0.0.1", proxy: devProxy({ vtaUrl: `http://127.0.0.1:${up}` }) },
  });
  try {
    await vite.listen();
    const port = (vite.httpServer!.address() as AddressInfo).port;
    assert.ok(![3000, 5173, 8000].includes(port));
    const r = await fetch(`http://127.0.0.1:${port}/__vta/trust-tasks?a=1`, { method: "POST", headers: { origin: `http://localhost:${port}`, "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
    assert.equal(seen[0].url, "/trust-tasks?a=1");
    assert.equal(seen[0].origin, undefined, "the VTA never sees a browser Origin");
    assert.equal(seen[0].host, `127.0.0.1:${up}`, "Host is the VTA's own, as in a direct call");
  } finally {
    await vite.close();
    upstream.close();
  }
});

test("a real Vite dev server answers 502 with the explanation when the VTA is down", async () => {
  const dead = createServer();
  const deadPort = await listen(dead);
  dead.close(); // nothing listens there now
  const vite = await createVite({
    configFile: false, logLevel: "silent", root: process.cwd(),
    server: { port: await freePort(), strictPort: true, host: "127.0.0.1", proxy: devProxy({ vtaUrl: `http://127.0.0.1:${deadPort}` }) },
  });
  try {
    await vite.listen();
    const port = (vite.httpServer!.address() as AddressInfo).port;
    const r = await fetch(`http://127.0.0.1:${port}/__vta/.well-known/did.jsonl`);
    assert.equal(r.status, 502);
    assert.match(await r.text(), /Is the stack up\? Run `npm run doctor`/);
  } finally {
    await vite.close();
  }
});

// The real vite.config.ts of every browser template that uses the proxy.
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfigFromFile } from "vite";

for (const t of ["hello-web", "web-vta-app", "community-dashboard"]) {
  test(`${t}: vite.config.ts proxies /__vta, never pins the port, and works from apps/<name>`, async () => {
    const root = process.cwd();
    const loaded = await loadConfigFromFile({ command: "serve", mode: "development" }, join(root, "templates", t, "vite.config.ts"));
    const server = loaded!.config.server as { port?: number; strictPort?: boolean; proxy?: Record<string, { target: string }> };
    assert.ok(server.proxy?.[VTA_PROXY]?.target.startsWith("http"), "VTA proxy target");
    assert.notEqual(server.strictPort, true, "a busy 5173 must not stop the app");
    const dev = JSON.parse(readFileSync(join(root, "templates", t, "package.json"), "utf8")).scripts.dev as string;
    assert.doesNotMatch(dev, /strictPort/);
    // `npm run new` copies templates/<t> to apps/<name>: same depth, so the "../../scripts/lib/dev-proxy.ts" import must resolve there too.
    const tmp = mkdtempSync(join(tmpdir(), "proxy-copy-"));
    try {
      mkdirSync(join(tmp, "apps"), { recursive: true });
      symlinkSync(join(root, "node_modules"), join(tmp, "node_modules"), "dir"); // so `vite` resolves, as in a real install
      cpSync(join(root, "scripts"), join(tmp, "scripts"), { recursive: true });
      cpSync(join(root, "templates", t), join(tmp, "apps", "mine"), { recursive: true, filter: (p) => !/node_modules|dist/.test(p) });
      for (const f of ["pins.json"]) if (existsSync(join(root, f))) cpSync(join(root, f), join(tmp, f));
      const copy = await loadConfigFromFile({ command: "serve", mode: "development" }, join(tmp, "apps/mine/vite.config.ts"));
      assert.ok((copy!.config.server as any).proxy[VTA_PROXY], "copy loads and proxies");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}
