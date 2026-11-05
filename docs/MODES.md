# Modes: local, tunnel, farm

One setting, `MODE` in `.env` (or the environment), chooses where the VTA and VTC run. There are exactly three modes and no separate
"messaging" switch: messaging is what `tunnel` adds. Back to the [README](../README.md).

Labels used here: **[verified]** observed while building this kit (tunnel spike and a live run of `npm run up -- --tunnel` against the
pinned images), **[unverified]** not observed, stated from documentation or inference.

## Which mode gives what

| | `local` (default) | `tunnel` | `farm` |
|---|---|---|---|
| Where it runs | Docker on your machine | Docker on your machine, exposed through Cloudflare quick tunnels | hosted by [VTA Farm](https://vta.farm/) |
| Trust Tasks over REST | yes | yes | yes |
| Messaging (DIDComm, TSP) | no (REST only) | yes, through a mediator that this mode runs | the Farm's mediator **[unverified]** for apps of this kit |
| Reachable from other devices or a phone | no | yes, on public URLs | yes |
| Persistence | Docker volumes, survive restarts | none worth keeping: new URLs and DIDs every run | the Farm's |
| Needs | Docker, the VTA (and VTC) image | Docker, `cloudflared` on PATH, internet, the VTA, VTC **and mediator** images | a browser with a passkey, internet |
| Start | `npm run up` | `npm run up -- --tunnel` | `MODE=farm npm run up`, then [FARM.md](FARM.md) |
| Stop | `npm run down` | `npm run down` (deletes its volumes) | delete the agent in the portal |
| Safe for real data | no | **no, never** | no (shared test service) |

Features and the mode they need (everything in the README and [TRY-THIS](TRY-THIS.md) works in `local` unless a row says otherwise):

| Feature | `local` | `tunnel` | `farm` |
|---|---|---|---|
| Trust Tasks, the dashboard, roles lab, `npm run e2e`, `npm run test:roles` | yes **[verified]** | yes **[verified: e2e 13/13, roles 36/36 through the public URLs]** | yes (see [FARM.md](FARM.md)) |
| [Approve on a second device](APPROVALS.md) (software approver) | yes **[verified]** | yes **[verified]** | no: a hosted VTA's policy is set in its portal |
| Membership credential reaches the member | no (messaging off) | frames reach the applicant's TSP listener: by default it applies as a `did:peer:2` naming the mediator, so the VTC pushes with no ping first (`npm run tsp:peer-push`) **[verified]**; with `VTC_APPLICANT=did:key`, the `did:key` after it spoke TSP first (`npm run tsp:listen`) **[verified]** ([MESSAGING.md](MESSAGING.md#tunnel-mode-delivers-the-credential-to-the-applicant)); no wallet-side storage, and `credentialsDelivered` stays false because it reports the member's own credential sent back, not frame arrival ([MESSAGING.md](MESSAGING.md#what-credentialsdelivered-means)) | **[unverified]** |
| TSP ping and pong (`npm run tsp:ping`) | no | yes, and the pong comes back **[verified]** with mediator 0.45.0 (VTA 0.65) and 0.48.0 (VTA 0.72); `tunnel:probe` runs it ([MESSAGING.md](MESSAGING.md)) | **[unverified]** |
| DIDComm round trip, a phone as approver | no | **no DIDComm client in the kit** ([MOBILE-WALLET.md](MOBILE-WALLET.md)) | **[unverified]** |

In the dashboard the membership card's "Credential delivery" row says which of these applies to the mode the page was built for.

## Tunnel mode in short

```bash
# Prebuilt images are not yet available (docs/IMAGES.md): build locally, once. `npm run setup -- --tunnel` does all three:
npm run images:build vta          # once; tsp is now in the feature list, see below
npm run images:build vtc          # once
npm run images:build mediator     # once, heavy: about 12 minutes cold and plenty of RAM
npm run up -- --tunnel            # tunnels -> mediator -> VTA -> VTC -> probe
npm run tunnel:probe              # re-run the checks at any time
npm run down          # stop tunnels, delete the volumes and the tunnel keys in .env
```

`npm run up` in tunnel mode does this, in this order (it matters: the DIDs and configs name the tunnel hostnames):

1. Starts three `cloudflared` quick tunnels (VTA, VTC, mediator) and reads their hostnames.
2. Starts `redis` and the `mediator` (compose profile `messaging`). The mediator creates its own identity on first boot and is told its
   public host.
3. Starts the VTA with `did:webvh` at its tunnel host, messaging pointing at that mediator, and `didcomm` + `tsp` enabled.
4. Provisions the app (the usual `vta:provision`, but against the public VTA URL, which is written to `.env` as `VTA_URL`).
5. Starts the VTC the same way, with its transports set to `tsp` and `didcomm` through the mediator.
6. Runs `npm run tunnel:probe` and fails loudly if any check fails. The stack is then left running so you can look at it.

Everything the scripts need (`npm run hello`, `vtc:join`, `vtc:approve`, ...) works unchanged with those public URLs **[verified]**. The
tunnel hostnames are kept only in `.vta/tunnel.json` and `.env`, which are git-ignored; nothing about a run is written to tracked files.
Compose files, entrypoints and recipes contain placeholders only.

## Browser access (CORS)

**The browser templates need none of this for the VTA and VTC.** Their Vite dev server proxies `/__vta` and `/__vtc` to the URLs in `.env`
(`scripts/lib/dev-proxy.ts`), so the page and the call share one origin and no CORS check happens, on any port. The proxy also drops the
browser `Origin` header, so the server sees an ordinary client. The credential sign-in is unaffected: a Trust Task is signed for the VTA's
**DID** (`recipient`), not for a URL, and the DID is read from `/.well-known/did.jsonl` through the same proxy **[client code read; farm mode already signs in this way; verified live 2026-10-30 (one machine, one run) in local mode: the status panel signs in through `/__vta`]**. The rest of this section is for code that
calls the VTA/VTC directly, and for the mediator, which cannot be proxied (its URL comes from its DID document).

A web page that talks to the mediator directly (the TSP browser client) needs two things the defaults do not give:

- **Mediator:** set `MEDIATOR_CORS_ALLOW_ORIGIN` before `npm run up` (it is applied on every boot, no volume reset). To change it on a running tunnel
  stack, recreate only the mediator; compose needs its tunnel host too, which is the last part of the mediator's `did:webvh` (`mediatorDid` in
  `.vta/tunnel.json`): `MEDIATOR_PUBLIC_HOST=<mediator host> MEDIATOR_CORS_ALLOW_ORIGIN=<origin> docker compose --profile messaging up -d mediator`
  (same host, so it keeps its DID; the VTA and VTC reconnect on their own) **[verified live 2026-10-30 (one machine, one run): the mediator DID stayed the same, `npm run tunnel:probe` passed afterwards]**. It becomes `[security] cors_allow_origin` and takes one exact origin such as `http://localhost:5173`, a
  `https://*.suffix` pattern, or `*`. **Unset (the default) means off**: responses carry no `Access-Control-Allow-Origin`, and the mediator also
  refuses a WebSocket upgrade that carries a browser `Origin` header (403). Prefer an exact origin; `*` is tolerable only because the mediator
  authenticates with a bearer token, not cookies. Anything outside letters, digits and `: / . * -` is refused at boot.
- **VTA and VTC:** their REST endpoints allow, by default, `http://localhost` and `http://127.0.0.1` on ports 3000-3009, 3050, 4000-4009,
  4173, 5173-5183 and 8000-8009 (exact origins, loopback only: the servers take no wildcard, and nothing outside this machine is admitted).
  For another origin use `CORS_ORIGINS_TOML` (VTA) and `VTC_CORS_ORIGINS_TOML` (VTC), **first boot only** (a stack made before this list
  grew keeps its old one until `npm run reset`; see the cheatsheet). Setting the variable *replaces* the default list, so include the
  defaults you still want. The browser templates do not depend on any of this: their Vite dev server proxies `/__vta` and `/__vtc`, so the page
  stays same-origin on whatever port it lands on.

The `tsp-ping` page (`templates/tsp-ping`) needs the same for its origin, `http://localhost:3000` by default. When the mediator's `did.jsonl` cannot be read
(`did:webvh resolve failed ... Failed to fetch`) or the socket is refused, its verdict names the exact `MEDIATOR_CORS_ALLOW_ORIGIN=<this page's origin>`
line and the recreate command above with the mediator host filled in **[unit-tested; verified live 2026-10-30 (one machine, one run)]**.

The community dashboard's optional "Credential frames" panel logs in to the mediator from the browser (it fetches the mediator's `did.jsonl` and
opens the socket), so it needs `MEDIATOR_CORS_ALLOW_ORIGIN=<the dashboard's origin>`, usually `http://localhost:5173` (one exact origin: the port Vite
reports); a failed connect there prints that exact line and the recreate command above. Its read-only "Identity" section fetches the same `did.jsonl`
to show the mediator's DID document and, when blocked, says so with the same line (the decoded applicant DID needs no fetch). Nothing else in the dashboard needs it.

The status panel's "Mediator did:webvh resolves at its tunnel host" row is the other place the browser templates touch the mediator: it fetches the
mediator's `did.jsonl`. Without this setting it reports "the host answers but this page cannot read it (CORS)" (not a fault; `npm run tunnel:probe`
checks it from Node) and names the optional `MEDIATOR_CORS_ALLOW_ORIGIN=<origin>` line.

_Verified live:_ with `MEDIATOR_CORS_ALLOW_ORIGIN=http://localhost:3000` the mediator answers that origin with a matching `Access-Control-Allow-Origin` and no other, and a headless Chromium page on that origin logs in and opens the TSP socket **[verified]**.

## Caveats, stated plainly

- **The URLs are public and unauthenticated.** Anyone who has a quick-tunnel URL can reach the VTA, VTC and mediator endpoints. The VTA's
  and VTC's own rate limits and ACLs are the only gates. All traffic arrives from the tunnel's address, so those limits are shared by every
  caller **[unverified under load]**.
- **The mediator is OPEN.** It runs with `mediator_acl_mode = explicit_deny` and `global_acl_default = ALLOW_ALL` (the generated default):
  any DID may register and relay through it while the tunnel is up. We left it open because a closed mediator (`explicit_allow`) answered
  403 to the `did:webvh` VTA and the VTA then **silently fell back to REST only**, with just a warning in its log **[verified]**. The DEV ONLY
  banner says so on every `up`. Keep the stack up only while you use it.
- **DIDs and credentials are regenerated on every run, and old ones are dead.** A `did:webvh` DID is bound to its hostname, and a quick
  tunnel gets a new hostname each time it starts. Restarting one tunnel gives a new hostname; the new host then serves a DID still bound
  to the old one, and the old host returns 530 **[verified]**. So tunnel volumes are never resumable, and `up` refuses to start on top of
  them (below).
- **Demo and test data only, never real credentials.** Keys are plaintext on the volumes, the admin key sits in `.vta/`, and the mediator is
  open.
- **No uptime guarantee.** Cloudflare quick tunnels are for testing: no SLA, they can be rate limited, and they are not for production.
- **Heavy first build.** The mediator is built from source. A cold build took about 12 minutes on a 12-core machine, building from a
  fresh clone of the pinned commit; the image is about 170 MB; the build's own footprint stayed within about 1.5 GB above idle **[verified,
  one machine]**. Upstream estimates 20+ minutes and 8 GB of RAM, and `npm run images:build mediator` warns when less than that is
  available. Running it (mediator 10 MB, redis 5 MB, VTA 16 MB, VTC 27 MB, each `cloudflared` about 33 MB resident) is light.
- **Messaging: a TSP round trip is verified, DIDComm is not.** (What this kit can and cannot build on it: [MESSAGING.md](MESSAGING.md).) Verified: the mediator answers through its public URL, the VTA and
  VTC connect to it, the VTA's DID document lists `TSPTransport`, `DIDCommMessaging` and `VTARest`, `messaging/ping/0.2` reports `tsp`, `didcomm`, `rest`, the VTC advertises both transports as serviceable,
  a signed TSP ping sent with `npm run tsp:ping` (and from the browser page) gets a pong from the VTA through the mediator, and after a join and an approval the VTC's two `credential-exchange/issue/0.1`
  frames arrive at the applicant's TSP listener: by default a `did:peer:2` whose `TSPTransport` service names the mediator, with no ping first (`npm run tsp:peer-push`), or the `did:key` with `VTC_APPLICANT=did:key` after it spoke TSP first (`npm run tsp:listen`). This needs the pinned mediator, v0.45.0: the first pin (0.33.1) read only TSP Rev 3 and refused the TSP 1.0 the VTA and
  VTC send. The status panel's `messaging/ping/0.2` is still only a capability check, not a peer ping. **Not** verified: any DIDComm message arriving at a peer (the kit has no DIDComm client), a wallet
  storing the credential, a Farm-hosted mediator, arm64, and Windows or macOS hosts. The tunnel mediator's DID is a short `did:webvh` bound to its tunnel host, so it resolves over HTTPS through that host, like the VTA's and VTC's (a `did:peer:2` mediator DID made the applicant's DID too long for the resolver's 1000 bytes; [MESSAGING.md](MESSAGING.md#tunnel-mode-delivers-the-credential-to-the-applicant)). The flag `credentials_delivered` stays false either way: it turns true only when the member sends its own membership credential back ([MESSAGING.md](MESSAGING.md#what-credentialsdelivered-means)).
- **A silent REST fallback is made loud.** The VTA keeps serving REST when its mediator connection fails and only logs a warning, so the
  probe and the status panel's Messaging row read the VTA's own protocol list and show `MESSAGING DEGRADED` (a failure) when `didcomm` or
  `tsp` is missing.
- **A hosted or organiser mediator may not admit your VTA.** Whether the Farm's or an organiser's mediator admits an outside `did:webvh` VTA
  is **unknown**; it depends on that mediator's ACL mode. The Farm provisions its own VTAs, which says nothing about external ones. Ask the
  operator which mode it runs. This kit supports only a self-run, open mediator for now.
- **The phone leg is not tested.** Neither a mobile wallet reaching these URLs nor `did:webvh` resolution from a device was exercised.
  If a phone connects to the mediator directly, set `MEDIATOR_CORS_ALLOW_ORIGIN` (see Browser access above); a React Native WebSocket sends an Origin
  header too **[unverified for a phone; the browser-Origin refusal itself was reproduced in the TSP spike]**.
- **The trigger-link sign-in (auth/oob) was not tested.** No path with that name exists in the VTA or VTC OpenAPI documents we read
  **[verified absent]**; whether it is a Trust Task or a wallet-side concept is **unknown**.

## Security notes for this mode

- `mediator-setup` prints the mediator's admin **private key** to its standard output (it also stores it). The entrypoint sends that output
  to a temporary file inside the container and deletes it, and deletes the generated `admin-monitor.json`, so the key is not in `docker
  logs`. If you run `mediator-setup` yourself, redact its output before pasting it anywhere.
- The VTC logs a one-time admin install URL with a signed token at boot, and `/admin/install` is reachable through its tunnel (it answered 503
  in the image we built, which has no admin console) **[verified]**. Do not tail VTC logs into a shared channel while the tunnel is up.
- Flushing the mediator's redis while the VTA and VTC are connected leaves both answering 500 ("No challenge found") until they are
  restarted **[verified]**. Redis here is memory only and is started fresh with the stack; do not flush it by hand. Restarting the mediator
  container alone is fine: the VTA and VTC reconnected on their own within about a second.
- Version skew: the VTC 0.15.0 sends a `messaging/message/status/0.2` Trust Task that the earlier mediator pin (0.33.1) answered with a "trust task unsupported"
  problem report; harmless to the flows above **[verified with 0.33.1; not re-checked with 0.45.0]**.
- The VTA's `VTA_ALLOW_PRIVATE_ENDPOINTS` loopback allowance is switched off in tunnel mode; the VTA resolves its own DID over the public
  network and that works.

## Which mode is in use

Strongest first: a flag on the command (`npm run up -- --tunnel`, also `--local`, `--farm`), `MODE` in the environment, a `MODE=` line in `.env`, the stack that is already running
(`.vta/mode.json`, written by `up`), then `local`. A flag is for that one command and writes nothing to `.env`; because later commands follow the running stack, `npm run down`, `hello` and
`tsp:ping` need no prefix after a tunnel `up`, and a plain `npm run up` after `down` or `reset` is local again. `up`, `down`, `reset` and `doctor` print one line with the mode, where it
came from and whether the VTC is on. The VTC is on by default in every mode (`WITH_VTC=0` or `--no-vtc` turn it off); if its image is not built and you did not ask for it, `up` says so and starts without it.
If you ask for another mode while the other mode's volumes exist, a terminal gets the question "reset it now?" and a script gets the refusal with the command.

## Switching modes

Volumes are never silently reused across modes. `npm run up` refuses, says why, and prints the reset command:

| You have | You run | Result |
|---|---|---|
| a `local` stack (volumes) | `npm run up -- --tunnel` | **refused.** Local data cannot move to a tunnel host. `npm run reset` (deletes the local volumes, `.vta` and the kit's `.env` keys), then try again |
| tunnel volumes (a run you did not take down) | `npm run up -- --tunnel` | **refused.** New hostnames mean new DIDs. `npm run down`, then up again |
| tunnel volumes | `npm run up` (local) | **refused.** `npm run down` first |
| a `local` stack | `npm run up` | fine, as before. A local stack made before modes existed counts as local |

`npm run down` stops the tunnels it started, removes the containers **and deletes the volumes** (they cannot be used again),
removes `.vta/tunnel.json`, and removes the dead URLs and the app credential from `.env`. It keeps `MODE` and the admin key in `.vta/`. The
refusal is also enforced inside the VTA and mediator entrypoints (a volume made for one host will not start for another), so running
`docker compose` by hand cannot reuse it either. `npm run reset` does all of that in any mode: it also stops any recorded tunnels, deletes every volume (local and messaging) and `.vta/`, and removes only the keys the kit wrote to `.env`.

In tunnel mode the browser pages say this at the top: the community dashboard and the `web-vta-app` page show a banner, "Tunnel mode: these
hosts and DIDs last only for this run.", naming the public hosts and DIDs of the VTA, the VTC and the mediator and the applicant `did:peer:2`
that names the mediator, which die at `npm run down` and are new after the next `npm run up -- --tunnel`, so nothing should be bookmarked or
shared beyond the run. The status panel's Mode row (card 1) says the same in short. No banner in local or farm mode. Wording in
`packages/status-panel/src/tunnel.ts` **[unit- and component-tested; verified live 2026-10-30 (one machine, one run), tunnel and local mode]**.

## Images and pins

`pins.json` records the mediator (affinidi-messaging-mediator commit `e6e2c636`, tag v0.48.0, features `tsp,secrets-aws`), the redis tag, and the
VTA build features. Two changes to the images you already know:

- **The VTA image must be built with `tsp`.** The VTI Dockerfile's default feature list has none, and then the VTA refuses
  `services.tsp = true` at setup **[verified]**. `npm run images:build vta` now passes the pinned feature list for every VTA build, so one
  image serves all modes. An image built before this change has no `tsp`: rebuild it. (`didcomm` without `tsp` also works **[verified]**,
  but this kit sets both.) `npm run pins:check` flags an unlabelled VTA image and confirms the label matches the pinned list **[verified: an image built by `npm run images:build vta` carries the `org.buildathon.vta-features` label, `pins:check` reports "features match", and `npm run up -- --tunnel` passed every probe check with it]**.
- **The mediator image** is built from `docker/mediator.Dockerfile`, locally: `npm run images:build mediator` (or `npm run setup -- --tunnel`, which builds whatever tunnel mode is missing). Prebuilt images are not yet available
  ([IMAGES.md](IMAGES.md)), so there is no way around the heavy build except importing an image a colleague built (`npm run images:import`). It is for
  `MODE=tunnel` only; `images:build all` does not build it. About 12 minutes cold on a 12-core machine and about 8 GB of memory advised.

`cloudflared` is a host binary (quick tunnels need no account) and is not pinned by this repo; 2024.6.1 was validated.

## Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| `up` says `cloudflared` is missing | not on PATH | Install it (see the error text); no account needed |
| "cloudflared did not print a tunnel host" | quick tunnels flaky or rate limited | wait a minute and run `npm run down` then `up` |
| "no usable image" | not built (prebuilt images are not available) | `npm run setup` (add `-- --tunnel` for the mediator), or the `images:build` commands in the message; `npm run doctor` lists them with times |
| "refusing to start ... volume was set up for" | stale volume for another host | `npm run down`, then `up` |
| probe: "DID names a different host" | a tunnel restarted under a live VTA | the DID is bound to the old host: `down`, then `up` |
| probe: MESSAGING DEGRADED / VTA reports REST only | mediator refused or unreachable (a closed ACL answers 403 to a `did:webvh` VTA), or `tsp` not built in | `docker compose --profile messaging logs vta mediator`; confirm the mediator ACL is open and the VTA image has `tsp` |
| public hosts answer 502 | tunnel is up but nothing listens behind it | `docker compose ps`; start the service |
| public hosts answer 530 / 1033 | the tunnel process is gone | `npm run down` and `up` (new URLs, new DIDs) |
| right after `up`, a public URL does not resolve | DNS for a fresh host lags a few seconds | wait and run `npm run tunnel:probe` again |
| VTA and VTC answer 500 "No challenge found" | the mediator's redis was flushed | restart the VTA and VTC; avoid flushing |
| hosted or organiser mediator rejects the VTA | its ACL is closed to your DID | ask the operator for its ACL mode; otherwise use this mode's own mediator |
| a template's dev page cannot reach the VTA | the page runs on a port other than 3000, 5173 or 8000 | those are the allowed origins (as in local mode) |
