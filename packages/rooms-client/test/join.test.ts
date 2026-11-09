import assert from "node:assert/strict";
import { test } from "node:test";
import { joinFromOffer } from "../src/join.js";

const calls: string[] = [];
const vtc = { acceptRoomOffer: async (roomId: string, kp?: string) => { calls.push(`accept:${kp ?? "-"}`); return kp ? { epoch: 4, welcome: "W", ratchetTree: "T" } : { epoch: 1 }; } };
const keys = {
  keyPackage: async (_r: string, inv: string) => { calls.push(`kp:${inv}`); return { keyPackage: "KP" }; },
  welcome: async (_r: string, w: string, inv: string, t?: string) => { calls.push(`welcome:${w}:${inv}:${t}`); return { epoch: 4 }; },
};

test("an open room is just the accept, no key service needed", async () => {
  calls.length = 0;
  const r = await joinFromOffer(vtc, undefined, { roomId: "r", visibility: "open" });
  assert.deepEqual(r, { roomId: "r", sealed: false, epoch: 1, steps: ["offers/accept"] });
  assert.deepEqual(calls, ["accept:-"]);
});

test("a sealed room runs key-package, accept with the KeyPackage, then welcome with the Welcome and tree", async () => {
  calls.length = 0;
  const r = await joinFromOffer(vtc, keys, { roomId: "r", visibility: "attributed", credentials: { invitation: "INV" } as any });
  assert.deepEqual(calls, ["kp:INV", "accept:KP", "welcome:W:INV:T"]);
  assert.equal(r.sealed, true);
  assert.equal(r.epoch, 4);
});

test("a sealed room without an invitation or a key service is refused before anything is sent", async () => {
  calls.length = 0;
  await assert.rejects(joinFromOffer(vtc, keys, { roomId: "r", visibility: "attributed" }), /no invitation/);
  await assert.rejects(joinFromOffer(vtc, undefined, { roomId: "r", visibility: "private", credentials: { invitation: "I" } as any }), /needs the member's VTA/);
  assert.deepEqual(calls, []);
});

test("a host that returns no Welcome stops before the VTA is asked to join", async () => {
  calls.length = 0;
  const noWelcome = { acceptRoomOffer: async () => ({ epoch: 2 }) };
  await assert.rejects(joinFromOffer(noWelcome, keys, { roomId: "r", visibility: "attributed", credentials: { invitation: "I" } as any }), /no Welcome/);
  assert.deepEqual(calls, ["kp:I"]);
});
