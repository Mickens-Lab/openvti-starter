# MODE=farm: use VTA Farm instead of Docker

Part of the [docs index](README.md). Local mode is the default path: [README](../README.md).

> **Optional shortcut, behind a gate.** Local mode is this kit's primary path. There are **two Farms**;
> **ic3.dev (staging) is the preferred one** and works. firstperson.dev has an agent-creation bug on the Farm
> side (see "Two Farms"). Organisers run the pre-event go/no-go gate (below, "Canary", and [EVENT.md](EVENT.md))
> the day before and the day of: ic3 first, then firstperson, then local mode for everyone.

## Two Farms: `FARM=ic3|firstperson`

One setting picks the Farm (default `ic3`); it lives in `.env`, `.env.farm` or the environment, and is backed by
the table in `scripts/farm-hosts.json` (override the file with `FARM_HOSTS`).

| | `FARM=ic3` (preferred, default) | `FARM=firstperson` |
|---|---|---|
| Portal | https://vtafarm.ic3.dev | https://vtafarm.firstperson.dev |
| API | https://vtafarm-api.ic3.dev (`/health` 200, no version exposed) | https://vtafarm-api.firstperson.dev (same) |
| DID host | https://dids.ic3.dev (did-hosting-control 0.11.0) | https://dids.firstperson.dev (did-hosting-control 0.11.0) |
| Agent REST URL | `https://vta-<name>.ic3.dev` | `https://vta-<name>.firstperson.dev` |
| VTC | Farm communities live at `https://vtc-<name>.<farm-domain>`; this kit lists none (set `VTC_URL` / `VTC_DID` yourself) | same |
| Agent creation | **works** (a 0.65.0 VTA created by hand on 2026-10-29 passed the kit canary) | **fails**: `unsupportedVersion: acl/grant/0.2` from the DID host; reproduced by hand on 2026-10-29 |

An example Farm-hosted community exists on the ic3 Farm (`vtc.ic3.dev`); confirm with the Farm operators before joining it. This kit never defaults to it: `VTC_URL` / `VTC_DID` are yours to supply.

The firstperson.dev failure is a **confirmed Farm-side bug** (reproduced by hand; it is not our
automation, image choice or Admin DID). Both portals offer the image selector. Re-probe before relying on it:
`npm run farm:probe` shows both Farms side by side (read-only) and says which looks usable.

Giving only an agent name is enough:

```sh
FARM=ic3 FARM_AGENT=<your-agent-name> ENV_FILE=.env.ic3 npm run vta:provision   # VTA_URL=https://vta-<your-agent-name>.ic3.dev,
                                                                       # VTA_DID read from https://dids.ic3.dev/<your-agent-name>-vta/did.jsonl
```

`farm:check`, `farm:canary`, `vta:provision` and the Vite farm proxy all derive `VTA_URL` (and, for the scripts, `VTA_DID`
from the agent's DID log, read-only) from `FARM` + `FARM_AGENT`. An explicit `VTA_URL` / `VTA_DID` always wins. The
mediator DID is never hardcoded; it is whatever the agent's DID log names.

One setting picks where the VTA (and VTC) come from:

| `MODE` | Where | You need |
|---|---|---|
| `local` (default) | docker compose on your laptop | Docker, the VTA image (and a VTC image for the community) |
| `farm` | agents hosted by [VTA Farm](https://vta.farm/) | A browser with a passkey, no Docker, no Rust build |

`MODE` lives in `.env` (or the environment: `MODE=farm npm run hello`). Commands are
the same in both modes: `npm run up`, `hello`, `vtc:hello`, `vtc:join`, `down`.

## What VTA Farm is

A hosted demo service that runs a Trust Agent per participant in a Kubernetes
namespace. https://vta.farm/ is the public landing page; its sign-in is a
portal per Farm (preferred: **https://vtafarm.ic3.dev**; also https://vtafarm.firstperson.dev, currently broken for
agent creation; the page links there). Individuals can create
up to two agents ("open to everyone", per the landing page; it may reset or stop
accepting agents when space runs out). A community (VTA + mediator + DID host + VTC)
is "on request". Source: github.com/ic3software/vtafarm, vtafarm-api, vtafarm-k8s.

**Invite or self-service?** Verified 2026-10-29: self-service (email + passkey, no verification). The text below is the earlier, pre-verification note.

 `vti-setup/developer/01-personal-vta.md` says you need an invite link from a
VTA Farm admin. The portal's own code has both: invitation registration (`/register/:token`) and a
self-service email sign-up (`POST /api/v1/signup`). The live portal bundle seen on 2026-10-29 contains the
"Create account" sign-up and the invitation routes, so an invite is probably not required, but we cannot
confirm without trying it (see "What a participant does at the portal" below). Organisers should still ask the
Farm operators about invites and capacity.

## Quickstart

```sh
npm i
MODE=farm npm run up         # = npm run farm:setup the first time
```

`farm:setup` mints `.vta/admin.json` and prints the **Admin DID**. Then, in the portal:

> **Pick `0.72.0-26d0da81` (verified 2026-11-08, ic3).** The kit targets VTA 0.72.0 / VTC 0.20.0 and sends `acl/grant/0.2`, `trust-task-discovery/0.3`, `task-consent/decision/0.2` and `messaging/ping/0.2`. The ic3 portal offers a `0.72.0-26d0da81` image; an agent created from it reported vta-service 0.72.0 (`farm:check`: equals the pin), and `vta:provision` and `hello` passed (292 Trust Tasks, app capabilities include `room-present` and `room-open`). A VTA from the older `0.65.0-fc157f76` image serves older task versions, so `provision` and the approvals demo answer `unsupportedVersion` against it; the 0.65.0 results further down are history. Not re-verified on firstperson. Rooms on the Farm: [ROOMS.md](ROOMS.md).

1. Open https://vtafarm.ic3.dev (`FARM=ic3`, preferred; `farm:setup` prints the URL for the selected Farm), sign up with a passkey (invite link if asked).
2. Create an agent (name, image). **In the image selector pick `0.72.0-26d0da81`** (the pinned release `vta-service-v0.72.0`). **Do not keep the portal's default image** (`VTI-Eucalyptus-49f5f1be [latest]`, vta-service 0.56.0): it predates the Trust Task versions this kit sends. `npm run farm:check` and `farm:canary` read the deployed agent's version and print a loud warning if it is not the pin. For a VTC, a community is "on request".
3. On the agent's **Connections** tab choose "Connect to PNM" and paste the DID `farm:setup` printed into **Admin DID**.
   Wait for "Running". (On firstperson.dev this step fails with `unsupportedVersion: acl/grant/0.2`, a Farm-side bug; on ic3.dev it works. See "Two Farms".)
4. Copy into `.env`: `VTA_URL=https://vta-<name>.<domain>`, `VTA_DID=did:webvh:...` (or just `FARM_AGENT=<name>`: both are derived),
   and for a community `VTC_URL=https://vtc-<name>.<domain>`, `VTC_DID=did:webvh:...`.
5. `npm run farm:check` (read-only GETs), then `MODE=farm npm run up` again: it runs
   `vta:provision`, which creates your context and a context-scoped app identity over
   the Trust Task API, exactly as it does locally. Then `npm run hello`.

Why this works with no portal UI for contexts or ACLs: the portal imports the Admin
DID you give it as the VTA's admin (`POST /api/v1/setup/:id/admin`, `import-admin-did`
step in vtafarm-api). That is the same `did:key` role the local VTA seeds, so
`provision` and everything after it is identical.

## What the farm gives you, and what it does not

| Question | Answer |
|---|---|
| Account | Passkey sign-up in a browser. Cannot be scripted; this kit does not try |
| VTA URL / DID | Shown in the portal. URL pattern `https://vta-<name>.<domain>` (from vtafarm-api) |
| DID resolution | A farm VTA's DID log is hosted on the farm's DID host, so `/.well-known/did.jsonl` on the VTA may not exist. Farm mode therefore trusts `VTA_DID` / `VTC_DID` from `.env` |
| Contexts, ACL | Via the Trust Task API as the admin DID (what `provision` does). **Unverified live** |
| Node scripts | HTTPS, no CORS involved |
| **Browser apps** | Verified 2026-10-29: the farm VTA's CORS allows only the VTA wallet extension origin (`chrome-extension://dbjgfkjlgfamanmbiihldgncpjeknphl`); `http://localhost:5173` gets no `access-control-allow-origin`, so it is **blocked**. The templates therefore proxy `/__vta` and `/__vtc` through the Vite dev server in farm mode. Hosted deploys need their own proxy or a farm CORS change |
| VTC | Only with a community (full stack). URL `https://vtc-<name>.<domain>`. Verified 2026-10-29 on a Farm-hosted VTC: the preflight answers 200 but sends **no** allow-origin for either localhost or the extension, so browsers are blocked; same proxy need |
| VTC admin | The VTC's first admin is claimed in a browser with an install URL, claim code and passkey (15 min; the portal can re-issue). That admin DID is not your Admin DID, so `vtc:approve` returns 403 on the farm: approve join requests in the VTC admin console |
| Wallet / phone | The portal pairs an agent with the Keyring mobile app by QR code; not needed here |
| Image version | The farm runs its own images and moves often. `npm run farm:probe` shows what is running right now. If the door is older (or newer) than this kit expects, `provision` fails with a 404 or `unsupportedType`/`unsupportedVersion`; tell the organiser. The portal lets the user pick the image tag when creating an agent (the portal source has a per-agent image/version card), so a participant's VTA may differ from the runner VTA probed below |

## Farm versions observed

**The Farm changes often (the operators' notes say almost daily, and it was wiped and rebuilt on
2026-09-29/30). Treat every row below as a dated snapshot, not a fact. Re-run `npm run farm:probe` the day
before and on the day of the event** ([EVENT.md](EVENT.md)); it is read-only (GET/HEAD/OPTIONS, about 2 s apart)
and prints a stamped table. Hosts live in `scripts/farm-hosts.json`; `FARM_AGENT` / `VTA_URL` / `VTC_URL` (yours) add your own agent and community to the probe; without them only the hosts are checked and it prints "no agent configured, version not checked".
When the result differs from this table, add a new dated block here and update the `farm` block of `pins.json`.

### Snapshot: 2026-11-08 (an ic3 agent created from the `0.72.0-26d0da81` image)

| Check | Result |
|---|---|
| `farm:check` | vta-service **0.72.0**, equals the pin; `/health` 200; `/openapi.json` 0.72.0 |
| `vta:provision`, `hello` | context and app identity created; discovery lists 292 Trust Tasks; `auth/whoami` capabilities include `room-present` and `room-open` |
| Rooms tasks served | `rooms/keys/{present,seal,open,key-package,welcome}` at 0.2 / 0.1 and the `rooms/owner/*` family |
| `vta/webvh/dids/create/1.2` as the app identity | refused: no `KeyMint` capability (the `application` role does not carry it) |
| `vta/webvh/dids/create/1.2` as the admin, `keys/sign-document`, `vault/credentials/receive` | worked: the VTA minted a persona `did:webvh` on the ic3 DID host (`control`), signed a community join request for it, and stored room credentials (the application role lacks `KeyMint` and `VaultWrite`) |
| A community with rooms (a VTC 0.26.0 hosted outside the Farm) | open room: joined, offered, accepted, posted, read back. Attributed room, as the persona: key-package, accept, welcome, sealed post and read back ([ROOMS.md](ROOMS.md)) |

### Snapshot: 2026-11-07 (read-only `farm:probe`, no account)

| Component | Seen | Change since 2026-10-29 |
|---|---|---|
| ic3 and firstperson API `/health` | 200 `{"status":"ok"}` | none |
| DID hosts `dids.ic3.dev`, `dids.firstperson.dev` | did-hosting-control **0.12.0** | **0.11.0 to 0.12.0** on both. The firstperson `acl/grant/0.2` bug was on 0.11.0; **whether 0.12.0 fixes it is untested** (needs a portal login and an agent creation by hand), so the issue stays listed |
| Portals | 200, last-modified 2026-11-06 07:57 UTC (both) | redeployed |
| Agent and VTC versions, image list | not readable without an account or an agent | unknown; the kit's 0.72 / 0.20 are **not** confirmed against any Farm agent |

### Snapshot: 2026-10-29 18:38 to 18:45 UTC

| Component (host) | Version seen | How read | vs this kit's pin |
|---|---|---|---|
| An existing Farm VTA (not named here) | vta-service **0.65.0** | `GET /openapi.json` `info.version` (`/health` returns only `{"status":"ok"}`) | equals the VTA pin 0.65.0 |
| A Farm-hosted VTC | vtc-service **0.15.0** | `GET /health` and `/openapi.json` | was newer than the then-pin 0.13.0; the pin is now 0.15.0 and equals it |
| DID host `dids.ic3.dev` | did-hosting-control 0.11.0 | `GET /api/health` | not pinned |
| DID host `dids.firstperson.dev` (the host the failing agent used) | did-hosting-control **0.11.0**, read directly 2026-10-29 19:43 UTC (same as `dids.ic3.dev`) | `GET /api/health` | not pinned |
| The Farm mediator (`did:webvh:<scid>:dids.<farm-domain>:<mediator>`) | version not exposed | named in the VTC's `GET /v1/community/public-profile` and both DID logs; advertised for TSP and DIDComm | not pinned |
| Portal `vtafarm.firstperson.dev` | HTTP 200, last-modified 2026-10-28 19:22 UTC; its API host `vtafarm-api.firstperson.dev` `/health` ok | `GET /` | n/a |
| Landing `vta.farm` | HTTP 200 | `GET /` | n/a |

Newest upstream tags at that time (`git ls-remote`, 2026-10-29): `vta-service-v0.67.0`, `vtc-service-v0.15.0`
(both at VTI commit `93d36996`, 2026-10-28). So the Farm VTC is at the newest release; an existing Farm VTA was one
or two releases behind (0.65.0 of 0.67.0). Identifiers in third-party notes go stale quickly; resolve DIDs from the live DID host instead of copying them.

Other facts read in the same run:

| Fact | Result |
|---|---|
| Farm VTA `/.well-known/did.jsonl` | 404 on the VTA host; its DID log is on the DID host (`https://dids.ic3.dev/<name>/did.jsonl`, 200). Confirms farm mode must take `VTA_DID` from `.env` |
| Farm VTC `/.well-known/did.jsonl` | 200: a VTC serves its own log; services `TSPTransport`, `DIDCommMessaging`, `VTCRest` (`https://vtc-<name>.<farm-domain>/v1`), `VTCStatusList` |
| `HEAD /trust-tasks` (VTA) and `HEAD /v1/trust-tasks` (VTC) | 405 on both: the door exists and is POST only. (Whether it serves the exact task versions we send is **not** checkable without POSTing) |
| VTA CORS preflight (`OPTIONS /trust-tasks`) | `http://localhost:5173`: no allow-origin (blocked). `chrome-extension://dbjgfkjlgfamanmbiihldgncpjeknphl` (the VTA Wallet origin pinned in vtafarm-api): allowed. Methods GET, POST, DELETE, PATCH; headers content-type, authorization, x-backup-token |
| VTC CORS preflight (`OPTIONS /v1/trust-tasks`) | HTTP 200 but no allow-origin for either origin (browsers blocked; Node is unaffected) |
| VTC public GETs | `/v1/community/public-profile` (name "ic3 VTC", `personhood.realHuman=false`, `singleMembership=false`, transports tsp/didcomm/rest), `/v1/community/did-qr.svg`, `/v1/status-lists/{purpose}`, `/openapi.json`. The join manifest (criteria, admission, join policy) is **only** a signed `POST /v1/trust-tasks`, so criteria are unknown to us |

### Compatibility of this kit with that snapshot

What our clients send (`packages/vta-client`, `packages/vtc-client`) against what VTI says that version serves
(VTI `CHANGELOG.md`s and `vtc-service/src/trust_tasks`, read from tags `vta-service-v0.65.0`/`vtc-service-v0.13.0`
locally and `vtc-service-v0.15.0` / `vta-service-v0.67.0` from GitHub):

| What we call | Farm VTC 0.15.0 | Verdict |
|---|---|---|
| `vtc/join-requests/manifest/0.4` | the only version served (0.3 dropped in 0.14.0) | ok; our 0.3 fallback is dead code on the Farm |
| `vtc/join-requests/submit/0.3`, `status/0.1`, `decide/0.1` | still the current versions in the 0.15.0 source | ok (expected) |
| `vtc/join-requests/list/0.1`, `vtc/members/list/0.1` | **dropped in 0.14.0**: now 0.2 | **fixed in `pin-farm-aligned`**: `vtc-client` sends 0.2 and falls back to 0.1 only on `unsupportedVersion`. (`vtc:approve` still answers 403 on the Farm: the VTC admin is not your Admin DID.) |
| `auth/challenge/0.1`, `auth/authenticate/0.3`, `auth/whoami/0.1` | `authenticate` 0.3 and `whoami` 0.1 present in the 0.15.0 source; `challenge` version not confirmed | probably ok; an enrolled member is required anyway |
| `acl/*` (VTC) | 0.1 dropped in 0.15.0 | not used by us |

| What we call | Farm VTA 0.65.0 | Newer VTA (0.67.0, released 2026-10-28) |
|---|---|---|
| `auth/challenge/0.1`, `auth/authenticate/0.3`, `auth/whoami/0.1` | served (pin is this version) | `authenticate` stays 0.3; others not re-checked |
| `trust-task-discovery/0.1` | served | **dropped** (0.3 only), so `discover()` fails |
| `acl/grant/0.1` (used by `provision`) | served | **dropped** in 0.67.0 (`acl/*/0.2` only): `provision` would fail on a participant VTA created from a 0.67 image |

Verdict as of the snapshot: the VTA path was compatible with an existing Farm VTA, and the VTC path was compatible
except the two admin list calls, which `pin-farm-aligned` moved to 0.2. The pins now match what the Farm runs
(VTA image `0.65.0-fc157f76`, Farm VTC 0.15.0). The remaining risk is drift: a VTA moving to 0.67 breaks
`provision` and `discover`, and a participant who keeps the portal default (0.56.0) gets an incompatible agent.
The lasting fix is version negotiation in the clients (to-do in [PINS.md](PINS.md)).

## Participant steps on the ic3.dev portal 

A 0.65.0 VTA was created by hand on https://vtafarm.ic3.dev on 2026-10-29 with this kit's generated Admin DID entered in the
creation flow, and everything worked (provision, hello and the canary then passed).
Known steps: open the portal, create an agent (name, then the image `0.65.0-fc157f76`), enter the Admin DID from
`npm run farm:setup`, wait for the agent to run, then `FARM_AGENT=<name>` or the portal's URL/DID in `.env`.
**To be confirmed:** the exact screens and labels on the ic3 portal (sign-up vs invite, whether the
Admin DID is asked in the creation wizard or on a Connections tab, button names, agent limit). The walk-through below
is the firstperson.dev portal, which shares the same portal build (identical `last-modified`); expect the ic3 one to match but do not rely on it.

## What a participant does at the portal on firstperson.dev (live pass, 2026-10-29)

Walked live with a throwaway account (headless browser, virtual passkey). Account sign-up and agent creation
worked; the **Admin DID step then failed in the Farm's own portal-to-DID-host call** (see "Live result" below), so nothing past it is
verified. Passkeys cannot be scripted by this kit.

1. `npm run farm:setup` first; it prints the **Admin DID** (a `did:key`).
2. Open https://vtafarm.firstperson.dev. Home page: "Get a VTA", "Create a VTA Farm account", "Sign in".
3. **Account**: "Create a VTA Farm account" opens a dialog with one email field and "Create account with Passkey".
   **No email verification, no invite, no CAPTCHA, no approval**: the email is only a label (vtafarm-api
   `signup.go`). The browser then shows its passkey prompt, and you land on `/portal` with a limit of **0 / 2** agents.
   The account is bound to that passkey and there is **no email recovery**: a lost passkey means a lost account.
4. `/portal` -> "Create Agent" (`/portal/create`). There was **no "VTA Only / Full Stack" choice** for this account:
   the form is "Connect to" (default "VTA Farm's messaging service"; or "Another messaging service"), "Agent name"
   (the agent lives at `https://vta-<name>.firstperson.dev`), and "VTA Image". The Farm's availability endpoint
   did report full-stack capacity, but the UI offered no way to pick it, so communities remain "on request".
5. **Images offered** (the dropdown, newest first): default `VTI-Eucalyptus-49f5f1be [latest]` (2026-10-15, version
   not shown), `0.67.0-736f6570 [nightly]`, `0.67.0-61c23f20 [main]`, `0.66.0-*` (two), **`0.65.0-fc157f76`**
   (2026-10-27), many `0.64.0-*` down to `0.60.0-fd1621d9`, then `VTI-Dogwood-*` and `Cypress-10d74fc5`. The page says
   "stay with the default 'latest' image unless you have been told otherwise". We chose `0.65.0-fc157f76` to match the pin.
6. "Create session" runs a setup that streams logs (about 1 minute) and ends "setup complete". It printed
   `Verifiable Trust Agent v0.65.0`, so the chosen image tag does give the version in its name.
7. **Admin DID step lives on the agent's "Connections" tab**, not in the wizard form: choose **"Connect to PNM"**,
   which shows the VTA DID (`did:webvh:...:dids.firstperson.dev:<name>-vta`), a field "Admin DID" and
   "Connect to VTA". Paste the `farm:setup` DID there. ("Connect to Keyring" is the phone QR path.) Copy the
   VTA DID from here for `.env`.
8. Expected next: "Deploy agent", then "Running"; copy `VTA_URL` / `VTA_DID` into `.env`, then
   `npm run farm:check`, `MODE=farm npm run up`, `npm run hello`.

### Live result of that pass

Step 7 ("Connect to VTA") made the portal's deploy step **fail**: `failed to add VTA DID to hosting ACL: DID hosting
Trust Task returned HTTP 422 ... unsupportedVersion: https://trusttasks.org/spec/acl/grant/0.2`, issued by the
DID host `dids.firstperson.dev`. The failed agent still counts toward the 2-agent limit; the portal says "Delete this
agent and create a new one to try again". Afterwards `https://vta-<name>.firstperson.dev` returns the ingress 404 (nothing deployed).

**Retry with the default image, 2026-10-29 20:00 UTC (done).** We deleted the failed agent
(account back to 0/2), created a test agent again with the portal's **default** image
`VTI-Eucalyptus-49f5f1be [latest]` (its setup log prints `Verifiable Trust Agent v0.56.0`), waited for "setup complete",
and entered the same Admin DID at 20:00:20 UTC. **Same failure**, at 20:00:21 UTC:
`failed to add VTA DID to hosting ACL: grant ACL entry: DID hosting Trust Task returned HTTP 422: {"type":"https://trusttasks.org/spec/trust-task-error/0.5","issuer":"did:webvh:<scid>:dids.firstperson.dev",...,"payload":{"code":"unsupportedVersion","inResponseTo":{"typeUri":"https://trusttasks.org/spec/acl/grant/0.2",...},"message":"unsupported version: https://trusttasks.org/spec/acl/grant/0.2","retryable":false}}`
(the first attempt, with `0.65.0-fc157f76`, had the identical error at 19:34:55 UTC). So the image tag does not matter
and hypothesis (a) below is refuted by experiment. We stopped there (no more tags); that failed agent is still in the
account (1/2). Note the issuer in the error is the DID host itself, which answers `unsupportedVersion` for grant 0.2.
Side finding: the default `latest` image is vta-service **0.56.0**, older than this kit's 0.65.0 pin. From the 0.56.0
source, it serves `auth/authenticate/0.1` where our client sends 0.3, so even a working default-image agent would probably
refuse our clients (inferred from source, not tested live because no agent got deployed). Participants would have to
pick a `0.65.0-*` image, as the quickstart says.

**Update, same day: confirmed Farm-side on firstperson.dev.** The failure was reproduced by hand with the same error, and the ic3.dev
staging Farm creates the same image fine, while both DID hosts report did-hosting-control 0.11.0. Our automation is not at fault;

**Whose fault? Diagnosis, 2026-10-29 (earlier reasoning, kept for the record).** Most likely a **Farm-side deploy skew** (confidence now high for "not caused
by our choice of image or Admin DID", moderate-high for the exact cause: a newer vtafarm-api against an older
did-hosting-control). Evidence:

- The call is made by vtafarm-api itself (`internal/setup/orchestrator.go` `runProvision` -> `didhosting.Client.CreateAcl`),
  *before* the provision job and the VTA deployment, so the VTA image never runs. The task type is a hardcoded constant
  in `internal/didhosting/client.go`; no request field (agent name, image, Admin DID) selects it. The image tag is
  passed only to the later k8s calls. So our image choice (`0.65.0-fc157f76` rather than the default) cannot change
  this call; the Admin DID value is only passed to the provision job afterwards.
- vtafarm-api **0.16.1** (released 2026-10-28 19:21 UTC, PR #103 "update trust task protocols", CHANGELOG "DID Hosting
  ACL management") changed that constant from `acl/grant/0.1` to `acl/grant/0.2` (and revoke likewise). The earlier
  source (checkout of 2026-10-01) has 0.1. The portal bundle served now has `last-modified` 2026-10-28 19:22:27 UTC, one minute
  after that release, so the live Farm is running the 0.2-sending API.
- `dids.firstperson.dev` `GET /api/health` returns `did-hosting-control` **0.11.0** (observed directly, twice,
  2026-10-29 19:43 UTC; `dids.ic3.dev` shows the same 0.11.0). The earlier note's 0.11.0 for this host is therefore
  confirmed, not inferred from `dids.ic3.dev`; what the original error text carried is not recorded. The host itself
  answered 422 `unsupportedVersion` for `acl/grant/0.2`, so that deployment serves only the older grant version.
  We could not read did-hosting-control 0.10/0.11 source (the ic3software mirror we can see ends at 0.9.0, whose changelog
  documents `acl/grant/0.1`), so "which release first serves 0.2" is **unknown**.
- Hypotheses. (a) *Our choice (image tag / Admin DID / step order)*: predicts the failure depends on the image or happens after
  deploy begins; contradicted by the source order and now by the default-image retry (same 422). (b) *Farm deploy skew (API ahead of DID host)*:
  predicts exactly what we saw, for every account and every image, and a fix when the DID host is upgraded (or the API
  rolled back). (c) *Unknown*: remains if the live API differs from the 0.16.1 source we read. Still-open discriminator for (b) vs (c): the operators confirming the rollout state, or the canary passing after a Farm change.
- Not our bug to fix here. **Before an event, create one agent end to end on the day**; do not assume the portal works.

## Live result against a real Farm VTA (2026-10-29, 22:50 UTC)

Run against a VTA created by hand in the portal (name `<your-agent-name>`, DID
`did:webvh:<scid>:dids.ic3.dev:<your-agent-name>-vta`), with a generated test admin
`did:key` entered as its Admin DID. Unlike the earlier throwaway-account pass, this agent deployed.

| Fact | Result |
|---|---|
| REST URL | `https://vta-<your-agent-name>.ic3.dev` (DID document service `VTARest`; matches the `vta-<name minus -vta>.ic3.dev` pattern) |
| DID host | `dids.ic3.dev`, log at `/<your-agent-name>-vta/did.jsonl` (200); the VTA host has no `/.well-known/did.jsonl` (404) |
| Messaging | `TSPTransport` and `DIDCommMessaging` (`didcomm/v2`) both point at the mediator `did:webvh:<scid>:dids.ic3.dev:<mediator>` |
| Version | vta-service **0.65.0** (`/openapi.json`), equal to the pin |
| `farm:check` | all rows pass; CORS: `http://localhost:5173` blocked, wallet extension origin allowed (as before) |
| `vta:provision` | authenticated as the admin; created context `my-app`; granted the application role to the app `did:key`. A second run reports both already exist (idempotent) |
| `hello` | authenticated; discovery lists 304 Trust Tasks; `auth/whoami` returns role `application`, scope `ctx:my-app`, 14 capabilities (vault-read, sign*, memory-*, room-*, ...) |
| `farm:canary` | PASS farm:check, provision, hello: verdict GO |
| web-vta-app | ran headless (`vite --mode farm --port <free port>`, which reads `.env.farm`) through the `/__vta` proxy: authenticated, `auth/whoami` and "List Trust Tasks" worked, no console errors |
| App-role reads | `keys/list` -> empty, `vault/list` -> empty (both allowed); `acl/list` -> 403 `permissionDenied` (admin only) |

Not verified: DIDComm/TSP messaging through the mediator (only REST used), VTC, wallet extension, write calls
other than what `provision` does, a VTA on 0.67+ (`acl/grant/0.1` and discovery 0.1 are dropped there).
Note the portal step that failed earlier (DID host `acl/grant/0.2`) was not exercised here; this agent already existed.
Run the app on another port with `npx vite --mode farm --port 5199` (the config pins 5173 with strictPort, and
`--mode farm` is what makes Vite read `.env.farm`).

## Verified live vs not (as of 2026-10-29)

| Item | Status |
|---|---|
| Sign-up needs email, no verification/invite/CAPTCHA/approval | **verified** |
| Passkey sign-in works from a stored credential | **verified** (virtual authenticator) |
| Limit 2 agents per account; image list; default `latest` is `VTI-Eucalyptus-49f5f1be` | **verified** |
| Setup with chosen image `0.65.0-fc157f76` reports vta-service 0.65.0; default `latest` reports 0.56.0 | **verified** (portal logs) |
| Admin DID step location and fields | **verified** |
| Portal completes deploy after the Admin DID | **FAILED** at the portal API -> DID host call (`acl/grant/0.2` refused by did-hosting-control 0.11.0); most likely deploy skew, see "Live result". Reproduced with the default image (v0.56.0) at 20:00 UTC |
| `farm:check`, `provision`, `hello`, web app via proxy on a participant VTA | **not verified** (no running agent) |
| DID-log location for a participant VTA | partly: the log is hosted at `https://dids.firstperson.dev/<name>-vta/did.jsonl` (200), VTA host has no `/.well-known/did.jsonl` |
| VTC join via portal | not tried (no community option in the UI for this account; no join was submitted) |

## Canary (organisers: Farm go/no-go)

Do this the day before and on the day. Both steps must pass; otherwise use local mode.

0. Order of preference: **ic3.dev first, then firstperson.dev, then local mode** for everyone. Run steps 1-4 for `FARM=ic3`; only if that fails repeat them for `FARM=firstperson` (known to fail agent creation until the Farm fixes it).
1. `npm run farm:probe`: read-only survey of both Farms side by side against `pins.json`; it names the one that looks usable.
2. Portal (manual; passkey): sign up or sign in, create ONE throwaway agent (the default image is what a participant
   would get), then Connections > Connect to PNM > paste the Admin DID from `npm run farm:setup`. Watch the stepper
   reach "Running". If any step fails, copy the portal's exact error text and time; that is a NO-GO.
3. Put `FARM=ic3` and `FARM_AGENT=<name>` (or the agent's `VTA_URL` / `VTA_DID`) into `.env.farm` (your local `.env` stays untouched), then
   `ENV_FILE=.env.farm npm run farm:canary`. It runs `farm:check`, `provision` and `hello` in order and prints
   PASS/FAIL per step and a verdict: GO, or "switch to local mode".
4. Delete the canary agent in the portal (an undeleted agent, even a failed one, uses one of the 2 slots).

`farm:canary` cannot create the agent: sign-up and agent creation need a passkey in a browser.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `MODE=farm needs VTA_URL=https://...` | Finish the portal steps; copy the URL into `.env`, or set `FARM_AGENT=<name>` |
| `unsupportedVersion: acl/grant/0.2` while creating an agent | firstperson.dev Farm bug (confirmed). Use `FARM=ic3` |
| `could not reach the VTA ... (ENOTFOUND)` | Wrong URL, or the agent is still building. `npm run farm:check` |
| `refused the admin (HTTP 401/403)` | The portal's Admin DID is not the one in `.vta/admin.json`. Delete the agent and recreate with the right DID, or `npm run farm:setup` prints it again |
| `HTTP 404` on `/trust-tasks` | The farm image predates the Trust Task door; ask the organiser |
| `unsupportedVersion` / `unsupportedType` from the Farm | The Farm is newer (or older) than the pin for that task. `npm run farm:probe`, then see "Compatibility" above |
| Browser CORS error | Use the Vite dev server (it proxies in farm mode); do not call the farm from another origin |
