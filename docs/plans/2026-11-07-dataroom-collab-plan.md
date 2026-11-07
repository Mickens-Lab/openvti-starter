# Plan: a collaboration space on data rooms

Status: plan, 2026-11-07. A simple collaboration space (chat history, files, notes, live updates, two search modes, contributor
attribution) on VTI **data rooms**, for both the plaintext tier and the MLS-sealed tiers. Labels as in [STATUS.md](../STATUS.md):
**[V]** verified in source, **[I]** inferred, **[unverified]** not checked.

Citations are `repo/path:line`. `VTI/` is the upstream verifiable-trust-infrastructure checkout (`VTI_PATH`), read at HEAD
(`vtc-service-v0.22.0`) and, where it matters, at this kit's pins (VTA `fc157f76`, VTC `93d36996`). `BP/` is the upstream
vta-browser-plugin's rooms client (`packages/core/src/rooms/index.ts`), the reference TypeScript client for `rooms/*`. A reference
wallet client (React Native, private) was also read; what it showed is summarised in section 1.8 without paths.

## 1. Findings

### 1.1 What a room is

- A room is identified by a DID its owner mints (`roomId`), not by the host. The host stores records and holds **no member list and
  no keys** [V] (`VTI/vti-rooms/src/lib.rs:263-330`, `VTI/docs/05-design-notes/data-rooms.md:169-199`).
- The tier is `Visibility`, fixed at creation [V] (`VTI/vti-rooms/src/lib.rs:230-258`, `data-rooms.md:136`):
  - `open`: plaintext. The host can read every record.
  - `attributed`: MLS-sealed. The host sees who acted but not what.
  - `private`: MLS-sealed and anonymous membership. A VTC refuses it by default (`private-tier-not-enabled`,
    `VTI/vtc-service/policies/default/rooms.rego:29-58`).
- The only item is a **record** [V] (`VTI/vti-rooms/src/lib.rs:451-540`, `VTI/vti-rooms/src/wire.rs:493-508` at the pin). A record has:
  - `key` (opaque on sealed tiers);
  - `version`, assigned by the host and rising **per room**, not per record;
  - `epoch`, `status` (`active` | `deprecated` | `retracted`), `pinned`, `updatedAt`;
  - `author` (absent on `private`);
  - a body that is either `cleartext {title?, description?, body, tags[]}` or `sealed {ciphertext, nonce, epoch, version?}`
    (`wire.rs:200-213, 276-284`).
- Record bodies are markdown and **must render inert** (`data-rooms.md:611, 627-631`).
- A note is an ordinary record. A file is a record whose body carries a file manifest, plus a cleartext `blobs: [blobRef]`, one file
  per record (`VTI/docs/05-design-notes/data-rooms-files.md:43-112`).
- Chat has no record type of its own. The upstream reference treats a chat message as a record with a small event envelope (1.8).

### 1.2 Wire

- There are no REST resources for rooms. Every operation is a signed Trust Task POSTed to one endpoint [V]:
  - VTC: `POST /v1/trust-tasks`, the same door `vtc-client` already uses.
  - standalone `room-host`: `POST /trust-tasks` plus `GET /health`, HTTP only with `--listen`, CORS only with `--allow-origin`
    (`VTI/room-host/src/lib.rs:1640-1641`, `VTI/room-host/src/main.rs:36-69`).
- Two services, and each call goes to exactly one of them [V] (`BP/index.ts:8-30`, `VTI/vta-service/src/operations/room_oracle.rs:1`):
  - `rooms/{create,info,records,epoch,blobs,owner}/*` go to the room's **host** (a VTC, or `room-host`).
  - `rooms/keys/*` go to the member's **own VTA**, which holds the MLS group, the room credentials and the epoch keys:
    `present`, `seal`, `open`, `read`, `browse`, `file-key`, `key-package`, `welcome`, `commit`, `act`.
- Writing to a sealed room is therefore two calls, `rooms/keys/seal` at the VTA and then `rooms/records/put` at the host. The `version`
  sealed into the ciphertext must be the version the put will get, so the safe shape is create-only with `expectedVersion: 0` and a
  fresh key (`BP/index.ts:22-30`, `data-rooms.md:588-593`).
- Versions this kit's pins serve [V] (live matrix in [VTC-SURFACE.md](../VTC-SURFACE.md); VTA source at `fc157f76`):

  | Service | Versions |
  |---|---|
  | VTC 0.15 | `rooms/records/put` 0.1–0.3, `list` 0.1 and 0.5, `get` 0.2, `info` 0.1 and 0.3, `blobs/upload/{begin,chunk,commit,abort}/0.2`, `blobs/get/0.2`, `blobs/chunk/0.1`, `create/0.2`; `vtc/rooms/memberships/list/0.1`, `offers/list/0.4` |
  | VTA 0.65 | `rooms/keys/{seal,open,present}` 0.1–0.2, `list/0.2`, `read/0.1`, `browse` 0.1–0.2, `file-key` 0.1–0.2, `key-package/0.2`, `welcome/0.1`, `commit/0.1`, `profile/{read,write}/0.1` |

- Paging on `records/list` [V] (`VTI/vti-rooms/src/wire.rs:446-466, 602-637` at the pin; `VTI/vti-rooms/src/storage.rs:975, 998`):
  - request: `{roomId, presentation, prefix?, sinceVersion?, cursor?, limit?}`;
  - reply: metadata only, `{records, cursor | nextCursor (0.5), dataCommitment?, recordCount?, headVersion?}`;
  - the page cap is 500. A missing cursor is the only end-of-list signal. Bodies come from `get` (with a Merkle trace).

### 1.3 Auth

- The signer of the document is the presenter [V] (`VTI/vtc-service/src/rooms/handlers.rs:16-46`, `VTI/vti-rooms/src/authz.rs:1-81`).
  - Every payload carries `presentation: {membership, authority: [leaf…root], subjectBinding?}`, made of credentials the **room**
    issued (`wire.rs:178-195`).
  - The actions are `read`, `write`, `curate` and `admin`. None implies another.
  - There is no bearer token, host ACL or session. A presentation lives 4 hours (`VTI/vti-rooms-wasm/src/identity.rs:38`).
- The member's VTA mints presentations (`rooms/keys/present`, `BP/index.ts:185-246`). The app identity needs the `room-present` and
  `room-open` capabilities (`VTI/vta-service/src/operations/device.rs:1327-1328` at `fc157f76`). Farm app identities show `room-*`
  capabilities ([FARM.md](../FARM.md)).
- Creation [V]:
  - `rooms/create` needs the signer to be `ownerDid`. On a VTC, `rooms.rego` then lets members create `open` and `attributed` rooms
    (`VTI/vti-rooms/src/authz.rs:313-338`, `VTI/vtc-service/src/rooms/handlers.rs:318-387`).
  - Community rooms are created by an admin with `vtc.rooms.manage`, and members join through offers: list, then `key-package`, then
    `offers/accept` returns the Welcome (`VTI/docs/03-vtc/community-rooms.md:113-115, 488-566`).

### 1.4 Files

- Upload [V] (`data-rooms-files.md:256-304`):
  1. `blobs/upload/begin/0.2` returns `{uploadId, mode, missing}`.
  2. In proxied mode, `chunk` and `commit` are signed by a single-use upload `did:key`. `commit` returns `{blobRef}`.
- Download [V]: `blobs/get/0.2` returns a `downloadId` for `blobs/chunk/0.1`, or a presigned GET (`direct` mode, off on `private`).
- Limits [V]: chunks are 16–256 KiB and a blob is at most 1 GiB. The defaults per room are 100 MiB per file and 5 GiB in total
  (`data-rooms-files.md:278-279, 509-514`).
  - A VTC serves files only with `[rooms.files]` configured; reads work without it (`VTI/vtc-service/src/config.rs:350-357, 555-559`).
    This kit's `vtc-entrypoint.sh` does not configure it [V].
- Encryption on sealed tiers [V] (`data-rooms-files.md:118-170`, `VTI/vti-rooms/src/files.rs:64`):
  - `file_key = HKDF-SHA256(MLS-Exporter("openvtc/room/storage/v1"), salt=fileId, info=…roomId||epoch)`;
  - STREAM ChaCha20-Poly1305 with a final-chunk flag.
  - In the upstream design the file key is meant for the wallet's own context, never a web page (`data-rooms-files.md:208-237`).
- The media type is the author's unverified claim. The upstream portal previews only PNG, JPEG, GIF, WebP and UTF-8 text, and judges
  them from the bytes (`VTI/vtc-service/admin-ui/src/members/file-preview.ts:1-27`).

### 1.5 MLS

- The group runs on openmls 0.9 with suite `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` [V] (`VTI/vti-rooms/Cargo.toml:100`,
  `VTI/vti-rooms/src/mls.rs:69`).
- The record key is the MLS exporter secret: label `openvtc/room/storage/v1`, empty context, 32 bytes (`mls.rs:76, 384-400` at the pin).
- Records are sealed with ChaCha20-Poly1305 [V] (`VTI/vti-rooms/src/sealed.rs:261-345, 417-419` at the pin):
  - a random 12-byte nonce;
  - AAD = `"{roomId}|{key}|{version}|{epoch}"`;
  - base64url without padding.
- Older epochs are reached through the wrapped `EpochLink` chain (`wire.rs:264-271`, `data-rooms.md:492-570`).
- `VTI/vti-rooms-wasm` exports `Identity`, `RoomMember.{join, applyCommit, sealRecord, openRecord, fileSealer, fileOpener, snapshot,
  restore}` (`VTI/vti-rooms-wasm/src/lib.rs:157-521`, `files.rs:138-388`). It is not published to npm. It builds only with a Rust and
  wasm toolchain (`VTI/scripts/build-rooms-wasm-npm.sh`), and its snapshots are key material meant for IndexedDB.
- The host cannot read `attributed` or `private` content [V] (`data-rooms.md:94-160`).

### 1.6 Search, push and profiles

- **Search**: there is no search endpoint [V]. The only filters are `prefix` and `sinceVersion` (`wire.rs:446-466`). Server-side search
  is possible only on `open` by design, and sealed tiers rank on the client after decryption (`data-rooms.md:150, 603-605`).
- **Push**: there is no member-facing push for record changes [V]. The only SSE is the admin console's
  `vtc/admin/events/subscribe/0.6`, which sends hint-only topics `rooms` and `communityRooms` with no contents and needs admin
  (`VTI/vtc-service/src/admin_events/mod.rs:1-48, 138-184`). Members catch up by polling `sinceVersion` (`data-rooms.md:590, 676`).
- **Profiles**:
  - The VTC directory (`vtc/directory/*`) gives members a projection of other members' cards: display name and role by default, and
    **no DID** unless the member discloses it (`VTI/docs/03-vtc/member-directory.md:16-38, 279-320`; [VTC-SURFACE.md](../VTC-SURFACE.md)).
    So a room author's DID cannot, in general, be looked up in the directory.
  - A member can read their own card (`directory/card/show`).
  - The VTA serves a room-scoped profile, `rooms/keys/profile/{read,write}/0.1` (`VTI/vta-service/src/operations/room_profile.rs`),
    for sealed rooms only.

### 1.7 This kit today

- `packages/vtc-client` has `roomOffers()` and `roomMemberships()` only (`packages/vtc-client/src/index.ts:69-71, 582-586`).
- The rest of `rooms/*` is reachable through the generic `VtcClient.call` / `VtaClient.call`.
- Rooms are compiled into the pinned VTC with no cargo feature (`VTI/vtc-service/Cargo.toml:177`). Locally no room exists, the VTC has
  no `[rooms.files]`, and community rooms need `[rooms.community]` plus messaging, which local mode leaves off
  ([VTC-SURFACE.md](../VTC-SURFACE.md), "What does not exist").
- Docker is not usable by every developer account on a shared machine. It was not usable by the account that wrote this plan, so
  nothing in section 8 may depend on it.

### 1.8 Reference wallet client (summary)

- The reference wallet is a thin TypeScript client that holds **no MLS code and no room keys**. Every read goes through the member's
  VTA: `rooms/keys/list/0.2`, `rooms/keys/browse/0.1`, `rooms/keys/read/0.1`, plus `vtc/rooms/memberships/list/0.1` at each community.
- It polls on pull-to-refresh, has no push and no search, and shows authors as `identityWords` or a shortened DID (first 8 and last 6
  characters).
- Chat posts are `{profile: "keyring.chat/1", eventId, type: "message", content: {format: "text/plain", text}, clientTs}` records, and
  notes are `{title, body}` JSON.
- Writes and files are designed (`rooms/keys/act`, `rooms/keys/file-key`, `blobs/*`) but not built. It renders all text inert, with
  no markdown.

## 2. Where the code lives

- **`packages/rooms-client`** (`@buildathon/rooms-client`): framework-free TypeScript for Node and browser, like `vtc-client`. It holds
  the wire layer, the crypto boundary, the content envelope, search, the change feed and profile resolution. Subpath
  `@buildathon/rooms-client/mock` exports the in-process mock host and a mock VTA key oracle, used by tests and by the UI's no-Docker
  demo mode.
  - Why a package: the logic is reusable by any template or app, and every piece is testable under `node:test` with no DOM.
- **`templates/collab-room`** (`@buildathon/collab-room`): React 18 + Vite, structured like `templates/community-dashboard`:
  - plain modules (`state.ts`, `render.ts`) with `node:test` tests;
  - `hooks.ts` and `components/` as the React layer;
  - Vitest and jsdom UI tests with a fake;
  - the same `/__vta` and `/__vtc` dev proxy and credential embedding as the dashboard.
  - Why a template and not `apps/`: `apps/` is git-ignored user space, and a template is copyable with `npm run new`.
- New dependencies, pinned exactly (`.npmrc`):
  - `ts-mls`, for real client-side MLS in the local key path and tests;
  - `@noble/ciphers` and `@noble/hashes` (already in the lockfile), for ChaCha20-Poly1305 and HKDF.
  - No markdown library: a small inert renderer that produces React elements (section 5).

## 3. Architecture and tasks

```
UI (templates/collab-room)
  ChatView · NotesView · FilesView · SearchBar · ItemBody(markdown/image/gif/text) · Author
      │ hooks: useRoom(roomId) → {items, search, post, upload, status}
rooms-client
  RoomSession ── HostClient (rooms/* → VTC or room-host, signed docs)
      │        └─ KeyService (sealed tiers): VtaKeyOracle (rooms/keys/* at the VTA)  |  LocalMlsKeys (ts-mls, in-page)
      ├─ envelope.ts (chat | note | file | profile, JSON in record body)
      ├─ feed.ts (sinceVersion polling, dedupe, backoff) → change events
      ├─ search.ts (filename index + full-text inverted index over decrypted content)
      └─ profiles.ts (room profile records → VTC own card → DID fallback)
mock: MockRoomHost (in-process rooms/* with versions, paging, blobs) · MockKeyOracle (wraps LocalMlsKeys behind rooms/keys/*)
```

The steps are independently implementable in this order. Each step lands with its tests and one commit.

1. **`packages/rooms-client` skeleton and wire types**: `package.json`, `tsconfig.json`, `src/index.ts`, `src/tasks.ts` (type URIs,
   version table), `src/wire.ts` (Record, SealedContent, Presentation, list/get/put shapes, `nextCursor ?? cursor`). Test: parsers on
   fixtures.
2. **`src/host.ts` `HostClient`**: `info`, `list` (follows cursors, `sinceVersion`), `get`, `put` (create-only for sealed tiers),
   `blobUpload` (proxied: begin, chunks signed by a fresh upload `did:key`, commit) and `blobDownload` (`get`, then `chunk` loop). It
   takes a generic `send(type, payload)` so it runs over `VtcClient.call` or a room-host URL.
3. **`src/keys.ts` `KeyService` interface** (`present(roomId, action)`, `seal`, `open`) and **`src/vta-keys.ts` `VtaKeyOracle`**:
   `rooms/keys/{present,seal,open}` at 0.2, stepping down to 0.1 only on `unsupportedVersion` (the existing `versionStepAllowed`).
4. **`src/local-mls.ts` `LocalMlsKeys`**: a ts-mls group with the pinned suite, `createRoom`, `keyPackage`, `addMember` → Welcome,
   `join(welcome)`, `applyCommit`, and storage key = exporter(`openvtc/room/storage/v1`, empty, 32). Seal and open are byte-compatible
   with `sealed.rs`: ChaCha20-Poly1305, 12-byte nonce, AAD `roomId|key|version|epoch`, base64url without padding. Its state is
   serialised for IndexedDB. Tests: two members round-trip, a wrong AAD fails, a removed member cannot open the next epoch.
5. **`src/envelope.ts`**: an app envelope `{profile: "openvti.collab/1", kind, id, clientTs, ...}` in the record body. Kinds:
   - `chat {text, format: "text/markdown" | "text/plain"}`;
   - `note {title, body}`;
   - `file {name, mediaType, size, sha256, inline? (base64url) | blobRef?}`;
   - `profile {displayName, avatar? (inline data, at most 64 KiB)}`.
   On `open` rooms, `cleartext.title` and `description` mirror the name and kind so other clients see something. Record keys:
   - `open`: `chat/<ulid>`, `note/<ulid>`, `file/<ulid>`, `profile/<did-hash>`;
   - sealed: a random opaque 128-bit key, with the kind only inside the ciphertext (the spec requires opaque keys).
6. **`src/feed.ts`, the change feed**: section 6.
7. **`src/search.ts`**: section 7.
8. **`src/profiles.ts`**: section 9.
9. **`src/session.ts` `RoomSession`**: ties steps 2–8 together. `open(roomRef)`, then `items` (sorted by version), `post`, `saveNote`,
   `upload`, `fileBytes`, `search`, `onChange`, `close`. The tier picks plaintext or the KeyService.
10. **`src/mock/host.ts` `MockRoomHost`**: an in-process `send(type, payload, signer)` with:
    - rooms, room-wide versions, list paging (`limit`, `cursor` = `v<version>`), `sinceVersion`, `headVersion`;
    - `expectedVersion` conflicts, and blobs in proxied mode;
    - it refuses `cleartext` on sealed rooms and stores sealed rooms as ciphertext only;
    - it checks that a presentation is present and names the room (credential verification is the real host's job and is not mocked);
    - `fetchHandler()`, so the same mock can sit behind `fetch` for integration tests and the UI demo.
    **`src/mock/keys.ts` `MockKeyOracle`** answers `rooms/keys/*` documents with a `LocalMlsKeys` behind them, so the `VtaKeyOracle`
    wire is exercised end to end.
11. **`templates/collab-room`**:
    - `vite.config.ts` copies the dashboard's proxy and env handling and adds `COLLAB_MODE=mock|live`. Mock is the default when no
      room is configured: an in-browser `MockRoomHost` seeded with an open room and an attributed room and two simulated members.
    - `src/state.ts` holds pure view state; `src/hooks.ts` has `useRoom`.
    - Components:
      - `RoomPicker`: `roomMemberships()` live, the seeded rooms in mock.
      - `ChatView`: history ascending, "load older", auto-scroll only when at the bottom.
      - `NotesView`: list plus editor; saving writes a new record.
      - `FilesView`: upload, list, download.
      - `ItemBody`: plain text, markdown, image and GIF.
      - `Author`: avatar, name, DID tooltip.
      - `SearchBar`: mode toggle "File names" / "Full text", with results that jump to the item.
      - `LiveBadge`: polling state.
    - README with the verified/unverified table.
12. **Docs**: a row in the README templates table, [ARCHITECTURE.md](../ARCHITECTURE.md) layout and tests rows, and a TRY-THIS exercise
    for mock mode.

## 4. MLS: what is real, what is stubbed, risks

- **Production path (`VtaKeyOracle`)**: the member's VTA holds the group and keys, as upstream designs it. The page never sees an epoch
  key. It is the default for live mode.
  - Real wire, built from the pinned schemas.
  - **[unverified] live**: no room exists locally, and joining one needs an offer, a key package and a Welcome through the VTA, which
    needs community rooms (`[rooms.community]` plus messaging), off in local mode.
- **Local path (`LocalMlsKeys`, ts-mls)**: real MLS (RFC 9420) in the page, used by the mock demo and by tests. The record format
  follows `sealed.rs` exactly.
  - Its state is serialised and stored in IndexedDB under the page origin, and in memory only in tests. As [SECURITY.md](../SECURITY.md)
    says for every key in this kit, a playground only.
  - **[unverified]**: interoperability with openmls. Both follow RFC 9420 and the exporter is standard, but no cross-implementation
    Welcome or exporter vector was run. A test vector from `VTI/vti-rooms` would close this (open question 3).
- **Stubbed**:
  - Sealed-tier blob files (STREAM file keys via `rooms/keys/file-key`). Sealed rooms carry files **inline** in the sealed record, up to
    a 256 KiB cap; larger files are refused with a clear message.
  - Open rooms use real blobs.
  - Epoch-chain backfill of history from before the member joined.
  - Owner-side membership commits beyond the local demo.
- **Risks**:
  1. Pinned version drift: records/put 0.3 vs 0.1 semantics were not diffed field by field. The client sends the shared fields only.
  2. The host's maximum record body size was not found, so the inline cap may be refused by a real host [unverified].
  3. ts-mls bundle size and WebCrypto availability (X25519 and Ed25519 in jsdom/Node 20: ts-mls uses noble fallbacks [I]).
  4. Polling cost against the rate limits (per-presenter 120, `VTI/vtc-service/src/config.rs:452-512`). The feed backs off.

## 5. Rendering

- **Plain text**: always the default for chat with `format: text/plain`.
- **Markdown** (`render.ts` → React elements, never `innerHTML`):
  - headings, emphasis, inline code, code blocks, lists, block quotes, links;
  - links only for `http(s):` and `mailto:`, shown with their URL, `rel="noopener noreferrer"`;
  - markdown images are rendered as links, not fetched. A page must not load third-party URLs that the room's authors chose.
- **Images and GIFs**: only from room file items. The type is sniffed from the bytes (PNG, JPEG, GIF, WebP magic). They are shown through
  a `blob:` object URL, which is revoked on unmount. GIFs animate natively. SVG and anything else is download-only.
- **Text files** (UTF-8, at most 1 MiB) are shown as plain text; `.md` files are shown through the markdown renderer.

## 6. Live updates

- **Polling only.** No member push exists (1.6). `Feed` polls `records/list` with `sinceVersion = lastSeenVersion`:
  - every 3 s while the page is visible, 15 s while hidden;
  - right away after the client's own write;
  - exponential backoff to 60 s on errors, and on `429` it respects `Retry-After`.
- New metadata is deduplicated by `(key, version)`, bodies are fetched (`get`) and opened, and `onChange({added, updated, retracted})`
  is emitted.
- `headVersion` is the watermark: equal means nothing to fetch.
- A `ChangeSource` interface lets a push source (DIDComm/TSP, or a future member SSE) replace the poll timer without touching the UI.

## 7. Search

- **Fully client-side, for both tiers** (no host search exists). The index lives in memory only and is never persisted, so decrypted
  sealed content is never written to disk.
  - **Mode 1, file names**: over `file` items. The name is normalised (lowercase, NFKD without diacritics), with a substring match plus
    a token-prefix match. Ranked as exact, then prefix, then substring, then newest.
  - **Mode 2, full text**: an inverted index over chat text, note title and body, and the decoded content of text files (`text/*`,
    `.md`, `.json`, `.csv`, at most 1 MiB). Text files on open rooms are fetched lazily as blobs.
    - Query terms are ANDed; `"quoted phrases"` must appear in order.
    - Results carry a snippet with highlight ranges, rendered as `<mark>` elements.
- The index is updated incrementally from feed events, and retracted records are removed.

## 8. Verification

Everything below runs without Docker:

- Unit tests (`node:test` via `tsx --test`, the kit's convention) in `packages/rooms-client/test`:
  - wire parsers;
  - envelope encode and decode;
  - search, both modes: ranking, phrases, diacritics, removal on retract;
  - the feed with a fake clock: dedupe, backoff, visibility interval, the watermark;
  - profile resolution and fallback: an impersonating profile (author ≠ subject) is ignored;
  - `LocalMlsKeys`: two-member group, seal/open round trip, wrong AAD/epoch fails, removed member;
  - `VtaKeyOracle` against `MockKeyOracle`;
  - `HostClient` against `MockRoomHost`, including paging over 500 records, conflicts, and a blob round trip.
- An integration test (`test/integration.test.ts`): two `RoomSession`s on one `MockRoomHost` over a fake `fetch`, for an open room and
  an attributed room.
  - Alice posts chat, a markdown note and a GIF/PNG file; Bob's feed picks them up and both search modes find them.
  - The host's stored data for the sealed room contains no plaintext, checked by searching the stored bytes for the message.
- UI tests (Vitest and jsdom) in `templates/collab-room/test/ui`:
  - markdown rendered inert (`<script>` and `javascript:` stay text);
  - image and GIF shown by sniffed type, SVG not shown;
  - author shows name and avatar, or the shortened DID;
  - a live item appears without reload;
  - search mode toggle.
- Typecheck of both workspaces. The commands are the workspace's `test` and `typecheck` scripts plus the root `npm test`.
- **Flagged unverified live** (README table):
  - any real VTC or room-host call;
  - `rooms/keys/*` against a real VTA;
  - ts-mls ↔ openmls interop;
  - the record size cap;
  - Farm mode;
  - a browser run of the built page (jsdom only, unless a headless Chromium is available).

## 9. Profile resolution

Profile resolution goes through `ProfileResolver.resolve(did) → {did, displayName?, avatarUrl?, source}`, cached per session. The
sources are tried in order:

1. **The room's own profile records**: the newest `profile` item **authored by** that DID. The record's `author` must equal the
   profile's subject, otherwise it is ignored. On `private` rooms there is no author, so this source is skipped.
   - When a session opens, the client publishes its profile once if missing or stale. The profile comes from the member's VTC card
     (`directory/card/show`, its display-name field and picture), else from a name the user types.
2. **The VTC card**, for the current member only.
3. **Fallback**: a shortened DID (first 8 and last 6 characters), with the full DID in a tooltip, and an identicon derived from the
   DID hash. "You" is shown for self.

The VTA's room profile (`rooms/keys/profile/*`) is left for later (open question 4).

## 10. Open questions (recommended default)

1. Should live mode create rooms, or only use rooms the member already holds? **Default: hold only** (`roomMemberships()`). Add create
   (`rooms/create/0.2`, open tier) behind a button for a member that is its own owner, unverified.
2. What is the sealed-room file cap? **Default: 256 KiB inline**, with blob file keys left for later.
3. How do we check ts-mls ↔ openmls interop? **Default**: flag it unverified, and add a fixture test as soon as `VTI/vti-rooms` exports a
   vector (exporter output for a known group).
4. Should profiles also use `rooms/keys/profile`? **Default: no** for now. The room-record profile works on both tiers and in the mock.
5. Is chat its own record per message? **Default: yes**, one create-only record each (sealed tiers need create-only anyway).
6. What is the poll interval? **Default: 3 s visible and 15 s hidden**, configurable.
7. Should the UI demo default to mock mode? **Default: yes**, when `COLLAB_ROOM` is not set, so it runs with no stack.
