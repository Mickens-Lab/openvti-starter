import assert from "node:assert/strict";
import { test } from "node:test";
import { remoteIdentity } from "@buildathon/vta-client";
import { VtcClient } from "../src/index.js";

test("a remote identity's documents are signed by signRemote, with the type's proof purpose", async () => {
  const seen: { doc: any; purpose: string }[] = [];
  const me = remoteIdentity("did:example:fake-persona", async (doc, purpose) => { seen.push({ doc, purpose }); return { ...doc, proof: { fake: true } }; });
  let sent: any;
  const fetchImpl = (async (_u: string, init: { body: string }) => { sent = JSON.parse(init.body); return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
  const vtc = await VtcClient.connect("http://vtc.invalid", me, fetchImpl, "did:example:fake-vtc");
  await vtc.call("https://trusttasks.org/spec/vtc/rooms/offers/list/0.4", {}).catch(() => {});
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.doc.issuer, "did:example:fake-persona");
  assert.equal(seen[0]!.doc.recipient, "did:example:fake-vtc");
  assert.equal(seen[0]!.purpose, "authentication");
  assert.deepEqual(sent.proof, { fake: true });
});

test("a remote identity has no local key", () => {
  const me = remoteIdentity("did:example:fake-persona", async (d) => d);
  assert.throws(() => me.signer.sign(new Uint8Array(1)), /signed remotely/);
  assert.equal(me.seed.length, 0);
});
