import assert from "node:assert/strict";
import { test } from "node:test";
import { ProfileResolver, identicon, makeProfile, shortDid, sniffImage } from "../src/index.js";

const ALICE = "did:key:z6MkAliceAliceAliceAliceAlice01";
const BOB = "did:key:z6MkBobBobBobBobBobBobBobBob0002";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const SVG = new TextEncoder().encode("<svg onload=alert(1)>");

test("a room profile authored by its subject resolves; newest version wins", () => {
  const r = new ProfileResolver();
  assert.equal(r.offer(makeProfile(ALICE, "Alice", { mediaType: "image/png", bytes: PNG }), ALICE, 3), true);
  assert.equal(r.offer(makeProfile(ALICE, "Old Alice"), ALICE, 2), false);
  const p = r.resolveSync(ALICE);
  assert.equal(p.source, "room");
  assert.equal(p.label, "Alice");
  assert.match(p.avatarUrl!, /^data:image\/png;base64,/);
  r.offer(makeProfile(ALICE, "Alice B."), ALICE, 7);
  assert.equal(r.resolveSync(ALICE).displayName, "Alice B.");
});

test("a profile whose record author is not its subject is ignored", () => {
  const r = new ProfileResolver();
  assert.equal(r.offer(makeProfile(ALICE, "Totally Alice"), BOB, 5), false);
  assert.equal(r.offer(makeProfile(ALICE, "No author"), undefined, 6), false, "private rooms have no author");
  const p = r.resolveSync(ALICE);
  assert.equal(p.source, "fallback");
  assert.equal(p.label, shortDid(ALICE));
});

test("avatars only when the bytes sniff as an image (the claimed type is ignored)", () => {
  const r = new ProfileResolver();
  r.offer(makeProfile(BOB, "Bob", { mediaType: "image/png", bytes: SVG }), BOB, 1);
  assert.equal(r.resolveSync(BOB).avatarUrl, undefined);
  assert.equal(sniffImage(SVG), undefined);
  assert.equal(sniffImage(PNG), "image/png");
  assert.equal(sniffImage(new TextEncoder().encode("GIF89a....")), "image/gif");
});

test("self: the VTC card is the second source, fetched once; 'You' is shown", async () => {
  let calls = 0;
  const r = new ProfileResolver({ self: ALICE, selfCard: async () => { calls++; return { displayName: "Alice (card)" }; } });
  const p = await r.resolve(ALICE);
  assert.equal(p.source, "card");
  assert.equal(p.displayName, "Alice (card)");
  assert.equal(p.label, "You");
  await r.resolve(ALICE);
  assert.equal(calls, 1);
  assert.equal((await r.resolve(BOB)).source, "fallback", "the card is never used for others");
  r.offer(makeProfile(ALICE, "Alice (room)"), ALICE, 1);
  assert.equal((await r.resolve(ALICE)).source, "room");
});

test("a failing card falls back to the DID", async () => {
  const r = new ProfileResolver({ self: ALICE, selfCard: async () => { throw new Error("no card"); } });
  const p = await r.resolve(ALICE);
  assert.equal(p.source, "fallback");
  assert.equal(p.short, `${ALICE.slice(0, 8)}…${ALICE.slice(-6)}`);
});

test("identicons are stable, mirrored, and differ by DID", () => {
  const a = identicon(ALICE);
  assert.deepEqual(a, identicon(ALICE));
  assert.ok(a.cells.every((row) => row[0] === row[4] && row[1] === row[3]));
  assert.notDeepEqual(a, identicon(BOB));
  assert.equal(shortDid("did:key:z6Mk"), "did:key:z6Mk");
});
