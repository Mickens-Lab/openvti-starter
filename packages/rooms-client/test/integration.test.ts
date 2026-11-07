// Two members, Alice and Bob, each with a RoomSession on one MockRoomHost reached over a fake fetch (signed Trust Task
// documents, proofs checked by the mock). Run for an open room and for an attributed (MLS-sealed) room. Alice's sealed
// keys go through VtaKeyOracle -> MockKeyOracle (the rooms/keys/* wire); Bob's are a LocalMlsKeys in the page.
import assert from "node:assert/strict";
import { test } from "node:test";
import { newIdentity, type Identity } from "@buildathon/vta-client";
import {
  HostClient, KEYS_TASK, LocalMlsKeys, PollSource, RoomSession, VtaKeyOracle, b64u, fromUtf8, roomHostTransport, shortDid, sniffImage,
  utf8, type KeyService, type Presenter, type SessionChange, type Visibility,
} from "../src/index.js";
import { ManualClock, MockKeyOracle, MockRoomHost, mockPresentation } from "../src/mock/index.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

const CHAT = "Kickoff is Thursday at the riverside office";
const NOTE_TITLE = "Procurement checklist";
const NOTE_BODY = "## Steps\n\n- collect *three* vendor quotes\n- confirm the escrow arrangement";
const TEXT_NAME = "budget-notes.txt";
const TEXT_BODY = "The contingency reserve stays at eleven percent of capex.";
const ALICE_NAME = "Alice Analyst";
const BOB_REPLY = "Thursday works for me";

const presenterFor = (did: string): Presenter => async (roomId, action) => ({ presentation: mockPresentation(roomId, did, action) });

/** Poll a condition in real time, bounded, while the sessions' own async work runs. */
async function waitFor(what: string, cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function hostClient(host: MockRoomHost, me: Identity, presenter: Presenter): HostClient {
  const transport = roomHostTransport({ url: "http://room-host.test", hostDid: host.hostDid, me, fetch: host.fetchHandler() });
  return new HostClient(transport, presenter);
}

async function setup(visibility: Visibility) {
  const roomId = `did:example:room-${visibility}`;
  const host = new MockRoomHost();
  host.createRoom(roomId, visibility);
  const alice = newIdentity();
  const bob = newIdentity();
  let aliceKeys: KeyService | undefined;
  let bobKeys: KeyService | undefined;
  let oracle: MockKeyOracle | undefined;
  if (visibility !== "open") {
    const ka = new LocalMlsKeys(alice.did);
    const kb = new LocalMlsKeys(bob.did, { present: presenterFor(bob.did) });
    await ka.createRoom(roomId);
    const { welcome } = await ka.addMembers(roomId, [await kb.keyPackage()]);
    await kb.join(roomId, welcome);
    oracle = new MockKeyOracle(ka, alice.did);
    aliceKeys = new VtaKeyOracle(oracle);
    bobKeys = kb;
  }
  const alicePresenter: Presenter = aliceKeys ? (r, a) => aliceKeys!.present(r, a) : presenterFor(alice.did);
  const bobPresenter: Presenter = bobKeys ? (r, a) => bobKeys!.present(r, a) : presenterFor(bob.did);
  const aliceClock = new ManualClock();
  const bobClock = new ManualClock();
  const as = await RoomSession.open({
    roomId, host: hostClient(host, alice, alicePresenter), self: alice.did, profile: { displayName: ALICE_NAME },
    source: new PollSource({ clock: aliceClock }), ...(aliceKeys ? { keys: aliceKeys } : {}),
  });
  const bs = await RoomSession.open({
    roomId, host: hostClient(host, bob, bobPresenter), self: bob.did,
    source: new PollSource({ clock: bobClock }), ...(bobKeys ? { keys: bobKeys } : {}),
  });
  return { roomId, host, alice, bob, as, bs, aliceClock, bobClock, oracle };
}

for (const visibility of ["open", "attributed"] as const) {
  test(`${visibility} room: Alice's chat, note, PNG, GIF and text file reach Bob live; both search modes; attribution`, async () => {
    const { roomId, host, alice, bob, as, bs, aliceClock, bobClock, oracle } = await setup(visibility);
    try {
      const bobChanges: SessionChange[] = [];
      bs.onChange((c) => bobChanges.push(c));

      await as.post(CHAT);
      await as.saveNote(NOTE_TITLE, NOTE_BODY);
      await as.upload("site-plan.png", "image/png", PNG);
      await as.upload("celebration.gif", "image/gif", GIF);
      await as.upload(TEXT_NAME, "text/plain", utf8(TEXT_BODY));
      assert.equal(as.items().length, 5);

      // Bob's poll timer fires on his clock; nothing reloads the session by hand.
      await bobClock.advance(3000);
      await waitFor("Bob's feed", () => bs.items().length === 5);
      assert.ok(bobChanges.some((c) => c.origin === "feed" && c.added.length > 0));
      // Alice published her profile when her session opened, before Bob's did: Bob loaded it with the history.
      assert.equal(bs.profiles.roomProfile(alice.did)?.displayName, ALICE_NAME);
      const items = bs.items();
      assert.deepEqual(items.map((i) => i.kind), ["chat", "note", "file", "file", "file"]);
      assert.deepEqual(items.map((i) => i.version), [...items.map((i) => i.version)].sort((a, b) => a - b));
      assert.ok(items.every((i) => i.author === alice.did && !i.mine));

      // Bodies as Alice wrote them; images judged by their bytes.
      const chat = items[0].envelope;
      assert.ok(chat.kind === "chat" && chat.text === CHAT);
      const note = items[1].envelope;
      assert.ok(note.kind === "note" && note.title === NOTE_TITLE && note.body === NOTE_BODY);
      const files = items.slice(2).map((i) => i.envelope).filter((e) => e.kind === "file");
      assert.deepEqual(files.map((f) => f.name), ["site-plan.png", "celebration.gif", TEXT_NAME]);
      assert.equal(sniffImage(await bs.fileBytes(files[0])), "image/png");
      assert.equal(sniffImage(await bs.fileBytes(files[1])), "image/gif");
      assert.deepEqual(await bs.fileBytes(files[1]), new Uint8Array(GIF));
      assert.equal(fromUtf8(await bs.fileBytes(files[2])), TEXT_BODY);
      // Open rooms carry files as blobs; sealed rooms inline in the sealed record.
      for (const f of files) assert.equal(visibility === "open" ? !!f.blobRef : f.inline !== undefined, true);

      // Search, mode 1: file names.
      for (const s of [as, bs]) {
        assert.deepEqual((await s.search("celebration", "names")).map((h) => h.name), ["celebration.gif"]);
        assert.deepEqual((await s.search("plan", "names")).map((h) => h.name), ["site-plan.png"]);
        assert.deepEqual((await s.search(".png", "names")).map((h) => h.rank), ["substring"]);
      }
      // Search, mode 2: full text over chat, note title and body, and the text file's content.
      const text = async (q: string) => (await bs.search(q, "text")).map((h) => h.item.kind);
      assert.deepEqual(await text("riverside"), ["chat"]);
      assert.deepEqual(await text("procurement"), ["note"]);
      assert.deepEqual(await text("escrow arrangement"), ["note"]);
      assert.deepEqual(await text('"contingency reserve"'), ["file"]);
      assert.deepEqual(await text("eleven capex"), ["file"]);
      assert.deepEqual(await text("thursday"), ["chat"]);
      const hit = (await bs.search("escrow", "text"))[0];
      const [a, b] = hit.ranges[0];
      assert.equal(hit.snippet.slice(a, b).toLowerCase(), "escrow");

      // Attribution: Alice's published name for Bob; Bob published nothing, so Alice sees his short DID.
      assert.equal(bs.profiles.resolveSync(alice.did).label, ALICE_NAME);
      assert.equal(bs.profiles.resolveSync(alice.did).source, "room");
      await bs.post(BOB_REPLY);
      await aliceClock.advance(3000);
      await waitFor("Alice's feed", () => as.items().length === 6);
      const reply = as.items()[5];
      assert.equal(reply.author, bob.did);
      const rb = as.profiles.resolveSync(bob.did);
      assert.equal(rb.source, "fallback");
      assert.equal(rb.label, shortDid(bob.did));
      assert.ok(rb.label.length < bob.did.length);
      assert.deepEqual((await as.search("thursday", "text")).map((h) => h.item.author).sort(), [alice.did, bob.did].sort());

      // What the host stores.
      const stored = Buffer.from(host.storedBytes(roomId));
      const secrets = [CHAT, BOB_REPLY, NOTE_TITLE, "escrow arrangement", TEXT_BODY, TEXT_NAME, "site-plan.png", "celebration.gif", ALICE_NAME, b64u(PNG), b64u(GIF)];
      if (visibility === "open") {
        // The check can see plaintext when it is there.
        assert.ok(stored.includes(CHAT) && stored.includes(PNG) && stored.includes(TEXT_BODY));
      } else {
        for (const s of secrets) assert.ok(!stored.includes(s), `sealed room stores plaintext: ${s}`);
        for (const raw of [PNG, GIF, Buffer.from(TEXT_BODY)]) assert.ok(!stored.includes(raw), "sealed room stores raw file bytes");
        // Alice's seals and opens went over the rooms/keys/* wire.
        assert.ok(oracle!.calls.includes(KEYS_TASK.seal));
        assert.ok(oracle!.calls.includes(KEYS_TASK.open));
        assert.ok(oracle!.calls.includes(KEYS_TASK.present));
      }
      // Every host call went through the fake fetch as a signed document.
      assert.ok(host.calls.length > 0 && host.calls.every((c) => c.signer === alice.did || c.signer === bob.did || c.signer.startsWith("did:key:")));
    } finally {
      as.close();
      bs.close();
    }
  });
}
