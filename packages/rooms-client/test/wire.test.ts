import assert from "node:assert/strict";
import { test } from "node:test";
import { blobManifest, blobRefOf, parseGetReply, parseInfo, parseListPage, parsePutReply, chunkWire, b64u, unb64u } from "../src/index.js";

test("list page: nextCursor, legacy cursor, and a missing cursor as the end", () => {
  const rec = { key: "chat/1", version: 3, updatedAt: "2026-11-07T00:00:00Z", author: "did:key:zAlice" };
  const a = parseListPage({ records: [rec], nextCursor: "v3", headVersion: 9, recordCount: 4 });
  assert.equal(a.nextCursor, "v3");
  assert.equal(a.headVersion, 9);
  assert.equal(a.records[0].status, "active");
  assert.equal(a.records[0].author, "did:key:zAlice");
  assert.equal(parseListPage({ records: [], cursor: "v7" }).nextCursor, "v7");
  assert.equal(parseListPage({ records: [] }).nextCursor, undefined);
  assert.equal(parseListPage({ records: [], nextCursor: "" }).nextCursor, undefined);
  assert.throws(() => parseListPage({}), /records/);
  assert.throws(() => parseListPage({ records: [{ ...rec, status: "gone" }] }), /status/);
});

test("get reply: flat binding shape and a {record} wrapper", () => {
  const flat = { key: "k", version: 2, status: "retracted", updatedAt: "t", pinned: true, sealed: { ciphertext: "AA", nonce: "BB", epoch: 1, version: 2 }, headVersion: 5 };
  const g = parseGetReply(flat);
  assert.equal(g.record.status, "retracted");
  assert.equal(g.record.pinned, true);
  assert.deepEqual(g.record.sealed, { ciphertext: "AA", nonce: "BB", epoch: 1, version: 2 });
  assert.equal(g.headVersion, 5);
  const w = parseGetReply({ record: { key: "k", version: 1, updatedAt: "t", cleartext: { title: "T", body: "b", tags: ["x"] } } });
  assert.deepEqual(w.record.cleartext, { title: "T", body: "b", tags: ["x"] });
  assert.equal(w.record.pinned, false);
});

test("put and info replies", () => {
  assert.deepEqual(parsePutReply({ key: "k", version: 4, epoch: 2 }), { key: "k", version: 4, epoch: 2 });
  assert.equal(parseInfo({ roomId: "did:x", visibility: "attributed", epoch: 3 }).visibility, "attributed");
  assert.throws(() => parseInfo({ roomId: "did:x", visibility: "secret" }), /visibility/);
});

test("blob manifest: chunking, digests, a stable blobRef", () => {
  const bytes = new Uint8Array(40_000).map((_, i) => i % 251);
  const { manifest, chunks } = blobManifest(bytes, 16 * 1024);
  assert.equal(chunks.length, 3);
  assert.equal(manifest.chunks.chunkCount, 3);
  assert.equal(manifest.size, 40_000);
  assert.match(manifest.digest, /^z/);
  assert.equal(blobRefOf(manifest), blobRefOf(blobManifest(bytes, 16 * 1024).manifest));
  assert.notEqual(blobRefOf(manifest), blobRefOf(blobManifest(bytes.slice(1), 16 * 1024).manifest));
  assert.equal(blobManifest(new Uint8Array()).chunks.length, 1);
});

test("chunk wire round trip and base64url without padding", () => {
  const data = Uint8Array.from([1, 2, 3, 250]);
  const p = chunkWire.upload("u1", 0, data);
  assert.ok(!p.data.includes("="));
  assert.deepEqual(chunkWire.readUpload(p).data, data);
  assert.deepEqual(unb64u(b64u(data)), data);
});
