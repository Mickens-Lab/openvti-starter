# Event guide

Part of the [docs index](README.md). Participants start with the [README](../README.md) and [TRY-THIS.md](TRY-THIS.md).

A four-hour buildathon for teams of 1 to 4 building a TypeScript app linked to a VTA.

## Agenda

| Time | What |
|---|---|
| 0:00 | Welcome, the Trust Task idea in 10 minutes: document, proof, verifier |
| 0:15 | Setup: `npm ci`, `npm run up` (or `WITH_VTC=1 npm run up`), `npm run hello` (with the images already built or loaded) |
| **0:40** | **Setup gate.** Every team shows the four-line `hello` output. Stragglers may use `MODE=farm` only if the Farm canary passed ([FARM.md](FARM.md)); otherwise a mentor fixes their local setup |
| 0:40 | Build. Pick a track from [TRACKS.md](TRACKS.md); start from a template |
| 1:30 | Check-in: each team states its round-trip status in one sentence |
| 2:30 | Mentors do a verification and replay review with each team |
| 3:00 | Feature freeze. Prepare a 3-minute demo |
| 3:15 | Demos (3 minutes plus 1 for questions) |
| 3:50 | Judging deliberation, awards |

## Staffing

- 1 lead organiser (runs the clock, owns the gate).
- 1 infra mentor per ~15 participants: Docker, image loading, ports, VTA logs.
- 1 protocol mentor per ~15 participants: Trust Task documents, proofs, `consumeInbound`.
- 2 to 3 judges. Give each the rubric below and one hour of demos.

## Judging rubric (100 points)

| Criterion | Points | Look for |
|---|---|---|
| Working Trust Task round trip | 30 | A signed request reaches a verifier or the VTA and a valid response comes back, live in the demo |
| Real VTA feature | 25 | Consent, policy, audit, ACL scopes, or similar, actually used and not just named |
| UX and story | 25 | A user can follow it; a clear problem and a reason trust matters |
| Correct verification and replay handling | 20 | Proof checked, recipient checked, replays not re-executed; tampering shown to fail |

Tie-break: the round-trip score.

## Organiser checklist

**Local mode is the plan; the Farm is an optional shortcut behind a go/no-go gate.** `MODE=tunnel` ([MODES.md](MODES.md)) is not part of the plan for a
room of participants: it puts the stack on public, unauthenticated URLs with an open mediator and needs a heavy local mediator build. Use it for a
single demo or a phone experiment, and take it down afterwards.

### Two weeks before

- [ ] **FIRST: plan the images. Prebuilt images are not available** (the organisation does not allow public GHCR packages, so nobody can pull them), and a Rust release build per laptop is what makes local setup slow:
      plan for 25 to 40 minutes cold for the VTA and again for the VTC on a laptop (about 12 minutes for the mediator, `MODE=tunnel` only). A realistic plan, in order of preference:
      1. **Build once on a fast machine, share the result.** On an organiser's machine: `npm ci && npm run setup` (add `-- --tunnel` for the mediator), then
         `npm run images:export -- buildathon-images.tar` (about 400 MB for the VTA and VTC). Put the tar on USB sticks or a local file share; each participant runs `npm ci`,
         `npm run images:import -- buildathon-images.tar`, `npm run up`. Do the full round trip on a second machine before the event (**the single-image and scratch-image round trips are verified, a full
         three-image import and `up` on another machine is not**). The tar is unsigned: hand it out yourself and say so ([VERIFY.md](VERIFY.md)).
         It must match the participants' CPU: build a second tar on an arm64 machine (Apple silicon) if some bring those; an amd64 tar does not run natively there.
      2. **Participants build in advance.** Send `npm ci && npm run setup` a week ahead ("start it before bed; about 1 hour, needs about 10 GB disk and 8 GB RAM free"). Do not have a room build at once over venue Wi-Fi: each build downloads crates and base images.
      3. **Build at the event** only for a few people, as the last resort. `npm run doctor` tells each person the exact command and time.
- [ ] **Test the plan on a clean laptop with no images:** `npm ci`, `npm run doctor` (it should list the images to build or import), import or build, `npm run pins:check`, `npm run up`, `npm run hello`.
      Build from the pinned refs, not from whatever is checked out: `npm run images:build all` uses VTA `vta-service-v0.72.0`, VTC `vtc-service-v0.15.0` ([VTC.md](VTC.md) for times; tags
      `<image>:<short-sha>` and `:local`). `npm run pins:check` should show no drift on the image refs. Before advancing a pin, re-verify the local VTA + VTC path and the farm note ([PINS.md](PINS.md)).
- [ ] **Later, not now: publishing prebuilt images.** If the organisation ever allows public packages, the workflow in [IMAGES.md](IMAGES.md) (never run, unverified) publishes signed multi-arch images; then set
      `images.available` to `true` in `pins.json`, record the digests, and verify with [VERIFY.md](VERIFY.md). Until then none of that is on the critical path.
- [ ] Locally built images match the builder's CPU only; include an arm64 machine in the clean-laptop check if participants have them.
- [ ] Test the full checkpoint from a clean clone on Linux, macOS and Windows (WSL2).
      Only Linux was tested for this kit.
- [ ] Decide whether to ship `vta-mcp` (Rust, `cargo build --release -p vta-mcp`).
      If not, tell the agent track to use the TypeScript fallback.
- [ ] Pre-warm npm: have a clone and `npm ci` result on the share if Wi-Fi is weak.

### MODE=farm (hosted VTA Farm): optional, gated

**Which Farm.** `FARM=ic3` (https://vtafarm.ic3.dev, staging) is the preferred and default Farm; `FARM=firstperson`
(https://vtafarm.firstperson.dev) currently fails agent creation (`unsupportedVersion: acl/grant/0.2`, confirmed
Farm-side, 2026-10-29). Send participants to the ic3 portal unless the gate says otherwise.
Portal screens on ic3: to be confirmed ([FARM.md](FARM.md)).

**Farm image.** The ic3 portal offers `0.72.0-26d0da81`, the kit's pin (verified 2026-11-08, [FARM.md](FARM.md)); the older `0.65.0-fc157f76` image does not serve the task versions this kit sends.

**Tell every Farm participant which image to pick.** In the portal's image selector choose **`0.72.0-26d0da81`**
(the pinned VTA release). **Do not keep the portal's default** (`VTI-Eucalyptus ... [latest]`, vta-service 0.56.0): it is
not compatible with this kit. `npm run farm:check` / `farm:canary` read the deployed agent's version and print a loud
warning when it is not the pin; a Farm-hosted VTC (vtc-service 0.15.0 when observed) matched the VTC pin.

An optional shortcut, not the plan. Participant steps are in [FARM.md](FARM.md); the kit
mints each team's admin key and prints what to paste.

- [ ] **GO / NO-GO GATE (the day before AND on the day).** Both must pass, or everyone uses
      local mode and nobody is sent to the portal:
      Try **ic3 first, then firstperson, then local mode**.
      1. `npm run farm:probe` (read-only, both Farms side by side; compare with `pins.json`).
      2. The canary: create ONE throwaway agent in the portal with the kit's Admin DID, put `FARM=ic3` and
         `FARM_AGENT=<name>` (or its `VTA_URL` / `VTA_DID`) into `.env.farm`, then `ENV_FILE=.env.farm npm run farm:canary`. Repeat with `FARM=firstperson` only if ic3 fails. It runs
         `farm:check` + `provision` + `hello` and prints GO or "switch to local mode".
         Portal creation can fail before the agent exists (as on 2026-10-29); that is a NO-GO too.
         Procedure and what to record: [FARM.md](FARM.md) "Canary". Delete the canary agent afterwards.

- [ ] **Ask the Farm operators first.** vta.farm is a demo that "may be reset or stop
      accepting new agents when it runs out of space"; accounts are limited to two
      agents. Confirm capacity for your head count (or a dedicated farm) and whether
      sign-up needs an invite. Older docs say invite link, the landing page says open.
- [ ] Agree who gets communities (VTA + VTC): they are "on request" and each is a full
      stack, so budget them for the community track only.
- [ ] Every participant needs a device with passkey support and a browser; sign-up is not
      scriptable. Do this at 0:15, not at the gate.
- [ ] **firstperson.dev: agent creation fails** after the Admin DID step, with both the default and the pinned image
      (`acl/grant/0.2` refused by its DID host; confirmed Farm-side, reproduced by hand 2026-10-29;
      [FARM.md](FARM.md) "Live result"). On ic3.dev a 0.65.0 agent was created by hand and the canary passed
      (2026-10-29). Treat either Farm as unproven until that day's canary passes.
- [ ] Do one dry run yourself: sign up, create an agent with the Admin DID from
      `npm run farm:setup`, then `MODE=farm npm run up` and `npm run hello`.
      **None of this was verified live when the kit was written.**
- [ ] **Run `npm run farm:probe` the day before and again on the day of the event.** It is read-only and prints
      a dated table of the Farm's vta-service / vtc-service versions, CORS and `/trust-tasks` door, compared with
      `pins.json`. The Farm updates almost daily; if a version moved past the pin, read "Compatibility" in
      [FARM.md](FARM.md) before the event, and add a new dated block there. A participant's own agent can differ:
      `npm run farm:check` probes the VTA/VTC in their `.env`.
- [ ] Check the farm's VTA image serves `POST /trust-tasks` with the task versions this kit sends (a dry run of
      `provision` shows it; the probe only proves the path exists).
- [ ] Browser apps: the farm VTA does not allow `http://localhost:5173` in CORS. The
      templates proxy through Vite in farm mode; ask the operators to add your origin
      if teams deploy elsewhere.
- [ ] Hosted VTC admin (approving join requests) is a passkey flow in the VTC console,
      not scriptable; assign a mentor as community admin.

### Local VTC (optional; verified locally, cold build ~23 min)

- [ ] A VTC needs its own image: `npm run images:build vtc` (`docker/vtc.Dockerfile`, see
      [VTC.md](VTC.md)). Build it once from the pinned ref, as for the VTA, only if a track needs a community and Farm communities are
      not available. Build it with features `setup,website,tsp` (already the default). Dry-run
      `WITH_VTC=1 npm run up && npm run vtc:hello && npm run vtc:join && npm run vtc:approve` before the event.

### Day of

- [ ] Farm gate again (probe + canary) if any Farm use is planned; any failure means local mode for everyone.
- [ ] Ports 8100 and 8200 (the stack), 5173, 3000 and 4000 (the templates and the inbox verifier) free on laptops (tunnel mode also uses 7037 and needs `cloudflared`); Docker running before 0:15.
- [ ] Projector, a timer, the rubric printed.
- [ ] A mentor on each gate failure: log the symptom and the fix for next time.
- [ ] After: `npm run reset` is all a participant needs to wipe their local state.
