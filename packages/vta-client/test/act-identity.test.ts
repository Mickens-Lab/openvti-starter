import assert from "node:assert/strict";
import { test } from "node:test";
import { VtaClient } from "../src/index.js";

test("actIdentity asks rooms/keys/act for the persona, without the caller's presentation, and returns the completed document", async () => {
  const vta = Object.create(VtaClient.prototype) as VtaClient;
  const calls: { type: string; payload: any }[] = [];
  (vta as any).call = async (type: string, payload: any) => {
    calls.push({ type, payload });
    return { principal: "did:example:persona", document: { ...payload.document, proof: { type: "DataIntegrityProof" } } };
  };
  const me = vta.actIdentity("did:example:persona");
  assert.equal(me.did, "did:example:persona");
  const out = await me.signRemote!({ id: "x", type: "t", issuer: "did:example:other", recipient: "did:example:host", payload: { roomId: "r", presentation: { membership: "", authority: [] } } }, "authentication");
  assert.equal(calls.length, 1);
  assert.match(calls[0].type, /\/rooms\/keys\/act\/0\.8$/);
  assert.equal(calls[0].payload.document.issuer, "did:example:persona");
  assert.deepEqual(calls[0].payload.document.payload, { roomId: "r" });
  assert.ok(out.proof);
});
