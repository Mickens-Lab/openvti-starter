import assert from "node:assert/strict";
import { test } from "node:test";
import { LocalMlsKeys, VtaKeyOracle, openWithKey, recordAad, sealWithKey, utf8, fromUtf8 } from "../src/index.js";
import { MockKeyOracle } from "../src/mock/index.js";

const ROOM = "did:example:room-sealed";

async function twoMembers() {
  const alice = new LocalMlsKeys("did:key:zAlice");
  const bob = new LocalMlsKeys("did:key:zBob");
  await alice.createRoom(ROOM);
  const { welcome } = await alice.addMembers(ROOM, [await bob.keyPackage()]);
  await bob.join(ROOM, welcome);
  return { alice, bob };
}

test("sealing format: ChaCha20-Poly1305, 12-byte nonce, AAD roomId|key|version|epoch, unpadded base64url", () => {
  const k = new Uint8Array(32).fill(7);
  const s = sealWithKey(k, ROOM, "k1", 5, 2, utf8("hello"));
  assert.equal(s.epoch, 2);
  assert.equal(s.version, 5);
  assert.ok(!/[=+/]/.test(s.ciphertext + s.nonce));
  assert.equal(Buffer.from(s.nonce, "base64url").length, 12);
  assert.equal(Buffer.from(s.ciphertext, "base64url").length, 5 + 16);
  assert.equal(fromUtf8(recordAad(ROOM, "k1", 5, 2)), `${ROOM}|k1|5|2`);
  assert.equal(fromUtf8(openWithKey(k, ROOM, "k1", 5, s)), "hello");
});

test("two members share the epoch and round-trip records", async () => {
  const { alice, bob } = await twoMembers();
  assert.equal(alice.epoch(ROOM), 1);
  assert.equal(bob.epoch(ROOM), 1);
  assert.deepEqual(alice.members(ROOM), ["did:key:zAlice", "did:key:zBob"]);
  const s = await alice.seal(ROOM, "rec-1", 3, utf8("secret plan"));
  assert.equal(fromUtf8(await bob.open(ROOM, "rec-1", 3, s)), "secret plan");
  const back = await bob.seal(ROOM, "rec-2", 4, utf8("ack"));
  assert.equal(fromUtf8(await alice.open(ROOM, "rec-2", 4, back)), "ack");
});

test("a wrong AAD (room, key, version) or epoch fails to open", async () => {
  const { alice, bob } = await twoMembers();
  const s = await alice.seal(ROOM, "rec-1", 3, utf8("x"));
  await assert.rejects(bob.open(ROOM, "rec-2", 3, s));
  await assert.rejects(bob.open(ROOM, "rec-1", 4, s));
  await assert.rejects(bob.open(ROOM, "rec-1", 3, { ...s, epoch: 0 }));
  await assert.rejects(bob.open(ROOM, "rec-1", 3, { ...s, epoch: 9 }), /no key/);
  const other = new LocalMlsKeys("did:key:zEve");
  await other.createRoom(ROOM);
  await assert.rejects(other.open(ROOM, "rec-1", 3, { ...s, epoch: 0 }));
});

test("a removed member cannot open the next epoch but keeps the old one", async () => {
  const { alice, bob } = await twoMembers();
  const carol = new LocalMlsKeys("did:key:zCarol");
  const add = await alice.addMembers(ROOM, [await carol.keyPackage()]);
  await carol.join(ROOM, add.welcome);
  await bob.applyCommit(ROOM, add.commit);
  const old = await alice.seal(ROOM, "before", 1, utf8("old"));
  const rm = await alice.removeMember(ROOM, "did:key:zBob");
  assert.equal(rm.epoch, 3);
  assert.deepEqual(await bob.applyCommit(ROOM, rm.commit), { removed: true, epoch: 2 });
  await carol.applyCommit(ROOM, rm.commit);
  const next = await alice.seal(ROOM, "after", 2, utf8("new"));
  assert.equal(next.epoch, 3);
  assert.equal(fromUtf8(await carol.open(ROOM, "after", 2, next)), "new");
  await assert.rejects(bob.open(ROOM, "after", 2, next), /no key/);
  await assert.rejects(bob.seal(ROOM, "x", 9, utf8("x")), /no longer a member/);
  assert.equal(fromUtf8(await bob.open(ROOM, "before", 1, old)), "old");
});

test("snapshot and restore keep groups, epoch keys and pending key packages", async () => {
  const { alice, bob } = await twoMembers();
  const dave = new LocalMlsKeys("did:key:zDave");
  const kp = await dave.keyPackage();
  const dave2 = LocalMlsKeys.restore(dave.snapshot());
  const alice2 = LocalMlsKeys.restore(alice.snapshot());
  const add = await alice2.addMembers(ROOM, [kp]);
  await dave2.join(ROOM, add.welcome);
  await bob.applyCommit(ROOM, add.commit);
  const s = await dave2.seal(ROOM, "k", 1, utf8("from dave"));
  assert.equal(fromUtf8(await bob.open(ROOM, "k", 1, s)), "from dave");
});

test("VtaKeyOracle against MockKeyOracle: present, seal, open at 0.2", async () => {
  const { alice, bob } = await twoMembers();
  const va = new VtaKeyOracle(new MockKeyOracle(alice, "did:key:zAlice"));
  const bobVta = new MockKeyOracle(bob, "did:key:zBob");
  const vb = new VtaKeyOracle(bobVta);
  const p = await vb.present(ROOM, "write");
  assert.match(p.presentation.membership, /zBob/);
  assert.ok(p.expiresAt);
  const s = await va.seal(ROOM, "rec", 7, utf8("via the VTA"));
  assert.equal(fromUtf8(await vb.open(ROOM, "rec", 7, s)), "via the VTA");
  assert.ok(bobVta.calls.every((t) => t.endsWith("/0.2")));
  await assert.rejects(vb.open(ROOM, "rec", 8, s), (e: any) => e.code === "rooms:openFailed");
  await assert.rejects(vb.present("did:example:nope", "read"), (e: any) => e.code === "rooms:notAMember");
});

test("VtaKeyOracle steps down to 0.1 only on unsupportedVersion, and remembers it", async () => {
  const { alice } = await twoMembers();
  const old = new MockKeyOracle(alice, "did:key:zAlice", { versions: ["0.1"] });
  const v = new VtaKeyOracle(old);
  const s = await v.seal(ROOM, "r", 1, utf8("x"));
  await v.seal(ROOM, "r2", 2, utf8("y"));
  assert.equal(fromUtf8(await v.open(ROOM, "r", 1, s)), "x");
  assert.deepEqual(old.calls.map((t) => t.split("/").slice(-2).join("/")), ["seal/0.2", "seal/0.1", "seal/0.1", "open/0.2", "open/0.1"]);
  // A refusal for any other reason is thrown as is.
  const refuse = new VtaKeyOracle({ call: async () => { throw Object.assign(new Error("no")); } });
  await assert.rejects(refuse.present(ROOM, "read"), /no/);
});
