import assert from "node:assert/strict";
import { test } from "node:test";
import { tspMediatorOf } from "@starter/tsp-client";
import { applicant, applicantOverride } from "../lib/applicant.js";

const seed = Uint8Array.from({ length: 32 }, (_, i) => 32 - i);
const MEDIATOR = "did:webvh:QmSCID:med-x.trycloudflare.com";

test("applicantOverride: VTC_APPLICANT is did:key, did:peer or unset; a typo is refused", () => {
  assert.equal(applicantOverride(undefined), undefined);
  assert.equal(applicantOverride("  "), undefined);
  assert.equal(applicantOverride("did:key"), "did:key");
  assert.equal(applicantOverride(" Key "), "did:key");
  assert.equal(applicantOverride("did:peer"), "did:peer");
  assert.equal(applicantOverride("peer"), "did:peer");
  assert.throws(() => applicantOverride("did:web"), /did:key or did:peer/);
});

test("MODE=tunnel defaults to the did:peer:2 naming the mediator, with its own request id", () => {
  const p = applicant(seed, { mode: "tunnel", mediatorDid: MEDIATOR });
  assert.equal(p.kind, "did:peer");
  assert.match(p.identity.did, /^did:peer:2\./);
  assert.equal(tspMediatorOf(p.identity.did), MEDIATOR);
  assert.equal(p.requestIdKey, "VTC_PEER_REQUEST_ID");
  assert.equal(p.identity.signer.did, p.identity.did);
  assert.equal(p.fallback, undefined);
  assert.ok(new TextEncoder().encode(p.identity.did).length < 1000);
  // VTC_APPLICANT=did:peer is harmless: the same choice.
  assert.equal(applicant(seed, { mode: "tunnel", mediatorDid: MEDIATOR, override: "did:peer" }).identity.did, p.identity.did);
});

test("VTC_APPLICANT=did:key keeps the did:key in tunnel mode", () => {
  const k = applicant(seed, { mode: "tunnel", mediatorDid: MEDIATOR, override: "did:key" });
  assert.equal(k.kind, "did:key");
  assert.match(k.identity.did, /^did:key:z6Mk/);
  assert.equal(k.requestIdKey, "VTC_REQUEST_ID");
  assert.match(k.note, /VTC_APPLICANT=did:key/);
  assert.equal(k.fallback, undefined);
});

test("local and farm stay did:key whatever VTC_APPLICANT says", () => {
  for (const mode of ["local", "farm"]) {
    for (const override of [undefined, "did:peer" as const]) {
      const a = applicant(seed, { mode, mediatorDid: MEDIATOR, override });
      assert.equal(a.kind, "did:key");
      assert.match(a.note, new RegExp(`MODE=${mode}.*not pushed`));
    }
  }
});

test("tunnel falls back to the did:key, with the reason, when the did:peer cannot be built", () => {
  const none = applicant(seed, { mode: "tunnel" });
  assert.equal(none.kind, "did:key");
  assert.match(none.fallback ?? "", /no mediator DID/);
  const big = applicant(seed, { mode: "tunnel", mediatorDid: "did:peer:2." + "x".repeat(700) });
  assert.equal(big.kind, "did:key");
  assert.match(big.fallback ?? "", /1000-byte limit/);
  assert.match(big.note, /could not be built/);
});
