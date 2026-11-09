# All commands

Part of the [docs index](README.md). Every root `npm run` script, grouped by who needs it. Any script prints its own usage with `--help`
(`npm run hello -- --help`). The groups are a naming convention in this page rather than a prefix in the script names, so older notes and
muscle memory keep working; a test fails if a script is missing from this page.

## Everyday (hour one)

| Command | Does |
|---|---|
| `npm run setup` | Build the images your mode needs and that are not built yet (local: VTA + VTC; `-- --tunnel` adds the mediator; `-- --no-vtc` leaves the VTC out). Prints a time estimate, warns about low memory, reports the time each took. Prebuilt images are not available yet, so this is the first command on a new machine |
| `npm run doctor` | Is this machine ready: Node, Docker, memory, ports, images (a missing one: the exact local build command first, with its time), VTI checkout, mode. `up` runs the blocking checks first |
| `npm run up` | Start the stack for the current mode (keys, VTA, optional VTC, an app context and credential in `.env`) |
| `npm run down` | Stop it and keep the data (tunnel mode: also deletes its volumes, which cannot be reused) |
| `npm run reset` | Stop everything (tunnels too), delete volumes and `.vta/`, remove the keys the kit wrote to `.env`. Works in every mode; lines you added to `.env` stay |
| `npm run hello` | The checkpoint: discover, authenticate, one signed call |
| `npm run new -- my-app --from hello-web\|hello-node` | Copy a minimal template to `apps/my-app` (git-ignored) and install it; prints the command that runs it. `npm run new` lists the starting points |
| `npm run vta:call -- <task> [json]` | Call any Trust Task as your app identity (no argument lists them; invalid JSON is reported, not a stack trace) |
| `npm run vta:call -- --search memory` / `--schema vta/memory/put/0.1` | Only the tasks whose name contains a word / a task's request and response fields (offline, from the bindings in `node_modules`) |
| `TRACE=1 <command>` then `npm run trace` | Record every client call (VTA and VTC REST, TSP ping) to `.vta/trace.jsonl`, then show them one per line: time, client, task, outcome, ms, who to whom, id. `-- --follow` keeps printing, `--json` for raw, `--clear` deletes. Payloads and keys are never logged |
| `npm run repl` | A Node REPL with `vta` (authenticated), `vtc`, `call(slug, payload)`, `tasks(words)` and top-level await |
| `npm run vtc:hello` / `vtc:join` / `vtc:approve` / `vtc:status` | Community: read the join manifest / apply / admin approves / where do I stand |
| `npm run rooms:status` | Data rooms: membership, offers, and the one command to run next ([ROOMS.md](ROOMS.md)) |
| `npm run rooms:list` / `rooms:accept -- <room DID>` | Data rooms: the offers and held rooms / join from an offer (open: the accept; sealed, as a persona: stores the room's credentials in the VTA, then key-package, accept, welcome; safe to repeat) |
| `npm run rooms:note -- <room DID> "Title" "body"` (`--id <note id>` saves a new version) / `rooms:upload -- <room DID> <file>` / `rooms:search -- <room DID> "words"` (`--names` for file names) / `rooms:download -- <room DID> <item id> [out]` | Data rooms: notes, files, search, and a download whose SHA-256 is checked. Sealed rooms take files up to 32 KiB; add `--app` to act as the app `did:key` when `ROOM_PERSONA` is set ([ROOMS.md](ROOMS.md)) |
| `npm run rooms:info -- <room DID>` / `rooms:post -- <room DID> "text"` (`--name`, `--avatar <image>`) / `rooms:read -- <room DID>` | Data rooms: tier, epoch and limits / post a chat message (`--markdown`, `--name`) and read it back / print the history (`--follow` keeps watching). `ROOM_ID` in `.env` replaces the argument |
| `npm run rooms:persona -- setup` (or `create`\|`use <did>`\|`join`\|`status`) | Sealed rooms need a persona DID the VTA holds: `setup` mints one (admin key) and applies to the community as it. Saves `ROOM_PERSONA`, which every `rooms:*` command then acts as ([ROOMS.md](ROOMS.md)) |
| `npm run tsp:ping` / `tsp:listen` | `MODE=tunnel`: TSP ping and pong / receive the credential frames the VTC pushes |
| `npm run tsp:peer-push` | `MODE=tunnel`, live check: the default `did:peer:2` applicant receives its credential over TSP with no ping first (listener, join, approve, status; ignores `VTC_APPLICANT=did:key` in `.env`; docs/MESSAGING.md) |

## Community (VTC), more

`vtc:profile` (what a member can read), `vtc:withdraw` (withdraw the open request), `vtc:leave -- --yes`, `vtc:refusals` (the same calls as a stranger and as you).

## Roles, approvals, security

`roles:matrix`, `roles:personas -- create <name> <role>` ([ROLES.md](ROLES.md)); `approvals:setup`, `approvals:demo`, `approver` ([APPROVALS.md](APPROVALS.md));
`security:check`, `recipe:backend-signer`, `recipe:webcrypto-key` ([SECURITY.md](SECURITY.md)).

## Plumbing (called by `up`, rarely by hand)

`vta:keygen` (mint the admin key), `vta:provision -- <context>` (a new context and app identity; `ENV_FILE=.env.x` keeps several), `vtc:up` (VTC hand-off),
`vta:logs` (follow the VTA log), `tunnel:probe` (re-run the tunnel checks).

## Organiser

`images:pull [vta|vtc|mediator|all]` (explains that prebuilt images are not yet available; [IMAGES.md](IMAGES.md)), `images:build [vta|vtc|mediator|all|needed]`, `images:export` / `images:import -- file.tar` (share the images you built with another machine, no registry; [IMAGES.md](IMAGES.md)), `images:verify [vta|vtc|mediator|all]` (`-- --local` for your own build) and `images:compare` ([VERIFY.md](VERIFY.md)), `pins:check` ([PINS.md](PINS.md)); `farm:setup`, `farm:check`, `farm:probe`, `farm:canary` ([FARM.md](FARM.md), [EVENT.md](EVENT.md)).

## Maintainer

`typecheck`, `test`, `check:generic` (`-- --history` also scans commits; without a `.git` folder, such as a ZIP download, it scans the files and skips the history), `check:docs`, and the live tests `test:roles`, `e2e`, `tsp:ping:browser`
(need a running stack and, for the last two, Chromium; not part of `npm test`).

## Old names (aliases)

`vta:up` is `up`, `vta:down` is `down`, `vta:reset` is `reset`.
