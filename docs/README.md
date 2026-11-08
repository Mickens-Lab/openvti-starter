# Docs index

Back to the [repo README](../README.md). Everything here is for a local playground; read [SECURITY.md](SECURITY.md) first.

## Start here

- [TRY-THIS.md](TRY-THIS.md): guided exercises, easy to advanced, with expected output.
- [TRACKS.md](TRACKS.md): project ideas and which template fits each.
- [EVENT.md](EVENT.md): checklist for organisers running a build day.

## Concepts

- [trust-tasks/README.md](trust-tasks/README.md): what Trust Tasks are, how to find, use, develop and evaluate them (six short chapters plus templates).
- [VTC.md](VTC.md): the community (VTC) side: join, approve, the sessionless member.
- [ARCHITECTURE.md](ARCHITECTURE.md): code tour, what talks to what, how identities are made, how to extend.

## Operate

- [STATUS.md](STATUS.md): what works in which mode, and what was and was not verified.
- [MODES.md](MODES.md): local, tunnel (messaging on public quick tunnels) and farm: what each gives, caveats, switching, troubleshooting.
- [FARM.md](FARM.md): the hosted VTA Farm mode, canary and troubleshooting.
- [PINS.md](PINS.md): pinned versions, building the images, drift checks (and [PINS_LOG.md](../PINS_LOG.md)).
- [VERIFY.md](VERIFY.md): how to check what you run (digest, signature, SBOM, labels, building yourself and comparing), and what that does and does not prove.
- [IMAGES.md](IMAGES.md): building the images locally (the default; prebuilt images are not yet available), sharing them with `docker save`/`load`, and how publishing would work later.

## Reference

- [CHEATSHEET.md](CHEATSHEET.md): endpoints, task names, env vars, common errors.
- [VTC-SURFACE.md](VTC-SURFACE.md): who can call which VTC task (stranger, applicant, member, admin).
- [ROOMS.md](ROOMS.md): read and post to a data room from the command line or an app; the open-room walkthrough (live), and why sealed rooms are blocked.
- [APPROVALS.md](APPROVALS.md): approve a gated task on a second device (a software approver first): `npm run approvals:demo`.
- [MOBILE-WALLET.md](MOBILE-WALLET.md): what a phone wallet could add, what was and was not checked.
- [MESSAGING.md](MESSAGING.md): what messaging gives in tunnel mode, the TSP ping client, and where it stops (the ping and its pong, and the credential frames, are verified; DIDComm is not).
- [ROLES.md](ROLES.md): roles lab: personas, separation of duties, lifecycle, strict mode (`npm run roles:matrix`).
- [trust-tasks/06-troubleshooting-and-glossary.md](trust-tasks/06-troubleshooting-and-glossary.md): error causes and a glossary.

## Security

- [SECURITY.md](SECURITY.md): where every secret lives, what not to do, a hardening ladder, `npm run security:check` and a checklist.
