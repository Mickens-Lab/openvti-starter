# Data rooms: read and post from your app or the command line

Part of the [docs index](README.md). Evidence labels as in [VTC-SURFACE.md](VTC-SURFACE.md): **live** = observed against a real host, **source** = read in code or a schema, **unverified** = built but not tried. Everything here is a playground ([SECURITY.md](SECURITY.md)).

A data room is a shared space on a community's host: chat, notes and files, with a record history. This kit reaches one with [`@buildathon/rooms-client`](../packages/rooms-client/README.md) (library), [`templates/collab-room`](../templates/collab-room/README.md) (a UI), and the `rooms:*` commands below (command line).

## The short answer

- **Open rooms work end to end, live.** Verified 2026-11-08: a VTC 0.26.0 (hosted outside the Farm), the app identity of a VTA 0.72.0 on the Farm. We joined the community, accepted an offer, read `rooms/info`, posted, and read the post back.
- **Attributed and private (sealed) rooms do not work yet with the app identity.** The room's keys live in the member's VTA, and the VTA only acts for a *persona* DID it holds, not for the app `did:key`. [Details and what we tried](#attributed-and-private-rooms).
- You do not need the Farm for the host. The host is the community's VTC (or a standalone room host). Your VTA only matters for sealed rooms.

## Who does what

| Who | Does |
|---|---|
| You (the member) | `vtc:join` once; then `rooms:list`, `rooms:accept`, `rooms:post`, `rooms:read` |
| Community admin (admin console, not this kit) | Approves your join request; creates the room; adds you to it (an *offer*) |
| Room owner | Same person as the admin in a small event. Chooses the tier: `open`, `attributed` or `private` |

## Walkthrough (open room, about five minutes)

Prerequisite: `.env` has `VTA_URL`, `VTA_CREDENTIAL` (`npm run vta:provision`) and the community's `VTC_URL` and `VTC_DID`. See [VTC.md](VTC.md) and, for the Farm, [FARM.md](FARM.md).

1. **Join the community, and be approved.**
   ```sh
   npm run vtc:join       # prints the request id; the status is "pending"
   ```
   An admin approves it in the community's admin console (`vtc:approve` works only where the admin key is yours). Then `npm run vtc:status` says `member yes`.
   Optional: a display name for the directory card, `npm run repl` then `await vtc.updateMyCard({ values: { displayName: "Your Name" }, expectedRevision: 0 })`.
2. **Ask the room owner to add you.** Send them your identity: the DID that `npm run rooms:list` prints (`identity`). In the admin console the owner creates the room (visibility `open` for a first run), then adds that DID with `read` and `write`. The offer shows up in about a minute. Being a community member is not enough; each room needs its own offer.
   ```sh
   npm run rooms:list     # offers to you, and rooms you hold
   ```
3. **Accept the offer.** Open rooms need no key exchange.
   ```sh
   npm run rooms:accept -- <room DID>     # accepted: admitted, epoch 1
   ```
   Accepting twice is harmless.
4. **Look, post, read.**
   ```sh
   npm run rooms:info -- <room DID>                  # tier, epoch, size limits (read-only)
   npm run rooms:post -- <room DID> "hello room"     # add --markdown for markdown, --name "Display Name" for the room profile
   npm run rooms:read -- <room DID>                  # the history; add --follow to keep watching
   ```
   Put `ROOM_ID=<room DID>` in `.env` to drop the argument. The room profile name defaults to your directory card's `displayName`.
5. **Or use the UI.** `COLLAB_MODE=live COLLAB_ROOM=<room DID> npm run dev -w @buildathon/collab-room` ([its README](../templates/collab-room/README.md)).

Every refusal prints one line and a hint. The common ones:

| You see | Meaning | Fix |
|---|---|---|
| `notAMember` | Not an active member of the community yet | Step 1; wait for the approval |
| `no open or recently accepted offer to this room is addressed to you` | The owner has not added this DID (or it has not arrived) | Step 2; check `rooms:list` after a minute |
| `this VTA holds no AuthorityCredential ... to a persona you may act as` | The VTA will not present for your app `did:key`. On an open room the kit uses the offer's credentials instead and you never see this; on a sealed room it is the blocker below | [Sealed rooms](#attributed-and-private-rooms) |
| `unsupportedVersion` / `unsupportedType` on a rooms task | The host runs other task versions than the client sends | Check the host's `GET /health` version and [VTC.md](VTC.md) |

## How the open-room path works

Every room call carries a *presentation*: `{ membership, authority: [leaf..root] }`, credentials the room issued to you. Normally the member's VTA builds it (`rooms/keys/present`). The offer you receive already contains the same credentials (`credentials.membership`, `credentials.authority`, `credentials.invitation`), so for an **open** room the client presents those directly when the VTA refuses: `offerFallbackPresenter` in `rooms-client` ([source](../packages/rooms-client/src/offers.ts)). The host still verifies them. Sealed rooms never fall back, because their records need the VTA's keys anyway.

The accepted offer stays in `rooms:list` (state `accepted`), and `rooms:read`/`rooms:post` read the credentials from it. If a later run finds no offer, re-accept or ask for a new one.

## Attributed and private rooms

What is true (live, 2026-11-08, same host as above):

- The host side works for a sealed room: our identity joined the community, was offered an `attributed` room (`rooms/offers/list` shows its `authority`, `invitation` and `membership` credentials), and `rooms/memberships/list` shows it as `offered`.
- Joining needs three steps, and the first fails: (1) the member's VTA mints an MLS KeyPackage, `rooms/keys/key-package/0.2` with the offer's `invitation`; (2) `rooms/offers/accept` with that KeyPackage returns a Welcome; (3) the VTA joins the group, `rooms/keys/welcome/0.1`.
- Step 1 is refused: *"the invitation names `did:key:...`, which is not a persona you may act as here; an invitation is not transferable, and the member it names is the DID this agent holds for them, never the client asking"*. The community admitted our app `did:key`, which the VTA does not hold as a persona.
- The kit's `rooms:accept` therefore explains this and stops for a sealed room, rather than half-joining.

What would likely fix it (**unverified**, partly blocked):

1. The VTA mints a *persona* DID: `vta/webvh/dids/create/1.2` in the app's context, published through the Farm's DID host (`vta/webvh/servers/list` shows it). The app role lacks the `KeyMint` capability, so this needs the admin key; whether the VTA then counts that DID as a persona the app may act as, or needs `persona/binding/set` or the `persona-holder` capability, is not known.
2. That persona DID joins the community (a second applicant, approved by the admin), is offered the room, and the three steps above run as it.
3. The client work: a `rooms:accept` for sealed tiers (key-package, accept, welcome), `VtaKeyOracle` wrappers for `key-package` and `welcome`, and a join script that applies as the persona. Not written.

Until that is done, use `open` rooms for events, and `LocalMlsKeys` plus the mock host for sealed-room practice ([rooms-client README](../packages/rooms-client/README.md)).

## Verified, and not

| What | Status |
|---|---|
| `rooms/offers/list`, `rooms/memberships/list`, `rooms/offers/accept` (open), `rooms/info`, post and read of a chat record, on an open room | **live**, 2026-11-08: VTC 0.26.0 host, VTA 0.72.0 on the ic3 Farm for the app identity |
| Directory card `displayName` update on the same community | **live** |
| The Farm VTA serves `rooms/keys/{present,seal,open,key-package,welcome}` and the app identity has `room-present` and `room-open` | **live** (`hello`, discovery) |
| Notes, files, search, the live feed, profiles against a real host | **unverified** (only chat was posted) |
| Sealed rooms (any step) against a real host and VTA | **unverified**; step 1 refused as above |
| ts-mls <-> openmls interop, host record size cap | **unverified** |
| This kit's pinned VTC (0.20.0) as a room host | **unverified**: the live run used a 0.26.0 host. The local stack has no rooms |
