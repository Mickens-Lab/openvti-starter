# Running the VTA and VTC as host binaries

By default the kit runs the VTA and VTC in Docker. If you already have the `vta` and `vtc` programs, `RUNTIME=binary` runs them
directly on your machine instead: no Docker, no image build. Docker stays the default and is unchanged when this is not selected.
Back to the [docs index](README.md).

## Turn it on

Put these lines in your env file (`.env`, or the file named by `ENV_FILE`):

```
RUNTIME=binary
VTI_BIN_DIR=<folder that contains vta and vtc>
```

Then use the usual commands: `npm run up`, `npm run down`, `npm run reset`, `npm run vtc:up`, `npm run doctor`.

| Variable | Meaning |
|---|---|
| `RUNTIME` | `docker` (default) or `binary`. |
| `VTI_BIN_DIR` | Folder holding `vta` (and `vtc` when the community is on). **No default**: if it is unset, missing or lacks the program, the command stops and names the variable. |
| `VTA_BIN`, `VTC_BIN` | Optional full paths that override the program found in `VTI_BIN_DIR`. |
| `VTI_ALLOW_VERSION_MISMATCH` | `1` lets a binary whose version is not the pinned one run anyway, with a warning (see below). Unset by default. |

The other settings (`VTA_PORT`, `VTC_PORT`, `VTC_CONTEXT`, `CORS_ORIGINS_TOML`, `VTC_CORS_ORIGINS_TOML`, `APPROVER_DID`, `WITH_VTC`) work as they do with Docker.

## What it does

- `up` makes the admin key, runs `vta setup --from` on the first run, starts the VTA detached, waits for `/health` and
  `/.well-known/did.jsonl` (the same two checks as the compose health check), then provisions as usual.
  The VTC (on by default; `WITH_VTC=0` leaves it out) is set up the way `vtc-entrypoint.sh` does it: mint a setup key, grant it at the
  VTA, run `vtc setup --from`, fill in CORS, add the admin to the ACL, then serve.
- State lives in `.vta/run/` (config, data, `*.pid`, `*.log`), which is git-ignored.
- `down` stops both processes and keeps `.vta/run/`; the next `up` resumes. `reset` stops them, deletes `.vta/` and the kit's keys in the
  env file, so the next `up` provisions a new VTA.
- Logs: `npm run vta:logs` and `npm run vtc:logs` follow `.vta/run/vta.log` and `.vta/run/vtc.log`.
- `npm run doctor` checks the binaries instead of Docker and images. The VTA binds to 127.0.0.1 (the container binds all interfaces).

## Limits

- **No `MODE=tunnel`.** It needs a mediator and `cloudflared`, which exist only as a Docker image; `RUNTIME=binary` with `--tunnel` is refused with a message. `MODE=farm` does not run anything locally, so the runtime does not matter there.
- Local mode only: a loopback DID, REST only, no messaging.
- **Versions must match the pins.** [pins.json](../pins.json) records the versions the kit was verified with (`vta-service-v<x.y.z>`, `vtc-service-v<x.y.z>`; see [PINS.md](PINS.md)). Before it starts anything, the kit runs `<binary> --version` (5 s limit) and requires the exact pinned version. A different version, or a version it cannot run or read, stops `npm run up` and `npm run vtc:up` and fails `npm run doctor`, with the binary path, the version found, the pinned version and the fix: use matching binaries, or update the pins deliberately. `doctor` shows a version line per binary either way.
- To run a different version anyway, set `VTI_ALLOW_VERSION_MISMATCH=1` in the env file. The failure becomes a loud warning; expect problems such as Trust Tasks refused with `unsupportedVersion` or a `setup` that rejects the config.
- The setup files are rendered by `scripts/lib/binary.ts`; `scripts/test/binary.test.ts` keeps them equal to the heredocs in `vta-entrypoint.sh` and `vtc-entrypoint.sh`.
