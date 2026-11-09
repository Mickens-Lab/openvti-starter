import assert from "node:assert/strict";
import { test } from "node:test";
import { describePong } from "../src/index.js";

test("describePong reads like a human sentence and names the protocols", () => {
  const line = describePong({ clientDid: "did:key:x", nonce: "n", elapsedMs: 42, pong: { status: "ok", protocols: ["tsp", "didcomm"], respondedAt: "2026-01-01T00:00:00Z", nonce: "n" } });
  assert.match(line, /pong from the VTA in 42 ms/);
  assert.match(line, /\[tsp, didcomm\]/);
});

test("documentSigner: on an exact second the ping carries no .000Z issuedAt or proof.created, and it verifies", async (t) => {
  const { mock } = await import("node:test");
  const { buildTrustTask, generateSigningIdentity } = await import("@openvtc/pnm-core");
  const { DataIntegrityProofVerifier } = await import("@openvtc/trust-tasks-proof");
  const { rfc3339 } = await import("@starter/vta-client");
  const { documentSigner } = await import("../src/index.js");
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-31T12:00:00.000Z") });
  t.after(() => mock.timers.reset());
  const signing = generateSigningIdentity();
  const doc: any = buildTrustTask("https://trusttasks.org/spec/messaging/ping/0.2", { nonce: "n" }, { issuer: signing.did, recipient: "did:example:vta", issuedAt: rfc3339() });
  await documentSigner(signing).sign(doc);
  assert.equal(doc.issuedAt, "2026-10-31T12:00:00Z");
  assert.equal(doc.proof.created, "2026-10-31T12:00:00Z");
  assert.equal(await new DataIntegrityProofVerifier().verify(doc), true);
});

test("checkPingReply: only a #response from the peer to us is a pong; an error surfaces its code", async () => {
  const { checkPingReply, PING_TYPE, PING_RESPONSE_TYPE } = await import("../src/index.js");
  const req = { id: "p1", type: PING_TYPE };
  checkPingReply(req, { type: PING_RESPONSE_TYPE, threadId: "p1", payload: {} }, "did:example:me", "did:example:vta");
  checkPingReply(req, { type: PING_RESPONSE_TYPE, issuer: "did:example:vta", recipient: "did:example:me", payload: {} }, "did:example:me", "did:example:vta");
  assert.throws(() => checkPingReply(req, { type: "https://trusttasks.org/spec/trust-task-error/0.5", payload: { code: "permissionDenied" } }, "a", "b"), /permissionDenied/);
  assert.throws(() => checkPingReply(req, { type: "https://trusttasks.org/spec/trust-task-next-step/0.1", payload: {} }, "a", "b"), /next-step/);
  assert.throws(() => checkPingReply(req, { type: PING_TYPE, payload: {} }, "a", "b"), /not a/);
  assert.throws(() => checkPingReply(req, { type: PING_RESPONSE_TYPE, issuer: "did:example:other", payload: {} }, "did:example:me", "did:example:vta"), /issuer/);
  assert.throws(() => checkPingReply(req, { type: PING_RESPONSE_TYPE, recipient: "did:example:other", payload: {} }, "did:example:me", "did:example:vta"), /addressed/);
});
