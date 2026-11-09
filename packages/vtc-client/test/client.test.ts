// No VTC needed: a fake fetch plays the community.
import assert from "node:assert/strict";
import { test } from "node:test";
import { newIdentity } from "@starter/vta-client";
import { TrustTaskError, VTC_TASK, VtcClient, pickCriterion } from "../src/index.js";

const VTC_DID = "did:webvh:Qmfake:localhost%3A8200";
const didLog = JSON.stringify({ state: { id: VTC_DID } });

function fakeVtc(handler: (doc: any, url: string) => unknown, seen: any[] = []): typeof fetch {
  return (async (input: any, init?: any) => {
    const url = String(input);
    if (url.endsWith("/.well-known/did.jsonl")) return new Response(didLog);
    const doc = JSON.parse(init.body);
    seen.push({ url, doc });
    const out = handler(doc, url);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify({ type: doc.type + "#response", payload: out }));
  }) as typeof fetch;
}

test("connect resolves the VTC DID and posts to /v1/trust-tasks addressed to it", async () => {
  const seen: any[] = [];
  const me = newIdentity();
  const c = await VtcClient.connect("http://localhost:8200/", me, fakeVtc(() => ({ communityDid: VTC_DID, criteria: [] }), seen));
  assert.equal(c.vtcDid, VTC_DID);
  await c.manifest();
  assert.equal(seen[0].url, "http://localhost:8200/v1/trust-tasks");
  assert.equal(seen[0].doc.type, VTC_TASK.manifestV04);
  assert.equal(seen[0].doc.recipient, VTC_DID);
  assert.equal(seen[0].doc.issuer, me.did);
  assert.ok(seen[0].doc.proof);
});

test("manifest falls back to 0.3 when 0.4 is unsupported", async () => {
  const seen: any[] = [];
  const f = fakeVtc((doc) =>
    doc.type === VTC_TASK.manifestV04
      ? new Response(JSON.stringify({ type: "https://trusttasks.org/spec/trust-task-error/0.5", payload: { code: "unsupportedType" } }), { status: 400 })
      : { communityDid: VTC_DID, criteria: [{ id: "open", requirementsDigest: "uabc", admission: "automatic" }] },
  seen);
  const c = await VtcClient.connect("http://x", newIdentity(), f);
  const m = await c.manifest();
  assert.equal(m.criteria[0].requirementsDigest, "uabc");
  assert.deepEqual(seen.map((s) => s.doc.type), [VTC_TASK.manifestV04, VTC_TASK.manifestV03]);
});

test("submitJoin sends a holder-bound empty VP and the chosen criterion", async () => {
  const seen: any[] = [];
  const me = newIdentity();
  const c = await VtcClient.connect("http://x", me, fakeVtc(() => ({ requestId: "r1", verdict: { outcome: "allow" } }), seen));
  const r = await c.submitJoin({ criterion: "uabc", attributes: [{ type: "name.display", value: "Ada" }] });
  assert.equal(r.requestId, "r1");
  const p = seen[0].doc.payload;
  assert.equal(seen[0].doc.type, VTC_TASK.joinSubmit);
  assert.deepEqual(p.vp, { type: "VerifiablePresentation", holder: me.did });
  assert.equal(p.criterion, "uabc");
  assert.equal(p.registryConsent, false);
  assert.equal(p.attributes[0].type, "name.display");
});

test("errors surface as TrustTaskError", async () => {
  const f = fakeVtc(() => new Response(JSON.stringify({ type: "https://trusttasks.org/spec/trust-task-error/0.5", payload: { code: "vtc/join-requests/submit:notAccepting" } }), { status: 422 }));
  const c = await VtcClient.connect("http://x", newIdentity(), f);
  await assert.rejects(c.submitJoin(), (e: any) => e instanceof TrustTaskError && e.status === 422);
});

test("authenticate stores the access token; decideJoin uses spec field names", async () => {
  const seen: any[] = [];
  const f = fakeVtc((doc) =>
    doc.type === VTC_TASK.challenge ? { challenge: "ch", sessionId: "s" }
    : doc.type === VTC_TASK.authenticate ? { tokens: { accessToken: "tok" } }
    : {}, seen);
  const c = await VtcClient.connect("http://x", newIdentity(), f);
  assert.equal(await c.authenticate(), "tok");
  // The session is bound to the signer's did:key so whoami can find it.
  assert.equal(seen.find((x) => x.doc.type === VTC_TASK.authenticate).doc.payload.sessionKey, c.me.did);
  await c.decideJoin("r1", "approved");
  assert.deepEqual(seen.at(-1).doc.payload, { id: "r1", decision: "approved" });
});

test("a known DID skips the did.jsonl fetch", async () => {
  const f = (async () => { throw new Error("no network"); }) as unknown as typeof fetch;
  const c = await VtcClient.connect("http://x", newIdentity(), f, "did:webvh:known");
  assert.equal(c.vtcDid, "did:webvh:known");
});

test("pickCriterion skips criteria an empty VP cannot meet (shape seen live on vtc 0.13.0)", () => {
  const m = {
    communityDid: VTC_DID,
    criteria: [
      { id: "invited", admission: "automatic", invitationRequired: true, requirementsDigest: "u1" },
      { id: "member-credential", admission: "automatic", presentationDefinition: { credentials: [] }, requirementsDigest: "u2" },
      { id: "review", admission: "review", requirementsDigest: "u3" },
    ],
  };
  assert.equal(pickCriterion(m)?.id, "review");
  assert.equal(pickCriterion({ communityDid: VTC_DID, criteria: [] }), undefined);
});

test("live response shapes: refer verdict, status without vmc, list with null nextCursor", async () => {
  const c = await VtcClient.connect(
    "http://localhost:8200",
    newIdentity(),
    fakeVtc((doc) => {
      if (doc.type === VTC_TASK.joinSubmit) return { requestId: "r1", verdict: { effect: "refer", with: { queue: "admin-review" } } };
      if (doc.type === VTC_TASK.joinStatus) return { requestId: "r1", status: "approved", credentialsDelivered: false };
      if (doc.type === VTC_TASK.joinList) return { items: [], nextCursor: null, totalEstimate: 0 };
      return {};
    }),
  );
  assert.equal((await c.submitJoin({ criterion: "u3" })).verdict.effect, "refer");
  const s = await c.joinStatus();
  assert.equal(s.status, "approved");
  assert.equal(s.vmc, undefined); // delivery is over messaging, not in the status response
  assert.deepEqual((await c.listJoinRequests({ status: "pending" })).items, []);
});

test("admin lists use 0.2 and fall back to 0.1 only when 0.2 is unsupported", async () => {
  const seen: any[] = [];
  const c = await VtcClient.connect("http://localhost:8200", newIdentity(), fakeVtc((doc) => {
    if (doc.type === VTC_TASK.membersList) return { items: [{ did: "did:key:z6Mkx", role: "member" }], nextCursor: null, totalEstimate: 1 };
    if (doc.type === VTC_TASK.joinList) return new Response(JSON.stringify({ type: "https://trusttasks.org/spec/trust-task-error/0.5", payload: { code: "unsupportedVersion" } }), { status: 400 });
    if (doc.type === VTC_TASK.joinListV01) return { items: [{ id: "r1" }] };
    return {};
  }, seen));
  assert.match(VTC_TASK.membersList, /members\/list\/0\.2$/);
  assert.match(VTC_TASK.joinList, /join-requests\/list\/0\.2$/);
  assert.equal((await c.listMembers({ role: "member" })).totalEstimate, 1);
  assert.equal((await c.listJoinRequests({ status: "pending" })).items[0].id, "r1");
  assert.deepEqual(seen.map((s) => s.doc.type.split("/vtc/")[1]), ["members/list/0.2", "join-requests/list/0.2", "join-requests/list/0.1"]);
});

// --- member surface (sessionless) ---------------------------------------------------------

test("member helpers sign a document of the right type and payload", async () => {
  const seen: any[] = [];
  const me = newIdentity();
  const c = await VtcClient.connect("http://x", me, fakeVtc(() => ({ ok: true }), seen));
  await c.withdrawJoin({ requestId: "r1", reason: "changed my mind" });
  await c.renewMembership();
  await c.communityProfile();
  await c.directoryEntries({ query: "ada", limit: 5 });
  await c.directoryQuery("did:key:z6Mkx", "name");
  await c.myCard();
  await c.updateMyCard({ values: { bio: "hi" }, expectedRevision: 2 });
  await c.groups({ mine: true });
  await c.joinGroup("g1");
  await c.groupMembers("g1", { limit: 10 });
  const got = seen.map((s) => [s.doc.type.replace("https://trusttasks.org/spec/", ""), s.doc.payload]);
  assert.deepEqual(got, [
    ["vtc/join-requests/withdraw/0.1", { requestId: "r1", reason: "changed my mind" }],
    ["vtc/members/renew/0.1", {}],
    ["vtc/community/profile/show/0.1", {}],
    ["vtc/directory/entries/list/0.2", { query: "ada", limit: 5 }],
    ["vtc/directory/query/0.1", { subject: "did:key:z6Mkx", fields: "name" }],
    ["vtc/directory/card/show/0.1", {}],
    ["vtc/directory/card/update/0.1", { values: { bio: "hi" }, expectedRevision: 2 }],
    ["vtc/groups/list/0.2", { mine: true }],
    ["vtc/groups/join/0.1", { groupId: "g1" }],
    ["vtc/groups/members/list/0.2", { groupId: "g1", limit: 10 }],
  ]);
  for (const s of seen) {
    assert.equal(s.doc.issuer, me.did);
    assert.ok(s.doc.proof);
  }
});

test("leaveCommunity refuses to run without an explicit confirmation", async () => {
  const seen: any[] = [];
  const c = await VtcClient.connect("http://x", newIdentity(), fakeVtc(() => ({ disposition: "tombstoned" }), seen));
  assert.throws(() => c.leaveCommunity({ confirm: false }), /confirm: true/);
  assert.throws(() => (c as any).leaveCommunity({}), /confirm: true/);
  assert.equal(seen.length, 0);
  await c.leaveCommunity({ confirm: true });
  assert.equal(seen[0].doc.type, VTC_TASK.membersSelfRemove);
});

test("a refusal for a non-member surfaces as TrustTaskError with the code", async () => {
  const f = fakeVtc(() => new Response(JSON.stringify({ type: "https://trusttasks.org/spec/trust-task-error/0.5", payload: { code: "vtc/directory/card/show:notMember", message: "not an active member" } }), { status: 422 }));
  const c = await VtcClient.connect("http://x", newIdentity(), f);
  await assert.rejects(c.myCard(), (e: any) => e instanceof TrustTaskError && e.status === 422 && /notMember/.test(JSON.stringify(e.body)));
});

test("portalSignIn mints a self-issued SIOP id_token bound to the challenge and the VTC, then portalMe reads /member/me", async () => {
  const me = newIdentity();
  const calls: any[] = [];
  const f = (async (input: any, init?: any) => {
    const url = String(input);
    if (url.endsWith("/.well-known/did.jsonl")) return new Response(didLog);
    calls.push({ url, init });
    if (url.endsWith("/v1/member/wallet/auth/challenge")) return new Response(JSON.stringify({ challenge: "abc123", sessionId: "s1" }));
    if (url.endsWith("/v1/member/wallet/auth/")) return new Response(JSON.stringify({ session: { expiresAt: "2030-01-01T00:00:00Z" }, tokens: { accessToken: "tok", refreshToken: "ref" } }));
    if (url.endsWith("/v1/member/me")) return new Response(JSON.stringify({ did: me.did, role: "member", joinedAt: "2026-01-01T00:00:00Z", personhood: false }));
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  const c = await VtcClient.connect("http://x", me, f);
  const proof = await c.memberProof();
  assert.equal(proof.role, "member");
  assert.equal(JSON.parse(calls[0].init.body).did, me.did);
  const authBody = JSON.parse(calls[1].init.body);
  assert.equal(authBody.type, VTC_TASK.authenticate);
  assert.equal(authBody.payload.session_id, "s1");
  const [h, p] = authBody.payload.id_token.split(".").slice(0, 2).map((x: string) => JSON.parse(Buffer.from(x, "base64url").toString()));
  assert.equal(h.alg, "EdDSA");
  assert.equal(h.kid.split("#")[0], me.did);
  assert.deepEqual([p.iss, p.sub, p.aud, p.nonce], [me.did, me.did, VTC_DID, "abc123"]);
  assert.equal(calls[2].init.headers.authorization, "Bearer tok");
});

test("onCall reports each call with type, signer, timing and the signed request; it is optional", async () => {
  const me = newIdentity();
  const c = await VtcClient.connect("http://x", me, fakeVtc((doc) => (doc.type === VTC_TASK.joinStatus ? { requestId: "r1", status: "pending" } : new Response(JSON.stringify({ type: "https://trusttasks.org/spec/trust-task-error/0.5", payload: { code: "urn:fake:notMember" } }), { status: 403 }))));
  await c.joinStatus(); // no observer: still works
  const events: any[] = [];
  c.onCall = (e) => events.push(e);
  await c.joinStatus();
  await assert.rejects(() => c.myCard(), TrustTaskError);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, VTC_TASK.joinStatus);
  assert.equal(events[0].issuer, me.did);
  assert.equal(events[0].ok, true);
  assert.equal(events[0].status, 200);
  assert.equal(typeof events[0].durationMs, "number");
  assert.equal(events[0].request.type, VTC_TASK.joinStatus);
  assert.ok(events[0].request.proof);
  assert.equal(events[1].ok, false);
  assert.equal(events[1].status, 403);
  assert.equal(events[1].code, "urn:fake:notMember");
});

test("a throwing onCall observer does not break the call, and a network failure is reported", async () => {
  const me = newIdentity();
  const c = await VtcClient.connect("http://x", me, fakeVtc(() => ({ requestId: "r1", status: "pending" })));
  c.onCall = () => { throw new Error("observer bug"); };
  assert.equal((await c.joinStatus()).status, "pending");
  const down = new VtcClient("http://x", VTC_DID, me, (async () => { throw new TypeError("fetch failed"); }) as typeof fetch);
  const events: any[] = [];
  down.onCall = (e) => events.push(e);
  await assert.rejects(() => down.joinStatus(), TypeError);
  assert.equal(events[0].code, "network");
  assert.equal(events[0].status, undefined);
});

test("joinPayload returns what submitJoin signs, without sending", async () => {
  const seen: any[] = [];
  const me = newIdentity();
  const c = await VtcClient.connect("http://x", me, fakeVtc(() => ({ requestId: "r1" }), seen));
  const p = c.joinPayload({ criterion: "uabc" });
  assert.equal(seen.length, 0);
  assert.equal(p.criterion, "uabc");
  assert.equal((p.vp as any).holder, me.did);
  await c.submitJoin({ criterion: "uabc" });
  assert.deepEqual(seen[0].doc.payload, p);
});

test("on an exact second, VtcClient.call never signs a .000Z issuedAt or proof.created", async (t) => {
  const { mock } = await import("node:test");
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-31T12:00:00.000Z") });
  t.after(() => mock.timers.reset());
  const seen: any[] = [];
  const c = await VtcClient.connect("http://vtc.test", newIdentity(), fakeVtc(() => ({}), seen));
  await c.joinStatus();
  assert.equal(seen[0].doc.issuedAt, "2026-10-31T12:00:00Z");
  assert.equal(seen[0].doc.proof.created, "2026-10-31T12:00:00Z");
});

test("manifest steps down only on unsupportedVersion/unsupportedType, and follows details.servedVersions", async () => {
  const ERR = "https://trusttasks.org/spec/trust-task-error/0.5";
  const run = async (payload: Record<string, unknown>) => {
    const seen: any[] = [];
    const c = await VtcClient.connect("http://x", newIdentity(), fakeVtc((doc) =>
      doc.type === VTC_TASK.manifestV04
        ? new Response(JSON.stringify({ type: ERR, payload }), { status: 422 })
        : { communityDid: VTC_DID, criteria: [] }, seen));
    const r = await c.manifest().then(() => "ok", (e) => e);
    return { r, types: seen.map((s) => s.doc.type) };
  };
  // A message that mentions a version, or another code, is not a reason to downgrade.
  for (const p of [{ code: "taskFailed", message: "unsupported version of something" }, { code: "unsupportedExtension" }, { code: "malformedRequest", message: "version" }]) {
    const { r, types } = await run(p);
    assert.ok(r instanceof TrustTaskError, JSON.stringify(p));
    assert.deepEqual(types, [VTC_TASK.manifestV04]);
  }
  assert.deepEqual((await run({ code: "unsupportedVersion", details: { servedVersions: [VTC_TASK.manifestV03] } })).types, [VTC_TASK.manifestV04, VTC_TASK.manifestV03]);
  const none = await run({ code: "unsupportedVersion", details: { servedVersions: ["0.2"] } });
  assert.ok(none.r instanceof TrustTaskError);
  assert.deepEqual(none.types, [VTC_TASK.manifestV04]);
});
