import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ENVELOPE_PROFILE, cleartextFor, decodeEnvelope, encodeEnvelope, makeChat, makeFile, makeNote, makeProfile, recordKeyFor, ulid, unb64u, utf8,
} from "../src/index.js";

test("every kind encodes and decodes", () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
  const items = [
    makeChat("hi **there**", "text/markdown"),
    makeNote("Plan", "# Steps\n1. go"),
    makeFile("logo.png", "image/png", png, { inline: true }),
    makeFile("big.bin", "application/octet-stream", new Uint8Array(10), { blobRef: "zRef" }),
    makeProfile("did:key:zAlice", "Alice", { mediaType: "image/png", bytes: png }),
  ];
  for (const e of items) {
    assert.deepEqual(decodeEnvelope(encodeEnvelope(e)), e);
    assert.deepEqual(decodeEnvelope(utf8(encodeEnvelope(e))), e);
    assert.equal(e.profile, ENVELOPE_PROFILE);
  }
  const f = items[2] as any;
  assert.deepEqual(unb64u(f.inline), png);
  assert.equal(f.sha256.length, 64);
  assert.equal(f.size, 4);
});

test("foreign or malformed bodies decode to undefined", () => {
  for (const b of ["not json", "{}", JSON.stringify({ profile: "keyring.chat/1", kind: "chat", id: "x", clientTs: "t", text: "hi", format: "text/plain" }),
    JSON.stringify({ ...makeChat("x"), format: "text/html" }), JSON.stringify({ ...makeFile("a", "b", new Uint8Array(), { inline: true }), inline: undefined }),
    JSON.stringify({ ...makeNote("t", "b"), kind: "poll" })]) {
    assert.equal(decodeEnvelope(b), undefined, b);
  }
});

test("note edits share an id; avatars are capped", () => {
  const a = makeNote("T", "one");
  const b = makeNote("T", "two", a.id);
  assert.equal(a.id, b.id);
  assert.throws(() => makeProfile("did:x", "X", { mediaType: "image/png", bytes: new Uint8Array(65 * 1024) }), /avatar/);
});

test("record keys: readable on open rooms, opaque on sealed ones; cleartext mirrors the title", () => {
  const c = makeChat("hello world");
  assert.equal(recordKeyFor(c, "open"), `chat/${c.id}`);
  assert.match(recordKeyFor(makeNote("t", "b"), "open"), /^note\/[0-9A-Z]{26}\/[0-9A-Z]{26}$/);
  assert.match(recordKeyFor(makeProfile("did:x", "X"), "open"), /^profile\/[A-Za-z0-9_-]{22}$/);
  const k1 = recordKeyFor(c, "attributed"), k2 = recordKeyFor(c, "attributed");
  assert.match(k1, /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(k1, k2);
  assert.ok(!k1.includes("chat"));
  const ct = cleartextFor(makeFile("report.pdf", "application/pdf", new Uint8Array(1), { inline: true }));
  assert.equal(ct.title, "report.pdf");
  assert.equal(ct.description, "file");
});

test("ulids sort by time", () => {
  assert.ok(ulid(1000) < ulid(2000));
  assert.equal(ulid().length, 26);
});
