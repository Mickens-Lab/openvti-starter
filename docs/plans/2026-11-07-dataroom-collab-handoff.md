# Handoff: rooms-client, steps 1–8 of the collaboration plan

Status 2026-11-07. Branch `feature/dataroom-collab`. The plan is [2026-11-07-dataroom-collab-plan.md](2026-11-07-dataroom-collab-plan.md).
The work stopped at a clean point because of the context budget. Every commit passes the package tests and typecheck.

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

Tests: `test/{wire,host,keys,envelope,feed,search,profiles}.test.ts`. There are 47 tests and all pass.

## Left

1. **`src/session.ts` `RoomSession`** (step 9). The suggested shape:
   - `RoomSession.open({roomId, host: HostClient, keys?: KeyService, self: string, profile?: {displayName, avatar?}, source?, selfCard?})`
     calls `host.info`, which gives the visibility. A sealed tier requires `keys`.
   - `items(): Item[]`, sorted by version, where `Item = {key, version, author?, envelope, status}`. Notes collapse by
     `envelope.id`, and the newest version wins.
   - `post(text, format)`, `saveNote(title, body, id?)`, `upload(name, mediaType, bytes)`, `fileBytes(item)`, `search(q, mode)`,
     `onChange`, `close`. `profiles` is a `ProfileResolver`.
   - Writes:
     - open rooms: `put({key: recordKeyFor(env,"open"), expectedVersion: 0, cleartext: cleartextFor(env), blobs?})`. A file goes
       up first with `host.blobUpload`, and its envelope carries `blobRef`. A profile overwrites (no `expectedVersion`).
     - sealed rooms: `version = feed.watermark + 1`, then `keys.seal(roomId, key, version, utf8(encodeEnvelope(env)))`, then
       `put({key: opaqueKey, expectedVersion: 0, sealed})`. A file is inline only, and anything over `INLINE_FILE_CAP` is refused
       with a clear error.
     - every write: `feed.markSeen(key, version)`, add the item locally, then `feed.kick()`.
   - Reads (the feed's `get`): `host.get`, then decode `cleartext.body`, or `keys.open(roomId, key, sealedVersion(rec.version,
     rec.sealed), rec.sealed)`, then `decodeEnvelope`.
   - Index into `SearchIndex`:
     - chat: `text`;
     - note: `title` and `body`;
     - file: `name`, and `text` when `isIndexableText` (inline bytes, or a lazy `blobDownload` on open rooms).
   - Offer profiles to the resolver with `rec.author`.
   - Retracted records: remove them from the items and from the index.
   - Publish your own profile once, when it is missing or stale.
2. **`test/integration.test.ts`**: two `RoomSession`s on one `MockRoomHost` through
   `roomHostTransport({fetch: host.fetchHandler()})`, for an open room and an attributed room. For the attributed room, Alice runs
   `LocalMlsKeys.createRoom` and `addMembers([bob.keyPackage()])`, Bob runs `join`, and each member is wrapped in
   `VtaKeyOracle(new MockKeyOracle(keys, did))`. The test:
   - Alice posts chat, a markdown note, a PNG, a GIF and a text file;
   - Bob's feed gets each of them (drive it with `ManualClock` or `feed.sync()`);
   - both search modes find them;
   - `storedBytes(sealedRoom)` contains none of the plaintexts.
3. **`packages/rooms-client/README.md`**: the public API above plus the session, a quick start, and the verified/unverified table
   below. Then run `check-docs`.
4. Update `src/index.ts` (it exports everything listed above) to add `session.js`.

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
- A sealed version comes from `sealed.version ?? record.version` [inferred]. The session seals with `watermark + 1` before the put.
  If another write lands in between, the record still opens because `sealed.version` is carried.
- The mock host tracks the highest epoch it has seen, not owner commits.
- Unverified live:
  - any real host or VTA call;
  - ts-mls ↔ openmls interop;
  - the record size cap.
