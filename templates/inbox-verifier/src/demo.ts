// Self-contained end-to-end run: start the inbox, send a good note, replay it,
// tamper with one, misaddress one, send a malformed one and one of another type. Exits non-zero if any verdict is wrong.
import assert from "node:assert/strict";
import { newIdentity } from "@starter/vta-client";
import { NOTE_TYPE } from "./inbox.js";
import { startServer } from "./server.js";
import { makeNote, post } from "./send.js";

const s = await startServer(0);
const me = newIdentity();
try {
  const good = makeNote(me, s.did, "hello", "world");
  const r1 = await post(s.url, good);
  console.log("good      ->", r1.status, r1.body.type);
  assert.equal(r1.status, 200);

  const r2 = await post(s.url, good);
  console.log("replay    ->", r2.status, r2.body?.type ?? "(prior response / no body)");
  assert.ok(r2.status === 200 || r2.status === 204);
  const notes = await (await fetch(`${s.url}/notes`)).json();
  assert.equal(notes.length, 1, "replay must not execute twice");

  const bad: any = makeNote(me, s.did, "x", "y");
  bad.payload.body = "tampered";
  const r3 = await post(s.url, bad);
  console.log("tampered  ->", r3.status, r3.body.payload?.code);
  assert.equal(r3.status, 422);
  assert.equal(r3.body.payload?.code, "proofInvalid");

  const r4 = await post(s.url, makeNote(me, "did:web:someone.else", "x", "y"));
  console.log("wrong rcpt->", r4.status, r4.body.payload?.code);
  assert.equal(r4.status, 422);
  assert.equal(r4.body.payload?.code, "wrongRecipient");

  const r5 = await post(s.url, makeNote(me, s.did, "", "y"));
  console.log("bad payload->", r5.status, r5.body.payload?.code);
  assert.equal(r5.status, 400);
  assert.equal(r5.body.payload?.code, "malformedRequest");

  // A signed, fresh, correctly addressed document of another type (here: a forged "#response") is not a note.
  const r6 = await post(s.url, makeNote(me, s.did, "x", "y", `${NOTE_TYPE}#response`));
  console.log("wrong type->", r6.status, r6.body.payload?.code);
  assert.equal(r6.status, 422);
  assert.equal(r6.body.payload?.code, "unsupportedType");
  console.log("OK: accepted once, replay not re-executed, tamper/misaddress/malformed/wrong type rejected");
} finally {
  await s.close();
}
