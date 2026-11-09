# Inbox verifier

A Node server that accepts signed Trust Task documents and applies the SPEC
section 7.2 consumer checks: type dispatch, recipient, freshness, Data Integrity
proof, payload schema, and duplicate-execution (replay) protection. **Runs offline:**
a `did:key` carries its own public key, so no VTA, resolver or network is needed.

```sh
npm run demo -w @starter/inbox-verifier     # self-contained end-to-end run

npm start -w @starter/inbox-verifier        # server on :4000
npm run send -w @starter/inbox-verifier -- --replay   # second terminal
npm run send -w @starter/inbox-verifier -- --tamper
```

`demo` starts the server and checks six cases: a good note is accepted, the
same note replayed does not run twice, a tampered payload is `proofInvalid`, a
misaddressed document is `wrongRecipient`, a malformed payload is `malformedRequest`,
and a signed document of another type (a forged `#response`) is `unsupportedType`.

## Files

| File | |
|---|---|
| `src/inbox.ts` | The task (`NOTE_SPEC`), the payload check and `consumeInbound` call. Start here. |
| `src/server.ts` | `POST /inbox`, `GET /notes`, `GET /did`. Not the HTTPS binding (whose path is `/trust-tasks`), but its status table: 400 `malformedRequest`, 403, 409 `idConflict`, 422 for the rest, 204 with no body for a duplicate with no kept response; the code in the error document is what counts |
| `src/send.ts` | Build, sign and POST a note |

## Make it yours

- **Your own task.** `NOTE_TYPE` is a made-up URI. Change the payload type and
  schema, or pin a registry task and generate typed modules with
  `trust-tasks` / `@openvtc/trust-tasks-gen` (see `GETTING-STARTED.md` in
  dtgwg-trust-tasks-tf) and use its `SPEC`.
- **Consequential tasks need the replay guard.** `consequentialChecks(guard)`
  makes a replayed document a `duplicate`. `InMemoryReplayGuard` is per process
  and forgets on restart; use a shared store for replicas. Use
  `notConsequentialChecks()` only for tasks that are safe to repeat.
- **Send as your VTA app.** In `send.ts`, replace `newIdentity()` with
  `identityFromCredential(decodeCredential(process.env.VTA_CREDENTIAL!))`.
  Then check the sender against your VTA ACL in the handler for real authorization.
- **Authenticated transports.** Behind a gateway that authenticates the caller,
  use `StaticTransport({ issuer })` so the in-band `issuer` is cross-checked
  (SPEC 4.8.1).
- **Schema validation.** `validateNote` is hand-rolled. Use ajv with the task's
  `payload.schema.json` for anything bigger.
- **Type dispatch (SPEC 7.2 item 3) happens first**, in `receive()`, because
  `consumeInbound` does not compare `doc.type` with the spec. `typeRefusal()`
  lets through a request of `NOTE_TYPE` in either form (bare or `#request`) and
  refuses everything else with an error document: a `#response`, a
  `trust-task-error`, another task (`unsupportedType`), or the note at another
  version (`unsupportedVersion`). Serving several tasks? Route on `doc.type`
  (fragment preserved) to one `consumeInbound` per task.
