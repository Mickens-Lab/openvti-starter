# @buildathon/rooms-client

A client for VTI **data rooms**, plus the app layer a collaboration UI (chat, notes, files, live updates, search, author names) sits on.
It works on both the plaintext tier (`open`) and the MLS-sealed tiers (`attributed`, `private`). Node and browser, no framework. DEV ONLY.

- Every room operation is a signed `rooms/*` Trust Task POSTed to the room's **host** (a VTC, or a standalone `room-host`).
- Sealed tiers also need a **KeyService** that mints presentations and seals and opens record bodies:
  - `VtaKeyOracle` sends `rooms/keys/*` to the member's own VTA (the production path: the page never sees an epoch key);
  - `LocalMlsKeys` runs a real MLS group in the page (ts-mls), for the mock demo and tests.
- There is no host search and no member push. Search runs in memory over decrypted content, and live updates come from polling
  `records/list` with `sinceVersion`.

The design, with citations, is [docs/plans/2026-11-07-dataroom-collab-plan.md](../../docs/plans/2026-11-07-dataroom-collab-plan.md).

## Quick start (mock host, no stack)

```ts
import { newIdentity } from "@buildathon/vta-client";
import { HostClient, RoomSession, roomHostTransport, type Presenter } from "@buildathon/rooms-client";
import { MockRoomHost, mockPresentation } from "@buildathon/rooms-client/mock";

const host = new MockRoomHost();
host.createRoom("did:example:room-1", "open");

const me = newIdentity();                                       // the identity that signs host documents
const presenter: Presenter = async (roomId, action) => ({ presentation: mockPresentation(roomId, me.did, action) });
const transport = roomHostTransport({ url: "http://mock", hostDid: host.hostDid, me, fetch: host.fetchHandler() });

const room = await RoomSession.open({
  roomId: "did:example:room-1",
  host: new HostClient(transport, presenter),
  self: me.did,
  profile: { displayName: "Demo member" },
});
room.onChange((c) => console.log(c.origin, c.added.map((i) => i.kind), c.updated.length, c.removed));

await room.post("hello **room**", "text/markdown");
const note = await room.saveNote("Agenda", "1. budget\n2. timeline");
await room.saveNote("Agenda", "1. budget\n2. timeline\n3. hiring", note.id);   // a new version of the same note
await room.upload("agenda.txt", "text/plain", new TextEncoder().encode("hiring plan"));

console.log(room.items().map((i) => [i.version, i.kind, room.profiles.resolveSync(i.author!).label]));
console.log(await room.search("agenda", "names"));
console.log(await room.search("hiring", "text"));
room.close();
```

For a sealed room, create it `attributed`, pass `keys` (a `KeyService`) to `RoomSession.open`, and use `keys.present` as the
`HostClient` presenter. `test/integration.test.ts` does both tiers with two members end to end.

Live mode builds the same `HostClient` over `vtcTransport(vtcClient)` (the VTC's `/v1/trust-tasks`) or `roomHostTransport({url, hostDid,
me})`, and the KeyService is `new VtaKeyOracle(vtaClient)`, whose `present` is the presenter. Live mode: open and attributed rooms verified (see the table below). For an `open` room wrap the presenter, `offerFallbackPresenter((r, a) => keys.present(r, a), (roomId) => offerFor(roomId))`, so an app `did:key` the VTA does not hold as a persona still works with the credentials in its offer. Command line and walkthrough: [docs/ROOMS.md](../../docs/ROOMS.md).

## RoomSession

```ts
RoomSession.open(o: RoomSessionOpts): Promise<RoomSession>

interface RoomSessionOpts {
  roomId: string;
  host: HostClient;
  keys?: KeyService;            // required on attributed/private: open() throws without it
  self: string;                 // the DID that signs host documents (the host records it as author)
  profile?: { displayName: string; avatar?: { mediaType: string; bytes: Uint8Array } };  // avatar at most 64 KiB
  selfCard?: SelfCard;          // the member's VTC card; used for the profile when `profile` is absent, and to resolve self
  source?: ChangeSource;        // default new PollSource() (3 s visible, 15 s hidden, backoff to 60 s, Retry-After on 429)
  start?: boolean;              // default true; false leaves the feed stopped (call session.feed.sync() yourself)
}
```

`open` calls `rooms/info` (which gives the tier), loads the history with one `feed.sync()`, publishes the member's profile if the room
holds none from them or a different one, then starts the feed.

| Member | |
|---|---|
| `roomId`, `visibility`, `sealed`, `self`, `info: RoomInfo` | What was opened. |
| `items(): SessionItem[]` | Chat, notes and files, ascending by host version. Profiles are not items. |
| `item(id)`, `history(id)` | One item by envelope id; every version of a note, ascending. |
| `post(text, format = "text/plain"): Promise<SessionItem<ChatEnvelope>>` | `format` is `"text/plain"` or `"text/markdown"`. |
| `saveNote(title, body, id?): Promise<SessionItem<NoteEnvelope>>` | Pass an existing note's `id` to save a new version. Each version is its own create-only record; the newest wins. |
| `upload(name, mediaType, bytes): Promise<SessionItem<FileEnvelope>>` | Open rooms: a proxied blob upload, then a record with `blobs: [blobRef]`. Sealed rooms: inline in the sealed record; over `INLINE_FILE_CAP` (32 KiB) it throws `"<name>" is N bytes; files in a <tier> room are sealed inline and limited to 32768 bytes (32 KiB; ...). ...`. Verified live: 34,300 bytes passed, 36,000 was refused by the host (documents are capped at 65536 bytes). |
| `fileBytes(item \| fileEnvelope): Promise<Uint8Array>` | Inline bytes, or the blob downloaded (and cached in memory). Throws when the bytes do not match the envelope's SHA-256. |
| `search(q, "names"): Promise<NameResult[]>` | File names: normalised (lowercase, no diacritics); ranked exact, prefix, substring, then newest. `NameResult = NameHit & {item}`, with `name`, `rank`, `ranges`. |
| `search(q, "text"): Promise<TextResult[]>` | Chat text, note title and body, file names, and the content of text files (`text/*`, `.md`, `.json`, `.csv`, at most 1 MiB). Terms are ANDed and prefix-match words; `"quoted phrases"` must be consecutive. `TextResult = TextHit & {item}`, with `field`, `snippet`, `ranges` (into `snippet`, for `<mark>`), `score`. On open rooms text files are downloaded on the first full-text search, once. |
| `onChange(fn): () => void` | `SessionChange {added, updated, removed (ids), profiles (DIDs to re-resolve), failed ({key, version, error}), origin: "local" \| "feed"}`. Own writes emit `"local"` at once; the feed does not echo them. |
| `profiles: ProfileResolver` | `resolveSync(did)` / `resolve(did)` give `{label, displayName?, avatarUrl?, short, isSelf, source: "room" \| "card" \| "fallback", identicon}`. `label` is "You" for self, else the room profile's name, else the short DID (first 8 and last 6 characters). |
| `feed: Feed` | `feed.sync()`, `feed.kick()`, `feed.watermark`; `feed.source` is the `PollSource` (`status`, `onStatus`, `setVisible(document.visibilityState === "visible")`) unless one was passed. |
| `close()` | Stops the feed and drops everything held in memory; writes after it throw. |

`SessionItem<E> = {id, kind, key, version, author?, status, updatedAt, envelope: E, mine}`. Narrow on `item.envelope.kind`
(`"chat" | "note" | "file"`), not on `item.kind`, to get the envelope's fields:

- `ChatEnvelope {text, format}`;
- `NoteEnvelope {title, body}`;
- `FileEnvelope {name, mediaType, size, sha256, inline? | blobRef?}`. `mediaType` is the author's claim: judge images with
  `sniffImage(bytes)` (PNG, JPEG, GIF, WebP only).

Every envelope also has `id`, `clientTs` (the author's clock; display only, order is `version`) and `profile: "openvti.collab/1"`.
Record bodies are untrusted: render markdown inert, never as HTML.

How the session writes:

- Open rooms: `recordKeyFor(env, "open")` (`chat/<ulid>`, `note/<id>/<ulid>`, `file/<ulid>`, `profile/<did-hash>`), `expectedVersion: 0`
  except for the profile, which overwrites. `cleartext.title` and `description` mirror the name and kind for other clients.
- Sealed rooms: `feed.sync()` first, then `keys.seal(roomId, opaqueKey(), watermark + 1, envelope)`, then a create-only put. The kind is
  only inside the ciphertext.
- Reads open `sealed` bodies at `sealed.version ?? record.version`. Records that are not envelopes of this profile are skipped.
- A record key stays bound to the envelope id it first carried, and an id keeps its kind. Anyone in the room may save a new version
  of a note (newest wins). A profile counts only when its record's author is its subject.

## Everything exported

From `@buildathon/rooms-client`:

| Module | Exports |
|---|---|
| `session` | `RoomSession`, `RoomSessionOpts`, `SessionItem`, `SessionChange`, `ItemEnvelope`, `ItemKind`, `SearchMode`, `NameResult`, `TextResult` |
| `host` | `HostClient(transport, presenter, now?)`: `presentation`, `info`, `listPage`, `list`, `get`, `put`, `curate`, `blobUpload`, `blobDownload`. `vtcTransport(vtc)`, `roomHostTransport({url, hostDid, me, fetch?, mount?})`, `HostTransport`, `Presenter`, `signDoc`, `isVersionConflict`, `RateLimitedError` |
| `keys` | `KeyService {present(roomId, action), seal(roomId, key, version, plaintext), open(roomId, key, version, sealed)}`, `sealedVersion` |
| `join` | `joinFromOffer(vtc, keys, offer)`: an open room is the host's accept; a sealed room is `keys.keyPackage` > `vtc.acceptRoomOffer(room, keyPackage)` > `keys.welcome` (`VtaKeyOracle.keyPackage/welcome/held`). Verified live on both |
| `offers` | `offerPresentation(offer)`, `offerFallbackPresenter(primary, lookup)`, `RoomOfferLike`, `OfferLookup`: a Presentation from the credentials in a `rooms/offers/list` item, and a Presenter that asks the VTA first and uses the offer's credentials for an `open` room when the VTA refuses |
| `vta-keys` | `VtaKeyOracle(taskCaller)`: `rooms/keys/{present,seal,open}` at 0.2, stepping down to 0.1 only when the refusal allows it. `TaskCaller` |
| `local-mls` | `LocalMlsKeys(memberId, {present?})`: `createRoom`, `keyPackage`, `addMembers` → `{welcome, commit, epoch}`, `removeMember`, `join`, `applyCommit`, `seal`, `open`, `epoch`, `members`, `has`, `snapshot`, `LocalMlsKeys.restore`. `sealWithKey`, `openWithKey`, `recordAad` |
| `envelope` | `makeChat`, `makeNote`, `makeFile`, `makeProfile`, `encodeEnvelope`, `decodeEnvelope`, `recordKeyFor`, `cleartextFor`, `ulid`, `opaqueKey`, `didHash`, `sniffImage`, `ENVELOPE_PROFILE`, `INLINE_FILE_CAP`, `AVATAR_CAP`, and the envelope types |
| `feed` | `Feed({list, get, source?, sinceVersion?})`, `PollSource({clock?, visibleMs?, hiddenMs?, maxBackoffMs?, visible?})`, `ChangeSource`, `FeedChange`, `FeedStatus`, `Clock`, `systemClock` |
| `search` | `SearchIndex` (`upsert`, `remove`, `searchNames`, `searchText`), `normalize`, `parseQuery`, `isIndexableText`, `TEXT_INDEX_CAP`, `NameHit`, `TextHit`, `Range` |
| `profiles` | `ProfileResolver({self?, selfCard?})`, `ResolvedProfile`, `SelfCard`, `shortDid`, `identicon` (5x5 cells and a hue) |
| `wire`, `tasks` | Wire types and parsers (`RoomRecord`, `RecordMeta`, `SealedContent`, `Presentation`, `Visibility`, ...), `b64u`, `unb64u`, `utf8`, `fromUtf8`, `isSealedTier`; `ROOMS_TASK`, `KEYS_TASK`, `LIST_PAGE_CAP`, `MLS_SUITE`, `STORAGE_EXPORTER_LABEL`, `CHUNK_MIN`, `CHUNK_MAX` |

From `@buildathon/rooms-client/mock` (tests and a no-stack demo; the UI can run it in the browser):

| Export | |
|---|---|
| `MockRoomHost(hostDid?, now?)` | In-process `rooms/*`: `createRoom(roomId, visibility, epoch?)`, `setEpoch`, `send(type, payload, signerDid)`, `transport(me)` (no documents), `fetchHandler()` (a `fetch` that checks each document's proof, issuer and recipient), `storedBytes(roomId)`, `calls`, `inject` (fail a call). Room-wide versions, paging, `sinceVersion`, conflicts, proxied blobs; sealed rooms take sealed bodies and opaque keys only. It checks that a presentation names the room, the signer and the action, but does not verify credentials. |
| `mockPresentation(roomId, subjectDid, action)` | The presentation the mock host accepts. |
| `MockKeyOracle(localMlsKeys, subjectDid, {versions?, ttlMs?, now?})` | A `TaskCaller` that answers `rooms/keys/{present,seal,open}` like a VTA would, so `new VtaKeyOracle(new MockKeyOracle(keys, did))` runs the oracle wire. |
| `ManualClock`, `settle()` | A clock for `PollSource({clock})`: timers run only on `advance(ms)`. |

A sealed mock room with two members:

```ts
const alice = new LocalMlsKeys(aliceDid, { present: async (r, a) => ({ presentation: mockPresentation(r, aliceDid, a) }) });
const bob = new LocalMlsKeys(bobDid, { present: async (r, a) => ({ presentation: mockPresentation(r, bobDid, a) }) });
host.createRoom(roomId, "attributed");            // epoch 1
await alice.createRoom(roomId);                   // epoch 0
const { welcome } = await alice.addMembers(roomId, [await bob.keyPackage()]);   // epoch 1
await bob.join(roomId, welcome);
```

## Tests

```sh
npm test -w @buildathon/rooms-client        # node:test via tsx, no Docker, no stack
npm run typecheck -w @buildathon/rooms-client
```

The suites: wire parsers, `HostClient` against `MockRoomHost` (paging over 500 records, conflicts, blob round trip), `LocalMlsKeys`
and `VtaKeyOracle` against `MockKeyOracle`, envelope, feed (fake clock: dedupe, backoff, visibility, watermark), search, profiles,
`RoomSession`, and `test/integration.test.ts`: Alice and Bob on one mock host over a fake `fetch`, for an open and an attributed room.

## Verified and unverified

| What | Status |
|---|---|
| Everything above against `MockRoomHost` and `MockKeyOracle`, in Node | Verified by the tests in this package. |
| Record sealing format (ChaCha20-Poly1305, 12-byte nonce, AAD `roomId\|key\|version\|epoch`, base64url without padding) | Written from vti-rooms `sealed.rs` at the pin; checked only against itself, no upstream vector. |
| A sealed room's stored bytes hold no plaintext | Verified against the mock host only. |
| `rooms/offers/{list,accept}`, `rooms/memberships/list`, `rooms/info` and chat `records/put` + `records/list` on an **open** room at a real VTC (0.26.0), presenting the offer's own credentials | **Verified live** 2026-11-08 (`npm run rooms:post` / `rooms:read`; one host, one run). Notes, files, search and the live feed against a real host: unverified. |
| Any other real VTC or room-host call (`rooms/*`) | **Unverified live.** The local stack has no room. |
| `rooms/keys/{present,key-package,welcome,list}` at a real VTA (0.72.0, ic3 Farm), `offers/accept` with a KeyPackage, `rooms/info` and a sealed chat `records/put` + `list` on an **attributed** room | **Verified live** 2026-11-08, one run, with a persona DID (the VTA only acts for a persona; the app `did:key` was refused). The VTA must hold the room's credentials in its vault and the app `did:key` signs room calls: [docs/ROOMS.md](../../docs/ROOMS.md). `seal`/`open` ran inside the VTA, not ts-mls. |
| ts-mls ↔ openmls interop (Welcome, exporter) | **Unverified.** Both follow RFC 9420; no cross-implementation vector was run. |
| The host's maximum document size | **Verified live** 2026-11-08: `rooms/records/put/0.3` accepts at most 65536 bytes. A sealed inline file inflates ~1.8x + 4.5 KB, so 250,000 bytes (448,902-byte document) was refused and 34,300 passed; the client cap is 32 KiB. Notes of 40,000 characters pass on both tiers. |
| `rooms/records/curate/0.1` (retract, pin) | **Unverified.** Not served by the pinned VTC's matrix; the mock gives a curate a new room-wide version [inferred]. |
| Blob chunk field names (`uploadId`, `index`, `digestMultibase`, `data`; download `downloadId`, `index`) | **Unverified live.** From the generated Trust Task bindings. |
| A VTC serving files | **Unverified.** Needs `[rooms.files]`, which this kit's VTC config does not set. |
| `sealed.version` carried by the VTA's seal reply | **Unverified.** If it is absent and another write lands between the session's sync and its put, the record will not open. |
| The host's conflict refusal code (`isVersionConflict`) and how a room-host publishes its DID (`hostDid`) | **Unverified.** |
| Sealed blob files (`rooms/keys/file-key`), epoch-chain backfill, owner membership commits | Not implemented. |
| A browser run | Not run here; the package has no DOM dependency. |
