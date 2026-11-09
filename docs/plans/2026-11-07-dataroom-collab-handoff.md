# Handoff: data-room collaboration, steps 1–12 of the plan

Status 2026-11-07. Branch `feature/dataroom-collab`. The plan is [2026-11-07-dataroom-collab-plan.md](2026-11-07-dataroom-collab-plan.md).
**All twelve steps are done.** `packages/rooms-client` (steps 1–10) and `templates/collab-room` (step 11) are in, with the docs
(step 12). Every commit passes its workspace's tests and typecheck. Nothing has been pushed.

## Done

### `packages/rooms-client` (steps 1–10)

`@starter/rooms-client`, with the `./mock` subpath. The public API, a quick start and the verified/unverified table are in
[packages/rooms-client/README.md](../../packages/rooms-client/README.md).

| Module | What it has |
|---|---|
| `tasks.ts`, `wire.ts` | Type URIs and version table; wire types and parsers (`nextCursor ?? cursor`, flat or `{record}` get replies, chunk field names) |
| `host.ts` | `HostClient` (`info`, `list`, `get`, `put`, `curate`, `blobUpload`, `blobDownload`) over `vtcTransport(vtc)` or `roomHostTransport({url, hostDid, me, fetch})` |
| `keys.ts`, `vta-keys.ts`, `local-mls.ts` | `KeyService`; `VtaKeyOracle` (`rooms/keys/*` at 0.2, 0.1 on an allowed step-down); `LocalMlsKeys` (ts-mls, the pinned suite, `sealed.rs` record format) |
| `envelope.ts`, `feed.ts`, `search.ts`, `profiles.ts` | `openvti.collab/1` envelope; `Feed` + `PollSource`; `SearchIndex`; `ProfileResolver` |
| `session.ts` | `RoomSession` ties them together |
| `mock/` | `MockRoomHost`, `MockKeyOracle`, `ManualClock` |

### `templates/collab-room` (step 11)

`@starter/collab-room`, React 18 + Vite, laid out like `templates/community-dashboard` (same pinned dependency versions, tsconfig,
`vite.config.ts` env and `/__vta` `/__vtc` proxy via `scripts/lib/dev-proxy.ts`, Vitest + jsdom for `test/ui`). Its README has the
modes, the rendering rules and the verified/unverified table: [templates/collab-room/README.md](../../templates/collab-room/README.md).

| File | What it has |
|---|---|
| `vite.config.ts` | `COLLAB_MODE=mock\|live` (from the environment or the repo-root `.env`); default mock unless `COLLAB_ROOM` is set |
| `src/render.ts` | Inert markdown: source to a block/inline tree to React elements; links only http(s)/mailto with the URL shown and `rel="noopener noreferrer"`; images as links; raw HTML as text; nesting capped |
| `src/state.ts` | Pure view state: ordering, chat window and auto-scroll, composer and note drafts, `classifyFile` (images by `sniffImage` only; SVG and unknown download-only; UTF-8 text at most 1 MiB, `.md` as markdown), highlights, labels |
| `src/backend.ts`, `src/mock.ts`, `src/live.ts` | Backend interface; the seeded mock (open room with three members and hostile content; attributed room with real two-member MLS; simulated Bob posting every 12 s); live wiring (VtcClient from the credential, `roomMemberships()`, `HostClient` over `vtcTransport`, `VtaKeyOracle` over `VtaClient`) |
| `src/demo-media.ts` | The mock's PNG and animated GIF, generated in code (no binary files in the tree) |
| `src/hooks.ts` | `useSession`, `useRoom` (onChange, `PollSource.onStatus`, `visibilitychange` to `setVisible`), `useFileBytes`, `useObjectUrl` (revoked on unmount) |
| `src/components/` | `RoomPicker`, `ChatView`, `NotesView`, `FilesView`, `ItemBody`, `Author`, `SearchBar`, `LiveBadge` |

### Docs (step 12)

- Root README: repo-map rows for `packages/rooms-client` and `templates/collab-room`, a templates-table row, the exercise list.
- [docs/ARCHITECTURE.md](../ARCHITECTURE.md): layout rows for both, the React section, and tests rows for both.
- [docs/TRY-THIS.md](../TRY-THIS.md): exercise 8d, the collaboration room in mock mode (no stack needed).
- `docs/STATUS.md` has no per-template table, so it was left unchanged.

## Tests and how to run

From the repo root, with `umask 002`, `TMPDIR=/var/tmp/dataroom-collab`, under `nice -n 10` and `timeout`:

| Command | Result at the last commit |
|---|---|
| `npm test -w @starter/collab-room` | node:test 16/16 pass (`render` 8, `state` 7, `mock` 1); Vitest 9/9 pass in 7 files (`markdown` 3, `files`, `author`, `live`, `search`, `chat`, `rooms`) |
| `npm run typecheck -w @starter/collab-room` | clean |
| `npm test -w @starter/rooms-client` | 61/61 pass |
| `npm run typecheck -w @starter/rooms-client` | clean |
| `npx tsc --noEmit` (root; covers `templates/*/src` and `packages/*`) | clean |
| `npx tsx scripts/check-generic.ts`, `npx tsx scripts/check-docs.ts` | ok |
| `npx vite build` in `templates/collab-room` (output to a scratch directory) | builds |

Run the UI:

```sh
npm run dev -w @starter/collab-room                    # mock mode, no stack
COLLAB_MODE=live npm run dev -w @starter/collab-room   # live mode, needs the stack's .env (unverified live)
```

## Deviations

- Live mode signs as the credential's `did:key`. It does not copy the dashboard's tunnel-mode `did:peer:2` choice, because a room
  presentation names the member's subject, and the plan did not settle which DID that is in tunnel mode.
- Live mode calls `vta.authenticate()` and continues if it fails: `rooms/keys/*` are signed documents and it is [unverified] whether
  the VTA wants a session for them.
- Markdown headings render two levels down (`#` is `<h3>`), so a body never outranks the page's own headings.
- `.md` files are previewed only when valid UTF-8 and at most 1 MiB; bytes are fetched for a preview only up to 8 MiB
  (`PREVIEW_FETCH_CAP`); larger files are download-only.
- Avatars come from `ProfileResolver` as `data:` URLs (already sniffed there), not `blob:` URLs. Only file items use `blob:`.
- The mock's simulated member alternates rooms, so each room gets a new message every 24 s.

## Verified and unverified

- **Verified (tests, Node and jsdom, against the mock host)**: chat, notes, files, search modes, attribution and live polling on both
  tiers; markdown inert; images by sniffed bytes through revoked `blob:` URLs; SVG and mislabelled files download-only; the sealed
  room's stored bytes hold no plaintext; the sealed 256 KiB upload cap message.
- **Verified**: the page builds with `vite build`.
- **Unverified**: the page in a real browser (jsdom only; no headless browser run); live mode end to end (`vtc/rooms/memberships/list`,
  `rooms/*` at a VTC, `rooms/keys/*` at a VTA), because no room exists in the local stack and joining one needs community rooms;
  ts-mls ↔ openmls interop; the host's record size cap; `sealed.version` in a real VTA's seal reply; everything else listed in the
  rooms-client README's table.

## Left

Nothing from the plan. Possible next steps:

1. A headless-browser run of the mock page (the kit's `scripts/lib/cdp.ts` drives Chromium for the dashboard's e2e).
2. Live mode against a VTC with `[rooms.community]`, messaging and `[rooms.files]` configured.
3. An openmls interop vector (plan open question 3), sealed blob files via `rooms/keys/file-key`, and epoch-chain backfill.
