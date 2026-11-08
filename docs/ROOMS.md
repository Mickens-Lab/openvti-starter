# Data rooms: read and post from your app or the command line

Part of the [docs index](README.md). Evidence labels as in [VTC-SURFACE.md](VTC-SURFACE.md): **live** = observed against a real host, **source** = read in code or a schema, **unverified** = built but not tried. Everything here is a playground ([SECURITY.md](SECURITY.md)).

A data room is a shared space on a community's host: chat, notes and files, with a record history. This kit reaches one with [`@starter/rooms-client`](../packages/rooms-client/README.md) (library), [`templates/collab-room`](../templates/collab-room/README.md) (a UI), and the `rooms:*` commands below (command line).

## The short answer

- **Open rooms: live.** Join, accept the offer, post, read back (verified 2026-11-08 on a VTC 0.26.0 host, app identity of a VTA 0.72.0 on the ic3 Farm).
- **Attributed (sealed) rooms: live, with a persona.** The same day, one run: a persona DID minted by the VTA, approved by the community, offered the room; key-package, accept and welcome; a sealed post read back. It needs a few extra steps that `rooms:persona` and `rooms:accept` do for you. [Sealed flow](#flow-b-attributed-and-private-rooms).
- The host is the community's VTC (or a standalone room host), not the Farm. Your VTA matters for sealed rooms and for signing as a persona.

Run `npm run rooms:status` at any point: it says where you are and prints the next command.

## Who does what

| Who | Does |
|---|---|
| You (the member) | `vtc:join` or `rooms:persona -- setup` once; then `rooms:status`, `rooms:accept`, `rooms:post`, `rooms:read` |
| Community admin (the admin console, not this kit) | Approves the join request; creates the room; adds you to it (an *offer*) |
| Room owner | Usually the same person at a small event. Chooses the tier: `open`, `attributed` or `private` |

Prerequisite for both flows: `.env` has `VTA_URL`, `VTA_CREDENTIAL` (`npm run vta:provision`) and the community's `VTC_URL` and `VTC_DID` ([VTC.md](VTC.md); for the Farm, [FARM.md](FARM.md)).

## Flow A: open rooms (about five minutes)

| # | You | Admin / owner |
|---|---|---|
| 1 | `npm run vtc:join` | Approves the request in the admin console |
| 2 | `npm run rooms:status` and send them your `identity` DID | Creates an `open` room, adds that DID with `read` and `write` (the offer appears in about a minute) |
| 3 | `npm run rooms:accept -- <room DID>` | |
| 4 | `npm run rooms:post -- <room DID> "hello"`, then `rooms:read -- <room DID>` | |

```sh
npm run rooms:status                              # membership, offers, and the one command to run next
npm run rooms:list                                # the raw offers and held rooms
npm run rooms:accept -- <room DID>                # accepted: admitted, epoch 1 (accepting twice is harmless)
npm run rooms:info -- <room DID>                  # tier, epoch, size limits (read-only)
npm run rooms:post -- <room DID> "hello room"     # --markdown for markdown, --name "Display Name" for the room profile
npm run rooms:read -- <room DID> [--follow]       # the history; --follow keeps watching
```

`ROOM_ID=<room DID>` in `.env` drops the argument. The room profile name defaults to your directory card's `displayName`. Or use the UI: `COLLAB_MODE=live COLLAB_ROOM=<room DID> npm run dev -w @starter/collab-room` ([its README](../templates/collab-room/README.md)).

How it works: every room call carries a *presentation* `{ membership, authority: [leaf..root] }`. The member's VTA normally builds it (`rooms/keys/present`). An offer already contains the same credentials, so for an **open** room the client presents those when the VTA refuses (`offerFallbackPresenter`, [source](../packages/rooms-client/src/offers.ts)); the host still verifies them. The accepted offer stays in `rooms:list`, and `rooms:post`/`rooms:read` read the credentials from it.

## Flow B: attributed and private rooms

A sealed room's keys live in your VTA, which only acts for a **persona**: a DID it holds. Your app `did:key` is not one, so a room that admitted it cannot be joined (live: the VTA refused `rooms/keys/key-package` with *"the invitation names `did:key:...`, which is not a persona you may act as here"*). So the community member, and the room's invitee, is a persona.

| # | You | Admin / owner |
|---|---|---|
| 1 | `npm run rooms:persona -- setup --name "Your Name"` (mints the persona, applies to the community as it) | Approves the persona's request |
| 2 | `npm run rooms:persona -- status`; send the owner the **persona's DID** (printed) | Adds the **persona's DID** (not the app `did:key`) to the sealed room |
| 3 | `npm run rooms:accept -- <room DID>` (stores the room's credentials in the VTA, then key-package, accept, welcome) | |
| 4 | `npm run rooms:post -- <room DID> "hello"`, then `rooms:read -- <room DID>` | |

`setup` is `create` (mint a `did:webvh` in your app's context, published on the Farm's DID host) plus `join`; both are also separate subcommands, and `use <did>` adopts a DID the VTA already holds. It saves `ROOM_PERSONA` in `.env`; from then on every `rooms:*` command acts as the persona. `rooms:accept` is safe to repeat: when the VTA already holds the room it says so and stops.

Things that are not obvious, all seen live:

- **Two keys sign.** The community and the offer belong to the persona, so the VTA signs those documents (`keys/sign-document`, one round trip per call). The room calls (`rooms/info`, records) are signed by the **app `did:key`**: the VTA's presentation grants to whoever asked for it ("the chain's leaf grants to the caller"), the persona is the member it speaks for. Signing room calls as the persona is refused with that message.
- **Admin key for two steps.** Minting a DID needs the `KeyMint` capability and storing the room's credentials in the VTA vault needs `VaultWrite`; the `application` role has neither. The kit uses the admin key in `.vta/admin.json` (the one you gave the portal) for exactly those two writes, to your own VTA, and says so. In a production setup the VTC delivers the credentials over messaging instead (off in this kit's modes).
- **The offer is single use.** The invitation inside it is consumed by the join. If a run dies half way, `rooms:status` shows whether the VTA holds the room; if not, ask the owner for a new offer.
- **Hosting.** `create` needs a DID host registered on the VTA (`vta/webvh/servers/list`); ic3 has one (`control`). Pass `--server <id>` for another.

## Notes, files, search and the live feed

Same flags in both flows; add `--app` to act as the app `did:key` when `ROOM_PERSONA` is set (an open room offered to the app `did:key`).

```sh
npm run rooms:note -- <room DID> "Agenda" "1. budget 2. timeline"            # a note
npm run rooms:note -- <room DID> "Agenda" "... 3. hiring" --id <note id>     # a new version of that note (the newest wins)
npm run rooms:upload -- <room DID> ./plan.txt                                # a file
npm run rooms:search -- <room DID> hiring                                    # full text: chat, notes, file names, text files
npm run rooms:search -- <room DID> plan --names                              # file names only
npm run rooms:download -- <room DID> <item id> ./out.txt                     # bytes, checked against the envelope's SHA-256
npm run rooms:read -- <room DID> --follow                                    # keep watching; new items print as they arrive
```

Limits, measured on the live host (2026-11-08):

| Where | Limit |
|---|---|
| Open room file | Blob upload in chunks; a 1 MiB file round-tripped byte for byte. The host reports 100 MiB per file |
| Sealed (attributed) room file | **About 34 KB.** The host refuses any document over 65,536 bytes (`rooms/records/put/0.3`), and a sealed inline file inflates about 1.8x plus 4.5 KB. 34,300 bytes passed, 36,000 failed. The client stops at 32 KiB with a clear message. Sealed blob files are not implemented |
| Notes and chat | A 40,000-character note passed on both tiers (not inflated like binary) |

Search runs in the client over decrypted content; the host has no search. The live feed polls (3 s); it survives another command logging in as the same identity (a VTA session is one token per identity, and the client logs in again once when it is superseded).

## Refusals and what they mean

| You see | Meaning | Fix |
|---|---|---|
| `notAMember` | Not an active member of the community yet | Step 1; wait for the approval |
| `no open or recently accepted offer to this room is addressed to you` | The owner has not added this DID (or it has not arrived) | Step 2; check `rooms:status` after a minute. For a sealed room make sure the **persona's** DID was added |
| `this VTA holds no AuthorityCredential ... to a persona you may act as` | Open room: the kit never shows this (it presents the offer's credentials). Sealed: the app `did:key` was offered, or `rooms:accept` has not run | Flow B |
| `the chain's leaf grants to <app did:key>, but it was presented by <persona>` | A room call was signed as the persona | Use the kit's commands; the app `did:key` signs room calls |
| `does not carry the KeyMint capability` / `VaultWrite` | The application role cannot mint DIDs or store credentials | Needs `.vta/admin.json`; `rooms:persona create` and `rooms:accept` fall back to it |
| `HTTP 401 token superseded` | Another process logged in as the same identity | The client logs in again and retries once; nothing to do |
| `the document is N bytes; ... accepts at most 65536` | A sealed file is too big for the host's document cap | Stay under 32 KiB, or use an open room |
| `invitation ... has already been used` | The offer was already used to join | `rooms:status`; ask for a new offer if the VTA does not hold the room |
| `unsupportedVersion` / `unsupportedType` on a rooms task | The host runs other task versions than the client sends | Check the host's `GET /health` version and [VTC.md](VTC.md) |

## Verified, and not

| What | Status |
|---|---|
| `rooms/offers/list`, `rooms/memberships/list`, `rooms/offers/accept` (open), `rooms/info`, chat post and read back, on an open room | **live**, 2026-11-08: VTC 0.26.0 host, VTA 0.72.0 on the ic3 Farm |
| Directory card `displayName` update on the same community | **live** |
| A persona `did:webvh` minted by the VTA; the VTA signing a community join request for it; the VTC accepting that proof | **live**, 2026-11-08 |
| Attributed room: offer to the persona, `rooms/keys/key-package`, `offers/accept` with the KeyPackage, `rooms/keys/welcome`, `rooms/keys/present`, `rooms/info`, a sealed post and read back (epoch 2) | **live**, 2026-11-08, one run, one host |
| The VTA serves `rooms/keys/{present,seal,open,key-package,welcome,list}`; the app has `room-present` and `room-open` | **live** (`hello`, discovery, the run above) |
| Notes (two versions, newest wins), file upload and download (SHA-256 checked), full-text and file-name search, on an open room and on an attributed room | **live**, 2026-11-08 |
| Open-room file of 1 MiB (chunked blobs); live feed following a second process's post | **live** |
| Sealed files over about 34 KB | **refused by the host** (64 KiB document cap); the client limit is 32 KiB |
| Profiles/avatars; a second member; the feed across an epoch change | **unverified** |
| `private` rooms; a second member in the same sealed room; epoch changes (commits) | **unverified** |
| ts-mls <-> openmls interop | **unverified** (the sealed run exercised the VTA's own MLS, not ts-mls) |
| This kit's pinned VTC (0.20.0) as a room host | **unverified**: the live runs used a 0.26.0 host. The local stack has no rooms |
