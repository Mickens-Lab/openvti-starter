# 4. Developing tasks

Authoring a Trust Task: when to, what files, what the build checks, how to open the PR, then a hands-on private "note"
task wired into a handler and a test. Marks: **[run]** executed, **[src]** read from source, **[untested]**,
**[draft]** ([legend](README.md#legend-how-each-claim-was-checked)).

## Decide first: private, extend, or propose

| Situation | Do |
|---|---|
| Only your app and server use it | **Private task** under your own authority (`https://example.org/spec/...`). No review needed. Walkthrough below. |
| A registry task fits but lacks one optional member | Propose a new **MINOR** of that slug upstream; declare `extends` so older consumers keep working. Or use the spec's `ext` slot with your reverse-DNS namespace if it has one. |
| The meaning or required members differ | New **MAJOR**, or a new slug |
| Others would reuse it (a VTA/VTC feature, a community ceremony) | **Propose** upstream: PR to `specs/<slug>/<version>/` in <https://github.com/trustoverip/dtgwg-trust-tasks-tf> |

Search first ([02](02-finding-tasks.md)): most needs already have a task.

## The files

```
specs/<slug>/<MAJOR.MINOR>/
  spec.md                        required   YAML front matter + prose + example documents
  payload.schema.json            required   JSON Schema 2020-12 for the payload (and $defs.Response)
  payload.invalid-examples.json  optional   payloads the schema MUST reject (worth writing)
  context.jsonld                 optional   only if jsonLdContext: true
```

The folder path is the slug, verbatim (`acl/grant` is `specs/acl/grant/0.1/`). `spec.md` and `payload.schema.json`
must both exist or the build fails **[src]** (`CONTRIBUTING-SPECS.md`). Shared definitions go in `specs/<family>/_shared/`,
not inline.

### Front matter

Required by `specs/spec.meta.schema.json` **[src]**: `slug`, `version`, `title`, `summary`, `status`
(`draft`|`candidate`|`standard`|`retired`|`withdrawn`), `targetFrameworkVersion`, `category`, `parties`,
`proofRequirement`, `sideEffects`, `exposure`. Also required in effect: `issuedAtRequirement: REQUIRED` for any
`mutating`/`destructive` task (the build rejects weaker). Optional: `keywords`, `authors` (derived if omitted), `retention`,
`errorCodes`, `related`, `extends`, `supersededBy`, `bearer`, `carries`, `maxDocumentBytes`, `outcomeEvidence`,
`knownImplementations`, `jsonLdContext`, `subjectPath`, `consequences`.

`category` is one of: `access-control`, `ai-agents`, `authentication`, `chat`, `consent`, `credentials`, `data-exchange`,
`did-management`, `framework`, `governance`, `identity`, `key-management`, `messaging`, `notifications`, `payments`,
`provenance`, `reputation`.

Prose sections the scaffold creates: Abstract, Status, Conformance, **Authorization** (consequential tasks: name the
authority, not "verify then execute"), Definitions, Request, Response, and **Security & Privacy** with four sub-headings
(Data carried, Correlation, Retention, Consent/purpose). Keep every example a complete, valid document.

### `payload.schema.json` conventions **[src]**

- `$schema`: `https://json-schema.org/draft/2020-12/schema`; `$id`: the Type URI without fragment.
- `"additionalProperties": false` (or `unevaluatedProperties`) on every object, so unknown members are rejected.
- The success payload lives at `$defs.Response` with `"$anchor": "response"`. No `$defs.Response` means
  fire-and-forget: no `#response` document is defined.
- Free text must declare `maxLength` and the spec must say who reads it, whether it is retained and that it is untrusted
  (SPEC 7.3 item 19). Prefer enums to free text.
- Names are lowerCamelCase. Instants are RFC 3339 strings (`format: date-time`) named `<event>At`; durations are integers
  with a unit in the name (`ttlSeconds`); paging is `cursor`/`limit` -> `nextCursor`.
- Reuse `_shared` definitions by relative `$ref`; opt into the `ext` slot with the framework `Ext` definition.

### Error codes

Standard codes are in [01](01-concepts.md). Add your own only for failures a caller must act on. Declare them in front
matter (sketch below, not run); the part before the colon **must be the full slug**, the local part lowerCamelCase, and the code must not
shadow a standard one:

```yaml
errorCodes:
  - code: example/note:inboxFull
    meaning: The inbox holds its maximum number of notes.
    retryable: true
    detailsSchema: { type: object, additionalProperties: false, properties: { limit: { type: integer } } }
```

Unknown extended codes degrade to `taskFailed` for clients that do not know them (SPEC 8.5).

### Valid and invalid examples

Valid examples are the complete documents in `spec.md`; the build validates every fenced JSON document in a spec against
the framework document. `payload.invalid-examples.json` is an array of `{ "note", "payload", "variant"? }`; `variant`
is `"response"` to test the response schema. **`npm run validate` does not read it** (shown below **[run]**); upstream
`trust-tasks-codegen` turns it into a `rejects_invalid_examples` test **[src]**. Test it yourself (below).

## Scaffold, validate, build, PR

Run in a clone of the spec repo (Node 24 is declared in `engines`; Node 22 worked with an engine warning **[run]**):

```sh
git clone https://github.com/trustoverip/dtgwg-trust-tasks-tf && cd dtgwg-trust-tasks-tf
npm install
npm run new-spec -- example/note --category messaging --title "Example Note" \
  --summary "Post a short note to a recipient." --side-effects mutating --discloses none
npm run validate        # parses front matter, validates schemas and examples, runs the lints; ~45 s
npm run build           # validate + regenerate website/ outputs (git-ignored)
```

Other `new-spec` flags: `--version`, `--no-response` (fire-and-forget), `--discloses none|metadata|secret`,
`--acts-as-subject`, `--force` **[src]**.

What actually happened (spec repo `main`, Node 22, nice -n 10) **[run]**:

| Step | Result |
|---|---|
| `npm run validate` before changes | exit 0, "Validated 1135 specs" in 44 s; many existing `warn:` lines for other specs |
| `npm run new-spec -- example/note ...` without `--category` | refused: the slug family `example` is unknown to the category guesser; prints the category list. `--category` is required for a new family |
| `new-spec` with `--category messaging` | wrote `specs/example/note/0.1/spec.md` and `payload.schema.json` (request plus `$defs.Response`), with an `## Authorization` stub because `mutating` is consequential |
| `validate` on the **unedited** scaffold | exit 0, "Validated 1136 specs": it passes with every `TODO` still in it. The lints do not read your prose; reviewers do |
| Fill in schema, front matter, examples | exit 0 |
| Delete `sideEffects` | exit 1: `example/note/0.1/spec.md: / must have required property 'sideEffects'` |
| Change `$id` to `.../example/notes/0.1` | exit 1: `$id must be https://trusttasks.org/spec/example/note/0.1 (got ...notes/0.1)` |
| Add a **valid** payload to `payload.invalid-examples.json` | exit 0: not checked by `validate` |
| `npm run build` | exit 0; `website/registry.json` then lists `https://trusttasks.org/spec/example/note/0.1`; nothing tracked changes |

The scaffold uses `https://trusttasks.org/spec/...` because it targets the **public registry**. A private task cannot
live in that repo; its `$id` and `type` use your own authority (the walkthrough does that).

### Opening the PR (upstream) **[src]** `CONTRIBUTING-SPECS.md`

1. Fork, branch, add only your own `specs/<slug>/<version>/` folder (CODEOWNERS routes review by namespace).
2. `git commit -s` (DCO sign-off is required) and agree to the contributor agreement in `CONTRIBUTING.md`.
3. `npm run build` must pass; CI runs it.
4. Adding or changing a spec also requires regenerating the four language bindings **in the same PR**:
   `cargo run -p trust-tasks-codegen && cargo fmt --all`, `npm run build-ts-bindings`, `npm run build-go-bindings`,
   `npm run build-dart-bindings`, then `npm run check-bindings` **[untested]** (needs a Rust toolchain; not run here).
   Do not bump library versions or edit changelogs; releases are automated.
5. Use a conventional-commit title: `feat(<slug>): ...` for a new family.
6. A new spec starts at `draft`. `candidate` needs two interoperable implementations; `standard` needs a 90-day stable
   window (SPEC 5.3). Record implementations in `knownImplementations`.
7. For a consequential task, check the Authorization section names an authority. No build check covers this.

## Walkthrough: a private "note" task, handler and test

Goal: take the starter's inbox-verifier, give its note task a real spec and schema, validate with ajv, and test the
negative space. All of this was run in a scratch copy of the starter **[run]**: `tsc --strict` clean, 10 tests pass,
`npm run demo` prints the five verdicts.

**1. Copy the template** (leave the original alone):

```sh
cp -r templates/inbox-verifier templates/my-inbox
rm -rf templates/my-inbox/node_modules
sed -i 's#@starter/inbox-verifier#@starter/my-inbox#' templates/my-inbox/package.json
```

Add `"ajv": "8.17.1"` and `"ajv-formats": "3.0.1"` to its `dependencies`, then `npm install` at the repo root.
(The starter ships no JSON-Schema validator; the consumer package says so.)

**2. Write the spec.** In the spec repo, `npm run new-spec -- example/note ...` as above gives you `spec.md` and a schema.
For a private task you keep the same files, with your own authority. Filled front matter that validated **[run]**:

```yaml
---
slug: example/note
version: "0.1"
title: "Example Note"
summary: "Post a short note to a recipient."
status: draft
targetFrameworkVersion: "0.6.0"
category: messaging
parties:
  - role: Sender
    requirement: REQUIRED
    member: issuer
  - role: Inbox owner
    requirement: REQUIRED
    member: recipient
proofRequirement:
  requirement: REQUIRED
  rationale: >-
    A note is kept and may be relied on later, so the sender's signature must travel with it
    and cannot depend on the transport.
issuedAtRequirement:
  requirement: REQUIRED
  rationale: >-
    Storing a note changes recipient state, so it is consequential; issuedAt bounds the
    duplicate-execution record (SPEC 7.2 items 11 and 13).
sideEffects:
  level: mutating
  rationale: >-
    Stores one note in the recipient's inbox. Recoverable: the owner can delete it.
exposure:
  discloses: none
  ingests: personal
  actsAsSubject: false
  rationale: >-
    Free-text members can carry personal data the sender chooses to include.
retention:
  class: durable
  rationale: >-
    The inbox keeps notes until its owner deletes them.
errorCodes: []
related: []
---
```

**3. The schema.** Copy `payload.schema.json` into `templates/my-inbox/schema/note.payload.schema.json` and change
`$id` to your authority, here `https://example.org/spec/buildathon/note/0.1` (the template's `NOTE_TYPE`):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://example.org/spec/buildathon/note/0.1",
  "title": "Example Note — payload",
  "description": "A short note addressed to the recipient's inbox. The outer document members are owned by the framework (SPEC §6.3).",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "title",
    "body"
  ],
  "properties": {
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120,
      "description": "One-line subject. Free text, shown to an operator, untrusted: render it attributed to the issuer."
    },
    "body": {
      "type": "string",
      "maxLength": 2000,
      "description": "The note text. Free text, untrusted, retained until the recipient deletes it."
    }
  },
  "$defs": {
    "Response": {
      "$anchor": "response",
      "type": "object",
      "additionalProperties": false,
      "required": [
        "noteId",
        "receivedAt"
      ],
      "description": "Receipt for an accepted note. Failures use trust-task-error, not this shape.",
      "properties": {
        "noteId": {
          "type": "string",
          "minLength": 1,
          "description": "Identifier the recipient assigned to the stored note."
        },
        "receivedAt": {
          "type": "string",
          "format": "date-time",
          "description": "When the recipient stored the note."
        }
      }
    }
  }
}
```

**4. Invalid examples** (`templates/my-inbox/schema/note.invalid-examples.json`):

```json
[
  {
    "note": "Missing required body: a note without text is not a note.",
    "payload": {
      "title": "hi"
    }
  },
  {
    "note": "Empty title: minLength 1 stops blank subjects.",
    "payload": {
      "title": "",
      "body": "x"
    }
  },
  {
    "note": "Unknown member: additionalProperties false catches typos and smuggled fields.",
    "payload": {
      "title": "hi",
      "body": "x",
      "frobnicate": true
    }
  },
  {
    "note": "Over-long body: free text must be bounded (SPEC 7.3 item 19).",
    "payload": {
      "title": "hi",
      "body": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
    }
  },
  {
    "note": "Receipt without receivedAt is not a valid response.",
    "variant": "response",
    "payload": {
      "noteId": "n1"
    }
  }
]
```

**5. The validator.** `src/note-validator.ts`:

```ts
// Payload validation (SPEC 7.2 item 2) with ajv, against the task's own schema.
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { PayloadValidator } from "@openvtc/trust-tasks/runtime";
import schema from "../schema/note.payload.schema.json" with { type: "json" };

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

/** Request payloads: the top-level schema. */
export const validateRequest = ajv.compile(schema);
/** Response payloads: the sub-schema anchored at `$defs.Response`. */
export const validateResponse = ajv.compile({ ...schema.$defs.Response, $defs: schema.$defs });

export const noteSchema = schema;

/** Adapter for `payloadPolicy: { kind: "validate", validate }`. */
export const noteValidator: PayloadValidator = {
  validate: (_schema, payload) => {
    const ok = validateRequest(payload);
    return ok ? { ok: true } : { ok: false, errors: (validateRequest.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`) };
  },
};
```

`strict: false` is needed: ajv's strict mode rejects the `$anchor` keyword in this setup (tried **[run]**). Formats such as
`date-time` come from `ajv-formats`.

**6. Wire it into the handler.** In `src/inbox.ts` import the validator, hand the schema to the spec policy and delete the
hand-rolled `validateNote`:

```ts
import { noteSchema, noteValidator } from "./note-validator.js";

export const NOTE_SPEC: SpecPolicy = {
  typeUri: NOTE_TYPE,
  isBearer: false,
  isProofRequired: true,       // from proofRequirement: REQUIRED
  isRecipientRequired: true,   // parties: recipient REQUIRED
  isIssuedAtRequired: true,    // issuedAtRequirement: REQUIRED
  payloadSchema: noteSchema,
};
// ...inside consumeInbound({ ... }):
//   payloadPolicy: { kind: "validate", validate: noteValidator },
//   checks: consequentialChecks(guard),     // sideEffects: mutating
```

The mapping from front matter to `SpecPolicy` flags is the point: what the spec declares, the consumer enforces.

**7. Test it.** `test/note-task.test.ts`:

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { newIdentity } from "@starter/vta-client";
import { createInbox } from "../src/inbox.js";
import { validateRequest, validateResponse } from "../src/note-validator.js";
import { makeNote } from "../src/send.js";

const ME = "did:web:inbox.test";
const invalid: { note: string; variant?: "request" | "response"; payload: unknown }[] = JSON.parse(
  readFileSync(new URL("../schema/note.invalid-examples.json", import.meta.url), "utf8"),
);

test("a valid note payload and receipt pass the schema", () => {
  assert.equal(validateRequest({ title: "hi", body: "there" }), true);
  assert.equal(validateResponse({ noteId: "n1", receivedAt: "2026-01-01T00:00:00Z" }), true);
});

for (const ex of invalid) {
  test(`schema rejects: ${ex.note}`, () => {
    const validate = ex.variant === "response" ? validateResponse : validateRequest;
    assert.equal(validate(ex.payload), false);
  });
}

test("the inbox refuses a schema-invalid payload as malformedRequest", async () => {
  const inbox = createInbox(ME);
  const v = await inbox.receive(makeNote(newIdentity(), ME, "", "body") as any);
  assert.equal(v.kind, "rejected");
  assert.equal(v.kind === "rejected" && v.code, "malformedRequest");
});

test("a replayed note runs once; a wrong-recipient note is refused", async () => {
  const inbox = createInbox(ME);
  const me = newIdentity();
  const doc = makeNote(me, ME, "t", "b") as any;
  assert.equal((await inbox.receive(doc)).kind, "accepted");
  assert.equal((await inbox.receive(doc)).kind, "duplicate");
  assert.equal(inbox.notes.length, 1);
  const wrong = await inbox.receive(makeNote(me, "did:web:other", "t", "b") as any);
  assert.equal(wrong.kind === "rejected" && wrong.code, "wrongRecipient");
});
```

Run: `npx tsx --test templates/my-inbox/test/*.test.ts` and `npx tsc --noEmit -p templates/my-inbox`.

**8. Send one.** `src/send.ts` already builds, signs and posts a note; `npm run send -w @starter/my-inbox -- --replay`
against `npm start -w @starter/my-inbox` shows accept then duplicate (the `demo` script covers the same cases and was run; `send` itself was not).

Promote it later: change the slug and `$id` to a registry slug, move the files to `specs/<slug>/0.1/` upstream and open
the PR above. Expect the slug and any `example` namespace to change (SPEC 6.5 item 5).
