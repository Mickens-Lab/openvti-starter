import assert from "node:assert/strict";
import { test } from "node:test";
import { signTrustTask } from "@openvtc/trust-tasks-proof";
import { newIdentity, rfc3339 } from "@starter/vta-client";
import { NOTE_RESPONSE, NOTE_TYPE, createInbox } from "../src/inbox.js";
import { makeNote } from "../src/send.js";

const ME = "did:web:inbox.test";

test("accepts a signed note once; a replay does not execute again", async () => {
  const inbox = createInbox(ME);
  const doc = makeNote(newIdentity(), ME, "t", "b");
  assert.equal((await inbox.receive(doc as any)).kind, "accepted");
  assert.equal((await inbox.receive(doc as any)).kind, "duplicate");
  assert.equal(inbox.notes.length, 1);
});

test("rejects tampered, unsigned and misaddressed documents", async () => {
  const inbox = createInbox(ME);
  const me = newIdentity();
  const tampered: any = makeNote(me, ME, "t", "b");
  tampered.payload.body = "x";
  const unsigned: any = makeNote(me, ME, "t", "b");
  delete unsigned.proof;
  const cases: [any, string][] = [[tampered, "proofInvalid"], [unsigned, "proofRequired"], [makeNote(me, "did:web:other", "t", "b"), "wrongRecipient"]];
  for (const [doc, code] of cases) {
    const v = await inbox.receive(doc);
    assert.equal(v.kind, "rejected");
    assert.equal((v as any).code, code);
  }
  assert.equal(inbox.notes.length, 0);
});

/** A note-shaped document of another `type`, signed by `me`: valid proof, right recipient, fresh. */
function signedAs(me: ReturnType<typeof newIdentity>, type: string) {
  return signTrustTask({ id: crypto.randomUUID(), type, issuer: me.did, recipient: ME, issuedAt: rfc3339(), payload: { title: "t", body: "b" } } as any, me.signer) as any;
}

test("accepts the explicit #request form of the note type", async () => {
  const inbox = createInbox(ME);
  assert.equal((await inbox.receive(signedAs(newIdentity(), `${NOTE_TYPE}#request`))).kind, "accepted");
});

test("refuses, with an error document, signed documents that are not a note request: a #response, an error, another task, another version", async () => {
  const inbox = createInbox(ME);
  const me = newIdentity();
  const cases: [string, string][] = [
    [NOTE_RESPONSE, "unsupportedType"],
    ["https://trusttasks.org/spec/trust-task-error/0.5", "unsupportedType"],
    ["https://trusttasks.org/spec/messaging/ping/0.1", "unsupportedType"],
    ["https://example.org/spec/buildathon/other/0.1", "unsupportedType"],
    ["https://example.org/spec/buildathon/note/1.0", "unsupportedVersion"],
    ["https://example.org/spec/buildathon/note/1.0#response", "unsupportedType"],
  ];
  for (const [type, code] of cases) {
    const doc = signedAs(me, type);
    const v: any = await inbox.receive(doc);
    assert.equal(v.kind, "rejected", type);
    assert.equal(v.code, code, type);
    assert.match(v.error.type, /^https:\/\/trusttasks\.org\/spec\/trust-task-error\//);
    assert.equal(v.error.threadId, doc.id);
    assert.equal(v.error.payload.code, code);
  }
  assert.equal(inbox.notes.length, 0);
});

test("the server maps codes to the HTTPS binding's statuses", async () => {
  const { statusForCode } = await import("../src/server.js");
  assert.deepEqual(
    ["malformedRequest", "permissionDenied", "idConflict", "unsupportedType", "proofInvalid", "wrongRecipient", "unavailable", "internalError"].map(statusForCode),
    [400, 403, 409, 422, 422, 422, 503, 500],
  );
});

test("makeNote on an exact second signs no .000Z issuedAt or proof.created", async (t) => {
  const { mock } = await import("node:test");
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-31T12:00:00.000Z") });
  t.after(() => mock.timers.reset());
  const doc: any = makeNote(newIdentity(), ME, "t", "b");
  assert.equal(doc.issuedAt, "2026-10-31T12:00:00Z");
  assert.equal(doc.proof.created, "2026-10-31T12:00:00Z");
});

test("signs notes for authentication; refuses a proof whose purpose is keyAgreement or unknown, even if the signature is good", async () => {
  const inbox = createInbox(ME);
  const me = newIdentity();
  assert.equal((makeNote(me, ME, "t", "b") as any).proof.proofPurpose, "authentication");
  for (const purpose of ["keyAgreement", "madeUp"]) {
    const doc = signTrustTask({ id: crypto.randomUUID(), type: NOTE_TYPE, issuer: me.did, recipient: ME, issuedAt: rfc3339(), payload: { title: "t", body: "b" } } as any, me.signer, { proofPurpose: purpose }) as any;
    const v: any = await inbox.receive(doc);
    assert.equal(v.kind, "rejected", purpose);
    assert.equal(v.code, "proofInvalid", purpose);
  }
  const ok = signTrustTask({ id: crypto.randomUUID(), type: NOTE_TYPE, issuer: me.did, recipient: ME, issuedAt: rfc3339(), payload: { title: "t", body: "b" } } as any, me.signer, { proofPurpose: "assertionMethod" }) as any;
  assert.equal((await inbox.receive(ok)).kind, "accepted");
});
