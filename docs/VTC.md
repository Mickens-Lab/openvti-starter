# Working with a VTC

Part of the [docs index](README.md). Walkthrough: exercises 3 and 5 in [TRY-THIS.md](TRY-THIS.md).

**Can this starter talk to both a VTA and a VTC?** Yes. `@buildathon/vta-client`
talks to the VTA, `@buildathon/vtc-client` talks to the VTC, and one app identity
(the `did:key` your VTA granted an ACL entry to) can be the applicant and member at
a community. The **local Docker VTC path was run end to end** against a VTA
(vta-service 0.65.0, tag `vta-service-v0.65.0`) and a VTC (vtc-service 0.15.0, tag `vtc-service-v0.15.0`; the two come
from different verifiable-trust-infrastructure commits, `fc157f76` and `93d36996`): see [Verified live](#verified-live-local-docker-vtc-0150) below. The
local dashboard and web template were also driven in headless Chromium. The
farm community path is not verified.

## What a VTC is

A Verifiable Trust Community service (`vtc-service`, binary `vtc`, default port
8200) that runs a community: members, join policy, credentials, directory, a
website and an admin console. It sits on top of a VTA:

- At setup the **VTA mints the VTC's DID and keys** (the `vtc-host` template) and
  seals them to the VTC. A VTC is never its own key authority. Provisioning needs
  an ephemeral setup `did:key` that is ACL-granted at the VTA with a one-time
  hand-off (`--admin-handoff`).
- After setup the two are separate services. JWT audience is `"VTC"` for the VTC
  and `"VTA"` for the VTA; tokens do not cross.
- A VTA-identity app is a **member** of the VTC by DID: it applies with its own
  `did:key` (or a `did:webvh` persona minted by a VTA, which this starter does not
  wire), the community admits it, and the community then issues it a membership
  credential (VMC). The VTA does not appear on the wire between app and VTC.

## Wire surface (verified against vtc-service and vtc-client source)

| | |
|---|---|
| Door | `POST {vtc}/v1/trust-tasks` (the VTA's is `/trust-tasks`, no `/v1`) |
| Recipient | The VTC's DID, from `GET {vtc}/.well-known/did.jsonl` (or `VTC_DID`) |
| Auth | The document's own `eddsa-jcs-2022` proof. No bearer. Authority comes from the signer's ACL entry at execution time |
| Health | `GET /health` |
| CORS | `[cors] allowed_origins` in the VTC `config.toml`: exact origins, no wildcard; empty means CORS is off |

| Task | Who | Notes |
|---|---|---|
| `vtc/join-requests/manifest/0.4` (0.3 also served) | anyone | Public. Criteria with `requirementsDigest`, `admission` (`automatic` or `review`), requested attributes |
| `vtc/join-requests/submit/0.3` | applicant (signed) | Payload `vp` (holder = signer), optional `criterion`, `attributes`, `registryConsent`. Returns `{requestId, verdict}` (live: `{effect:"refer", with:{queue:"admin-review"}}` for the `review` criterion). The starter's VP carries no credentials, so it can only meet a criterion with no invitation, credential or vetting requirement (`pickCriterion`); a fresh VTC lists `invited` and `member-credential` first, then `review` |
| `vtc/join-requests/status/0.1` | applicant (signed) | `pending`, `deferred`, `approved`, `rejected`, `withdrawn`. Live response: `{requestId, status, credentialsDelivered}`; `credentialsDelivered` is `false` until the member sends its own membership credential back ([MESSAGING.md](MESSAGING.md#what-credentialsdelivered-means)), and there is **no `vmc` in the response** (credentials travel over messaging) |
| `auth/challenge/0.1`, `auth/authenticate/0.3`, `auth/whoami/0.1` | administrators only (not used by the starter's member flow) | **Only an administrator ACL entry can sign in** (vtc-service `acl::resolve_auth_role` accepts a row only if `entry.admin.is_administrator()`; a `member` row, an applicant, or an unknown DID gets `authentication failed`). Verified live: the app's did:key gets `authentication failed` both before and after its join is approved; the seeded admin authenticates. `whoami` answers for the key a session was bound to, so `VtcClient.authenticate()` now sends `sessionKey` (the signer's did:key). With the pinned build `whoami` also answered without it; the earlier "not the key of a live session" could not be reproduced and its cause is unknown. `vtc:hello` reports membership with the signed `join-requests/status`, which needs no session. The one member session that exists is the portal's (see "The sessionless member") |
| `vtc/members/list/0.2`, `vtc/join-requests/list/0.2` (0.1 is gone from 0.14.0; the client falls back to 0.1 only for an older VTC), `vtc/join-requests/decide/0.1` | admin (ACL entry, signed doc, no session needed) | List returns `{items, nextCursor (null when last; spec says absent), totalEstimate}`; `decide` takes `{id, decision: approved\|rejected}`. After approval the DID appears in `members/list` with `role: member`, a `currentVmcId` and `currentRoleVacId` |

Specs: `dtgwg-trust-tasks-tf/specs/vtc/*`. Sources: `vtc-service/src/routes/trust_tasks.rs`,
`vtc-client/src/lib.rs`, `vta-sdk/src/protocols/join_requests.rs`.

## The sessionless member

A plain member is an app `did:key` whose join was approved. It has a live ACL row (role `member`) and a member
record, but **no console session**: `auth/authenticate` is refused `authentication failed` (verified live for the member
and for a pending applicant; an administrator authenticates). That is by design (`auth_role_for` admits only
administrators; "no gate in this service may be a claims check"), so **do not build the member app around a session or
`whoami`**. Build it around signed requests:

- Every call is a Trust Task signed by the member's own key (`VtcClient.call`, or a typed helper). The VTC reads the
  signer's live membership on that request, so there is no token to expire and nothing to revoke except the membership.
- **Identity proof for your own backend.** A member can prove "I am an active member right now, as role X" with
  `vtc.memberProof()`: it mints a self-issued SIOPv2 `id_token` from its did:key, signs in to the member portal
  (`/v1/member/wallet/auth/*`, audience `VTC-member`) and reads `GET /v1/member/me`
  (`did`, `role`, `joinedAt`, `personhood`). Verified live: works for an approved member, refused for a pending
  applicant. A did:peer:2 applicant (tunnel mode) signs it with its own key id, `<did>#key-2` (the VTC refuses any other
  key id with a 401); verified live 2026-10-30 (one machine, one run) from the community dashboard. That portal route is marked deprecated upstream in favour of the wallet `auth/oob/*` flow, so treat it
  as a convenience, and the token as good for `/v1/member/me` and passkeys only: it unlocks no Trust Task.
- **Pattern for an app with its own backend.** The browser (or agent) signs a challenge/request with the member
  did:key; the backend verifies the signature, then asks the VTC about that DID. The cheap, session-free ways are
  (a) the member itself calls `memberProof()` and forwards the result (the VTC vouches over TLS to that client, so
  forward the DID and let the backend re-check with its own call), or (b) the backend holds an
  administrator identity and calls `members/list` / `members/show` (admin only) for the live roster. Do not accept
  a VMC alone as proof of current membership: check the community's status list
  (`GET /v1/status-lists/revocation`, public) and the live record.
- Applicants are not members: `status` works, community reads do not (`the signer holds no entry in this community`).

### What a member can do (all verified live, local VTC 0.15.0)

| Helper | Task | Notes |
|---|---|---|
| `joinStatus()`, `withdrawJoin()` | `join-requests/status`, `withdraw` | Own request only. A member can submit a second request; do not |
| `communityProfile()`, `communityBranding()`, `communityTheme()`, `joinDiscovery()`, `requestedAttributes()`, `ceremonies()` | `community/*/show`, `ceremonies/list` | Any ACL entry; applicants refused |
| `directoryFields()`, `directoryEntries()`, `directoryEntry({entryId})`, `directoryQuery(did, fields)` | `directory/*` | Members see each other by `entryId` and the fields the policy shows (displayName, role), **not DIDs** |
| `myCard()`, `updateMyCard({values, expectedRevision})` | `directory/card/show`, `update` | Own card; `missingRequired` lists unset required fields (`displayName`) |
| `publicCard(entryId)` | `directory/card/public` | Unauthenticated read of a card its member published |
| `renewMembership()` | `members/renew` | Returns the renewed `roleVac` |
| `leaveCommunity({confirm:true})` | `members/self-remove` | **Immediate; an empty payload is enough.** The helper refuses without `confirm: true` |
| `groups()`, `group()`, `joinGroup()`, `leaveGroup()`, `groupMembers()` | `groups/*` | List verified; the rest need the operator to enable `[groups]` (otherwise `noKeyHolder` on create, so nothing to join) |
| `relationships({did})`, `roomOffers()`, `roomMemberships()` | `relationships/list`, `rooms/offers/list`, `rooms/memberships/list` | Verified (empty); rooms need the community's VTA room host |
| `memberProof()`, `portalSignIn()`, `portalMe()` | member portal | See above |

The full matrix for stranger, applicant, member and admin, and every served task, is in [VTC-SURFACE.md](VTC-SURFACE.md).

### What a member can't do, and why

| Can't | Why | What to do instead |
|---|---|---|
| `auth/authenticate`, `auth/whoami`, any console session | Only administrator ACL entries sign in; the console session is for operating the community | Signed requests; `memberProof()` for an identity read |
| List the roster, read another member's DID, show a member by DID | `members/list/show` need `vtc.members.manage`; the directory hides DIDs from members | Directory entries by `entryId`; have members share their DID out of band, or have an admin-run backend publish a roster |
| Approve joins, invite, issue endorsements, edit profile/branding/directory fields, run groups/rooms/website | Each needs a named capability on the signer's live ACL row (`vtc.join.decide`, `vtc.invitations.manage`, `vtc.credentials.issue`, `vtc.surface.admin`, `vtc.groups.manage`, `vtc.rooms.manage`) | An admin grants the capability (`acl/update`), or the app uses an admin identity on the backend |
| Receive their VMC or role VAC over HTTP | `status` carries no `vmc` (its `credentialsDelivered` is about the member's own credential sent back, not this); delivery is pushed over DIDComm/TSP, off in the local stack | `MODE=tunnel` turns messaging on, but the applicant also needs its own inbox, which a `did:key` lacks ([MESSAGING.md](MESSAGING.md)); or let an admin read it from the `decide` response |
| Vote, chat, post, feed | No such tasks at this pin: `elections/*` are not served (feature off); rooms are credential-gated on a VTA room host | Build it in the app; use the VTC only to check membership. For polls on a VTC built with `voting`: [packages/polls-client](../packages/polls-client/README.md) (tested against a mock only) |
| Undo `self-remove` | Immediate tombstone. The same DID can re-apply and be approved again (verified) | Guard it behind a confirmation |
| Use the portal token for tasks | Different audience (`VTC-member`); consumers are `/v1/member/me` and passkey routes only | Sign each task |

Be careful with a bare `vtc.call(task, {})`: several member tasks accept an empty payload and **act**. An empty
`members/self-remove` removed the test member, and an empty `join-requests/withdraw` withdrew a request.

## Commands

```sh
npm run vtc:hello     # VTC DID, join manifest, member check
npm run vtc:join      # apply as the app identity, poll the request (-- --name "Ada")
npm run vtc:approve   # admin: approve pending requests
npm run vtc:status    # join status + member proof (portal /v1/member/me), no session
npm run vtc:profile   # member reads: community profile, my directory card, fields, entries, groups
npm run vtc:withdraw  # applicant: withdraw the open join request (-- --reason "text")
npm run vtc:leave -- --yes   # LEAVE the community now (members/self-remove); needs --yes
npm run dev -w @buildathon/community-dashboard   # the same flow in a browser
```

All of them read `VTC_URL` (and `VTC_DID` if the VTC's DID is not at
`/.well-known/did.jsonl`) from `.env`, or default to `http://localhost:8200` in
`MODE=local`. In `MODE=tunnel` they are the public URLs `up` writes to `.env` ([MODES.md](MODES.md)); in `MODE=farm` see [FARM.md](FARM.md).

## Local VTC in Docker

The VTA image is built from the repo Dockerfile with `cargo build -p vta-service`
only, so the VTC needs a **second image**:

```sh
nice -n 10 docker build -f docker/vtc.Dockerfile -t vtc-buildathon:local /path/to/verifiable-trust-infrastructure
# preferred, from the pinned ref: npm run images:build vtc  (docs/PINS.md)
# or: export VTC_IMAGE=<an image you were given>
WITH_VTC=1 npm run up
```

Build facts (verified): cold build 1401 s (~23 min) on 12 cores for 0.13.0; 0.15.0 took about 8 min with warm caches; image about 197 MB, `vtc 0.15.0`.
Features must be `setup,website,tsp`. Without `tsp` the crate does not compile
(upstream: `registry/messaging.rs` calls the `tsp`-gated `outbound::seal_trust_task_tsp`
unconditionally; E0425). `keyring` and the `admin-ui` SPA are left out (no secret-service
in a container; the SPA needs a Node build), so there is no console at `/admin`.

What it does: compose profile `vtc` runs the `vtc` service in the VTA's network
namespace (so the VTA's `localhost:8100` DID host resolves from the VTC).
`vtc-entrypoint.sh` runs `vtc setup --setup-key-out`, waits, then `vtc setup --from`
over `provision_transport = "rest"` with the plaintext secrets backend, fills in
`[cors] allowed_origins`, and seeds the buildathon admin key as a VTC admin with
`vtc acl add`. `npm run vtc:up` does the grant the VTA needs in between: an
`acl/grant` Trust Task, signed by the buildathon admin, for the VTC's setup `did:key`
with role `admin`, scope `vtc`, a 1 h expiry and `ext["org.openvtc.handoff"] = true`
(`VtaClient.grantHandoff`). No VTA CLI is involved.

## Verified live (local Docker VTC 0.15.0)

Re-run on 2026-10-29 after aligning the pins with the Farm: vta-service 0.65.0 (tag `vta-service-v0.65.0`, `fc157f76`)
and vtc-service 0.15.0 (tag `vtc-service-v0.15.0`, `93d36996`), each image built from its own ref by
`npm run images:build all`, DIDComm off, `docker compose --profile vtc`. Build times on 12 cores, niced, with
warm Docker layer caches (VTA about 11 min, VTC about 8 min; the earlier cold VTC build took 23 min):

- Both images run together. `vtc setup` phase 1/2, the `did:key` scrape, and the hand-off `acl/grant` against
  vta-service 0.65.0 all work; the VTC's `tsp` feature is still required (see the build facts above).
- `npm run hello` (304 Trust Tasks listed), `vtc:hello` (3 criteria), `vtc:join` (criterion `review`, pending),
  `vtc:approve` (`join-requests/list/0.2` + `decide/0.1`), status `approved`, and the applicant listed by
  `members/list/0.2` (`items`, `totalEstimate`; `nextCursor` absent on the last page).
- Restart: `docker compose --profile vtc down` (no `-v`) then `up -d --wait` took 6 s; the VTA/VTC DIDs, the ACL entries,
  the credential and the approved request survived; `hello`, `vtc:hello`, `vtc:join`, `vtc:approve` worked unchanged.
- Browser (system Chromium via Playwright, from `http://localhost:5173`, one template at a time, screenshots inspected):
  `web-vta-app` authenticated over CORS, `auth/whoami` and the Trust Task list worked; `community-dashboard` loaded the
  manifest, submitted a join (`pending`), showed status, then `npm run vtc:approve` approved it and the page showed
  "Member: yes (approved)". No console errors.
- `pins:check`: no drift (labels, binary versions, tag-to-ref, running VTC `/health` 0.15.0).
- Unit tests (`npm test`, 18 tests) and `npm run typecheck` pass, including list 0.2 with fallback to 0.1.

Member surface pass (2026-10-29, same stack, fresh DIDs): see [VTC-SURFACE.md](VTC-SURFACE.md) for the matrix. `vtc:status`,
the typed member helpers and `memberProof()` were run live; `members/self-remove` followed by a re-join and re-approval of the same DID also worked.

Not verified: the Farm itself (no portal login, no POST, by design); member sign-in (refused by design, below); the
manifest 0.3 fallback and the list 0.1 fallback against a real older VTC (unit-tested with a fake only).

The first pass (VTC 0.13.0, VTI `fff94fc6`) found and fixed the bugs below; they are kept for the record.

Bugs found and fixed by this run:

- `vtc-entrypoint.sh` extracted the VTA DID with a greedy sed that returned the `#vta-rest` service id; the VTC's sign-in
  was then refused `wrongRecipient`.
- It appended a second `[cors]` table; `vtc setup` already writes `[cors] allowed_origins = []`, so the VTC failed to
  start on a duplicate key.
- `vtc:up` shelled `vta contexts create --admin-handoff` into the VTA container; the running daemon holds the store
  (`FjallError: Locked`). Replaced by the Trust Task grant above.
- `vtc:join` took `criteria[0]` (`invited`, needs an invitation). Now `pickCriterion`.
- Docs claimed status carried a `vmc`; it does not here (`credentialsDelivered:false`).
- The Dockerfile omitted `tsp` (see above).

Also verified (second pass, images rebuilt from the pin with `npm run images:build all`; the VTA build took
697 s, and the VTC build was almost fully layer-cached so its cold time was not re-measured):

- Both labelled images (`org.buildathon.vti-ref=fff94fc6`) run the stack; `pins:check` reports no drift and no unlabelled warning.
- Member sign-in: refused by design, see the table (source read plus live run). Admin sign-in and `whoami` work.
- Browser, headless Chromium against the local stack, from `http://localhost:5173` (in the CORS allow list; both
  templates use `strictPort` 5173, so run one at a time): `web-vta-app` authenticated to the VTA over CORS,
  `auth/whoami` and the Trust Task list worked; `community-dashboard` loaded the manifest, submitted a join
  (`pending`), showed status, then `npm run vtc:approve` approved it and the page showed `approved` and
  "Member: yes". Screenshots were inspected; fixes below.
- Restart: `docker compose --profile vtc down` (no `-v`) then `up -d --wait` took about 6 s. The VTA DID, the app's
  ACL entry and credential, the VTC DID, the admin ACL entry, the manifest, and an open join request all
  survived; `hello`, `vtc:hello`, `vtc:join` and `vtc:approve` worked unchanged, and the entrypoint skipped setup.
- (On 0.13.0, `join-requests/list` 0.2 was refused `unsupportedVersion`; 0.1 was dropped in 0.14.0 per the VTI source; the 0.15.0 run used 0.2.)

Bugs found and fixed by the second pass:

- `npm run vta:reset` / `vta:down` ran `docker compose down` without `--profile vtc`, so the VTC container and its volume
  survived a reset. The next `up` then paired a fresh VTA and fresh admin key with a stale VTC, and `vtc:approve`
  failed `DID not in ACL`. Both now pass `--profile vtc`.
- `vtc:approve` stopped at the first request it could not approve (a member that re-applies gets a second open
  request, which `decide` refuses with a duplicate-membership conflict); it now reports it and continues. Refusals print
  `code - message` instead of the whole signed document.
- The dashboard showed the raw error document before a first join, and the membership button dumped JSON; it now
  explains, and says "Member: yes (approved)".

Not verified:

- Playwright's locators timed out on the page after a `reload()` here while `evaluate` showed the DOM was fine; it looks like a
  tooling quirk, not a page bug, and was not chased.
- Receiving the membership credential (needs messaging and an applicant with an inbox; messaging is off in local mode, and in tunnel mode this kit's applicant has none: [MESSAGING.md](MESSAGING.md)).
- Farm mode ([FARM.md](FARM.md)); criteria needing credentials, invitations or vetting; the VTA browser wallet.

If the local VTC does not come up in your time box, use MODE=farm for the community
side ([FARM.md](FARM.md)).
