# 3. Using tasks

Two directions: **calling** a task on a VTA or VTC, and **consuming** a signed document someone sends you.
Marks: **[run]** executed, **[src]** read from source, **[untested]**, **[draft]**
([legend](README.md#legend-how-each-claim-was-checked)). Every TypeScript block below was typechecked against this
workspace **[run]** (`tsc --strict`, Bundler resolution, packages as pinned in `package.json`); they were not run against
a live VTA or VTC. The clients' own tests (mocked `fetch`) pass in the starter.

## Calling a task

### The short way: the clients

```ts
import { TASK, VtaClient, decodeCredential, identityFromCredential } from "@starter/vta-client";
import { VtcClient } from "@starter/vtc-client";
import { refusalOf } from "./refusal.js";

const vta = await VtaClient.fromCredential(process.env.VTA_CREDENTIAL!);   // base64url bundle from `npm run vta:provision`
await vta.authenticate();                                                    // bearer for authenticated tasks, ~15 min
const served = await vta.discover();
console.log(served.includes(TASK.whoami), served.length);

try {
  await vta.call("https://trusttasks.org/spec/acl/list/0.3", {});            // an admin-only task
} catch (e) {
  if (refusalOf(e)?.code === "permissionDenied") console.log("this signer is not an admin");
  else throw e;
}

const me = identityFromCredential(decodeCredential(process.env.VTA_CREDENTIAL!));
const vtc = await VtcClient.connect("http://localhost:8200", me);            // no bearer: the signature is the auth
console.log((await vtc.manifest()).communityDid);
```

- `VtaClient.call(type, payload)` signs and POSTs `{baseUrl}/trust-tasks`. `VtcClient.call` posts to
  `{baseUrl}/v1/trust-tasks` (no bearer). Both set `id`, `issuer`, `recipient`, `issuedAt` for you, return the payload
  only of a reply typed `<request type>#response`, throw `TrustTaskError` for a `trust-task-error` (or any reply that is
  not this task's response), and throw `TrustTaskPending` for a `trust-task-next-step` or an empty `202` **[src]**
  ([01 Concepts](01-concepts.md#how-the-starter-sends-one) has the table).
- `call` returns the **response payload** only. If you need the whole response document (`threadId`, `issuedAt`, proof),
  use `send(build(type, payload))`, which returns the classified reply with its `document`, or catch the error's `body`.
- The type string is the version you speak. `TASK` in `vta-client` and `VTC_TASK` in `vtc-client` list the ones the
  starter uses; any other Type URI works with `call()`, as above.
- An empty payload `{}` is legal for many tasks, including some that **act** (`members/self-remove`,
  `join-requests/withdraw`). Never call a task you have not read with `{}` (`docs/VTC.md`).

### Building and signing by hand

```ts
import { signTrustTask } from "@openvtc/trust-tasks-proof";
import { newIdentity } from "@starter/vta-client";

const me = newIdentity();                       // a did:key; see identityFromCredential for a provisioned app
const recipient = "<recipient-did>";            // the consumer's DID

// Set issuer, recipient and issuedAt BEFORE signing: the proof covers what exists at signing time.
const signed = signTrustTask(
  {
    id: crypto.randomUUID(),
    type: "https://example.org/spec/buildathon/note/0.1",
    issuer: me.did,
    recipient,
    issuedAt: new Date().toISOString(),
    payload: { title: "hello", body: "world" },
  } as any,                                      // the signer takes a loosely typed document
  me.signer,
);
console.log(signed.proof);
```

Rules, all enforced by the proof package **[src]**: `issuer` must be the signer's own `did:key` (no `#fragment`);
`signTrustTask` replaces any existing `proof`; the suite is `eddsa-jcs-2022` for Ed25519 keys. To send as your
provisioned app instead of a fresh key: `identityFromCredential(decodeCredential(process.env.VTA_CREDENTIAL!))`.

Typed payloads: `@openvtc/trust-tasks` ships generated types (for example `AclGrant_v0_2.Payload`). Its prebuilt modules
are **deprecated** upstream in favour of generating only the tasks you pin (below); the framework ones
(`TrustTaskError_v0_6`, `TrustTaskDiscovery_v0_3`) stay **[src]**.

### Handling refusals

An error document looks like this (from SPEC 8.2, shape verified against the VTA error quoted in `docs/FARM.md`):

```json
{ "type": "https://trusttasks.org/spec/trust-task-error/0.5", "threadId": "<request id or thread>",
  "issuer": "<responder-did>", "recipient": "<your-did>",
  "payload": { "code": "unsupportedVersion", "message": "...", "retryable": false } }
```

```ts
import { TrustTaskError, unwrapReply, type VtaClient } from "@starter/vta-client";

/** What a refusal looks like once the client has thrown it. */
export interface Refusal {
  httpStatus: number;
  code: string;            // SPEC 8.3 standard code, or a task-specific "<slug>:<local>" code
  message?: string;
  retryable?: boolean;
  retryAfter?: string;
  details?: unknown;
}

export function refusalOf(e: unknown): Refusal | undefined {
  if (!(e instanceof TrustTaskError)) return undefined;
  const p = (e.body as any)?.payload ?? {};
  return {
    httpStatus: e.status,
    code: String(p.code ?? "unknown"),
    message: p.message,
    retryable: p.retryable,
    retryAfter: p.retryAfter,
    details: p.details,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A retry in the SPEC 8.4 sense: re-send the SAME signed document (same id, same proof) while the refusal says it is
 * retryable. Safe for a consequential write: the consumer absorbs a duplicate (7.2 item 11), and its answer to one
 * (the kept response, or an empty 202/204) is not an error.
 */
export async function sendWithRetry<R>(vta: VtaClient, doc: Record<string, unknown>, attempts = 3): Promise<R> {
  for (let i = 1; ; i++) {
    try {
      return unwrapReply<R>(await vta.send(doc)); // vta.build(type, payload) made `doc`; keep it
    } catch (e) {
      const r = refusalOf(e);
      if (!r?.retryable || i >= attempts) throw e;
      const wait = r.retryAfter ? Date.parse(r.retryAfter) - Date.now() : 500 * 2 ** i;
      await sleep(Math.min(Math.max(wait, 0), 10_000));
    }
  }
}

/** Newest version first; fall back only on a version refusal (mirrors vtc-client's list helpers). */
export async function callNewestSupported<R>(vta: VtaClient, versions: string[], payload: Record<string, unknown>): Promise<R> {
  let last: unknown;
  for (const type of versions) {
    try {
      return await vta.call<R>(type, payload);
    } catch (e) {
      const code = refusalOf(e)?.code;
      if (code !== "unsupportedVersion" && code !== "unsupportedType") throw e;
      last = e;
    }
  }
  throw last;
}
```

How to react (SPEC 8.3, 8.4):

| `code` | Meaning | You should |
|---|---|---|
| `unsupportedVersion` / `unsupportedType` | Server does not serve that version/slug | Discover what it serves; fall back to another version of the *same MAJOR* only if your payload is valid for it |
| `permissionDenied` | Your signer is not allowed (ACL role, context scope) | Fix the grant. Retrying never helps |
| `proofInvalid` / `proofRequired` | Bad or missing signature | Check you set `issuer`/`recipient`/`issuedAt` before signing |
| `wrongRecipient` | `recipient` is not that server's DID | Re-read the server DID; a farm VTA or VTC has its own |
| `malformedRequest` | Fails the framework or payload schema (also: future `issuedAt`) | Validate against `payload.schema.json` first |
| `expired` | `expiresAt` passed, or the document is older than the server's window | Send a **new** document with a fresh `id` |
| `unavailable`, `internalError` (`retryable: true`) | Transient | Retry with backoff; honour `retryAfter` |
| `idConflict` | Same `id`, different content | You reused an id; mint a new one |
| `<slug>:<local>` | Task-specific, `details` has the shape | Read the spec's `errorCodes` |

"Retry" means re-sending the *same bytes* (same `id`, same proof). For a consequential task that is safe, because the
consumer must absorb the duplicate (7.2 item 11). Use `sendWithRetry(vta, vta.build(type, payload))` for that. Calling
`vta.call` again is **not** a retry: it mints a new `id`, so a write that did run the first time (you just never saw the
answer) runs again. That "reissue" is fine for a read; for a write, re-send the same document or check the state first,
and never reissue a write blindly after a timeout.

HTTP status is secondary: the starter saw 400 and 422 for refusals and 401/403 for sessions and roles; decide on the
reply's `type` and then `payload.code`, not the status **[src]** (`docs/FARM.md`, `README.md`). Match `code` exactly;
never pattern-match `message`, which is free text (SPEC 8.2.1).

### Version tolerance

- Send the version your server serves (discovery, [02](02-finding-tasks.md)). `callNewestSupported` above tries a list
  newest first and falls back only on `unsupportedVersion`/`unsupportedType`; `vtc-client` does the same for list tasks.
- Within one MAJOR, a response from a newer MINOR may carry members you do not know. Ignore them; do not fail.
  Pass documents through `readForSpec` (below) when you consume.
- A new MAJOR is a different task: new payload, new code. Pin it deliberately.

### Rate limits

Servers throttle per caller. Observed on a local VTC 0.15.0 (`docs/VTC-SURFACE.md`, source and live): a signer with
no ACL entry shares one per-address budget (burst 10, then about one document per 5 s); a known signer gets its own
(burst 60, then one per 500 ms). The VTA rate-limits auth per IP (`README.md`: burst 60). A throttled call is HTTP 429
or an `unavailable`-style refusal. Do not loop on `authenticate()`; cache the token (about 15 minutes) and reuse it.

## Consuming a task

If you *receive* documents, you are the consumer and SPEC 7.2 applies to you. `@openvtc/trust-tasks/runtime` implements
the checks; `templates/inbox-verifier` is the worked example (`src/inbox.ts`, offline).

```sh
npm run demo -w @starter/inbox-verifier
```

`demo` starts the server and checks six cases: accepted once, replay not re-run, tampered payload `proofInvalid`,
wrong recipient `wrongRecipient`, bad payload `malformedRequest`, a signed document of another type (a forged
`#response`) `unsupportedType` **[run]** (the first five also run for the "note" walkthrough copy in
[04](04-developing-tasks.md)).

What `consumeInbound` does, in order **[src]** (package README):

| SPEC 7.2 item | Check | In `consumeInbound`? |
|---|---|---|
| 1 | Framework document schema | No: your parse |
| 3 | Unknown `type` | No: **you dispatch on `doc.type` first** (below; the template's `typeRefusal()`) |
| 2 | Payload against the spec schema | Yes, via your `payloadPolicy` validator |
| 4, 13 | `expiresAt`, future `issuedAt`, max age | Yes (`checks`) |
| 5, 8 | Wrong or missing `recipient`; proof without `recipient` | Yes |
| 6 | In-band `issuer`/`recipient` vs transport identity | Yes (`transport`) |
| 7 | Proof verification, proof-required | Yes (`proofPolicy`) |
| 11 | Duplicate execution (replay guard keyed on `id`) | Yes (`consequentialChecks(guard)`) |
| 10 | Proof is not permission | **No: your handler authorizes** |
| 12 | Re-check authority before each irreversible effect | **No: your handler** |

```ts
import { createServer } from "node:http";
import {
  InMemoryReplayGuard, UnauthenticatedTransport, consequentialChecks, consumeInbound, refuse, respondWith,
  type SpecPolicy, type TrustTaskDocument,
} from "@openvtc/trust-tasks/runtime";
import { DataIntegrityProofVerifier } from "@openvtc/trust-tasks-proof";

const MY_DID = "<your-did>";
const TYPE = "https://example.org/spec/buildathon/note/0.1";
const schema = { type: "object", required: ["title"], properties: { title: { type: "string", minLength: 1 } } };
const spec: SpecPolicy = { typeUri: TYPE, isBearer: false, isProofRequired: true, isRecipientRequired: true, isIssuedAtRequired: true, payloadSchema: schema };
const guard = new InMemoryReplayGuard();
// 7.2 item 2: validate the payload. Hand-rolled here; with ajv: ({ ok: ajv.validate(s, p), errors: [...] }).
const validator = { validate: (_s: unknown, p: any) => ({ ok: typeof p?.title === "string" && p.title !== "", errors: ["title: required string"] }) };
const reply = (res: any, status: number, body?: unknown) =>
  body === undefined ? res.writeHead(status).end() : res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

createServer(async (req, res) => {
  let raw = ""; for await (const c of req) raw += c;
  const doc = JSON.parse(raw) as TrustTaskDocument<{ title: string }>;
  // Item 3: dispatch first. A request is the bare URI OR its #request form (4.4.1 rule 1: accept both). Never strip or
  // ignore a #response fragment: a signed #response or a trust-task-error sent to you is not a request.
  if (doc.type !== TYPE && doc.type !== `${TYPE}#request`) {
    const why = { code: "unsupportedType" as const, message: `this endpoint serves ${TYPE}`, retryable: false };
    return reply(res, 422, refuse(doc, crypto.randomUUID(), why));
  }
  const out = await consumeInbound({
    transport: new UnauthenticatedTransport(),
    spec,
    proofPolicy: { kind: "verify", verify: new DataIntegrityProofVerifier() },
    payloadPolicy: { kind: "validate", validate: validator },
    checks: consequentialChecks(guard),
    doc, myVid: MY_DID, now: Date.now(), newErrorId: () => crypto.randomUUID(),
    handler: (accepted) => respondWith(accepted, crypto.randomUUID(), { ok: true }),
  });
  // Answer with the document, never with the outcome's name.
  if (out.kind === "handled") return reply(res, 200, out.response);
  if (out.kind === "rejected") return reply(res, (out.error as any).payload.code === "malformedRequest" ? 400 : 422, out.error);
  if (out.kind === "duplicate") return out.priorResponse ? reply(res, 200, out.priorResponse) : reply(res, out.inFlight ? 202 : 204);
  return reply(res, out.kind === "accepted" ? 204 : 400); // accepted: fire-and-forget; suppressed: say nothing (8.1)
});
```

Decisions that are yours:

- **Dispatch.** Accept the bare Type URI you implement or its `#request` form, before `consumeInbound` (which does not
  compare `type` itself). Reject the rest with an error document: `unsupportedType`, or `unsupportedVersion` for a known
  slug at another version. Keep fragments when you key or route on `type` (4.4.1 rule 5). The inbox-verifier's
  `typeRefusal()` and vta-client's `isRequestOf()` do this.
- **Transport.** `UnauthenticatedTransport` means identity is the proof's `did:key`. Behind a gateway that authenticated
  the caller use `StaticTransport({ issuer })` so a mismatch is `identityMismatch` (7.2 item 6).
- **Proof policy.** `verify` (honour proofs), `rejectIfPresent`, or `acceptUnverified` (only if the transport gives the same
  guarantee). A spec that requires a proof rejects a proofless document under all three.
- **Checks.** `consequentialChecks(guard)` for anything that changes state, moves value or discloses data;
  `notConsequentialChecks()` only for safe-to-repeat tasks. `InMemoryReplayGuard` forgets on restart and is per process:
  use a shared store for replicas, and keep records for as long as you accept the document (7.2 "Bounding the record").
- **Audience binding.** A signed document must name its `recipient`; the consumer rejects one that names someone else.
  This is what stops a document signed for service A being replayed at service B (SPEC 12.1). Compare against **your own**
  DID, never a value from the document.
- **Outcomes.** `handled` (send the response), `rejected` (send the prepared error), `duplicate` (return the prior
  response, not an error), `suppressed` (say nothing: answering would be an oracle, SPEC 8.1; still log it), `accepted`
  (fire-and-forget, emit nothing).
- **Authorization** is a separate decision in your handler. In the starter's design that means checking the issuer
  against your VTA ACL; a valid signature from any stranger is still a valid signature.
- **Later MINORs.** `readForSpec(parsed, X.SPEC)` lets a consumer of `x/0.2` accept `x/0.3` when `0.3` declares `extends`.
  Pass `read.doc` to `consumeInbound`, not a copy.

## Generating types and pinning tasks (Rust CLI + `@openvtc/trust-tasks-gen`)

Not shipped in this starter. Documented upstream (`GETTING-STARTED.md`, `trust-tasks-cli/README.md`) **[untested]**
here: the `trust-tasks` binary is not installed in the starter and was not built.

```sh
cargo install trust-tasks-cli                  # installs the `trust-tasks` binary
trust-tasks add acl/grant/0.2                  # writes trust-tasks.toml, trust-tasks.lock, trust-tasks/ (commit all three)
npm install @openvtc/trust-tasks && npm install -D @openvtc/trust-tasks-gen
trust-tasks generate --lang ts --out src/trust-tasks   # runs `check`, then npx trust-tasks-gen-ts
trust-tasks check                              # offline lock verification, for CI
trust-tasks list --remote                      # pinned versions and whether a newer one extends or breaks
```

`npm view @openvtc/trust-tasks-gen` reports version 0.1.2 with one bin, `trust-tasks-gen-ts` **[run]**. Generated modules
export `SPEC` (the per-task declarations `consumeInbound` needs: proof required, recipient required, schema) so you
do not hand-write a `SpecPolicy` as the inbox-verifier does. You can pin your own tasks under another authority in
`trust-tasks.toml` (`[sources.<name>]`, then `<name>:<slug>`), which is the upstream route for private specs.

Other upstream reading: `examples/consumer-app-ts` (a minimal pinned project) and `fixtures/proof/` (signed documents
every library's verifier must accept or reject) in the spec repo **[src]**.
