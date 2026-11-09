// The mock backend the demo runs on: both seeded rooms open, the sealed one stores no plaintext, and simulated Bob's post
// reaches the member's session through the poll feed on a manual clock.
import assert from "node:assert/strict";
import { test } from "node:test";
import { sniffImage } from "@starter/rooms-client";
import { ManualClock } from "@starter/rooms-client/mock";
import { BOB_NAME, BOB_SCRIPT, OPEN_ROOM, SEALED_ROOM, createMockBackend } from "../src/mock.ts";

async function waitFor(what: string, cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 5)); }
}

test("seeded rooms: open and attributed, with chat, notes and files; Bob's posts arrive live", async () => {
  const clock = new ManualClock();
  const b = await createMockBackend({ clock, everyMs: 10_000, history: 4 });
  try {
    const rooms = await b.rooms();
    assert.deepEqual(rooms.map((r) => r.visibility), ["open", "attributed"]);
    const open = await b.open(rooms[0]);
    const sealed = await b.open(rooms[1]);
    assert.equal(open.sealed, false);
    assert.equal(sealed.sealed, true);
    const kinds = (s: typeof open) => s.items().map((i) => i.kind);
    assert.ok(kinds(open).includes("note") && kinds(open).filter((k) => k === "file").length === 6);
    assert.ok(kinds(sealed).includes("note") && kinds(sealed).includes("file"));
    const gif = sealed.items().find((i) => i.envelope.kind === "file" && i.envelope.name.endsWith(".gif"))!;
    assert.equal(sniffImage(await sealed.fileBytes(gif as any)), "image/gif");
    assert.equal(open.profiles.resolveSync(b.bob.did).label, BOB_NAME);
    assert.ok(open.profiles.resolveSync(b.bob.did).avatarUrl?.startsWith("data:image/png;base64,"));
    assert.equal(open.profiles.resolveSync(b.carol.did).source, "fallback");
    assert.equal(open.profiles.resolveSync(b.self).label, "You");

    const stored = Buffer.from(b.host.storedBytes(SEALED_ROOM));
    assert.ok(!stored.includes("Term sheet") && !stored.includes("sealed: the host stores"), "sealed room stores plaintext");
    assert.ok(Buffer.from(b.host.storedBytes(OPEN_ROOM)).includes("riverside"));

    const before = open.items().length;
    await clock.advance(10_000);           // Bob's timer fires (first post goes to the open room)
    await b.idle();
    await clock.advance(3_000);            // the member's poll
    await waitFor("Bob's live post", () => open.items().length === before + 1);
    const last = open.items().at(-1)!;
    assert.ok(last.envelope.kind === "chat" && last.envelope.text === BOB_SCRIPT[0] && last.author === b.bob.did);

    const sb = sealed.items().length;
    await b.bobPosts(SEALED_ROOM);
    await clock.advance(3_000);
    await waitFor("Bob's sealed post", () => sealed.items().length === sb + 1);
    open.close();
    sealed.close();
  } finally {
    b.close();
  }
});
