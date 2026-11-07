# Handoff: rooms-client, steps 1–10 of the collaboration plan

Status 2026-11-07. Branch `feature/dataroom-collab`. The plan is [2026-11-07-dataroom-collab-plan.md](2026-11-07-dataroom-collab-plan.md).
`packages/rooms-client` is complete (steps 1–10). Every commit passes the package tests and typecheck. What is left is the UI
template (step 11) and the docs (step 12).

## Done

`packages/rooms-client` (`@buildathon/rooms-client`, with the `./mock` subpath):

| Module | What it has |
|---|---|
| `tasks.ts` | `ROOMS_TASK`, `KEYS_TASK` (0.2 and 0.1), `LIST_PAGE_CAP`, `STORAGE_EXPORTER_LABEL`, `MLS_SUITE`, `CHUNK_MIN/MAX` |
| `wire.ts` | wire types; `parseListPage` (`nextCursor ?? cursor`), `parseGetReply` (flat binding or `{record}`), `parsePutReply`, `parseInfo`, `blobManifest`, `blobRefOf`, `chunkWire` (every chunk field name in one place), `b64u`/`unb64u`/`utf8`/`fromUtf8`, `isSealedTier` |
| `host.ts` | `HostClient(transport, presenter, now?)`: `info`, `listPage`, `list` (follows cursors), `get`, `put` (sealed must be `expectedVersion: 0`), `curate`, `blobUpload` (proxied, fresh upload did:key), `blobDownload`. Transports: `vtcTransport(vtc)`, `roomHostTransport({url, hostDid, me, fetch, mount})`. Also `signDoc`, `isVersionConflict`, `RateLimitedError.retryAfterMs` |
| `keys.ts` | `KeyService {present, seal, open}`, `sealedVersion(recordVersion, sealed)` |
| `vta-keys.ts` | `VtaKeyOracle(taskCaller)`: 0.2, then 0.1 only via `versionStepAllowed`, remembered per task |
| `local-mls.ts` | `LocalMlsKeys(memberId, {present?})`: `createRoom`, `keyPackage`, `addMembers` (returns `{welcome, commit, epoch}`), `removeMember`, `join`, `applyCommit`, `seal`, `open`, `epoch`, `members`, `has`, `snapshot`, `LocalMlsKeys.restore`. Also `sealWithKey`, `openWithKey`, `recordAad` |
| `envelope.ts` | `openvti.collab/1` envelope: `makeChat`, `makeNote(title, body, id?)`, `makeFile(name, type, bytes, {inline} or {blobRef})`, `makeProfile(subject, name, avatar?)`, `encodeEnvelope`, `decodeEnvelope`, `recordKeyFor(env, visibility)`, `cleartextFor`, `ulid`, `opaqueKey`, `didHash`, `sniffImage`, `INLINE_FILE_CAP` (256 KiB), `AVATAR_CAP` |
| `feed.ts` | `Feed({list, get, source?, sinceVersion?})`: `start`, `stop`, `kick`, `sync`, `markSeen`, `onChange({added, updated, retracted, failed})`, `watermark`. `PollSource({clock, visibleMs, hiddenMs, maxBackoffMs, visible})`: `setVisible`, `status`, `onStatus`, `nextDelay`. `ChangeSource`, `Clock`, `systemClock` |
| `search.ts` | `SearchIndex`: `upsert(SearchItem)`, `remove(id)`, `searchNames(q)`, `searchText(q)`; `normalize`, `parseQuery`, `isIndexableText`, `TEXT_INDEX_CAP` |
| `profiles.ts` | `ProfileResolver({self?, selfCard?})`: `offer(profile, author, version)`, `resolveSync`, `resolve`, `roomProfile`; `shortDid`, `identicon` |
| `mock/host.ts` | `MockRoomHost(hostDid?, now?)`: `createRoom`, `setEpoch`, `send`, `transport(me)`, `fetchHandler()` (checks proof, issuer and recipient), `storedBytes(roomId)`, `inject`, `calls`; `mockPresentation(roomId, subject, action)` |
| `mock/keys.ts` | `MockKeyOracle(localMlsKeys, subjectDid, {versions?})`: a `TaskCaller` for `VtaKeyOracle` |
| `mock/clock.ts` | `ManualClock` (`advance`, `pending`), `settle()` |
| `session.ts` | `RoomSession.open({roomId, host, keys?, self, profile?, selfCard?, source?, start?})`: `items`, `item`, `history`, `post`, `saveNote`, `upload`, `fileBytes`, `search(q, "names" \| "text")`, `onChange`, `profiles`, `feed`, `close` |

Tests: `test/{wire,host,keys,envelope,feed,search,profiles,session,integration}.test.ts`. There are 61 tests and all pass.

The public API, a quick start and the verified/unverified table are in [packages/rooms-client/README.md](../../packages/rooms-client/README.md).
Build the UI from that README.

## Left

1. **Step 11, `templates/collab-room`** (plan section 3, step 11, and sections 5 and 6). Notes for it:
   - Mock mode: one in-browser `MockRoomHost` reached through `roomHostTransport({fetch: host.fetchHandler()})`, seeded with an
     `open` and an `attributed` room. For the sealed room, build two `LocalMlsKeys` and join them as `test/integration.test.ts` does.
   - `useRoom` wraps `RoomSession`: re-read `session.items()` on every `onChange`, re-resolve authors listed in `change.profiles`,
     and wire `document.visibilitychange` to `(session.feed.source as PollSource).setVisible(...)`. `LiveBadge` reads
     `PollSource.status` and `onStatus`.
   - Narrow items on `item.envelope.kind`. Images: `sniffImage(await session.fileBytes(item))`, shown through a `blob:` URL.
   - Sealed uploads over 256 KiB throw a readable error: show it.
2. **Step 12, docs**: a row in the README templates table, [ARCHITECTURE.md](../ARCHITECTURE.md) layout and tests rows, and a TRY-THIS
   exercise for mock mode.

## State and how to run

- ts-mls 1.6.4 is installed in the workspace (`packages/rooms-client/node_modules/ts-mls`).
- `@noble/ciphers` is **2.1.1**, not the 2.4.0 at the root, because ts-mls 1.6.4 has an exact non-optional peer on 2.1.1.
  npm nests both packages under the workspace.
- Commands (run from the repo root, with `umask 002`, `TMPDIR=/var/tmp/dataroom-collab`, under `nice -n 10` and `timeout`):
  `npm test -w @buildathon/rooms-client`, `npm run typecheck -w @buildathon/rooms-client`, `npx tsx scripts/check-generic.ts`,
  `npx tsx scripts/check-docs.ts`.

## Deviations and unverified

- `records/get/0.2`: the generated binding is flat (the record's fields at the top level), not `{record: {...}}`. The parser accepts
  both.
- Chunk field names (`uploadId, index, digestMultibase, data`; download `downloadId, index`) come from the generated
  `@openvtc/trust-tasks` bindings. They are not checked against a live host.
- `records/curate/0.1` (used for retract) is not in the pinned VTC's served matrix. The mock gives a curate a new room-wide version
  [inferred].
- `isVersionConflict` matches `versionConflict`/`conflict`/`alreadyExists` codes or `details.reason: "conflict"`. The host's real
  code is [unverified].
- `roomHostTransport` needs `hostDid` to be passed in. How a room-host publishes its DID is [unverified].
- A sealed version comes from `sealed.version ?? record.version` [inferred]. A sealed write runs `feed.sync()` first and seals for
  `watermark + 1`. If another write lands in between, the record still opens because `sealed.version` is carried, which a real
  VTA's seal reply is [unverified] to include.
- Open-room files are always blobs (never inline). Text files there are downloaded on the first full-text search, once.
- Anyone in a room may save a new version of a note (newest wins). A record key stays bound to its first envelope id, and an id
  keeps its kind.
- The mock host tracks the highest epoch it has seen, not owner commits.
- Unverified live:
  - any real host or VTA call;
  - ts-mls ↔ openmls interop;
  - the record size cap.
