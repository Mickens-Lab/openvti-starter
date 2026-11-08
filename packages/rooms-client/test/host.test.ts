import assert from "node:assert/strict";
import { test } from "node:test";
import { TrustTaskError, newIdentity } from "@starter/vta-client";
import { HostClient, isVersionConflict, roomHostTransport, type Presenter } from "../src/index.js";
import { MockRoomHost, mockPresentation } from "../src/mock/index.js";

const ROOM = "did:example:room-open";
const presenterFor = (did: string): Presenter => async (roomId, action) => ({ presentation: mockPresentation(roomId, did, action) });

function setup(visibility: "open" | "attributed" = "open") {
  const host = new MockRoomHost();
  host.createRoom(ROOM, visibility);
  const me = newIdentity();
  return { host, me, client: new HostClient(host.transport(me), presenterFor(me.did)) };
}

test("put assigns room-wide rising versions; list pages over 500 records to the end", async () => {
  const { client } = setup();
  for (let i = 0; i < 1203; i++) await client.put(ROOM, { key: `chat/${String(i).padStart(5, "0")}`, cleartext: { body: `m${i}` } });
  const page = await client.listPage(ROOM, { limit: 9999 });
  assert.equal(page.records.length, 500);
  assert.equal(page.nextCursor, "v500");
  const all = await client.list(ROOM);
  assert.equal(all.records.length, 1203);
  assert.equal(all.headVersion, 1203);
  assert.deepEqual(all.records.map((r) => r.version), Array.from({ length: 1203 }, (_, i) => i + 1));
  const since = await client.list(ROOM, { sinceVersion: 1200 });
  assert.deepEqual(since.records.map((r) => r.version), [1201, 1202, 1203]);
  assert.equal((await client.list(ROOM, { prefix: "chat/0000" })).records.length, 10);
});

test("expectedVersion conflicts and create-only", async () => {
  const { client } = setup();
  const a = await client.put(ROOM, { key: "note/a", expectedVersion: 0, cleartext: { body: "one" } });
  await client.put(ROOM, { key: "note/b", cleartext: { body: "x" } });
  await assert.rejects(client.put(ROOM, { key: "note/a", expectedVersion: 0, cleartext: { body: "dup" } }), (e) => isVersionConflict(e));
  const b = await client.put(ROOM, { key: "note/a", expectedVersion: a.version, cleartext: { body: "two" } });
  assert.equal(b.version, 3);
  await assert.rejects(client.put(ROOM, { key: "note/a", expectedVersion: a.version, cleartext: { body: "stale" } }), (e) => isVersionConflict(e));
  const g = await client.get(ROOM, "note/a");
  assert.equal(g.record.cleartext?.body, "two");
  assert.equal(g.headVersion, 3);
});

test("sealed tier: cleartext refused, create-only enforced client side, no author on private", async () => {
  const { host, client, me } = setup("attributed");
  await assert.rejects(client.put(ROOM, { key: "a".repeat(22), expectedVersion: 0, cleartext: { body: "leak" } }), (e: any) => e instanceof TrustTaskError && e.code === "rooms:cleartextOnSealedRoom");
  await assert.rejects(client.put(ROOM, { key: "a".repeat(22), sealed: { ciphertext: "AA", nonce: "BB", epoch: 1 } }), /create-only/);
  const r = await client.put(ROOM, { key: "a".repeat(22), expectedVersion: 0, sealed: { ciphertext: "AA", nonce: "BB", epoch: 1, version: 1 } });
  assert.equal(r.epoch, 1);
  assert.equal((await client.get(ROOM, "a".repeat(22))).record.author, me.did);
  host.createRoom("did:example:private", "private");
  await client.put("did:example:private", { key: "b".repeat(22), expectedVersion: 0, sealed: { ciphertext: "AA", nonce: "BB", epoch: 1 } });
  assert.equal((await client.get("did:example:private", "b".repeat(22))).record.author, undefined);
});

test("a presentation for another room or action is refused", async () => {
  const { host, me } = setup();
  const wrong = new HostClient(host.transport(me), async (_r, a) => ({ presentation: mockPresentation("did:example:other", me.did, a) }));
  await assert.rejects(wrong.list(ROOM), (e: any) => e.code === "rooms:presentationMismatch");
  const readOnly = new HostClient(host.transport(me), async (r) => ({ presentation: mockPresentation(r, me.did, "read") }));
  await assert.rejects(readOnly.put(ROOM, { key: "x", cleartext: { body: "b" } }), (e: any) => e.code === "permissionDenied");
});

test("presentations are cached until close to expiry", async () => {
  const host = new MockRoomHost();
  host.createRoom(ROOM, "open");
  const me = newIdentity();
  let minted = 0;
  let now = 0;
  const c = new HostClient(host.transport(me), async (r, a) => { minted++; return { presentation: mockPresentation(r, me.did, a), expiresAt: new Date(3600_000).toISOString() }; }, () => now);
  await c.list(ROOM); await c.list(ROOM);
  assert.equal(minted, 1);
  now = 3600_000 - 60_000;
  await c.list(ROOM);
  assert.equal(minted, 2);
});

test("blob round trip over signed documents through fetch, chunks signed by a fresh upload key", async () => {
  const host = new MockRoomHost();
  host.createRoom(ROOM, "open");
  const me = newIdentity();
  const t = roomHostTransport({ url: "http://room-host.test", hostDid: host.hostDid, me, fetch: host.fetchHandler() });
  const c = new HostClient(t, presenterFor(me.did));
  const bytes = new Uint8Array(70_000).map((_, i) => (i * 7) % 256);
  const up = await c.blobUpload(ROOM, bytes, { chunkSize: 16 * 1024 });
  assert.equal(up.size, 70_000);
  const chunkSigners = host.calls.filter((x) => x.type.includes("/upload/chunk/") || x.type.includes("/upload/commit/")).map((x) => x.signer);
  assert.equal(chunkSigners.length, 6);
  assert.equal(new Set(chunkSigners).size, 1);
  assert.notEqual(chunkSigners[0], me.did);
  await c.put(ROOM, { key: "file/1", cleartext: { body: "{}" }, blobs: [up.blobRef] });
  assert.deepEqual(await c.blobDownload(ROOM, up.blobRef), bytes);
  await assert.rejects(c.blobDownload(ROOM, "zNope"), /manifest|blobNotFound/);
});

test("fetch handler refuses a forged document and surfaces a 429 Retry-After", async () => {
  const host = new MockRoomHost();
  host.createRoom(ROOM, "open");
  const me = newIdentity();
  const f = host.fetchHandler();
  const forged = await f("http://h/trust-tasks", { method: "POST", body: JSON.stringify({ type: "x", issuer: me.did, recipient: host.hostDid, payload: {} }) });
  assert.equal(forged.status, 401);
  host.inject = () => ({ status: 429, code: "rateLimited", retryAfter: 7 });
  const c = new HostClient(roomHostTransport({ url: "http://h", hostDid: host.hostDid, me, fetch: f }), presenterFor(me.did));
  await assert.rejects(c.list(ROOM), (e: any) => e.status === 429 && e.retryAfterMs === 7000);
});

test("curate retracts with a new room-wide version", async () => {
  const { client } = setup();
  await client.put(ROOM, { key: "chat/1", cleartext: { body: "hi" } });
  const r = await client.curate(ROOM, "chat/1", { status: "retracted" });
  assert.equal(r.version, 2);
  const l = await client.list(ROOM, { sinceVersion: 1 });
  assert.equal(l.records[0].status, "retracted");
});

test("the mock host refuses a document over the live host's 65536-byte cap", async () => {
  const host = new MockRoomHost();
  host.createRoom("did:example:cap", "open");
  const me = newIdentity();
  const t = roomHostTransport({ url: "http://mock", hostDid: host.hostDid, me, fetch: host.fetchHandler() });
  const big = { presentation: mockPresentation("did:example:cap", me.did, "write"), roomId: "did:example:cap", pad: "x".repeat(70000) };
  await assert.rejects(t.send("https://trusttasks.org/spec/rooms/info/0.3", big), (e: unknown) => e instanceof TrustTaskError && e.status === 400);
});
