# 2. Finding tasks

Goal: before you invent a task, find out whether one exists, whether the VTA or VTC you target serves it, and whether
it is fit for use. Marks: **[run]** executed, **[src]** read from source, **[untested]**, **[draft]**
([legend](README.md#legend-how-each-claim-was-checked)).

## Where to look

| Source | What you get | Status |
|---|---|---|
| `https://trusttasks.org/registry` | Browsable registry of every task version | **[run]** live |
| `https://trusttasks.org/registry.json` | Machine-readable index: `typeUri`, `slug`, `title`, `summary`, `status`, `category`, `keywords`, `parties`, `proofRequirement`, `sideEffects`, `exposure`, `errorCodes`, `related`, `extends`, `schemaPath`, `prosePath`, `hasResponse`. Several MB, includes schemas | **[run]** live (1140 versions on 2026-10-29) |
| `https://trusttasks.org/spec/<slug>/<MAJOR.MINOR>` | The spec page. Ask for the schema with `Accept: application/schema+json` | **[run]** live |
| `https://trusttasks.org/specs/<slug>/<MAJOR.MINOR>/spec.md`, `payload.schema.json`, `payload.invalid-examples.json` | The raw files | **[run]** live (spec.md as markdown) |
| `specs/<slug>/<version>/` in the spec repo | The same files, with history and `git log` | **[src]** |
| `catalog.json`, `llms.txt`, `llms-full.txt`, and a guided `/start` page that ranks tasks from a short description | A slim retrieval catalog and a plain-text crawler index | **Planned.** Built by the spec repo's `portal-start-wizard` branch **[src]**; on 2026-10-29 `https://trusttasks.org/catalog.json` and `/llms.txt` returned the site's HTML page, not the files **[run]**. Check again before relying on them |
| `npm run extends-candidates` (spec repo) | Version pairs that could declare `extends` but do not | **[src]** |

Spec families you will meet first: `vta/*` (VTA features: contexts, app-state, keys, backup...), `vtc/*` (community:
join requests, members, directory, groups, rooms), `acl/*`, `auth/*`, `trust-task-*` (framework: discovery, error,
control, next-step). The folder names under `specs/` are the slugs.

### Search the registry from a script

Works on Node 20+ (global `fetch`); **[run]**:

```js
// find.mjs   node find.mjs <keyword> [slug-prefix]
const [kw = "consent", prefix = ""] = process.argv.slice(2);
const { tasks } = await (await fetch("https://trusttasks.org/registry.json")).json();
const hits = tasks.filter(
  (t) =>
    t.status !== "retired" &&
    t.slug.startsWith(prefix) &&
    [t.slug, t.title, t.summary, ...(t.keywords ?? [])].join(" ").toLowerCase().includes(kw.toLowerCase()),
);
for (const t of hits.slice(0, 15)) {
  console.log(`${t.typeUri}  [${t.status}] side=${t.sideEffects?.level} proof=${JSON.stringify(t.proofRequirement?.requirement ?? "per-variant")}`);
}
console.log(`${hits.length} match(es) of ${tasks.length} versions`);
```

`node find.mjs consent task-consent` listed four live tasks. Keywords are hyphenated (`app-state`, not `app state`).
Every slug has one entry per version; pick the version your VTA/VTC serves, not just the newest.

## Which tasks does my VTA or VTC serve?

A server answers `trust-task-discovery` with the Type URIs it supports. Optional `patterns` narrow by slug:
`"*"`, `"acl/*"` (prefix), or an exact slug (SPEC 10.2). Version filtering is up to you.

```ts
const served = await vta.discover();               // authenticated VTA caller; returns strings
const aclTasks = served.filter((t) => t.includes("/spec/acl/"));
console.log(served.length, aclTasks);
```

- **VTA**: `vta.discover()` calls `trust-task-discovery/0.3` with no patterns and needs a bearer **[src]**. `npm run hello`
  prints the count. The CHEATSHEET says about 300 more tasks are served than the seven the client names.
- **VTC**: any signer may call `trust-task-discovery/0.3`; on the local VTC 0.15.0 a fresh stranger got the full list
  of 305 URIs (observed in `docs/VTC-SURFACE.md`; not re-run here). `vtc.call("https://trusttasks.org/spec/trust-task-discovery/0.3", {})`
  returns `{ supportedTypes: [...], frameworkVersion?, acceptanceWindow? }`; entries are a bare URI string or an object
  `{ type, requiredExt?, acceptanceWindow? }` **[src]** (`trust-task-discovery/0.3` schema).
- Discovery says what is **served**, not what *you* may call. A listed task can still answer `permissionDenied`
  (admin only) or `notFound`/"holds no entry" for your signer. `docs/VTC-SURFACE.md` maps callers to tasks for the VTC.
- A discovery response is advisory and unauthenticated unless signed (SPEC 10.5). Use it to choose what to *send*,
  never as proof of what is safe.

Compare with the registry: a task in the registry but not served is not available on that deployment, whatever the
spec says. This mismatch is the usual cause of `unsupportedType`/`unsupportedVersion` ([06](06-troubleshooting-and-glossary.md)).

## Versions this starter sends, and why

Each client pins the version the pinned VTA/VTC answers (the kit's live runs), not the newest in the registry. Several
are already superseded; a superseded version is deprecated and withdrawn later (SPEC 5.3.2-5.3.3), so check
discovery before you build on one **[src]** `packages/*/src`:

| Task | Sent | Newest in the registry | Note |
|---|---|---|---|
| `trust-task-discovery` | 0.1 | 0.3 | 0.3 adds `requiredExt` and windows; the VTC answers 0.3 too |
| `acl/grant` | 0.1 | 0.2 | |
| `task-consent/decision` | 0.1 | 0.2 | the decision payload is the same shape for the kit's use |
| `messaging/ping` | 0.1 | 0.2 | TSP ping only |
| `trust-task-error` (received) | 0.5 from the VTA | 0.6 | the clients accept any `trust-task-error/<v>` |
| `vtc/join-requests/manifest` | 0.4, then 0.3 | 0.4 | steps down only on `unsupportedVersion`/`unsupportedType` |

The version comparison rules are in [01](01-concepts.md); a newer MINOR is not automatically accepted by an older consumer.

## Reading a spec in two minutes

Open `spec.md` (or the Type URI) and read in this order:

1. **Front matter** (top of `spec.md`): `status`, `parties` (who is `issuer`, who is `recipient`), `proofRequirement`,
   `issuedAtRequirement`, `sideEffects`, `exposure`, `retention`, `errorCodes`, `related`, `extends`/`supersededBy`.
2. **Abstract** and **Conformance**: the MUST list for producer and consumer.
3. **Authorization** (consequential tasks): what entitles the sender. This is the section that tells you whether your
   app's ACL role will be enough.
4. **Request** / **Response** examples: complete documents. Copy one and change values.
5. **`payload.schema.json`**: the machine contract. `required`, `additionalProperties: false` (unknown members are
   rejected), `$defs.Response` (the success payload), `$ref`s into `_shared/` definitions.
6. **Error codes**: the standard ones plus `<slug>:<local>` codes with their `details` shape.
7. **Security and Privacy**: data carried, correlation, retention, purpose.
8. **`payload.invalid-examples.json`**, if present: documents the schema must reject. They show the edges the
   author cared about.

Example to read: `https://trusttasks.org/specs/vta/app-state/put/1.0/spec.md` has a conditional write with a typed
conflict error, and `vta/app-state/put/1.1` shows a later minor.

## Use, extend or propose?

```
Is there a live task whose payload and effect match what you need?
 |-- yes ---------------------------------> USE it (pin the exact version your server serves).
 |-- almost (needs one more optional member) -> see below.
 `-- no ----------------------------------> Is it only for your app or deployment?
                                              |-- yes -> PRIVATE task under your own authority (04, walkthrough).
                                              `-- no  -> PROPOSE a new spec upstream (04).
```

Checklist (answer in order, stop at the first "yes"):

- [ ] **Exact fit.** Same parties, same effect, same payload meaning? Use it. Do not repurpose a task whose name fits
      but whose semantics differ: the Type URI is a promise about meaning.
- [ ] **Same task, different version.** Is the version you need only on a newer/older MINOR? Check `extends`:
      a newer version that `extends` yours is safe to consume by ignoring unknown members (SPEC 5.2).
- [ ] **Optional addition.** Need an extra optional member? For a deployment-specific hint use the payload `ext`
      slot with your reverse-DNS namespace (SPEC 4.5.1) if the spec opts in (`ext` in its schema). Otherwise propose a
      new MINOR upstream with the member added.
- [ ] **Breaking difference** (different required members, narrower constraint, different meaning). New MAJOR of that
      slug, proposed upstream, or a new slug.
- [ ] **No match.** Search by `related`, category and keywords once more, then author a new task.
- [ ] **Private or public?** Needed only by your own app and server? Keep it private; promote later if others want it
      (SPEC 6.5 item 5 says the slug usually changes on re-hosting).

Also check the status. Every live task is `draft` today, so also check **how recently it changed** (`git log` on the
folder) and whether a successor exists (`supersededBy`), and read [05](05-evaluating-tasks.md) before depending on it.
