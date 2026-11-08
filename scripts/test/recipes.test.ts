import assert from "node:assert/strict";
import { test } from "node:test";
import { TrustTaskError } from "@starter/vta-client";
import { handle, type Opts } from "../recipes/backend-signer.js";
import { generateNonExtractableDid } from "../recipes/webcrypto-key.js";

const calls: string[] = [];
const opts: Opts = {
  origins: ["http://localhost:5173"],
  allow: ["https://trusttasks.org/spec/auth/whoami/0.1"],
  caller: { async call(type) { calls.push(type); if (type.endsWith("boom")) throw new TrustTaskError(403, { payload: { code: "permissionDenied" } }); return { ok: true }; } },
};
const post = (body: unknown, origin: string | undefined = "http://localhost:5173") => handle(opts, { method: "POST", path: "/api/call", origin, body: typeof body === "string" ? body : JSON.stringify(body) });

test("backend signer: allowed origin and task are signed; the key is never in a reply", async () => {
  const r = await post({ type: opts.allow[0], payload: {} });
  assert.equal(r.status, 200);
  assert.equal(r.headers["access-control-allow-origin"], "http://localhost:5173");
  assert.doesNotMatch(JSON.stringify(r), /privateKey|VTA_CREDENTIAL/);
});
test("backend signer: other origins, other tasks, bad bodies and other routes are refused", async () => {
  calls.length = 0;
  assert.equal((await post({ type: opts.allow[0] }, "https://evil.example")).status, 403);
  assert.equal((await post({ type: opts.allow[0] }, "")).status, 403);
  assert.equal((await post({ type: "https://trusttasks.org/spec/acl/grant/0.1" })).status, 403);
  assert.equal((await post("not json")).status, 400);
  assert.equal((await handle(opts, { method: "GET", path: "/api/call", origin: "http://localhost:5173", body: "" })).status, 404);
  assert.equal((await handle(opts, { method: "OPTIONS", path: "/api/call", origin: "https://evil.example", body: "" })).headers["access-control-allow-origin"], undefined);
  assert.deepEqual(calls, []);
});
test("backend signer: an upstream refusal is passed through for the page to handle", async () => {
  const o2 = { ...opts, allow: ["x/boom"] };
  const r = await handle(o2, { method: "POST", path: "/api/call", origin: "http://localhost:5173", body: JSON.stringify({ type: "x/boom" }) });
  assert.equal(r.status, 403);
  assert.deepEqual((r.body as any).refused.payload.code, "permissionDenied");
});
test("webcrypto: a non-extractable Ed25519 key yields a did:key, signs, and refuses export", async () => {
  const k = await generateNonExtractableDid();
  assert.match(k.did, /^did:key:z6Mk/);
  assert.equal(k.privateKey.extractable, false);
  await assert.rejects(globalThis.crypto.subtle.exportKey("pkcs8", k.privateKey));
  const data = new TextEncoder().encode("hello");
  assert.equal(await k.verify(data, await k.sign(data)), true);
  assert.equal(await k.verify(new TextEncoder().encode("other"), await k.sign(data)), false);
});
