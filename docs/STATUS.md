# Status: what works, by mode

Part of the [docs index](README.md). This page holds the project status that used to sit in the README: what was checked, in which mode, and what was not.
Every doc marks claims as **verified** (observed while building this kit) or **unverified** (documentation or inference).

## Modes at a glance

One setting, `MODE` in `.env` (or the environment), chooses where the VTA/VTC run. Exactly three modes, no separate messaging switch.
Unless a row in [docs/MODES.md](MODES.md) says otherwise, a command works in every mode; that page also says what each mode gives and what each feature needs.

| `MODE` | Runs | Needs | Start |
|---|---|---|---|
| `local` (default) | docker compose on your laptop | Docker, the VTA image (built locally: `npm run setup`; prebuilt images are not yet available) | `npm run up` |
| `tunnel` | the local stack plus a mediator (messaging), on **public, ephemeral** quick-tunnel URLs, with an **open** mediator; demo data only | Docker, `cloudflared`, internet, a locally built mediator image (heavy first build) | `npm run up -- --tunnel` (stop: `npm run down`), every caveat in [docs/MODES.md](MODES.md) |
| `farm` | agents hosted by [VTA Farm](https://vta.farm/) | A browser with a passkey; no Docker, no Rust build | `MODE=farm npm run up`, then [docs/FARM.md](FARM.md) |

**Local mode is the primary, supported path.** Farm mode is an optional shortcut for
when Docker does not cooperate, and only after a pre-event check. There are two Farms:
**`FARM=ic3` (https://vtafarm.ic3.dev, staging) is preferred and the default**; `FARM=firstperson`
(https://vtafarm.firstperson.dev) is supported but currently cannot create agents (`acl/grant/0.2`, a confirmed
Farm-side bug, 2026-10-29). Organisers run `npm run farm:probe` plus a canary agent (`npm run farm:canary`) the
day before and on the day (ic3 first, then firstperson), and use local mode for everyone if both fail ([docs/EVENT.md](EVENT.md), [docs/FARM.md](FARM.md)).
Browser apps work in farm mode through the Vite proxy in each template. Tunnel mode turns DIDComm/TSP on. A TSP client (`npm run tsp:ping`, `templates/tsp-ping`) sends a signed ping to the VTA through the kit's mediator and gets the pong back, and `npm run tsp:listen` receives the credential frames the VTC pushes after an approval; both **verified live** in tunnel mode (a wallet storing the credential, DIDComm and a Farm mediator are not: [docs/MESSAGING.md](MESSAGING.md)).
A VTC (community) is described in [docs/VTC.md](VTC.md): the client is ready,
the local Docker VTC (vtc-service 0.15.0, the version the Farm VTC runs) was **verified live** (join, approve, restart, browser; a member cannot get a console session by design, but the sessionless member surface was mapped and verified: docs/VTC-SURFACE.md), the farm community path needs the portal and is unverified.


## Verification status

This starter was checked on Linux with Docker 29 and Node 22 only; Windows and macOS hosts are untested. The organiser checklist is in [EVENT.md](EVENT.md).

**Verified live**: the local VTA and VTC flows, the dashboard (browser end to end), the role matrix, `MODE=tunnel` bring-up with the public URLs, the status
panel Messaging row in a browser, the software-approver demo in local and tunnel mode, and the TSP round trip in tunnel mode: a ping from Node and from headless
Chromium reaches the VTA and its pong comes back through the mediator (0.45.0), and `npm run tsp:listen` receives the credential frames the VTC pushes after an approval. In tunnel mode the applicant is, by default, a `did:peer:2` whose `TSPTransport` service names the mediator (a short `did:webvh` bound to its tunnel host), so the VTC pushes the credential frames to it with no ping first (`npm run tsp:peer-push`, [MESSAGING.md](MESSAGING.md#tunnel-mode-delivers-the-credential-to-the-applicant)); `VTC_APPLICANT=did:key` keeps the old `did:key` flow, also verified; `credentialsDelivered` stays false because it reports the member's own credential sent back, not frame arrival ([MESSAGING.md](MESSAGING.md#what-credentialsdelivered-means)).
The status panel's "Applicant and messaging" card (applicant type per mode, DID sizes vs the 1000-byte resolver limit, the mediator's did:webvh at its tunnel host) is unit-tested and verified live 2026-10-30 (one machine, one run): local (messaging off, did:key) and tunnel (did:peer:2 with sizes, the mediator row both in the CORS case and readable once the mediator allows the origin), in the community dashboard and web-vta-app.
The community dashboard's "Send my membership credential back" (the member's own `MembershipCredential` to `vtc/members/vmc/0.1` over REST, which turns `credentialsDelivered` true; [MESSAGING.md](MESSAGING.md#what-credentialsdelivered-means)) is unit- and component-tested. Unbound (no grant received) it is verified live 2026-10-30 (one machine, one run): receipt `"status": "stored"` and the flag true, as a did:key (local) and as a did:peer:2 (tunnel). Bound to the grant from the issue frame (tunnel mode, as the did:peer:2; the digest also matches dtg-credentials' known answer in a unit test) it is verified live 2026-10-31 (one machine, one run): bound credential held, `memberVmcBound: true` at the VTC, no unverified-digest warning. In local and farm mode the page never receives the grant, so it sends an unbound one and says why.
The community dashboard's "Credential frames" panel (listen on the mediator as the applicant from the browser, list frames by kind; needs `MEDIATOR_CORS_ALLOW_ORIGIN` for its origin) is unit- and component-tested with a fake listener and verified live 2026-10-30 (one machine, one run): started before approval as the did:peer:2, it showed the relationship invite and the credential-exchange/issue frames and kept listening after the page turned Member; without the mediator setting it shows the exact line and the recreate command.
In tunnel mode the community dashboard and the web-vta-app page show a banner that the public hosts and DIDs die at `npm run down` and change at the next `npm run up -- --tunnel` (none in local or farm mode); unit- and component-tested, verified live 2026-10-30 (one machine, one run) (tunnel and local; farm not run).
The community dashboard's read-only "Identity" section (the applicant DID decoded locally beside the mediator's DID document from its `did.jsonl`; needs the same mediator CORS for the document) is unit- and component-tested with a fake reader and verified live 2026-10-30 (one machine, one run) (local: did:key and no mediator; tunnel: did:peer:2 decoded, the CORS alert, then the mediator's document once allowed).
**Re-verified on VTA 0.72.0 + VTC 0.20.0 (2026-11-04)**, `MODE=local`, one run each, after the pins moved from 0.65.0 / 0.15.0 (the claims on this page that name 0.65 or 0.15 describe the earlier pins): `WITH_VTC=1 npm run up`, `hello`, `vtc:hello`/`join`/`approve`/`status`, `npm run e2e` (13 of 13 steps, headless Chromium), the software-approver demo (policy enforced, consent granted, update executed; also with a two-DID approver set), `roles:matrix`, `test:roles` (36 of 36 probes match [VTC-SURFACE.md](VTC-SURFACE.md)), `security:check`, `npm test` and `npm run typecheck`. Two client changes were needed: `acl/grant` 0.2 and `trust-task-discovery` 0.3, and the consent decision moved to 0.2. **`MODE=tunnel` on 0.72 (2026-11-05)**, with the mediator advanced to 0.48.0 (the version the 0.72 lockfile names; built on a build server with podman), `cloudflared` 2026.10.7, one run: `up --tunnel` and its tunnel probe (9 checks, including the TSP ping and pong, now `messaging/ping/0.2`), `hello`, `tsp:ping`, `tsp:ping:browser` (with `MEDIATOR_CORS_ALLOW_ORIGIN=http://localhost:3000`), the credential push (`tsp:listen` received the `credential-exchange/issue/0.1` frame at a `did:peer:2` with no earlier contact) and `npm run e2e` (13 of 13). The 0.72 VTA serves `messaging/ping` 0.2 only; the pong's `serverTime` is now `respondedAt`. **Not re-run on 0.72**: `farm:*` (a read-only `farm:probe` found no agent to check and no new information), the approvals demo in tunnel mode, and the browser templates other than the community dashboard and tsp-ping. On a snap-installed Chromium, set `TMPDIR` to a non-hidden folder under your home for `npm run e2e` (snap confinement cannot use `/tmp`).

**Trust Task conformance (2026-10-31)**, against the pinned VTA 0.65.0 and VTC 0.15.0, one machine, one run of each:
- *Timestamps without `.000Z`* (`issuedAt`, `proof.created`): unit-tested with a mocked clock; every live call below used them. The 1-in-1000 failure it prevents was not reproduced.
- *Replies decided by `type`* (response, `trust-task-error`, `trust-task-next-step`, empty 202/204) and idempotent creates by code: verified live in local mode (a duplicate `contexts/create` is `taskFailed` with `details.reason: "conflict"`, so a second `vta:provision` reports "already exists"). A real `trust-task-next-step` or 202/204 from the VTA/VTC was not seen live (unit-tested only).
- *Inbox verifier type dispatch and binding status codes*: unit tests and `npm run demo -w @buildathon/inbox-verifier`; not run against a remote sender.
- *Docs wording* (document vs envelope, transports, retries): `check:docs` rules.
- *Proof purpose* (`authentication` for ordinary requests, `assertionMethod` for the consent decision and credentials): verified live in local mode (provision, hello, `vta:call`, `roles:matrix`, `vtc:*`, `approvals:demo`) and in tunnel mode (the VTC accepted the did:peer:2's `#key-2` for `authentication` on join submit and status; the did:key flow; the dashboard). The inbox's refusal of `keyAgreement`/unknown purposes is unit-tested only.
- *Consent DID checks* (key under `authentication`, VTA-controlled; did:webvh log verified with didwebvh-ts): verified live in local mode on two approval runs. `fetchVtaDid` (connect) still trusts the transport ([SECURITY.md](SECURITY.md)).
- *Reply proofs* (reported as `replyProof`, never refused): live VTA/VTC replies were `verified` in local mode; the TSP pong carried an `authentication` proof by the VTA's `#key-0`. A `wrongSigner` or `invalid` reply was never seen live (unit-tested only).
- *TSP pong in-band `issuer`/`recipient`* (`checkPingReply`): verified live in tunnel mode, Node and browser ([MESSAGING.md](MESSAGING.md)).
- *Bound member credential*: above.

**Not verified**: DIDComm, a wallet storing the credential, a phone as approver, a hosted mediator admitting an outside VTA, the Farm community path, arm64, and Windows or macOS
([MESSAGING.md](MESSAGING.md)).
