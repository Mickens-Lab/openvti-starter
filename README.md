# OpenVTI buildathon starter

> **WARNING: a playground for demos and testing ONLY.** Keys are held in plaintext files
> (`.vta/`, `.env`, the VTA's seed on its volume) and, for the web templates, embedded in the
> browser page. Nothing here is secure for long-term or real use. Do not reuse these keys, do not
> deploy the built pages, do not point it at anything real. Details and the way up from here:
> [docs/SECURITY.md](docs/SECURITY.md).

A small TypeScript kit for getting familiar with **Verifiable Trust Agents (VTAs)**, **Verifiable Trust
Communities (VTCs)** and **Trust Tasks** (signed, typed request/response documents). It gives you a
disposable local VTA and VTC in Docker (or a hosted VTA from VTA Farm), small clients for both, and
runnable templates: a signed-document inbox, a browser app, and a React community dashboard.
It is for developers who want to see a signed Trust Task round trip working in minutes, then build on it.

## Prerequisites

- Node 20+ and npm 10+, Docker with Compose v2
- The VTA image (plus the VTC image for the community, and the mediator image for tunnel mode). **Build locally; prebuilt images are not yet available**
  (the organisation does not allow public packages, so there is nothing to pull). `npm run setup` builds what your mode needs: it needs a checkout of the upstream VTI repository
  next to this one (`npm run setup -- --clone` makes it) and a cold Rust build of **25 to 40 minutes for the VTA and again for the VTC** on a laptop (the mediator, `MODE=tunnel` only,
  is about 12 minutes). Do this once, ahead of time, with a few GB of free memory; later runs reuse the images. A colleague with the same CPU architecture can hand you theirs
  (`npm run images:import`; [docs/IMAGES.md](docs/IMAGES.md#sharing-images-you-built)). Exact steps: [docs/PINS.md](docs/PINS.md#where-the-images-come-from). To check what you run:
  [docs/VERIFY.md](docs/VERIFY.md). Without Docker, see the Farm mode in [docs/MODES.md](docs/MODES.md).

## Quick start

```sh
npm ci
npm run setup                # once: builds the missing images (the slow part, 25 to 40 min per Rust image cold; see Prerequisites)
npm run up                   # keys, VTA + VTC, a "my-app" context and a credential in .env (WITH_VTC=0: no community)
npm run hello                # first signed call
npm run vtc:hello            # read the community's join manifest
```

Expected from `npm run hello` (DIDs differ on your machine):

```
1. VTA DID        did:webvh:Qm...:localhost%3A8100   (MODE=local)
2. authenticated  as did:key:z6Mk...
3. discovery      304 supported Trust Tasks
4. signed call    auth/whoami -> {"capabilities":[...],"roles":["application"],"scopes":["ctx:my-app"],...}
```

`npm run doctor` checks Docker, memory, ports (8100, 8200, 5173, 3000, 4000), the images (with the exact build command for a missing one) and the VTI checkout; `npm run up` runs the blocking part first, so a missing image or a busy port is a short message, not a Docker or Node stack trace.
Use `WITH_VTC=0 npm run up` if you do not need a VTC. Stop with `npm run down`, wipe everything with `npm run reset`.
Trouble? See [Troubleshooting](#troubleshooting).

## Your first hack

```sh
npm run new -- my-app --from hello-web     # or hello-node: copies a ~15-line starting point to apps/my-app and installs it
# then run the command `new` printed (for hello-web it starts a page at http://localhost:5173)
```

Both read the credential `npm run up` wrote to `.env` and call the VTA (`whoami`, and for hello-node a `memory/put` and `memory/list`). `apps/` is git-ignored: it is your code.
`npm run new` alone lists the other starting points.

## Things to try

[docs/TRY-THIS.md](docs/TRY-THIS.md) has guided exercises, easy to advanced, each with commands and expected output:
a first signed call, the status page, join a community and see the member screens, tamper/replay/wrong-recipient
against the inbox verifier, reading refusals, calling a task you have not used, a read-only look at the Farm, a collaboration room on data rooms (mock mode, no stack), and ideas to extend,
plus approving a gated task from a second key ([docs/APPROVALS.md](docs/APPROVALS.md)). Each exercise names the mode it needs.

## Repo map

| Path | What |
|---|---|
| `packages/vta-client`, `packages/vtc-client` | Discover, authenticate, sign and call any Trust Task; VTC join and member helpers. Node and browser. Each has a README with an example ([vta-client](packages/vta-client/README.md), [vtc-client](packages/vtc-client/README.md)). |
| `packages/tsp-client` | Log in to the mediator, open the TSP socket, send a signed ping and read the pong; `connectTsp` receives frames. Node and browser. See its [README](packages/tsp-client/README.md). |
| `packages/status-panel` | Dependency-free connection-status panel (vanilla TypeScript). |
| `packages/rooms-client` | VTI data rooms: signed `rooms/*` calls to a room host, sealed tiers through a key service (VTA oracle or in-page MLS), chat/note/file envelope, polling feed, in-memory search, author profiles; `./mock` has an in-process host. See its [README](packages/rooms-client/README.md). |
| `templates/inbox-verifier` | Server that accepts signed documents (works offline). |
| `templates/web-vta-app` | Browser app with a status page and optional wallet (vanilla TypeScript). |
| `templates/community-dashboard` | React dashboard for the VTC member journey. |
| `templates/collab-room` | React collaboration space on data rooms (chat, notes, files, search, live polling); runs with no stack in mock mode. |
| `templates/tsp-ping` | Browser page that sends a TSP ping to the VTA (`MODE=tunnel`; sends a TSP ping and shows the pong, see docs/MESSAGING.md). |
| `templates/mcp-agent` | Stub for an AI agent with a scoped VTA identity. |
| `scripts/` | The npm commands (`up`, `hello`, `vtc:*`, `farm:*`, `vta:call`, checks). |
| `docker-compose.yml`, `docker/` | Local VTA and VTC. |
| `docs/` | Everything else: see the [docs index](docs/README.md). |

Code tour with a diagram: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Docs

[Docs index](docs/README.md): [TRY-THIS](docs/TRY-THIS.md), [ARCHITECTURE](docs/ARCHITECTURE.md), [CHEATSHEET](docs/CHEATSHEET.md),
[VTC](docs/VTC.md), [VTC-SURFACE](docs/VTC-SURFACE.md), [ROLES](docs/ROLES.md), [MODES](docs/MODES.md), [FARM](docs/FARM.md), [PINS](docs/PINS.md), [EVENT](docs/EVENT.md),
[TRACKS](docs/TRACKS.md), [SECURITY](docs/SECURITY.md), [Trust Tasks guide](docs/trust-tasks/README.md).

## Modes

One setting, `MODE` in `.env` (or the environment), chooses where the VTA/VTC run: `local` (default, Docker on your laptop), `tunnel` (local stack plus a mediator on
public, ephemeral quick-tunnel URLs, for messaging and TSP; heavy first build) or `farm` (agents hosted by [VTA Farm](https://vta.farm/), no Docker).
**Local mode is the primary, supported path.** What each mode gives, what works and what was verified: [docs/MODES.md](docs/MODES.md) and [docs/STATUS.md](docs/STATUS.md).

## Templates

| Template | Run it | Good for |
|---|---|---|
| [`templates/hello-node`](templates/hello-node), [`templates/hello-web`](templates/hello-web) | `npm run new -- my-app --from hello-node` (or `hello-web`) | The smallest apps: sign in, `whoami`, memory put/list; a one-button page. Start here. |
| [`templates/inbox-verifier`](templates/inbox-verifier) | `npm run demo -w @buildathon/inbox-verifier` | Servers that accept signed Trust Tasks. Works offline, no VTA needed. |
| [`templates/web-vta-app`](templates/web-vta-app) | `npm run dev -w @buildathon/web-vta-app` | Browser apps that talk to the VTA. Optional wallet. |
| [`templates/mcp-agent`](templates/mcp-agent) | see its README | AI agents with a scoped VTA identity. Partial: a stub. |
| [`templates/community-dashboard`](templates/community-dashboard) | `npm run dev -w @buildathon/community-dashboard` | A React + TypeScript dashboard for the whole member journey with a VTC, no session: visit, apply (with a signed-request preview), pending (polls every 10 s, withdraw), member (card, directory, my card, renew, leave), re-apply, plus an "Under the hood" log of every Trust Task call. Its membership card has a per-mode "Credential delivery" note. Needs a VTC. Driven end to end in headless Chromium against the local stack; states are marked verified/inferred in its README. |
| [`templates/collab-room`](templates/collab-room) | `npm run dev -w @buildathon/collab-room` | A React collaboration space on VTI data rooms: chat history (load older, plain/markdown), notes with versions, files, two search modes (file names, full text), live updates by polling and author names/avatars, on an open and an MLS-sealed room. Mock mode (the default) runs an in-browser room host with a simulated member, no stack; `COLLAB_MODE=live` wires the VTC and VTA and is unverified live. Markdown and files render inert. Tested in Node and jsdom only. |

Six track ideas are in [`docs/TRACKS.md`](docs/TRACKS.md); endpoints, task names
and env vars are in [`docs/CHEATSHEET.md`](docs/CHEATSHEET.md).

New to Trust Tasks, or need one that does not exist yet? [`docs/trust-tasks/`](docs/trust-tasks/README.md) covers
concepts, finding, using, developing and evaluating them, with a hands-on custom-task walkthrough.

## Commands

The ones you need in the first hour (all of them, grouped: [docs/COMMANDS.md](docs/COMMANDS.md); every script has `--help`):

| Command | Does |
|---|---|
| `npm run doctor` | Is this machine ready: Node, Docker, memory, ports, images (a missing one: the exact local build command first, with its time), VTI checkout, mode. `up` runs the blocking checks first |
| `npm run up` | Start the stack (local by default; `-- --tunnel` for messaging, this run only). The community (VTC) is on in every mode, `WITH_VTC=0` leaves it out |
| `npm run down` / `npm run reset` | Stop and keep data / stop everything, delete volumes, `.vta/` and the keys the kit wrote to `.env` (your own `.env` lines stay). Both work in every mode |
| `npm run setup` | Build the images your mode needs and are missing (`-- --tunnel` adds the mediator, `-- --no-vtc` leaves the VTC out); prints estimates, warns on low memory, reports the time ([docs/IMAGES.md](docs/IMAGES.md)) |
| `npm run images:export` / `images:import -- file.tar` | Share the images you built with another machine (same CPU architecture), no registry ([docs/IMAGES.md](docs/IMAGES.md#sharing-images-you-built)) |
| `npm run hello` | The checkpoint |
| `npm run new -- my-app --from hello-web\|hello-node` | Copy a minimal template to `apps/my-app` and install it |
| `npm run vta:call -- <task> [json]` | Call any Trust Task as your app identity (no argument lists them; `--search <word>` filters, `--schema <task>` shows its fields offline) |
| `TRACE=1 npm run hello` then `npm run trace` | See every signed call the clients made, one line each (task, outcome, ms, who to whom) |
| `npm run repl` | A REPL with `vta` and `vtc` already signed in and top-level await: `await vta.whoami()` |
| `npm run vtc:hello` / `vtc:join` / `vtc:approve` / `vtc:status` | Community: read the join manifest / apply / admin approves / where do I stand |
| `npm run tsp:ping` / `tsp:listen` | `MODE=tunnel`: send a signed TSP ping and print the pong / receive the credential frames the VTC pushes ([docs/MESSAGING.md](docs/MESSAGING.md)) |
| `npm run roles:matrix` / `approvals:demo` / `security:check` | Who can call what / approve a gated task from a second key / key-hygiene scan ([ROLES](docs/ROLES.md), [APPROVALS](docs/APPROVALS.md), [SECURITY](docs/SECURITY.md)) |
| `npm run images:verify` / `images:compare` | Check what you run: is the image the pinned one, built and signed by this repository's workflow, with the pinned labels (`-- --local` for your own build; [docs/VERIFY.md](docs/VERIFY.md)) |
| `npm run images:build [vta\|vtc\|mediator\|all]` / `pins:check` | Fallback or organiser: build an image from its pinned ref / report version drift ([docs/PINS.md](docs/PINS.md)) |
| `npm test` / `npm run typecheck` / `npm run check:docs` / `npm run check:generic` | Unit tests (no VTA needed) / typecheck / links and script names in the docs / no personal specifics in the tree |

Old names `vta:up`, `vta:down` and `vta:reset` still work. Farm, tunnel, VTC, live-test and maintainer commands are in [docs/COMMANDS.md](docs/COMMANDS.md).

## Troubleshooting

| Symptom | Fix |
|---|---|
| Port busy, or an image is missing | `npm run doctor` names the busy port with a free alternative, or the missing image with the exact build command (`npm run setup` builds them all). |
| `pull access denied` for a registry image | Prebuilt images are not available (the organisation does not allow public packages); you only see this with `IMAGES=registry` or a custom registry. Build locally: `npm run setup` ([docs/IMAGES.md](docs/IMAGES.md)). |
| `.vta/admin.env` not found | `npm run vta:keygen` before `docker compose up`. |
| `provision` fails with 401 or `permissionDenied` | `.vta/admin.json` is not the key this volume was seeded with. `npm run reset`, then `npm run up`. |
| `VTA DID changed` | The VTA was recreated. `npm run vta:provision`. |
| `429` | Auth is rate limited per IP; the kit allows burst 60. Wait a few seconds. |
| Browser "NetworkError" / fetch failed | The stack is down (`npm run doctor`), or your own code calls the VTA directly from an origin outside its CORS list. The templates proxy `/__vta` through Vite, so any port works for them; see the cheatsheet. |
| Port 8100 taken | `VTA_PORT=8101 npm run up` on a fresh volume (`reset` first) and `VTA_URL=http://localhost:8101`. Not tested here. |
| `MODE=farm` errors | See the troubleshooting table in [docs/FARM.md](docs/FARM.md). |
| `refusing to start ... volume was set up for` / `Found volumes from a MODE=local run` | Volumes from another mode: follow the printed reset; table in [docs/MODES.md](docs/MODES.md#switching-modes). |
| Tunnel probe fails or shows `MESSAGING DEGRADED` | See the troubleshooting table in [docs/MODES.md](docs/MODES.md#troubleshooting). |
| Anything else | `npm run vta:logs`; a `Setup failed:` line names the bad field. |

## Status

What works in which mode, and what was and was not verified: [docs/STATUS.md](docs/STATUS.md).

## Privacy / what this repo does not contain

This is a general tool. It holds no one's keys, agents, accounts or infrastructure:

- No agent names, VTA/VTC DIDs, runner agents or default community. `scripts/farm-hosts.json` lists only the public host
  patterns of the VTA Farms. You supply your own `FARM_AGENT` / `VTA_URL`, and `VTC_URL` / `VTC_DID` if you use a community.
  `farm:probe` checks hosts, and your own agent only if you configured one.
- No key material. Your admin key (`.vta/`) and app credential (`.env*`) are generated on your machine and gitignored,
  as are passkey and state files. `farm:setup` prints your own freshly generated Admin DID.
- No personal details, machine paths or private repositories. `npm run check:generic` (part of `npm test`) enforces this.
  Test fixtures are made up and short (for example `did:webvh:Qmfake:localhost`).
- An example Farm-hosted community may be named in [docs/FARM.md](docs/FARM.md); confirm with the Farm operators before joining any community you did not set up.

## License

Apache-2.0. Adapted from the `buildathon-vta` kit in
verifiable-trust-infrastructure; see [NOTICE](NOTICE).
