import assert from "node:assert/strict";
import { test } from "node:test";
import { communityNext, statusLines } from "../lib/rooms-status.js";

test("communityNext names the join command for the identity in use, and nothing once a member", () => {
  assert.match(communityNext({ persona: false, member: false })!, /vtc:join/);
  assert.match(communityNext({ persona: true, member: false })!, /rooms:persona -- join/);
  assert.equal(communityNext({ persona: true, member: true }), undefined);
});

test("an open room: offered then accepted", () => {
  const [a] = statusLines({ persona: false, member: true, offers: [{ roomId: "r", visibility: "open", state: "open" }], held: new Set() });
  assert.equal(a!.status, "offered");
  assert.match(a!.next, /rooms:accept -- r/);
  const [b] = statusLines({ persona: false, member: true, offers: [{ roomId: "r", visibility: "open", state: "accepted" }], held: new Set() });
  assert.equal(b!.status, "joined");
  assert.match(b!.next, /rooms:post -- r/);
});

test("a sealed room: the app did:key is told to make a persona; a persona accepts, then posts once the VTA holds the room", () => {
  const offer = [{ roomId: "s", visibility: "attributed", state: "open" }];
  assert.match(statusLines({ persona: false, member: true, offers: offer, held: new Set() })[0]!.next, /rooms:persona -- setup/);
  assert.match(statusLines({ persona: true, member: true, offers: offer, held: new Set() })[0]!.next, /rooms:accept -- s/);
  const joined = statusLines({ persona: true, member: true, offers: [{ ...offer[0]!, state: "accepted" }], held: new Set(["s"]) })[0]!;
  assert.equal(joined.status, "joined");
});
