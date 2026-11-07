// The no-stack demo (COLLAB_MODE=mock, the default): one MockRoomHost in the page, reached over a fake `fetch` with signed
// Trust Task documents exactly as a room-host would be, seeded with
//  - an `open` room (plaintext; files as blobs) with three members: you, Bob (publishes a name and avatar) and Carol (no
//    profile, so she shows as a short DID);
//  - an `attributed` room (MLS-sealed with real two-member MLS: LocalMlsKeys for you and Bob; files inline, sealed).
// Bob is simulated: every `everyMs` he posts the next line of a script into one of the rooms, so the live feed is visible.
// Nothing leaves the page; keys live in memory only and vanish on reload.
import { newIdentity, type Identity } from "@buildathon/vta-client";
import {
  HostClient, LocalMlsKeys, PollSource, RoomSession, roomHostTransport, systemClock, utf8, type Clock, type KeyService, type Presenter,
  type RoomSessionOpts, type Visibility,
} from "@buildathon/rooms-client";
import { MockRoomHost, mockPresentation } from "@buildathon/rooms-client/mock";
import type { Backend, RoomRef } from "./backend.ts";
import { demoAvatar, demoGif, demoPng } from "./demo-media.ts";

export const OPEN_ROOM = "did:example:collab-open-room";
export const SEALED_ROOM = "did:example:collab-sealed-room";
export const BOB_NAME = "Bob Builder";
export const SELF_NAME = "Demo member";

/** Markdown that must render inert: raw HTML, a script link, an image that must not be fetched. */
export const HOSTILE_NOTE = [
  "# Kickoff agenda",
  "",
  "Bring **three** vendor quotes and the `escrow` terms.",
  "",
  "- budget review",
  "- timeline",
  "",
  "> Quoted: decisions need two members.",
  "",
  "<script>alert('not run')</script> <img src=x onerror=alert(1)>",
  "",
  "[Click me](javascript:alert(1)) and [the spec](https://example.org/spec).",
  "",
  "![tracking pixel](https://example.org/pixel.png)",
  "",
  "```",
  "const total = quotes.reduce((a, b) => a + b, 0);",
  "```",
].join("\n");

export const SVG_BYTES = utf8('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><rect width="10" height="10"/></svg>');
/** Claims image/png, but it is HTML. */
export const MISLABELLED_BYTES = utf8("<html><body onload=alert(1)>not an image</body></html>");
export const TEXT_FILE = "The contingency reserve stays at eleven percent of capex.\nReviewed every quarter.";
export const MD_FILE = "# Room guide\n\n- Chat is for *quick* questions.\n- Decisions go in **notes**.";

export const BOB_SCRIPT = [
  "Just pushed the revised timeline, take a look when you can.",
  "Anyone free for a call at three?",
  "The **escrow** draft is in the notes now.",
  "Thanks, all, good progress today.",
];

export interface MockOpts {
  /** Drives every poll and Bob's posting (tests pass a ManualClock). */
  clock?: Clock;
  /** How often simulated Bob posts (ms); 0 turns him off. */
  everyMs?: number;
  /** Older chat messages to seed in the open room (to show "Load older"). */
  history?: number;
}

export interface MockBackend extends Backend {
  host: MockRoomHost;
  bob: Identity;
  carol: Identity;
  /** Make Bob post the next scripted line now, into `roomId` (default: alternate rooms). */
  bobPosts(roomId?: string): Promise<string>;
  /** Resolves when Bob's posts in flight have landed. */
  idle(): Promise<void>;
}

const presenterFor = (did: string): Presenter => async (roomId, action) => ({ presentation: mockPresentation(roomId, did, action) });

export async function createMockBackend(o: MockOpts = {}): Promise<MockBackend> {
  const clock = o.clock ?? systemClock;
  const host = new MockRoomHost();
  const me = newIdentity();
  const bob = newIdentity();
  const carol = newIdentity();
  const hostClient = (who: Identity, presenter: Presenter) =>
    new HostClient(roomHostTransport({ url: "http://mock-room-host.invalid", hostDid: host.hostDid, me: who, fetch: host.fetchHandler() }), presenter);

  host.createRoom(OPEN_ROOM, "open");
  host.createRoom(SEALED_ROOM, "attributed");
  const myKeys = new LocalMlsKeys(me.did, { present: presenterFor(me.did) });
  const bobKeys = new LocalMlsKeys(bob.did, { present: presenterFor(bob.did) });
  await myKeys.createRoom(SEALED_ROOM);
  const { welcome } = await myKeys.addMembers(SEALED_ROOM, [await bobKeys.keyPackage()]);
  await bobKeys.join(SEALED_ROOM, welcome);

  const sessionFor = (who: Identity, roomId: string, keys: KeyService | undefined, profile?: RoomSessionOpts["profile"]) =>
    RoomSession.open({ roomId, host: hostClient(who, keys ? (r, a) => keys.present(r, a) : presenterFor(who.did)), self: who.did, start: false, ...(keys ? { keys } : {}), ...(profile ? { profile } : {}) });

  const bobProfile = { displayName: BOB_NAME, avatar: { mediaType: "image/png", bytes: demoAvatar(220, 120, 40) } };
  const bobOpen = await sessionFor(bob, OPEN_ROOM, undefined, bobProfile);
  const carolOpen = await sessionFor(carol, OPEN_ROOM, undefined);
  const bobSealed = await sessionFor(bob, SEALED_ROOM, bobKeys, bobProfile);

  // --- seed the open room ---
  const history = o.history ?? 26;
  for (let i = 1; i <= history; i++) await (i % 3 === 0 ? carolOpen : bobOpen).post(`Earlier message ${i} of ${history}`);
  await carolOpen.post("Kickoff is Thursday at the riverside office");
  await bobOpen.post("Agenda below, *please* add to it:\n\n1. budget\n2. hiring", "text/markdown");
  await bobOpen.saveNote("Kickoff agenda", HOSTILE_NOTE);
  await bobOpen.upload("site-plan.png", "image/png", demoPng());
  await carolOpen.upload("celebration.gif", "image/gif", demoGif());
  await bobOpen.upload("diagram.svg", "image/svg+xml", SVG_BYTES);
  await carolOpen.upload("photo.png", "image/png", MISLABELLED_BYTES);
  await bobOpen.upload("budget-notes.txt", "text/plain", utf8(TEXT_FILE));
  await bobOpen.upload("room-guide.md", "text/markdown", utf8(MD_FILE));

  // --- seed the sealed room ---
  await bobSealed.post("This room is sealed: the host stores only ciphertext.");
  await bobSealed.post("Offer terms are in the **term sheet** note.", "text/markdown");
  await bobSealed.saveNote("Term sheet", "## Terms\n\n- valuation: *confidential*\n- closing: end of quarter");
  await bobSealed.upload("sealed-plan.png", "image/png", demoPng());
  await bobSealed.upload("sealed-wave.gif", "image/gif", demoGif());

  // --- simulated Bob ---
  let line = 0;
  let turn = 0;
  let inflight: Promise<unknown> = Promise.resolve();
  let timer: unknown;
  let closed = false;
  const bobPosts = (roomId?: string): Promise<string> => {
    const room = roomId ?? (turn++ % 2 === 0 ? OPEN_ROOM : SEALED_ROOM);
    const text = BOB_SCRIPT[line++ % BOB_SCRIPT.length];
    const p = (room === OPEN_ROOM ? bobOpen : bobSealed).post(text, "text/markdown").then(() => text);
    inflight = Promise.allSettled([inflight, p]);
    return p;
  };
  const every = o.everyMs ?? 12_000;
  const schedule = () => {
    if (closed || every <= 0) return;
    timer = clock.setTimeout(() => { void bobPosts().catch(() => undefined).finally(schedule); }, every);
  };
  schedule();

  const rooms: RoomRef[] = [
    { roomId: OPEN_ROOM, label: "Project room (open)", visibility: "open" as Visibility, description: "Plaintext: the host can read everything." },
    { roomId: SEALED_ROOM, label: "Deal room (attributed)", visibility: "attributed" as Visibility, description: "MLS-sealed: the host sees who acted, not what." },
  ];

  return {
    mode: "mock",
    self: me.did,
    host, bob, carol,
    rooms: async () => rooms,
    open: (ref) => RoomSession.open({
      roomId: ref.roomId,
      host: hostClient(me, ref.roomId === SEALED_ROOM ? (r, a) => myKeys.present(r, a) : presenterFor(me.did)),
      self: me.did,
      profile: { displayName: SELF_NAME },
      source: new PollSource({ clock }),
      ...(ref.roomId === SEALED_ROOM ? { keys: myKeys } : {}),
    }),
    bobPosts,
    idle: async () => { await inflight; },
    close: () => {
      closed = true;
      clock.clearTimeout(timer);
      for (const s of [bobOpen, carolOpen, bobSealed]) s.close();
    },
  };
}
