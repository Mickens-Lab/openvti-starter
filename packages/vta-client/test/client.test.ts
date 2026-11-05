// Unit tests that need no VTA: a fake fetch plays the VTA.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DataIntegrityProofVerifier } from "@openvtc/trust-tasks-proof";
import {
  TASK,
  TrustTaskError,
  VtaClient,
  decodeCredential,
  encodeCredential,
  fetchVtaDid,
  identityFromCredential,
  identityFromSeed,
  newIdentity,
  seedFromMultibase,
  seedToMultibase,
  siopIdToken,
  siopKid,
} from "../src/index.js";

const VTA_DID = "did:webvh:Qmfake:localhost%3A8100";
const didLog = JSON.stringify({ state: { id: "did:webvh:old" } }) + "\n" + JSON.stringify({ state: { id: VTA_DID } });

type Seen = { url: string; headers: Record<string, string>; doc?: any };
function fakeVta(handler: (doc: any, seen: Seen) => unknown, seen: Seen[] = []): typeof fetch {
  return (async (input: any, init?: any) => {
    const url = String(input);
    if (url.endsWith("/.well-known/did.jsonl")) return new Response(didLog);
    const doc = JSON.parse(init.body);
    const s = { url, headers: init.headers, doc };
    seen.push(s);
    const out = handler(doc, s);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify({ type: doc.type + "#response", payload: out }));
  }) as typeof fetch;
}

test("identity: did:key and multibase seed round trip", () => {
  const id = newIdentity();
  assert.match(id.did, /^did:key:z6Mk[^#]+$/);
  const again = identityFromSeed(seedFromMultibase(seedToMultibase(id.seed)));
  assert.equal(again.did, id.did);
});

test("credential bundle round trips and yields the same identity", () => {
  const id = newIdentity();
  const bundle = { did: id.did, privateKeyMultibase: seedToMultibase(id.seed), vtaDid: VTA_DID, vtaUrl: "http://x" };
  const decoded = decodeCredential(encodeCredential(bundle));
  assert.deepEqual(decoded, bundle);
  assert.equal(identityFromCredential(decoded).did, id.did);
});

test("fetchVtaDid reads the last did.jsonl entry", async () => {
  assert.equal(await fetchVtaDid("http://vta", fakeVta(() => ({}))), VTA_DID);
});

test("call sends a signed envelope addressed to the VTA, verifiable by anyone", async () => {
  const me = newIdentity();
  const seen: Seen[] = [];
  const c = await VtaClient.connect("http://vta", me, fakeVta(() => ({ ok: true }), seen));
  assert.deepEqual(await c.call(TASK.whoami, { a: 1 }), { ok: true });
  const doc = seen[0].doc;
  assert.equal(seen[0].url, "http://vta/trust-tasks");
  assert.equal(doc.issuer, me.did);
  assert.equal(doc.recipient, VTA_DID);
  assert.equal(doc.type, TASK.whoami);
  assert.equal(await new DataIntegrityProofVerifier().verify(doc), true);
  doc.payload.a = 2; // tamper after signing
  assert.equal(await new DataIntegrityProofVerifier().verify(doc), false);
});

test("authenticate runs challenge then authenticate and sends the bearer afterwards", async () => {
  const seen: Seen[] = [];
  const c = await VtaClient.connect(
    "http://vta",
    newIdentity(),
    fakeVta((doc) => {
      if (doc.type === TASK.challenge) return { challenge: "ch", sessionId: "s1" };
      if (doc.type === TASK.authenticate) return { tokens: { accessToken: "tok" } };
      return { roles: ["application"] };
    }, seen),
  );
  await c.authenticate();
  assert.deepEqual(seen.map((s) => s.doc.type), [TASK.challenge, TASK.authenticate]);
  assert.equal(seen[1].doc.payload.challenge, "ch");
  assert.equal(seen[0].headers.authorization, undefined);
  await c.whoami();
  assert.equal(seen[2].headers.authorization, "Bearer tok");
});

const ERR = "https://trusttasks.org/spec/trust-task-error/0.5";
const refuse = (doc: any, payload: Record<string, unknown>, status = 422) =>
  new Response(JSON.stringify({ type: ERR, threadId: doc.id, payload }), { status });

test("error responses raise TrustTaskError; an existing resource (taskFailed + reason conflict) is idempotent", async () => {
  const c = await VtaClient.connect(
    "http://vta",
    newIdentity(),
    fakeVta((doc) =>
      doc.type === TASK.contextsCreate
        ? refuse(doc, { code: "taskFailed", message: "context already exists: demo", details: { reason: "conflict" } })
        : refuse(doc, { code: "permissionDenied", message: "no" }, 403),
    ),
  );
  assert.equal(await c.createContext("demo"), false);
  const e = await c.grantAcl("did:key:z6Mkx", "demo").catch((x) => x);
  assert.ok(e instanceof TrustTaskError);
  assert.equal(e.code, "permissionDenied");
});

test("idempotent() keys off the code: idConflict and messages that say 'already' are NOT 'already exists'", async () => {
  for (const payload of [
    { code: "idConflict", message: "id reused with different content" },
    { code: "taskFailed", message: "context already exists", details: { reason: "not_found" } },
    { code: "permissionDenied", message: "already revoked; conflict; does not exist" },
  ]) {
    const c = await VtaClient.connect("http://vta", newIdentity(), fakeVta((doc) => refuse(doc, payload)));
    await assert.rejects(c.createContext("demo"), TrustTaskError, JSON.stringify(payload));
  }
  const ext = await VtaClient.connect("http://vta", newIdentity(), fakeVta((doc) => refuse(doc, { code: "vta/contexts/create:alreadyExists" })));
  assert.equal(await ext.createContext("demo"), false);
});

test("grantHandoff sends an admin entry with the one-time hand-off marker and an expiry", async () => {
  const seen: Seen[] = [];
  const c = await VtaClient.connect("http://vta", newIdentity(), fakeVta(() => ({ entry: {} }), seen));
  await c.grantHandoff("did:key:z6Mksetup", "vtc");
  const e = seen[0].doc.payload.entry;
  assert.equal(seen[0].doc.type, TASK.aclGrant);
  assert.deepEqual([e.role, e.act, e.keys, e.capabilities, e.ext], ["admin", { scope: "contexts", contexts: ["vtc"] }, { scope: "all" }, { scope: "ceiling" }, { "org.openvtc.handoff": true }]);
  assert.equal(e.scopes, undefined, "acl/grant/0.2 has no `scopes`");
  assert.ok(Date.parse(e.expiresAt) > Date.now());
});

test("siopIdToken names the signer's verification method as kid: did:key form, and a did:peer:2 #key-2 when the signer says so", () => {
  const me = newIdentity();
  const head = (t: string) => JSON.parse(Buffer.from(t.split(".")[0], "base64url").toString());
  assert.equal(head(siopIdToken(me, VTA_DID, "n1")).kid, `${me.did}#${me.did.slice("did:key:".length)}`);
  // A did:peer:2 applicant (shape of tsp-client's didPeerFromSeed): the old code sliced "did:key:".length off the DID and named no real key.
  const peerDid = "did:peer:2.Ez6LSfake.Vz6Mkfake.SeyJ0IjoiVFNQVHJhbnNwb3J0In0";
  const peer = { ...me, did: peerDid, signer: { ...me.signer, did: peerDid, verificationMethod: `${peerDid}#key-2` } };
  assert.equal(siopKid(peer), `${peerDid}#key-2`);
  const t = siopIdToken(peer, VTA_DID, "n2");
  assert.equal(head(t).kid, `${peerDid}#key-2`);
  const body = JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString());
  assert.deepEqual([body.iss, body.sub, body.aud, body.nonce], [peerDid, peerDid, VTA_DID, "n2"]);
  // A signer for some other DID is not trusted for the kid: fall back to the did:key form.
  assert.equal(siopKid({ ...me, signer: { ...me.signer, verificationMethod: "did:key:zOther#zOther" } }), `${me.did}#${me.did.slice("did:key:".length)}`);
});
