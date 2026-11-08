import assert from "node:assert/strict";
import { test } from "node:test";
import { newIdentity } from "@buildathon/vta-client";
import {
  HostClient, INLINE_FILE_CAP, LocalMlsKeys, RoomSession, ROOMS_TASK, cleartextFor, makeChat, utf8, type Presenter, type SessionChange,
} from "../src/index.js";
import { MockRoomHost, mockPresentation } from "../src/mock/index.js";

const OPEN = "did:example:room-open";
const SEALED = "did:example:room-sealed";
const presenterFor = (did: string): Presenter => async (roomId, action) => ({ presentation: mockPresentation(roomId, did, action) });

function member(host: MockRoomHost) {
  const id = newIdentity();
  return { id, client: new HostClient(host.transport(id), presenterFor(id.did)) };
}

async function openRoom() {
  const host = new MockRoomHost();
  host.createRoom(OPEN, "open");
  const a = member(host);
  const s = await RoomSession.open({ roomId: OPEN, host: a.client, self: a.id.did, start: false });
  return { host, a, s };
}

async function sealedRoom() {
  const host = new MockRoomHost();
  host.createRoom(SEALED, "attributed");
  const a = member(host);
  const b = member(host);
  const ka = new LocalMlsKeys(a.id.did, { present: presenterFor(a.id.did) });
  const kb = new LocalMlsKeys(b.id.did, { present: presenterFor(b.id.did) });
  await ka.createRoom(SEALED);
  const { welcome } = await ka.addMembers(SEALED, [await kb.keyPackage()]);
  await kb.join(SEALED, welcome);
  return { host, a, b, ka, kb };
}

test("open room: writes show at once, sorted by version; notes collapse to the newest version", async () => {
  const { s, a } = await openRoom();
  const changes: SessionChange[] = [];
  s.onChange((c) => changes.push(c));
  const chat = await s.post("hello *world*", "text/markdown");
  const note = await s.saveNote("Plan", "first draft");
  const edit = await s.saveNote("Plan", "second draft", note.id);
  assert.equal(edit.id, note.id);
  assert.ok(edit.version > note.version);
  assert.deepEqual(s.items().map((i) => [i.kind, i.version]), [["chat", chat.version], ["note", edit.version]]);
  assert.equal((s.item(note.id)!.envelope as { body: string }).body, "second draft");
  assert.equal(s.history(note.id).length, 2);
  assert.ok(chat.mine && chat.author === a.id.did);
  assert.equal(changes.length, 3);
  assert.deepEqual(changes.map((c) => [c.origin, c.added.length, c.updated.length]), [["local", 1, 0], ["local", 1, 0], ["local", 0, 1]]);
  // The feed does not echo the session's own writes.
  await s.feed.sync();
  assert.equal(changes.length, 3);
  s.close();
});

test("a second session loads history, and the feed delivers new items and edits", async () => {
  const { host, s } = await openRoom();
  await s.post("before");
  const b = member(host);
  const bs = await RoomSession.open({ roomId: OPEN, host: b.client, self: b.id.did, start: false });
  assert.deepEqual(bs.items().map((i) => (i.envelope as { text: string }).text), ["before"]);
  const seen: SessionChange[] = [];
  bs.onChange((c) => seen.push(c));
  const n = await s.saveNote("T", "v1");
  await s.saveNote("T", "v2", n.id);
  await bs.feed.sync();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].origin, "feed");
  // Both note versions arrive in one sync: the item is added once, at the newest version.
  assert.equal(seen[0].added.length, 1);
  assert.equal((seen[0].added[0].envelope as { body: string }).body, "v2");
  assert.equal(bs.items().length, 2);
  assert.ok(!bs.items()[1].mine);
  s.close();
  bs.close();
});

test("open-room files go up as blobs; bytes round-trip; names and lazily fetched text are searchable", async () => {
  const { host, a, s } = await openRoom();
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const f = await s.upload("Diagram.png", "image/png", png);
  assert.ok(f.envelope.blobRef && f.envelope.inline === undefined);
  await s.upload("minutes.md", "text/markdown", utf8("# Minutes\nWe agreed on the quarterly budget."));
  const b = member(host);
  const bs = await RoomSession.open({ roomId: OPEN, host: b.client, self: b.id.did, start: false });
  const bf = bs.items().find((i) => i.envelope.kind === "file" && i.envelope.name === "Diagram.png")!;
  assert.deepEqual(await bs.fileBytes(bf as never), png);
  assert.deepEqual((await bs.search("diag", "names")).map((h) => h.name), ["Diagram.png"]);
  assert.deepEqual((await bs.search("minutes", "names")).map((h) => h.rank), ["exact"]);
  const gets = () => host.calls.filter((c) => c.type === ROOMS_TASK.blobsGet && c.signer === b.id.did).length;
  const before = gets();
  const hits = await bs.search("quarterly budget", "text");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].item.kind, "file");
  assert.equal(gets(), before + 1, "the text file was fetched on the first full-text search");
  await bs.search("budget", "text");
  assert.equal(gets(), before + 1, "and only once");
  assert.equal(a.id.did, s.self);
  s.close();
  bs.close();
});

test("a file whose bytes do not match its SHA-256 is refused", async () => {
  const { s } = await openRoom();
  const f = await s.upload("a.txt", "text/plain", utf8("abc"));
  await assert.rejects(s.fileBytes({ ...f.envelope, sha256: "00".repeat(32) }), /SHA-256/);
  s.close();
});

test("sealed room: a KeyService is required; records are opaque and sealed; files over the inline cap are refused", async () => {
  const { host, a, b, ka, kb } = await sealedRoom();
  await assert.rejects(RoomSession.open({ roomId: SEALED, host: a.client, self: a.id.did, start: false }), /KeyService is required/);
  const s = await RoomSession.open({ roomId: SEALED, host: a.client, keys: ka, self: a.id.did, start: false });
  assert.ok(s.sealed);
  const m = await s.post("the launch code is tangerine");
  assert.match(m.key, /^[A-Za-z0-9_-]{22}$/);
  const t = await s.upload("notes.txt", "text/plain", utf8("inline secret words"));
  assert.ok(t.envelope.inline);
  await assert.rejects(s.upload("big.bin", "application/octet-stream", new Uint8Array(INLINE_FILE_CAP + 1)), /limited to 32768 bytes/);
  // Inline text is indexed without any blob call.
  assert.equal((await s.search("secret words", "text")).length, 1);
  const stored = Buffer.from(host.storedBytes(SEALED)).toString("latin1");
  for (const p of ["tangerine", "inline secret", "notes.txt"]) assert.ok(!stored.includes(p), p);
  const bs = await RoomSession.open({ roomId: SEALED, host: b.client, keys: kb, self: b.id.did, start: false });
  assert.deepEqual(bs.items().map((i) => i.kind), ["chat", "file"]);
  assert.equal(bs.items()[0].author, a.id.did);
  s.close();
  bs.close();
});

test("a sealed write seals for the host's head even when the watermark lagged", async () => {
  const { a, b, ka, kb } = await sealedRoom();
  const s = await RoomSession.open({ roomId: SEALED, host: a.client, keys: ka, self: a.id.did, start: false });
  const bs = await RoomSession.open({ roomId: SEALED, host: b.client, keys: kb, self: b.id.did, start: false });
  await s.post("one");
  await s.post("two");
  // Bob has not synced; his write syncs first, so the version he seals for is the one the put gets.
  const r = await bs.post("three");
  assert.equal(r.version, 3);
  assert.deepEqual(bs.items().map((i) => (i.envelope as { text: string }).text), ["one", "two", "three"]);
  await s.feed.sync();
  assert.equal(s.items().length, 3);
  s.close();
  bs.close();
});

test("a retracted record leaves the items and the index", async () => {
  const { s, a } = await openRoom();
  const m = await s.post("delete me please");
  await s.post("keep");
  const seen: SessionChange[] = [];
  s.onChange((c) => seen.push(c));
  await a.client.curate(OPEN, m.key, { status: "retracted" });
  await s.feed.sync();
  assert.deepEqual(seen.map((c) => c.removed), [[m.id]]);
  assert.deepEqual(s.items().map((i) => (i.envelope as { text: string }).text), ["keep"]);
  assert.equal((await s.search("delete", "text")).length, 0);
  s.close();
});

test("retracting a note's newest version falls back to the previous one", async () => {
  const { s, a } = await openRoom();
  const n = await s.saveNote("N", "old");
  const e = await s.saveNote("N", "new", n.id);
  await a.client.curate(OPEN, e.key, { status: "retracted" });
  await s.feed.sync();
  assert.equal((s.item(n.id)!.envelope as { body: string }).body, "old");
  assert.equal((await s.search("new", "text")).length, 0);
  assert.equal((await s.search("old", "text")).length, 1);
  s.close();
});

test("records that are not envelopes of this profile are ignored", async () => {
  const { s, a } = await openRoom();
  await a.client.put(OPEN, { key: "other/1", cleartext: { body: "not json" } });
  await a.client.put(OPEN, { key: "other/2", cleartext: { body: JSON.stringify({ profile: "another.app/1", id: "x" }) } });
  await s.feed.sync();
  assert.equal(s.items().length, 0);
  s.close();
});

test("a body claiming another item's id under a new key cannot change its kind", async () => {
  const { s, a } = await openRoom();
  const n = await s.saveNote("Mine", "body");
  const forged = { ...makeChat("hijack"), id: n.id };
  await a.client.put(OPEN, { key: `chat/${n.id}`, cleartext: cleartextFor(forged) });
  await s.feed.sync();
  assert.equal(s.item(n.id)!.kind, "note");
  s.close();
});

test("profile: published once on open, republished only when it changes; resolves by name, else short DID", async () => {
  const host = new MockRoomHost();
  host.createRoom(OPEN, "open");
  const a = member(host);
  const puts = () => host.calls.filter((c) => c.type === ROOMS_TASK.recordsPut).length;
  const s1 = await RoomSession.open({ roomId: OPEN, host: a.client, self: a.id.did, profile: { displayName: "Ada" }, start: false });
  assert.equal(puts(), 1);
  s1.close();
  const s2 = await RoomSession.open({ roomId: OPEN, host: a.client, self: a.id.did, profile: { displayName: "Ada" }, start: false });
  assert.equal(puts(), 1, "unchanged profile is not republished");
  s2.close();
  const s3 = await RoomSession.open({ roomId: OPEN, host: a.client, self: a.id.did, selfCard: async () => ({ displayName: "Ada L." }), start: false });
  assert.equal(puts(), 2, "a changed name (from the VTC card) is republished");
  const b = member(host);
  const bs = await RoomSession.open({ roomId: OPEN, host: b.client, self: b.id.did, start: false });
  assert.equal(puts(), 2, "no profile and no card: nothing published");
  const ra = bs.profiles.resolveSync(a.id.did);
  assert.equal(ra.label, "Ada L.");
  assert.equal(ra.source, "room");
  const rb = s3.profiles.resolveSync(b.id.did);
  assert.equal(rb.source, "fallback");
  assert.equal(rb.label, rb.short);
  assert.equal(s3.profiles.resolveSync(a.id.did).label, "You");
  s3.close();
  bs.close();
});

test("close stops the feed and refuses writes", async () => {
  const { s } = await openRoom();
  await s.post("x");
  s.close();
  assert.equal(s.items().length, 0);
  await assert.rejects(s.post("y"), /closed/);
});
