# Pins

Part of the [docs index](README.md). How the pieces fit: [ARCHITECTURE.md](ARCHITECTURE.md).

`pins.json` records the versions this kit was last validated against: the
verifiable-trust-infrastructure (VTI) refs that the VTA and VTC images are built from, and exact npm versions (no `^`; `.npmrc` sets
`save-exact`, `package-lock.json` is committed). Upstream moves fast; without pins a
participant's or organiser's rebuild silently changes the wire behaviour.

```sh
npm run setup                        # build the images your mode needs and that are missing (= images:build needed); the usual first command
npm run images:build [vta|vtc|mediator|all]   # build each image from its own pinned ref; tags <image>:<short-sha> and :local (`all` = vta + vtc; the mediator is for MODE=tunnel only)
npm run images:pull [vta|vtc|mediator|all]   # prebuilt images are NOT available yet (pins.json images.available is false): explains and pulls nothing; IMAGES=registry for members with access
npm run images:verify [-- vta|vtc|mediator|all]   # is it the pinned, signed image? see VERIFY.md
npm run pins:check [-- --strict]     # report drift; changes nothing
```

**Build locally; prebuilt images are not yet available.** `pins.json` `images.available` is `false` (the organisation does not allow public packages), so `npm run up`
uses the `<name>:local` images you built and never pulls ([IMAGES.md](IMAGES.md)). `pins.json` `images` still holds the registry, the platforms and, for later, each image's digest;
the registry tag would be the first 8 characters of the pinned ref. The commands below are the path everyone takes today.

`images:build` exports each pinned ref from a VTI checkout (`VTI_PATH`, default
`../verifiable-trust-infrastructure`) with `git archive`, so whatever is checked out
there is irrelevant. `VTI_LOCAL=1` builds that checkout's working tree instead (for
development; tagged `:local` only). Images carry the label `org.buildathon.vti-ref`.
**Digests.** They matter only for prebuilt images, which are not available yet, so `pins:check` says "not in use" instead of warning. If `images.available` is flipped to `true` and a digest is `null`, an image is pulled by a movable tag and `pins:check` prints a `WARN`. After a workflow run, record the digests, and `images:verify` can check them against the signature ([VERIFY.md](VERIFY.md)).

`pins:check` compares, per image, the label, the binary's own `--version`, that the release tag still resolves to the pinned ref, a running VTC's
`/health` version, the lockfile against `pins.json`, and the newest upstream
`vta-service-v*` / `vtc-service-v*` tags and `npm outdated`. It is read-only.

## Where the images come from

**Current decision: build locally; prebuilt images are not yet available.** The organisation does not allow public GHCR packages, so participants cannot pull images and everyone builds their own
(`npm run setup`). `pins.json` `images.available` (`false`, with a one-line `why`) is the single switch: while it is `false`, `IMAGES=auto` means local and nothing is pulled. The publish workflow
(`.github/workflows/images.yml`, never run), the signing and verification tooling and the digest fields stay for later, for organisation members (`IMAGES=registry`, after `docker login`) or if
packages can ever be public ([IMAGES.md](IMAGES.md)). This is the one place that says so; the other docs link here, so if the status changes, change this section, the `images.available` switch and the `Prerequisites` bullet in the README.

The local-build cold path, exactly (Linux, 12 cores, Docker; the times below were measured on a 12-core desktop, so plan 25 to 40 minutes per Rust image on a laptop):

```sh
# 1. The upstream repository, next to this one (the URL is `vti.repo` in pins.json). `images:build` asks before cloning in a terminal,
#    prints these two commands otherwise, and does it for you only with `npm run images:build -- --clone`.
git clone https://github.com/OpenVTC/verifiable-trust-infrastructure ../verifiable-trust-infrastructure
git -C ../verifiable-trust-infrastructure fetch --tags origin     # the pinned refs must be present
# 2. Build what you need, in one command: `npm run setup` (local: VTA + VTC; `-- --tunnel` adds the mediator). Or one at a time (each image is exported from its own pinned ref; niced; the first build is the slow one)
npm run images:build vta        # about 12 min cold (Rust); local mode needs this
npm run images:build vtc        # about 8 min with warm caches, about 23 min cold; only for WITH_VTC=1 and the community
npm run images:build mediator   # about 12 min cold, tunnel mode only; also needs `cloudflared`
```

Budget several GB of free RAM (the mediator build warns below 8 GB) and about 10 GB of disk for the Rust build layers. If the checkout is somewhere else, set `VTI_PATH`.
The mediator comes from its own repository (`messaging.mediator.repo` in pins.json), which the Dockerfile fetches itself, so no checkout is needed for it.
`npm run doctor` lists which images and which VTI checkout are missing, with the exact build command and its time first. Images you built can be copied to another machine of the same CPU architecture
with `npm run images:export` / `images:import` (`docker save` / `docker load`; [IMAGES.md](IMAGES.md#sharing-images-you-built), [EVENT.md](EVENT.md)).

## What is pinned now

One ref: the 0.72 release commit is both `vta-service-v0.72.0` and `vtc-service-v0.20.0` (the earlier pins were two refs, matched to the Farm):

| Image | Tag | Ref | Why |
|---|---|---|---|
| `vta-buildathon` | `vta-service-v0.72.0` | `26d0da81` | Advanced from 0.65.0 on 2026-11-04. **Not yet re-validated end to end, and not what the Farm ran when last observed (0.65.0).** |
| `vtc-buildathon` | `vtc-service-v0.20.0` | `26d0da81` | The VTC cut from the same release commit as the VTA. Previously 0.15.0 (`93d36996`), which a Farm VTC ran when observed. |

For `MODE=tunnel` ([MODES.md](MODES.md)) there are more pins, in `pins.json` under `messaging`:

| What | Pin | Why |
|---|---|---|
| `mediator-buildathon` | affinidi-messaging-mediator `7e378c03` (tag v0.45.0), features `tsp,secrets-aws` | The mediator release the VTA 0.65.0 lockfile names; it reads TSP 1.0 like the VTA and VTC (the earlier pin, affinidi-tdk-rs `55580615` / v0.33.1, read only Rev 3); built from `docker/mediator.Dockerfile` (heavy: see MODES.md). |
| `redis` | `7.4.6-alpine` | In-memory queue store for the mediator. |
| `cloudflared` | validated 2024.6.1 (host binary, not pinned) | Quick tunnels. |
| VTA build features | `setup,rest,didcomm,tsp,cli-synthesis,aws-secrets,webvh` | The VTI default has no `tsp`; the VTA then refuses `services.tsp = true`. |

Farm participants must pick the image `0.65.0-fc157f76`, never the portal default (0.56.0).
`npm run farm:check` and `farm:canary` compare the deployed agent's `/openapi.json` `info.version` with this pin and warn loudly.

## To do: version negotiation in the clients

The clients hard-code Trust Task versions (`vta-client`: `acl/grant/0.2`, `trust-task-discovery/0.3` (moved from 0.1 for the 0.72 pin, so it no longer works against a 0.65 VTA such as the Farm's), `auth/*`;
`vtc-client`: manifest 0.4 with a 0.3 fallback, list 0.2 with a 0.1 fallback). They should ask the peer what it serves
(trust-task discovery, or the OpenAPI document) and pick the highest common version, so one kit works across Farm
releases (a 0.67 VTA already drops `acl/grant/0.1` and `trust-task-discovery/0.1`) instead of being fixed to one pin.
Until then, the pins plus the canary's version warning are the guard.

## Advancing (never automatic)

1. `npm run pins:check` and read the upstream changes you would take (VTI CHANGELOG, `vta-service`/`vtc-service` tags).
2. Edit `pins.json` (per image `tag`, `ref`, `version`; `pinnedOn`, `why`; exact npm versions, then `npm install`).
3. `npm run images:build`, then re-verify end to end: `WITH_VTC=1 npm run up`, `npm run hello`,
   `vtc:hello`, `vtc:join`, `vtc:approve`, `npm test`, `npm run typecheck`, then `docker compose --profile vtc down -v`.
4. Fix whatever broke (this is where the starter's scripts and docs change), update the verified/unverified notes in
   [VTC.md](VTC.md), and run `npm run farm:probe` and read the [farm note](FARM.md#farm-versions-observed).
5. Add one line to [PINS_LOG.md](../PINS_LOG.md): date, old -> new, why, what was re-verified.
6. Rebuild and republish the images: run the `images` workflow and record the new digests in `pins.json` ([IMAGES.md](IMAGES.md), [EVENT.md](EVENT.md)). Until a digest is recorded, `pins:check` says so.

Pins are what was last validated, advance deliberately and say why.
