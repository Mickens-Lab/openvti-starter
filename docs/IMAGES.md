# Images: build locally; prebuilt images are not available yet

Part of the [docs index](README.md). Pins and drift checks: [PINS.md](PINS.md).

> **Current state, plainly.** The organisation does not allow public GHCR packages, so participants **cannot pull prebuilt images**.
> Everyone builds their own images on their own machine. That is the default and the only generally supported path today.
> The switch is one line in `pins.json`: `images.available` (currently `false`, with a one-line `why`). While it is `false`,
> `IMAGES=auto` behaves like `IMAGES=local`: the kit uses `<name>:local`, never attempts a network pull and never defaults to a `ghcr.io` tag.
> The publish workflow, the signing and verification tooling and the digests in `pins.json` stay in the repository for later (organisation
> members who have access, or the day packages can be public). They are not the default path and nothing here should be read as saying
> prebuilt images exist for you.

The VTA, VTC and mediator images are Rust release builds. Plan for **25 to 40 minutes cold for the VTA and for the VTC** on a laptop (12 to 25 minutes
were measured on a 12-core desktop) and **about 12 minutes for the mediator**, which only `MODE=tunnel` needs. Later builds reuse Docker's layer cache.
Each image is built once; after that `npm run up` starts in seconds.

## What a participant does

```sh
npm ci
npm run doctor           # says exactly which images are missing and the command that builds each (with its time)
npm run setup            # builds what your mode needs and is not built yet: VTA + VTC (add -- --tunnel for the mediator)
npm run up
```

`npm run setup` is `images:build needed`: it builds only the missing images for the chosen mode (`-- --tunnel`, `-- --no-vtc`), one after the
other, prints the estimate first, warns if memory is low, and reports how long each took. It is safe to stop and run again. The VTA and VTC are
built from a checkout of the upstream VTI repository next to this one (`git clone ... ../verifiable-trust-infrastructure`, or add `-- --clone`
and the script does it); the mediator needs no checkout but about 8 GB of memory. Details and times: [PINS.md](PINS.md#where-the-images-come-from).

Local builds run on a resource-limited buildx builder so they cannot starve or crash the machine: 6 GB memory with no swap, a quarter of the CPU cores (cargo is pinned to that many cores, so its parallel jobs fit in the memory cap), low CPU priority (`nice` on the docker client alone would not reach the daemon that compiles). Change it per run with `npm run setup -- --memory 8g --cpus 4` (`--no-limits` builds unlimited), or once for all runs by putting `BUILD_MEMORY=8g` and `BUILD_CPUS=4` in `.env` (the environment works too; a flag wins over both). Needs `docker buildx`.

To get images without building them yourself, a colleague with the same CPU architecture can send you theirs: see
[Sharing images you built](#sharing-images-you-built).

`npm run up` decides per image, in this order (`scripts/lib/images.ts`):

1. `VTA_IMAGE` / `VTC_IMAGE` / `MEDIATOR_IMAGE` set: that exact image, nothing else is tried.
2. `IMAGES=local`, **or `IMAGES` unset/`auto` while `images.available` is `false` (today)**: only the locally built `<name>:local`. Never touches the network.
3. `IMAGES=auto` once `images.available` is `true`: the pinned registry image if it is already here, else a local build if you have one, else it **pulls** the pinned registry image.
4. `IMAGES=registry`: the pinned registry image only (pulled if absent), no fallback to a local build. Works even while `images.available` is `false`, for people whose account
   can pull the organisation's packages (`docker login ghcr.io` first); it says that the images are not generally available.

| Variable | Effect |
|---|---|
| `IMAGES=local` | Only locally built images. Today this is what `auto` means anyway. |
| `IMAGES=registry` | Insist on the registry images. For organisation members with access; not generally available. |
| `IMAGE_REGISTRY=host/org` | Pull from another registry or org (a mirror, a fork's packages, a local `registry:2`). Default: `pins.json` `images.registry`. |
| `VTA_IMAGE`, `VTC_IMAGE`, `MEDIATOR_IMAGE` | An exact image (for example one loaded with `docker load`). |

These can go in `.env` or the shell. `npm run reset` removes only the keys the kit wrote to `.env`, so your own lines stay.
Bare `docker compose up` (without `npm run up`) knows nothing of the registry and uses `<name>:local`; use `npm run up`.

`npm run images:pull` while images are unavailable prints an explanation and pulls nothing (add `IMAGES=registry` if you have access).
`npm run images:pull -- --check` shows, without any network, what is present.

### Sharing images you built

Building is the slow part; copying is not. Build once on a fast machine, then share the result with `docker save` / `docker load`, with no registry:

```sh
npm run images:export -- buildathon-images.tar     # on the machine that built (add --tunnel for the mediator, --no-vtc to leave the VTC out)
npm run images:import -- buildathon-images.tar     # on the other machine, same CPU architecture
```

These run `docker save -o` and `docker load -i` on the `<name>:local` images the mode needs. **Verified here:** a `docker save | gzip` then `zcat | docker load` round trip and
the script's `save -o` then `import` on a tiny scratch image (the image ID and labels survived), and `images:export` on the real VTA image (the tar is written, 179 MB).
**Not verified:** a full export and import of all three images onto a second machine, and `up` from images loaded that way (it should be the same, as compose only needs the `:local` tags). Details
that matter: the CPU architecture must match (import warns when it does not; an amd64 tar will not run natively on Apple silicon), and the tar is **unsigned**, so it is exactly as
trustworthy as whoever made it ([VERIFY.md](VERIFY.md)). By hand the same thing is `docker save vta-buildathon:local vtc-buildathon:local | gzip > images.tar.gz` and `zcat images.tar.gz | docker load`.

## The registry design (for later)

Everything below is how prebuilt images are meant to work once `images.available` is `true`. Until then it is not a path you can use unless you are an organisation member with access.

### Where the names come from (registry images)

`pins.json` stays the single source of truth. The image is `<registry>/<name>:<first 8 characters of the pinned upstream commit>`:

| Image | Name | Tag from | Example |
|---|---|---|---|
| VTA | `vta-buildathon` | `vti.vta.ref` | `ghcr.io/mickens-lab/vta-buildathon:26d0da81` |
| VTC | `vtc-buildathon` | `vti.vtc.ref` | `ghcr.io/mickens-lab/vtc-buildathon:26d0da81` |
| mediator | `mediator-buildathon` | `messaging.mediator.ref` | `ghcr.io/mickens-lab/mediator-buildathon:7e378c03` |

`pins.json` `images.<kind>.digest` (initially `null`) is the multi-arch index digest. Once recorded, `images:pull` and `up` pull by
digest (`<registry>/<name>@sha256:...`), so a moved tag cannot change what runs. Until it is recorded they pull by tag and
`pins:check` warns "no digest in pins.json" (`images:pull -- --by-digest` refuses the tag fallback).

### Checks

`npm run pins:check` reads the labels of a pulled image: the upstream ref label (`org.buildathon.vti-ref` or
`org.buildathon.mediator-ref`) must equal the pin, the VTA's `org.buildathon.vta-features` must equal the pinned list (it includes
`tsp`), and, if a digest is recorded, the local copy must have that digest. Other labels the workflow sets:
`org.opencontainers.image.source` (this repository, which is what links the package to it on GHCR), `.revision` (this repo's commit that
built it), `.licenses` (Apache-2.0, the licence of the software built in), `.version`, `org.buildathon.pinned-ref` and
`org.buildathon.upstream-source`.

For a future `doctor`: `scripts/lib/images.ts` exports `imageStatus(imageSpecs(pins()), realDocker, currentMode())`, which returns
per image `ready | pullable | missing` with a fix command, and pulls nothing.

### Checking the images

Pulling is not trusting. `npm run images:verify` checks a pulled image against `pins.json` and the workflow's signature and attestations, and `npm run images:pull -- --by-digest` pulls only by the pinned digest. How, and what that does and does not prove: [VERIFY.md](VERIFY.md). The workflow attaches an SBOM, a build provenance attestation and a keyless cosign signature (jobs `attest` and `sign`); these have **never run** and are unverified until the first real run.

## What an organiser does: publishing (only when packages can be public, or for members)

**The current blocker is organisational, not technical:** the organisation does not allow public GHCR packages. Publishing the images (and the signatures and digests that go with them) is therefore not something participants can use today. Running the workflow is still useful for organisation members and for the day the policy changes; when it does, set `images.available` to `true` in `pins.json`, record the digests, and run the checks in step 7 below.

Publishing happens in GitHub Actions with the built-in `GITHUB_TOKEN` (`packages: write`). No personal token is involved, and no
credential is stored in this repository. (A personal token needs the `write:packages` scope; the `gh` token on the organiser's
machine may lack it. The alternative is `gh auth refresh -s write:packages`, then a manual `docker login ghcr.io` and push. The workflow
route is preferred because the images are then built from a clean checkout, labelled, multi-arch and recorded.)

### First run

1. **Check the org allows it.** Org owners: Organisation settings > Packages > "Package creation": members must be allowed to create
   **public** packages (and the org's plan matters little: public packages on GHCR are free of charge; the repository is public). Without
   this, the first push fails with a permission error and an owner can create the package or change the setting. This is **unverified**
   for this org.
2. **Actions must be enabled** for the repository, and workflows may need "Read and write permissions" under Settings > Actions > General >
   Workflow permissions (the workflow requests `packages: write` itself, but an org policy can cap it).
3. **Dry run first.** Actions > images > Run workflow, `images` = `vta` (the quickest to learn from), `push` = **false**. This builds on the
   native amd64 and arm64 runners, runs `--version` and checks the labels, and pushes nothing.
4. **Publish.** Run it again with `push` = true and `images` = `all`, or push a tag named `images-<date>`. Expect roughly 25 to 45
   minutes per image on GitHub's 4-vCPU runners (an estimate, not measured), in parallel. See the timeout notes at the top of the workflow.
5. **Make the packages public.** New packages are **private** by default. For each of the three: GitHub > the org > Packages > the package >
   Package settings > Change visibility > Public. Because the images carry the `org.opencontainers.image.source` label for this repository,
   the package is linked to the repository automatically on first push; if it is not, use "Connect repository" on the package page.
   (Linking is also what lets the repository's Actions keep pushing new versions.)
6. **Check the signatures, then record the digests.** First `npm run images:pull`, then `npm run images:verify` (needs `gh` or `cosign`; [VERIFY.md](VERIFY.md)): expect `INCOMPLETE` only for the missing digest, and no `FAIL`. The run's summary lists each image's digest and a `jq` command that sets it in `pins.json`; the same data is
   the `images-digests` artifact. Commit the change (`git commit -s`) so participants pull by digest, and run `images:verify` again: now it can say `VERIFIED`.
7. **Verify from a clean machine**, with no local images: `docker logout ghcr.io` (the package is public, no login should be needed), then
   `npm ci && npm run images:pull && npm run pins:check && npm run up && npm run hello`. On an arm64 machine (Apple silicon, an arm64 server)
   as well as amd64: the arm64 image is built on a native arm64 runner and is **untested** until someone does this.

### When pins advance

Advance a pin per [PINS.md](PINS.md), then re-run the workflow (tag `images-<date>`), record the new digests, and commit. The tag in the
registry changes with the ref, so an old tag stays available for those who need it. The images are for development only: the mediator is
open-ACL by design and the VTA stores a plaintext seed ([MODES.md](MODES.md), [SECURITY.md](SECURITY.md)).

### If something fails

| Symptom | Likely cause |
|---|---|
| Push fails with 403 or "denied" at the first push | Package creation by members is off in the org (step 1), or an org policy caps the token's permissions (step 2). |
| `permission_denied: read_package` when pushing a package that already exists | The package was pushed by hand, so the repository's workflow token has no access to it. Either delete that package and let the workflow create it, or open the package settings, "Manage Actions access", and add this repository with the Write role. Seen on the first real run. |
| `cannot allocate memory` or "the runner has received a shutdown signal" during a Rust build | The runner ran out of memory. The build job adds 16 GB of swap before building; if it still happens, build fewer images per run (`images=vta`, then `vtc`, then `mediator`). |
| arm64 jobs wait for ever | The `ubuntu-24.04-arm` runner is not available to the organisation. See the QEMU fallback in the workflow comments (hours, not minutes), or publish amd64 only. |
| A build leg is cancelled at its timeout | The runner was slower than the estimate. Raise `timeout` in the plan step, and record the real time in this file. |
| `fetch ... origin <sha>` fails in the VTA or VTC leg | The pinned commit is not reachable from the upstream repository (force-pushed or deleted). Re-pin ([PINS.md](PINS.md)). |
| `pull access denied` for a participant | Expected today: the packages are private and the organisation does not allow public ones. Build locally (`npm run setup`). If `images.available` is true: the package is still private (step 5), or `IMAGE_REGISTRY` points elsewhere. |
| `no matching manifest for linux/...` | A CPU architecture that was not built (only amd64 and arm64 are). |
| `pins:check` reports a digest drift | The registry tag moved or the local copy is old: `npm run images:pull -- vta --force`. |

## What is verified and what is not

Verified here (no network, no registry):

- `images.available` false/true: `IMAGES=auto` resolves to the local build and never pulls while false; flipping it to true gives the earlier behaviour (unit tests, both ways); `images:pull` prints the explanation;
  `doctor` puts the local build command first; `npm run setup` plans only the missing images for the mode (unit tests; the build itself is the pre-existing `images:build`);

- the resolution logic and its fallbacks, the friendly pull errors, the label and digest checks (unit tests, `scripts/test/images.test.ts`);
- `images:verify` and `images:compare` against a mocked `docker`/`gh`/`cosign` (`scripts/test/verify.test.ts`), and live against the local images (labels only; the hand-pushed stopgap images correctly fail `label origin`);
- the workflow file parses, its permissions are read-only except `packages: write` on the publishing jobs and `id-token`/`attestations: write` only on `attest` and `sign`, every action is pinned to a
  commit SHA, no expression is interpolated into a script, and its plan step, run locally against `pins.json`, produces the expected
  six build legs (`scripts/test/images-workflow.test.ts`);
- `npm run images:pull` against an unreachable registry fails with the friendly message and the local build named; `npm run up` with
  local images starts a working VTA and `npm run hello` passes.

**Not verified:** that the workflow runs on GitHub at all (including the `attest` and `sign` jobs, `anchore/sbom-action`, `actions/attest-*` and `cosign` against GHCR, and that `gh attestation verify` / `cosign verify` accept the result with the identity `images:verify` expects); that the actions' pinned versions behave as written; that the arm64 images
build, start and work; build times on the runners; that the org permits package creation; that a participant can pull anonymously; the
digest flow end to end; `actionlint` was not available, so only the YAML parse and a shell syntax check stood in for it.
