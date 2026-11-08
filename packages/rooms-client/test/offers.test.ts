import assert from "node:assert/strict";
import { test } from "node:test";
import { offerFallbackPresenter, offerPresentation, type RoomOfferLike } from "../src/offers.js";
import type { Presenter } from "../src/host.js";

const open: RoomOfferLike = { roomId: "did:example:open", visibility: "open", credentials: { authority: "AUTH", membership: "MEMB", invitation: "INV" } };
const sealed: RoomOfferLike = { ...open, roomId: "did:example:sealed", visibility: "attributed" };
const refuse: Presenter = async () => { throw new Error("vta refused"); };
const fine: Presenter = async () => ({ presentation: { membership: "FROM-VTA", authority: ["X"] } });

test("offerPresentation is the membership credential plus the authority credential", () => {
  assert.deepEqual(offerPresentation(open), { membership: "MEMB", authority: ["AUTH"] });
});

test("offerPresentation refuses an offer without credentials", () => {
  assert.throws(() => offerPresentation({ roomId: "r" }), /no membership and authority/);
  assert.throws(() => offerPresentation({ roomId: "r", credentials: { authority: "A" } }), /no membership and authority/);
});

test("the fallback presenter prefers the VTA", async () => {
  const p = offerFallbackPresenter(fine, () => open);
  assert.equal((await p(open.roomId, "read")).presentation.membership, "FROM-VTA");
});

test("the fallback presenter uses the offer on an open room when the VTA refuses", async () => {
  const p = offerFallbackPresenter(refuse, (id) => (id === open.roomId ? open : undefined));
  assert.deepEqual((await p(open.roomId, "write")).presentation, { membership: "MEMB", authority: ["AUTH"] });
});

test("the fallback presenter rethrows the VTA's refusal for a sealed room, an unknown room or a credential-less offer", async () => {
  await assert.rejects(offerFallbackPresenter(refuse, () => sealed)(sealed.roomId, "read"), /vta refused/);
  await assert.rejects(offerFallbackPresenter(refuse, () => undefined)("did:example:none", "read"), /vta refused/);
  await assert.rejects(offerFallbackPresenter(refuse, () => ({ roomId: "r", visibility: "open" }))("r", "read"), /vta refused/);
});
