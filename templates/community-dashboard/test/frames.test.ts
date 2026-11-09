// The "Credential frames" panel's pure logic: mode gating, frame words, tally and verdict, and the connect-failure explanation.
import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyTally, ISSUE_TYPE, record } from "@starter/tsp-client";
import { ConnectTimeout, connectFailureText, frameKind, framesGate, framesVerdict, mediatorHostOf, NOT_DELIVERED_FLAG, ONE_LISTENER, tallyLine } from "../src/frames.ts";

const MED = "did:webvh:QmScid:med.example.test";

test("listening is offered only in tunnel mode with a known mediator", () => {
  const local = framesGate("local", { kind: "did:key", mediatorDid: null });
  assert.equal(local.listen, false);
  assert.match(!local.listen ? `${local.title} ${local.text}` : "", /No mediator in local mode.*MODE=tunnel turns messaging on/);
  const farm = framesGate("farm", { kind: "did:key", mediatorDid: MED });
  assert.ok(!farm.listen && /Not available in farm mode/.test(farm.title) && /no mediator/.test(farm.text));
  const down = framesGate("tunnel", { kind: "did:key", mediatorDid: null });
  assert.ok(!down.listen && /tunnel stack up/.test(down.text));
  assert.deepEqual(framesGate("tunnel", { kind: "did:peer", mediatorDid: MED }), { listen: true, relate: false, mediatorDid: MED });
  assert.deepEqual(framesGate("tunnel", { kind: "did:key", mediatorDid: MED }), { listen: true, relate: true, mediatorDid: MED }, "a did:key invites first, as tsp:listen does");
});

test("each frame kind has its own words; the credential is never read", () => {
  assert.equal(frameKind({ control: "invite" }), "relationship invite");
  assert.equal(frameKind({ control: "accept" }), "relationship accept");
  assert.equal(frameKind({ control: "close" }), "relationship close");
  assert.equal(frameKind({ documentType: ISSUE_TYPE }), "credential-exchange/issue/0.1");
  assert.equal(frameKind({ documentType: "https://example.test/x" }), "other document: https://example.test/x");
  assert.equal(frameKind({ documentType: undefined }), "other document: (no document type)");
  assert.equal(frameKind({ unreadable: "sealed by did:x, not the peer" }), "unreadable, or not from the VTC");
});

test("the tally and verdict count frames and never claim credentialsDelivered", () => {
  assert.equal(tallyLine(emptyTally()), "0 frames: 0 invite, 0 accept, 0 credential-exchange/issue, 0 other, 0 unreadable");
  assert.match(framesVerdict(emptyTally()), /^No credential-exchange\/issue\/0\.1 frame yet/);
  const t = [{ control: "invite" }, { documentType: ISSUE_TYPE }, { unreadable: "x" }].reduce(record, emptyTally());
  assert.equal(tallyLine(t), "3 frames: 1 invite, 0 accept, 1 credential-exchange/issue, 0 other, 1 unreadable");
  assert.match(framesVerdict(t), /^1 credential-exchange\/issue\/0\.1 frame arrived/);
  assert.match(framesVerdict(t), /can bind to it/);
  assert.match(framesVerdict(t), /does not verify that credential's proof/);
  assert.match(NOT_DELIVERED_FLAG, /^Frames arriving is not credentialsDelivered/);
  assert.match(NOT_DELIVERED_FLAG, /vtc\/members\/vmc\/0\.1/);
  assert.match(ONE_LISTENER, /npm run tsp:listen.*may go to that listener/);
});

test("the mediator host comes from its did:webvh", () => {
  assert.equal(mediatorHostOf(MED), "med.example.test");
  assert.equal(mediatorHostOf("did:webvh:QmScid:localhost%3A7037:path"), "localhost:7037");
  assert.equal(mediatorHostOf("did:peer:2.Vz"), undefined);
  assert.equal(mediatorHostOf("did:webvh:QmScid"), undefined);
});

test("a failed connect names the exact MEDIATOR_CORS_ALLOW_ORIGIN line, also when the resolver wrapped the fetch error", () => {
  const origin = "http://localhost:5173";
  for (const e of [new Error("did:webvh resolve failed: invalidDid — Failed to fetch"), new TypeError("NetworkError when attempting to fetch resource."), new Error("WebSocket error")]) {
    const m = connectFailureText(e, origin, MED);
    assert.match(m, /^Could not start listening: /);
    assert.match(m, /^MEDIATOR_CORS_ALLOW_ORIGIN=http:\/\/localhost:5173$/m, e.message);
    assert.match(m, /MEDIATOR_PUBLIC_HOST=med\.example\.test MEDIATOR_CORS_ALLOW_ORIGIN=http:\/\/localhost:5173 docker compose --profile messaging up -d mediator/);
  }
  const other = connectFailureText(new Error("authcrypt requires the public key of sender"), origin, MED);
  assert.doesNotMatch(other, /MEDIATOR_CORS_ALLOW_ORIGIN/, "an unrelated error is shown as it is");
  const slow = connectFailureText(new ConnectTimeout(20_000), origin, MED);
  assert.match(slow, /no answer from the mediator within 20 s/);
  assert.match(slow, /npm run doctor/);
});
