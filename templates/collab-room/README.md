# Collaboration room

A React + TypeScript (Vite) collaboration space on VTI **data rooms**: chat history, notes, files, live updates, two search
modes and contributor attribution, for both the plaintext tier (`open`) and the MLS-sealed tiers (`attributed`). It is built on
[`@starter/rooms-client`](../../packages/rooms-client/README.md); the design, with citations, is
[docs/plans/2026-11-07-dataroom-collab-plan.md](../../docs/plans/2026-11-07-dataroom-collab-plan.md). DEV ONLY.

```sh
npm run dev -w @starter/collab-room       # mock mode: no stack, no Docker; http://localhost:5173 (or the port Vite reports)
npm test -w @starter/collab-room          # node:test for the plain modules, then Vitest + jsdom component tests
npm run typecheck -w @starter/collab-room
COLLAB_MODE=live npm run dev -w @starter/collab-room   # live mode: VTC + VTA from the repo-root .env (open rooms verified live by the rooms:* commands; docs/ROOMS.md)
```

## Modes

`COLLAB_MODE=mock|live`, from the environment or the repo-root `.env`. With neither set, the mode is **mock** unless
`COLLAB_ROOM=<room DID>` is set, which makes it live.

- **mock** (default): one `MockRoomHost` runs in the page, reached over a fake `fetch` with signed Trust Task documents, as a
  room-host would be. It is seeded with:
  - **Project room (open)**: plaintext, files as blobs. Members: you, Bob (publishes a name and an avatar) and Carol (no
    profile, so she shows as a short DID). Chat history, a markdown note full of hostile markup, a PNG, an animated GIF, an
    SVG with a script, a file that claims `image/png` but is HTML, a text file and a `.md` file;
  - **Deal room (attributed)**: real two-member MLS (`LocalMlsKeys`, ts-mls) between you and Bob. The host stores ciphertext
    only; files are sealed inline (at most 32 KiB, the host's 64 KiB document cap; a larger upload shows the session's message).
  - Bob is simulated: every 12 s he posts the next line of a script, alternating between the rooms, so the live feed is visible.
  - Keys and content live in memory only and vanish on reload.
- **live** (open and attributed rooms verified live through the same library by the `rooms:*` commands; this page in a browser, and sealed rooms from this page, are not): the identity is the app credential (`VTA_CREDENTIAL`, as in `community-dashboard`), signing as
  its `did:key`. Rooms come from `vtc/rooms/memberships/list` (admitted rooms), or `COLLAB_ROOM` names one. `rooms/*` go to the
  VTC over `/__vtc` (`HostClient` over `vtcTransport`); presentations, seals and opens go to the member's VTA over `/__vta`
  (`VtaKeyOracle` over `VtaClient`, `rooms/keys/*`); on an open room, when the VTA refuses, the room offer's own credentials are
  presented instead (`offerFallbackPresenter`). The same dev proxy as the dashboard keeps the page same-origin. The local stack has
  no room, so use a community whose host has rooms, and accept the room's offer first (`npm run rooms:accept`, [docs/ROOMS.md](../../docs/ROOMS.md)).

## What you see

A room list on the left, then for the open room: its tier chip, the **LiveBadge** (poll status), who you are, a search bar and
three tabs.

| Part | What it does |
|---|---|
| `RoomPicker` | The seeded rooms (mock) or the admitted memberships (live). |
| `ChatView` | History ascending by host version, the newest 20 with **Load older**; auto-scrolls only when you are at the bottom or the newest message is yours. Composer with a **Plain text / Markdown on** toggle (Enter sends, Shift+Enter is a new line). |
| `NotesView` | List (newest first) and an editor. **Save new version** writes a new create-only record; the newest version wins. |
| `FilesView` | Upload, list with an inert preview each, **Download**. |
| `ItemBody` | Plain text; markdown through `render.ts`; images and GIFs from room files; text files. |
| `Author` | Avatar (from the room profile, sniffed as an image) or an identicon, the display name, "You" for yourself, or the short DID (first 8 and last 6 characters); the full DID in the tooltip. |
| `SearchBar` | **File names** or **Full text**, results with a `<mark>`-highlighted snippet that jump to the item (switching tab and highlighting it). |
| `LiveBadge` | Connecting, Live (every 3 s), Live (tab hidden: every 15 s), or Reconnecting (backing off). Wired to `document.visibilitychange`. |

## Rendering rules

Record bodies are untrusted. Nothing is passed to `innerHTML` or `dangerouslySetInnerHTML` anywhere in this template.

- **Markdown** (`src/render.ts`, source to a small tree to React elements): headings (shifted down two levels), emphasis, inline
  code, code blocks, lists, block quotes, rules and links. Raw HTML such as `<script>` stays visible text. Links are links only for
  `http:`, `https:` and `mailto:` (judged on the parsed URL), always shown with their URL, with `rel="noopener noreferrer"`; anything
  else stays text. Markdown images become a link and are never fetched.
- **Images and GIFs** only from room files, typed by their bytes (`sniffImage`: PNG, JPEG, GIF, WebP), shown through a `blob:`
  object URL that is revoked on unmount. The claimed media type decides nothing. SVG and anything unknown are download-only.
- **Text files** that are valid UTF-8 and at most 1 MiB are shown as text; `.md` files go through the markdown renderer.
- **Search** runs in memory over decrypted content, never persisted (no host search exists).
- **Live updates** are polling (`records/list` with `sinceVersion`); no member push exists.

## Code

| File | Role |
|---|---|
| `src/state.ts` | Pure view state: ordering, the chat window, auto-scroll, file classification, highlights, labels. |
| `src/render.ts` | The inert markdown renderer. |
| `src/backend.ts`, `src/mock.ts`, `src/live.ts` | The backend interface, the seeded mock, the live wiring. |
| `src/demo-media.ts` | The mock's PNG and animated GIF, generated in code. |
| `src/hooks.ts` | `useSession`, `useRoom` (onChange, poll status, visibility), `useFileBytes`, `useObjectUrl`. |
| `src/components/` | The thin React layer. |

## Tests

`npm test -w @starter/collab-room` runs both suites:

- `test/*.test.ts` (node:test): `render.test.ts` (tree structure, React output, `<script>`/raw HTML/`javascript:` inert, images as
  links, hostile nesting), `state.test.ts`, `mock.test.ts` (both seeded rooms, no plaintext stored for the sealed one, Bob's post
  arrives through the feed on a `ManualClock`).
- `test/ui/*.test.tsx` (Vitest, jsdom, `URL.createObjectURL` stubbed in `setup.ts`, `fetch` refused): markdown inert in the DOM;
  PNG and GIF as `<img>` with `blob:` URLs by sniffed type, SVG and a mislabelled file not, URLs revoked on unmount; text and `.md`
  files; author name and avatar, short-DID fallback and "You"; a simulated member's post appearing without reload, and the badge on
  visibility changes; the search mode toggle and jumping to results; chat history and **Load older**; the open and the sealed room
  (post, note version, sealed upload cap).

## Verified and unverified

Markers: **verified** = shown by the tests here (Node and jsdom, against the mock host); **inferred** = worked out from the spec or
source, not seen; **unverified** = built but not tried.

| What | Status |
|---|---|
| Chat, notes, files, search, attribution, live polling on both tiers against the in-page mock host | verified (tests) |
| Markdown inert; images by sniffed bytes through revoked `blob:` URLs; SVG and mislabelled files download-only | verified (tests) |
| The sealed room's host stores no plaintext (mock) | verified (tests) |
| `vite build` of the page | verified (it builds) |
| The page in a real browser | **unverified**: jsdom only, no headless browser run of this template |
| Live mode on an **open** room: `rooms/offers/list`, `rooms/info`, a chat post and read back at a 0.26.0 VTC, presenting the offer's own credentials when the VTA refuses (the library and the `rooms:*` commands; this page's live wiring uses the same code) | verified live 2026-11-08 by the CLI; the page itself was not run in a browser |
| Live mode on a **sealed** room | the library and the `rooms:*` commands are **verified live** with a persona (docs/ROOMS.md); this page signs as the app `did:key`, so it cannot join a sealed room yet (the persona and the vault step are CLI only) |
| ts-mls ↔ openmls interop, the host's record size cap, `sealed.version` in the VTA's seal reply | **unverified** (see the rooms-client README) |
| Live mode signing as the credential's `did:key` (not the dashboard's did:peer choice in tunnel mode) | inferred to be what a room host expects |
