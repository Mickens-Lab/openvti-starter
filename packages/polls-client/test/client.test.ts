// PollsClient against a fake fetch: exact task types, recipients and byte-for-byte pass-through. No server.
import assert from "node:assert/strict";
import { test } from "node:test";
import { VtaClient, newIdentity } from "@starter/vta-client";
import { VtcClient } from "@starter/vtc-client";
import { POLL_TASK, PollsClient, didWebvhLogUrl, pollManifest, resolveTrustTaskHttps } from "../src/index.js";

const VTC_DID = "did:webvh:Qmfakevtc:localhost%3A8200";
const BOX = "did:webvh:Qmfakebox:box.example";
const ERR = "https://trusttasks.org/spec/trust-task-error/0.5";

function fake(handler: (doc: any, url: string) => unknown, seen: any[]): typeof fetch {
  return (async (input: any, init?: any) => {
    const url = String(input);
    if (url.endsWith("did.jsonl")) return new Response(JSON.stringify({ state: { id: url.includes("8100") ? "did:webvh:Qmfakevta:localhost%3A8100" : VTC_DID } }));
    const doc = JSON.parse(init.body);
    seen.push({ url, doc });
    const out = handler(doc, url);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify({ type: doc.type + "#response", payload: out }));
  }) as typeof fetch;
}

const manifest = pollManifest({ community: VTC_DID, ballotBox: BOX, question: "Q?", options: ["A", "B"], electionId: "e1", now: new Date("2026-11-07T10:00:00Z") });
// A manifest as a server returns it: odd key order and a timestamp form the client must not normalise.
const served = { ...manifest, votingOpensAt: "2026-11-07T10:00:00.000000Z" };
const shown = { manifest: served, manifestDigest: "uDIGEST", state: "voting", parameters: { suite: "ps-ddh-bls12381", votingKey: "k" }, disclosure: { ballotBox: BOX } };

async function clients(handler: (doc: any, url: string) => unknown, seen: any[] = []) {
  const f = fake(handler, seen);
  const vtc = await VtcClient.connect("http://localhost:8200", newIdentity(), f);
  const vta = await VtaClient.connect("http://localhost:8100", newIdentity(), f);
  return new PollsClient({ vtc, vta, contextId: "my-app", member: "did:key:fake-member", ballotBoxUrl: "https://box.example/tt", castDelayMs: 0, fetchImpl: f });
}

test("create sends the manifest to vtc/elections/create/0.5 at the community", async () => {
  const seen: any[] = [];
  const p = await clients(() => ({ electionId: "e1", manifestDigest: "u1", state: "registered" }), seen);
  const r = await p.create({ ...manifest, community: "" });
  assert.equal(r.state, "registered");
  assert.equal(seen[0].doc.type, POLL_TASK.create);
  assert.equal(seen[0].doc.recipient, VTC_DID);
  assert.equal(seen[0].doc.payload.manifest.community, VTC_DID); // filled in
  assert.equal(seen[0].url, "http://localhost:8200/v1/trust-tasks");
});

test("create validates before signing anything", async () => {
  const seen: any[] = [];
  const p = await clients(() => ({}), seen);
  await assert.rejects(p.create({ ...manifest, votingClosesAt: manifest.votingOpensAt }), /close after it opens/);
  assert.equal(seen.length, 0);
});

test("show as the member: the VTA signs, the document goes to the community unchanged", async () => {
  const seen: any[] = [];
  const memberDoc = { id: "m1", type: POLL_TASK.show, issuer: "did:key:fake-member", recipient: VTC_DID, issuedAt: "2026-11-07T10:00:00Z", payload: { electionId: "e1" }, proof: { fake: true } };
  const p = await clients((doc) => (doc.type === POLL_TASK.voterRead ? { document: memberDoc } : shown), seen);
  const s = await p.show("e1");
  assert.equal(s.manifestDigest, "uDIGEST");
  assert.deepEqual(seen[0].doc.payload, { contextId: "my-app", community: VTC_DID, member: "did:key:fake-member", read: "show", payload: { electionId: "e1" } });
  assert.deepEqual(seen[1].doc, memberDoc);
  assert.equal(seen[1].url, "http://localhost:8200/v1/trust-tasks");
});

test("vote: register -> issue -> accept -> vote -> cast at the box -> receipt, passing the manifest through", async () => {
  const seen: any[] = [];
  const ticketDocument = { id: "t1", type: POLL_TASK.ticketsIssue, payload: { electionId: "e1" } };
  const castDocument = { id: "c1", type: POLL_TASK.cast, issuer: "did:key:one-time", payload: { electionId: "e1" } };
  const p = await clients((doc) => {
    switch (doc.type) {
      case POLL_TASK.voterRegister: return { electionId: "e1", manifestDigest: "uDIGEST", request: {}, ticketDocument };
      case POLL_TASK.ticketsIssue: return { electionId: "e1", label: "voter/e1", preCredential: "pc", ext: { x: 1 } };
      case POLL_TASK.voterAccept: return { electionId: "e1", ticketHeld: true };
      case POLL_TASK.vote: return { castDocument, tag: "tag1" };
      case POLL_TASK.cast: return { electionId: "e1", outcome: "counted", leafIndex: 0 };
      case POLL_TASK.voterReceipt: return { status: "included", leafIndex: 0 };
    }
    throw new Error("unexpected " + doc.type);
  }, seen);
  const out = await p.vote("e1", ["B"], { shown: shown as any });
  assert.deepEqual([out.outcome, out.tag, out.ticketTaken, out.kept], ["counted", "tag1", true, "included"]);
  assert.deepEqual(seen.map((s) => s.doc.type), [POLL_TASK.voterRegister, POLL_TASK.ticketsIssue, POLL_TASK.voterAccept, POLL_TASK.vote, POLL_TASK.cast, POLL_TASK.voterReceipt]);
  assert.equal(seen[0].doc.payload.manifest.votingOpensAt, "2026-11-07T10:00:00.000000Z"); // not re-serialised
  assert.deepEqual(seen[1].doc, ticketDocument); // the VTA's signed document, as is
  assert.deepEqual(seen[2].doc.payload.response, { electionId: "e1", label: "voter/e1", preCredential: "pc" }); // ext dropped
  assert.deepEqual(seen[3].doc.payload.ballot, { electionId: "e1", manifestDigest: "uDIGEST", answers: [{ question: "q1", choice: ["b"] }] });
  assert.equal(seen[4].url, "https://box.example/tt/trust-tasks");
  assert.deepEqual(seen[4].doc, castDocument);
});

test("vote skips the ticket when the VTA already holds one", async () => {
  const seen: any[] = [];
  const p = await clients((doc) => {
    if (doc.type === POLL_TASK.voterRegister) return new Response(JSON.stringify({ type: ERR, payload: { code: "vta/pcs/voter/register:ticketHeld" } }), { status: 409 });
    if (doc.type === POLL_TASK.vote) return { castDocument: { id: "c", type: POLL_TASK.cast }, tag: "t" };
    if (doc.type === POLL_TASK.cast) return { electionId: "e1", outcome: "replaced", leafIndex: 1 };
    return new Response(JSON.stringify({ type: ERR, payload: { code: "internal" } }), { status: 500 }); // receipt fails: best effort
  }, seen);
  const out = await p.vote("e1", ["a"], { shown: shown as any });
  assert.equal(out.ticketTaken, false);
  assert.equal(out.outcome, "replaced");
  assert.equal(out.kept, undefined);
});

test("vote refuses locally: bad ballot, closed poll, digest drift, no VTA", async () => {
  const seen: any[] = [];
  const p = await clients((doc) => (doc.type === POLL_TASK.voterRegister ? { manifestDigest: "uOTHER", ticketDocument: {} } : {}), seen);
  await assert.rejects(p.vote("e1", ["a", "b"], { shown: shown as any }), /only one/);
  await assert.rejects(p.vote("e1", ["a"], { shown: { ...shown, state: "tallied" } as any }), /takes no more votes/);
  assert.equal(seen.length, 0);
  await assert.rejects(p.vote("e1", ["a"], { shown: shown as any }), /different poll/);
  const bare = new PollsClient({ vtc: p.vtc });
  await assert.rejects(bare.vote("e1", ["a"], { shown: shown as any }), /POLL_MEMBER_DID/);
});

test("results go to the ballot box, signed, addressed to its DID; close and cancel to the community", async () => {
  const seen: any[] = [];
  const p = await clients((doc) => (doc.type === POLL_TASK.resultShow ? { result: { electionId: "e1", ballotsCounted: 0, questions: [] }, provisional: false, state: "tallied" } : { electionId: "e1", state: "closed" }), seen);
  const r = await p.results("e1", { shown: shown as any });
  assert.equal(r.state, "tallied");
  assert.equal(seen[0].doc.recipient, BOX);
  assert.deepEqual(seen[0].doc.payload, { community: VTC_DID, electionId: "e1" });
  assert.ok(seen[0].doc.proof);
  await p.close("e1", "done");
  assert.deepEqual([seen[1].doc.type, seen[1].doc.payload], [POLL_TASK.close, { electionId: "e1", reason: "done" }]);
  await assert.rejects(p.cancel("e1", " "), /needs a reason/);
  await p.cancel("e1", "typo");
  assert.equal(seen[2].doc.type, POLL_TASK.cancel);
});

test("did:webvh log URLs and TrustTaskHTTPS resolution", async () => {
  assert.equal(didWebvhLogUrl("did:webvh:Qmx:example.org"), "https://example.org/.well-known/did.jsonl");
  assert.equal(didWebvhLogUrl("did:webvh:Qmx:localhost%3A8300:box"), "http://localhost:8300/box/did.jsonl");
  assert.throws(() => didWebvhLogUrl("did:key:z6Mk"), /not a did:webvh/);
  const f = (async () => new Response(JSON.stringify({ state: { service: [{ type: ["DIDCommMessaging"] }, { type: "TrustTaskHTTPS", serviceEndpoint: { uri: "https://b/tt" } }] } }))) as unknown as typeof fetch;
  assert.equal(await resolveTrustTaskHttps("did:webvh:Qmx:b", f), "https://b/tt");
  const none = (async () => new Response(JSON.stringify({ state: { service: [] } }))) as unknown as typeof fetch;
  await assert.rejects(resolveTrustTaskHttps("did:webvh:Qmx:b", none), /BALLOT_BOX_URL/);
});
