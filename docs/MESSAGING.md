# Messaging in this kit: what exists, and the gap

`MODE=tunnel` gives the VTA, the VTC and a mediator a public home and turns DIDComm and TSP on ([MODES.md](MODES.md)). This page says what that does and does not let you build today.
Back to the [docs index](README.md).

Labels: **[verified]** observed live (`MODE=tunnel`, pinned images), **[unverified]** not observed.

## What works

- The VTA and VTC connect to the kit's mediator, advertise `DIDCommMessaging` and `TSPTransport` in their DID documents, and `messaging/ping/0.2` reports `tsp`, `didcomm`, `rest` **[verified]**.
  This is a **capability check, not a peer ping.** The status panel's Messaging row reads "transport connected ..., not a peer ping" and means exactly that; the peer ping is `npm run tsp:ping` (below).
- A VTC approval queues Trust Task pushes over DIDComm and the mediator accepts them (outbox `Queued` then `Sent`) **[verified]**.
- Everything else (every Trust Task this kit sends) travels over REST, in every mode. A Trust Task is a signed JSON document; REST and messaging only differ in how it is carried.

## TSP client: what runs

`packages/tsp-client` is a small TypeScript TSP client (built on `@openvtc/pnm-core` and `@openvtc/vti-tsp-js`, Apache-2.0, pinned exactly). `npm run tsp:ping` and the page
`templates/tsp-ping` (`npm run tsp:ping:browser` drives it in headless Chromium) log in to the mediator as the app's `did:key`, resolve the VTA's `did:webvh` to TSP keys, form
a TSP relationship, and send a signed `messaging/ping/0.2` in the TSP binding envelope (`{"type": ".../binding/tsp/0.1/envelope", "document": <Trust Task>}`).

**Verified live (`MODE=tunnel`, pinned images including mediator 0.45.0, 2026-10-30, two separate bring-ups):**
- **The pong.** `npm run tsp:ping` (Node) and `npm run tsp:ping:browser` (the `templates/tsp-ping` page in headless Chromium) each end in `pong from the VTA ... status ok, protocols [tsp, didcomm, rest], nonce echoed`
  after the relationship invite was accepted **[verified]**. `npm run tunnel:probe` (and so `npm run up`) now includes the same ping as a row **[verified]**. The pong is the VTA's answer to a signed
  `messaging/ping/0.2`, routed client -> mediator -> VTA and back, all TSP 1.0. The client checks the pong by its `type`, its
  `threadId` (the ping's `id`) and its in-band `issuer`/`recipient`: the VTA (0.65.0) sends both, `issuer` exactly the VTA's DID (no
  fragment) and `recipient` exactly the pinger's DID, and signs the pong for `authentication` with the VTA's `#key-0` **[verified
  2026-10-31, one machine, one run]**.
- **Credential push to a `did:key`.** With `npm run tsp:listen` running as the app's `did:key` (`VTC_APPLICANT=did:key`; the tunnel default is the `did:peer:2` [below](#tunnel-mode-delivers-the-credential-to-the-applicant)), `npm run vtc:join` plus `npm run vtc:approve` made the VTC send two `credential-exchange/issue/0.1` frames to that
  DID through the mediator; the listener received and opened both, and the VTC logged `trust-task push delivered ... via=tsp` **[verified]**. The listener must have spoken TSP to the VTC first
  (it forms the relationship; the VTC learns the route from the inbound invite). Not checked: that a wallet could accept and store the credential, or what the frames contain beyond their type.
  The `credentialsDelivered` flag in the approval response and `npm run vtc:status` still reads `false`, and that is expected: see [What credentialsDelivered means](#what-credentialsdelivered-means).
  Do not read it as the push's outcome: the VTC log and the listener are.
- The mediator login with a `did:key` and the raw-TSP WebSocket from a browser origin work once `MEDIATOR_CORS_ALLOW_ORIGIN` names that origin ([MODES.md](MODES.md)); another origin gets no CORS header **[verified]**.
- A DID that is not on the VTA's ACL is refused (403), and an unsigned document is refused (`ProofRequired`); the client signs, and the app's own `did:key` is on the ACL **[verified]**.

**Why this needed a mediator pin advance.** The VTA (0.65.0) and VTC (0.15.0) speak **TSP 1.0** (`affinidi-tsp` 0.3). The first pin, mediator 0.33.1 (affinidi-tdk-rs `55580615`), only read **Rev 3**
("unsupported TSP major version 1 (this build speaks 0)", HTTP 400 on `/mediator/v1/inbound`), so with it the request reached the VTA but no pong, relationship accept or credential frame ever came back
**[verified failure, 2026-10-30 earlier run]**. The pin is now mediator **0.45.0** (`7e378c03`, the version in the VTA's own lockfile). The release commit is in the separate repository
`affinidi/affinidi-messaging-mediator` (tag `v0.45.0`); the mediator left affinidi-tdk-rs after 0.41 ([PINS.md](PINS.md)). The client therefore packs everything as TSP 1.0 with one package,
`@openvtc/vti-tsp-js` 0.4.0.

**Limits, stated plainly.** Observed with our own open-ACL mediator over quick tunnels, one machine, a handful of runs; a Farm-hosted mediator was not tried **[unverified]**.
One extra frame reaches the listener before the accept (`tsp: signature verification failed`: it is not from the VTC, its sender was not identified); it is ignored and did not affect the results.

## Tunnel mode delivers the credential to the applicant

A `did:key` names no mediator, so the VTC (0.15.0) reaches it over TSP only after that DID has spoken TSP to it (`tsp:listen` sends a relationship invite first for exactly this reason).
A `did:peer:2` can carry a service. So in `MODE=tunnel` the kit applies, **by default**, as a `did:peer:2` derived from the app credential's seed: X25519 key (`#key-1`, keyAgreement),
Ed25519 key (`#key-2`, authentication) and a `TSPTransport` service whose endpoint is the **mediator's DID** from `.vta/tunnel.json` (`didPeerFromSeed` in `packages/tsp-client`).
`npm run vtc:join`, the community dashboard and `npm run tsp:listen` all make the same choice (`scripts/lib/applicant.ts`):

| Mode | Applicant |
|---|---|
| `tunnel` | the `did:peer:2` naming the mediator; `VTC_APPLICANT=did:key` in `.env` keeps the app `did:key` instead (it is then reached only after it spoke TSP first) |
| `tunnel`, no mediator DID in `.vta/tunnel.json`, or a DID over the limit below | the app `did:key`, and the command or the dashboard's card says why |
| `local`, `farm` | the app `did:key` (no mediator to name) |

**Verified live (MODE=tunnel, pinned images, mediator 0.45.0, 2026-10-30, one machine, one run):**
- `npm run tsp:peer-push` with nothing set in `.env`: the listener logged in to the mediator as the `did:peer:2`, the kit applied and approved, and the listener received
  a relationship invite from the VTC and then two `credential-exchange/issue/0.1` frames, with no earlier contact from the applicant: `PASS: the credential reached the did:peer over TSP with no earlier contact.`
  **[verified]**. The join status then read `credentialsDelivered: false`, as expected ([why](#what-credentialsdelivered-means)).
- With `VTC_APPLICANT=did:key` the did:key flow still works: `tsp:listen` (invite accepted), `vtc:join`, `vtc:approve`, two `credential-exchange/issue/0.1` frames received **[verified]**.
- The community dashboard in headless Chromium applies as the `did:peer:2`, with no fallback and no console errors **[verified]**. Applying and the status checks do not talk to the mediator from the browser and need no mediator CORS; only its optional "Credential frames" panel and its read-only "Identity" section (which shows the decoded applicant DID beside the mediator's DID document) do (below).
- `npm run tunnel:probe` (and so `npm run up -- --tunnel`) checks that the mediator's DID resolves at its tunnel host **[verified]**.

**Why this needed a different mediator DID.** The affinidi DID resolver that both the mediator and the VTC use (`DIDCacheClient`) refuses any DID over `max_did_size_in_bytes`, default
**1000** bytes, before parsing it, and says nothing useful when it does (the mediator login answers `403 ... authcrypt requires the public key of sender`). A `did:peer:2` carries its service
inside the identifier, so the applicant's DID contains the whole mediator DID. The kit's mediator used to mint a `did:peer:2` of about 725 bytes, which made the applicant about 1115 bytes and
the login fail (a verified failure in an earlier run of the same day). The tunnel mediator now mints a short **`did:webvh`** (about 105 bytes) bound to its tunnel host, and serves the log itself
at `/.well-known/did.jsonl` (`mediator-entrypoint.sh`); the applicant's `did:peer:2` is then about 288 bytes. `didPeerFromSeed` still refuses a DID over 1000 bytes and says why.

A lean `did:peer:2` mediator DID was tried and cannot fit: `mediator-setup` 0.45.0 hard-codes its services (`dm` with an https and a wss URL, `Authentication` and `tsp`), each carrying the full
tunnel URL, and quick-tunnel hosts are 50 to 62 characters. Even the shortest recipe (no API prefix) gives applicants of about 1036 to 1108 bytes (measured with `mediator-setup` in the pinned image).

**What this costs, stated plainly.** The mediator's DID now resolves over HTTPS (DNS plus an HTTP fetch) through its tunnel host, as the VTA's and VTC's `did:webvh` DIDs already do in tunnel mode.
Every party that resolves it (VTA, VTC, the clients, a browser page) needs the tunnel up and reachable. A browser page that resolves it (the `templates/tsp-ping` page) fetches the mediator's
`did.jsonl` cross-origin, so `MEDIATOR_CORS_ALLOW_ORIGIN` must name the page's origin, the same setting `/ws` already needed: without it the page fails with
`did:webvh resolve failed ... Failed to fetch`, with it the pong comes back **[verified, both]**. On that failure the page now names the exact line `MEDIATOR_CORS_ALLOW_ORIGIN=<its origin>` and the command that recreates only the mediator (unit-tested; verified live 2026-10-30 (one machine, one run)). `MODE=local` has no mediator and makes no DNS or HTTP lookups beyond localhost. The applicant's
`did:peer:2` itself resolves with no lookup at all (its keys and service are in the identifier).

Upstream quirk worth reporting: `mediator-setup` 0.45.0 writes `did_web_self_hosted = "file://./conf/did.jsonl"`, which the mediator resolves against its **working directory**, not the
config directory. `mediator-entrypoint.sh` rewrites it to an absolute path and fails loudly if the line is not there.

From reading the VTC source at its pin (and consistent with the live run above):
- the VTC has no allowlist of applicant DID methods, and resolves `did:peer` locally, both for the join proof and for the push;
- its push engine matches services by `type`; an applicant advertising a `TSPTransport` mediator gets a TSP-only plan with no earlier contact. The VTC sends a routed relationship invite and then the
  credential at once. A recipient that advertises only transports the VTC cannot use is refused, never downgraded;
- when the mediator DID in the applicant's service is the **same string** as the VTC's own mediator DID, the frame is sealed to the applicant and routed through that mediator, and the VTC gets
  evidence of collection. A different mediator is sent nested and settles only by escalation **[unverified]**. The plan is TSP only, so a silent TSP failure has no DIDComm fallback.

**In the browser.** The status panel's card "9. Applicant and messaging" (web-vta-app, and the dashboard's connection drawer) shows the same choice:
the applicant type for the mode (and why a tunnel-mode did:peer:2 fell back to the did:key), the mediator's and the applicant's DID size against the
1000-byte resolver limit, and whether the mediator's `did:webvh` resolves at its tunnel host (the page fetches its `did.jsonl` and compares the last
entry's `id`). Without `MEDIATOR_CORS_ALLOW_ORIGIN` set to the page's origin the browser cannot read that file; the row then says so and points
to `npm run tunnel:probe`, which checks it from Node. It is advisory and does not watch delivery. Unit-tested; verified live 2026-10-30 (one machine, one run).

**Watching the frames in the browser.** The community dashboard's collapsed **Credential frames** panel (in-review and member screens) is
`tsp:listen` in the page: *Listen for credential frames* logs in to the mediator as the same applicant the page applies as (a `did:key`
sends the VTC a relationship invite first, a `did:peer:2` does not) and lists each frame from the VTC with its time and kind
(relationship invite or accept, `credential-exchange/issue/0.1`, another document type, unreadable or not from the VTC) and a running tally.
It reads the frame kind only, never the credential, and says plainly that frames arriving is not `credentialsDelivered`. Start it before
the approval. It and the collapsed **Identity** section (the applicant `did:peer:2` decoded locally, keys and `TSPTransport` service, beside the mediator's DID document read from its `did.jsonl`) are the parts of the dashboard that need `MEDIATOR_CORS_ALLOW_ORIGIN` set to the page's origin (the panel fetches the
mediator's `did.jsonl` and opens its socket from the browser); a failed connect prints the exact line. The mediator keeps one
live-delivery socket per DID, so with `npm run tsp:listen` running as the same DID at the same time a frame may go to either. Unit- and
component-tested with a fake listener; verified live 2026-10-30 (one machine, one run) (3 frames: 1 invite, 2 credential-exchange/issue/0.1, as the did:peer:2).

```
npm run tsp:peer-push                         # tunnel mode: listener as the did:peer, join, approve, status; PASS when an issue frame arrives
VTC_APPLICANT=did:key npm run vtc:join        # tunnel mode, the old way: apply as the did:key (run npm run tsp:listen first)
```

**Not verified:** Windows and macOS hosts, arm64, a hosted (Farm or organiser) mediator, a real wallet storing the credential, and DIDComm (the kit has no DIDComm client).

## What credentialsDelivered means

`credentialsDelivered` in `join-requests/status` (and the dashboard's membership card) is **not** a delivery receipt for the pushed frames. The VTC sets it to `true` only once it holds the
member's **own** membership credential, sent back to the community (`vtc/members/vmc/0.1`, the reciprocal half of the membership pair; read from the VTC 0.15.0 source,
`member_vmc_received_at`). The pushed frames do not set it, so the flag stays `false` even when every frame arrived, for a `did:key` and a `did:peer` alike. Frame arrival is what
`npm run tsp:listen` (its last line) and the VTC log (`trust-task push delivered ... via=tsp`) show.

The community dashboard can send that credential back: the membership card's **Send my membership credential back** (after a confirm)
signs a DTG `MembershipCredential` as the member (issuer: the applicant `did:key` or `did:peer:2`; subject: the community's DID;
`issuerScope: directed`; an `eddsa-jcs-2022` proof for `assertionMethod`, as a credential is an assertion; the Trust Task carrying it is signed for `authentication`) and sends
`{ vc }` to `vtc/members/vmc/0.1` over REST, so the call works in every mode (`local` too).

**Bound or unbound.** The member's credential completes the membership pair only when it is *bound* to the community's own
`MembershipCredential` to the member (the grant): `credentialSubject.digestMultibase` is the grant's DigestMultibase (base58btc
multibase of a sha2-256 multihash over the JCS form of the grant without its `proof`, as dtg-credentials computes it; the kit's
`digestMultibase()` matches that library's known answer), and its `validUntil` is capped at the grant's, as mobile wallets do. The VTC
checks the digest against the grant it stored: a match is stored bound (pair complete), a mismatch is refused, and **no** digest is stored
**unbound** (`credentialsDelivered` turns `true`, the pair stays incomplete, the VTC logs a warning). The member gets the grant only in
the `credential-exchange/issue` frame the VTC pushes at approval (`payload.credential_response.credential`): it cannot read its own
grant over REST (`vtc/members/credentials/0.1` is admin only; the admin's `decide` reply carries it, but that is the admin's, not the
member's). So:

- **Tunnel mode, frames panel listening before approval:** the page keeps the grant from the issue frame (in memory; a reload forgets
  it), says so on the card, and sends a **bound** credential (`VtcClient.sendMembershipCredential({ grant })`; `membershipGrantOf()`
  picks the grant out of an issue document; a grant that is not this member's, not the community's, not `public` or expired is refused
  before anything is sent). The card then says the pair is complete.
- **Otherwise** (local mode: no messaging; tunnel mode with no frame received; farm): it sends an **unbound** one, and the card and the
  confirm say why.

It sends no `requestId`: the page cannot be sure which approved request is the current membership's, and a wrong one makes the VTC
refuse the whole delivery. `VtcClient.sendMembershipCredential()` does the same from Node. The unbound send is **verified live
2026-10-30 (one machine, one run)** for both identities (receipt `stored`, `credentialsDelivered=true`, the VTC logs `stored
member-issued VMC` with the unbound-digest warning). The bound send is **verified live 2026-10-31 (tunnel mode, did:peer:2, one
machine, one run)**: the card said the grant arrived, the community answered `stored`, the row turned to "bound credential held",
the VTC logged `stored member-issued VMC` with no unverified-digest warning, and the admin's `vtc/members/credentials/0.1` read
`memberVmcBound: true`. A frame left over from an earlier membership can arrive when the listener starts; the page keeps the latest
grant, and the bound credential matched the grant issued at the new approval.

## The rest of the gap: no DIDComm client, no wallet-side delivery

The TSP client above is the only messaging client in the kit. Nothing in the pinned npm stack sends or receives a DIDComm message. These were **not** built, and none of them is faked here:

| Idea | Why it is not here | What it needs |
|---|---|---|
| **A DIDComm "send a Trust Task" example** (for example the inbox verifier over messaging) | no DIDComm client (TSP: see above) | a client that resolves DIDs, packs and unpacks DIDComm v2 (authenticated encryption), authenticates to the mediator, and polls or listens (and, for TSP, its own framing). A substantial project of its own; use an existing library rather than writing one |
| **Credential delivery to the member's app** | the frames do arrive at a TSP listener (above); the dashboard keeps the membership grant from them in memory only to bind its send-back ([above](#what-credentialsdelivered-means)), but nothing in the kit verifies the credential's proof or stores it durably; in `MODE=tunnel` the applicant is a `did:peer:2` that names the mediator, so the frames reach it with no earlier contact ([above](#tunnel-mode-delivers-the-credential-to-the-applicant)); in `local` there is no mediator, and the applicant is a plain `did:key` | a client that unpacks, verifies and stores the credential, and sends its own membership credential back bound to it. A mobile wallet is such a client ([MOBILE-WALLET.md](MOBILE-WALLET.md)); it was not tried |
| **A DIDComm round-trip check** | TSP has one (above). For DIDComm there is no client | a DIDComm client |

What the kit shows for credentials: the community dashboard's membership card says, per mode, why delivery to the app is not confirmed instead of showing a bare `false`, and the admin's
approval response (`npm run vtc:approve`) is where a CLI-driven flow sees the credential; `npm run tsp:listen` shows the push frames arrive.

## Notes for anyone extending the TSP client

- **Ping version.** The kit sends `messaging/ping/0.2`. VTA 0.72 serves only 0.2 (0.65 served 0.1); the request is the same and
  the pong's `serverTime` became `respondedAt` (the client reads either).
- **A restarted VTA forgets the relationship.** The client invites once per session; after a VTA restart, open a new
  session (invite again) or requests go unanswered.
- **Replies are checked by `type`.** A `trust-task-error` reply surfaces its code; an in-band `issuer`/`recipient` that
  differs from the TSP peer/own VID is refused (`checkPingReply`).
- **DIDComm clients** (not in this kit) carry the same document as the body of a
  `https://trusttasks.org/binding/didcomm/0.1/envelope` message; the authenticated sender must equal the document's
  `issuer`. See [the transport table](trust-tasks/01-concepts.md#who-is-the-caller-rest-bearer-vs-messaging-sender).

## Building it yourself

Pick an established DIDComm v2 / TSP library for your language, give your applicant a DID that references the mediator in `.vta/tunnel.json`'s DID, and watch the mediator's
logs (`docker compose --profile messaging logs mediator`) while you send. If you get a message through, record it as **verified** only then, and say in which mode.
The mediator in this kit is open and public for the length of a run: demo data only.

## Mode needs at a glance

| Feature | `local` | `tunnel` | `farm` |
|---|---|---|---|
| Trust Tasks over REST, the dashboard, roles lab, e2e | yes **[verified]** | yes **[verified]** | yes |
| Approvals demo with the software approver ([APPROVALS.md](APPROVALS.md)) | yes **[verified]** | yes **[verified]** | no (you cannot seed a hosted VTA's policy from here) |
| Credential frames reach the member's listener | no | yes, over TSP to a `did:key` listening on the mediator after it spoke TSP first **[verified]** (`npm run tsp:listen`); by default to the `did:peer:2` applicant naming the mediator, with no ping first **[verified]** (`npm run tsp:peer-push`, [above](#tunnel-mode-delivers-the-credential-to-the-applicant)); `credentialsDelivered` stays false either way ([why](#what-credentialsdelivered-means)) | **[unverified]** |
| A real phone as approver | no | needs a wallet and its messaging; **not tried** | **[unverified]** |
| TSP ping and pong (`npm run tsp:ping`, browser page, `tunnel:probe`) | no | yes **[verified]** (mediator 0.45.0) | **[unverified]** |
| DIDComm application round trip | no | **no client** | **[unverified]** |
