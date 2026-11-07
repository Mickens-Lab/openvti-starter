# Polls client: plan (2026-11-07)

A client for creating community polls and taking part in them, built on the VTI election feature. A "poll" in VTI
*is* an election: there is no separate poll task family, and the upstream docs file polls, surveys and elections
under `vtc/elections/*`.

Citations are paths in the upstream `verifiable-trust-infrastructure` checkout (`VTI_PATH`), at the commit checked
out on 2026-11-07 (vtc-service 0.22.x line).

## Research findings

### What exists upstream

- **No separate poll concept.** No `Poll` type and no `polls/` tasks. `docs/03-vtc/elections.md:3` names polls,
  surveys and elections together. The CLI's starter manifest defaults its id to `poll-<date>` (`cnm-cli/src/elections.rs:130`).
- **Three parties** (`vti-voting/README.md`):
  - the **VTC** is the registrar: it creates the election, issues blind tickets, closes and cancels;
  - the member's **VTA** is the voter: it holds the ticket and does all PCS (BLS12-381) crypto;
  - **`vti-voting-service`** is the ballot box: it takes casts, keeps an RFC 9162 board and does the tally.
  
  A TypeScript client never touches the crypto. It moves signed documents between the three parties.

### Task types and who may call them (all under `https://trusttasks.org/spec/`)

- **VTC tasks** (`vtc-service/src/trust_tasks/election_tasks.rs:6-11`). Compiled in only with `--features voting`
  (`vtc-service/Cargo.toml:55`, `vtc-service/src/trust_tasks/mod.rs:191`).
  - `vtc/elections/create/0.5` (0.4 and 0.3 also served), `close/0.1`, `cancel/0.1`, `certify/0.1` and
    `ballot-boxes/list/0.1` need the capability `vtc.elections.manage`, which admins hold.
  - `list/0.5` and `show/0.6` take any signed caller. Callers other than managers see only the elections whose
    roll admits them.
  - `tickets/issue/0.3` is called once per admitted party per election.
  - Schemas: `vti-specs-vtc/trust-tasks/vtc/elections/*/<v>.bundle.json`.
- **VTA tasks** (`vta-service/src/trust_tasks/pcs.rs:789`).
  - `vta/pcs/voter/read/0.6`, `voter/register/0.5`, `voter/accept/0.1`, `voter/receipt/0.1` and `vta/pcs/vote/0.4`
    all need the `pcs-voter` capability.
  - The admin and initiator roles hold it. **The `application` role does not** (`vti-common/src/acl/mod.rs:335-345`).
  - Schemas: `vti-specs-vta/trust-tasks/vta/pcs/**`.
- **Ballot box tasks** (`vti-voting-service/src/dispatch.rs:133-139`).
  - The client uses `voting/ballot/cast/0.1` and `voting/result/show/0.1`.
  - A cast must come from a one-time `did:key` (`dispatch.rs:369-382`).
  - Reads are unsigned-OK on a public board and restricted on a private one (`vti-voting/src/service/mod.rs:694-702`).
  - The HTTPS door is the `TrustTaskHTTPS` service in the ballot box's DID document
    (`vta-cli-common/src/commands/elections.rs:394-413`).

### Data model (from `vtc/elections/create/0.5` `$defs/Manifest`)

The manifest has these required fields:
`electionId` (`^[A-Za-z0-9._-]{1,128}$`), `community`, `questions[1..128]`, `secrecy` (`open|sealed|talliedEncrypted`),
`roll` (`{rule: members|membersAndListed|listed|credential, listed?, memberOf?}`), `registrationOpensAt`,
`votingOpensAt`, `votingClosesAt`, `revote` (`replace|refuse`), `board {visibility: public|private, auditors[]}`,
`ballotBox` (a DID), `binding`, `allowEarlyClose`, `resultsBeforeClose`, `textReleaseThreshold` (at least 1, 10 recommended).

It also takes the optional fields `title`, `description` and `trustees` (sealed secrecy only).

The ballot has four question types:
- `choice` (`options[2..256]`, `minSelections`, `maxSelections`, `optional`). This covers single choice, multi choice
  and approval voting.
- `ranking`.
- `score`.
- `text`.

There is no quorum field. A ready-made minimal manifest is at `cnm-cli/src/elections.rs:118-158`.

The registrar's election states are `registered`, `registration`, `voting`, `closed`, `tallied`, `cancelled`,
`pendingRegistration` and `registrationRefused` (`list/0.5` `$defs/RegistrarState`).

### Member vote sequence (`vta-cli-common/src/commands/elections.rs:541-643`)

1. VTA `voter/read` (`read: "show"`) returns a signed `show` document. POST it to the VTC to get `manifest` and
   `parameters`.
2. VTA `voter/register`, with the manifest and parameters copied byte for byte, returns `ticketDocument`. POST it to
   the VTC (`tickets/issue`), then call VTA `voter/accept` with the reply.
3. VTA `vote` with `{contextId, community, parameters, manifest, ballot}` returns `{castDocument, tag}`. The ballot
   is `{electionId, manifestDigest, answers[{question, choice[] | abstain}]}`.
4. After a random pause (0 to 20 s, `MAX_CAST_DELAY`, `elections.rs:54`), POST `castDocument` to the ballot box. Its
   receipt carries `outcome: counted|replaced|alreadyCounted`.
5. VTA `voter/receipt` keeps the receipt.

Pass every JSON value through unchanged: re-serialising a timestamp breaks the digests (`vta-sdk/src/client/pcs.rs:228-242`).

### Semantics

- **Tickets** are blind and one per party per election (`alreadyIssued` on a second claim). They are issued while
  `registrationOpensAt <= now < votingClosesAt` (`vtc-service/src/elections/ops.rs:658-664`).
- **Revoting** follows `revote`: `replace` lets a new ballot replace the old one, `refuse` answers `alreadyVoted`.
- **The tag** is the per-election nullifier.
- **Privacy:** the community never sees ballots, and the ballot box never learns who voted.
- **Tally** runs automatically at `votingClosesAt`, or on an early close if `allowEarlyClose` is set
  (`vti-voting/src/service/mod.rs:735-750`).
- **Results** are refused with `notTallied` before then, unless `resultsBeforeClose` is set.

### Error codes

Codes are prefixed with the task slug, e.g. `vtc/elections/create:invalidManifest`.

| Step | Codes |
|---|---|
| create | `electionExists`, `invalidManifest`, `ballotBoxNotTrusted` |
| tickets/issue | `notEligible`, `alreadyIssued`, `notOpen` |
| ballot/cast | `alreadyVoted`, `notOpen`, `ballotInvalid` |
| close | `earlyCloseNotAllowed` |
| result/show | `notTallied` |
| VTA `vote` | `notFound` (no ticket) |
| VTA `voter/register` | `ticketHeld` |

### Reference wallet

The reference mobile wallet (the private sibling checkout) has **no** poll, election or ballot code, screens or plans.
Its pinned `@openvtc/trust-tasks` 0.28.1 ships voting types, but none of them are used, and they stop at
`create/0.3`, `show/0.2` and `vote/0.2`. The nearest pattern is its `vta/pcs/vetter/*` module, which also routes VTA
PCS tasks through a VTC. So the bundle schemas above are the reference, not the wallet.

### What this kit can run today

- The pinned VTC (0.15.0) is built with `FEATURES="setup,website,tsp"` (`docker/vtc.Dockerfile`), so
  `vtc/elections/*` is not served. `docs/VTC-SURFACE.md` already records this.
- No compose file in either repository runs a ballot box.
- **Live end-to-end voting is therefore not possible on the kit's stack without new images and a provisioned ballot
  box.** The client is built against the current upstream bundles and tested against an in-process mock.

## Placement

- **`packages/polls-client`** (`@buildathon/polls-client`) is the reusable client. It is framework-free and runs in
  Node and browsers, like `vtc-client`, which it builds on (`VtcClient.send/call` for the VTC, `VtaClient.call` for
  the VTA, `classifyReply/unwrapReply` for the ballot box). It contains:
  - manifest builder and validation;
  - ballot builder and validation;
  - phase from times and state;
  - results summary;
  - `PollsClient` (create, list, show, vote, results, close, cancel);
  - refusal wording.
- **`templates/polls`** (`@buildathon/polls`) is a Node CLI and starting point, in the style of `hello-node` and
  `inbox-verifier`:
  - `npm run demo` runs the whole flow against the in-process mock, offline;
  - `npm start -- <create|list|show|vote|results|close|cancel>` runs against the URLs in `.env`.
- **Mock:** `packages/polls-client/src/mock.ts` is one `node:http` server playing the VTC registrar, the member VTA
  and the ballot box, with the rules above. It does no crypto. The integration test and the demo both use it.

## Steps

1. Commit this plan alone.
2. Write the `polls-client` modules: tasks, manifest, ballot, results, errors, client and mock, each with unit tests.
3. Write an integration test: a real HTTP mock on an ephemeral port, driven through the full create, vote, revote,
   close and results flow, plus the error paths.
4. Write the `templates/polls` CLI and demo, with a README.
5. Docs: a README row, a `docs/VTC.md` pointer, and the package README with a "verified vs not" section.
6. `npm ci`, then typecheck and test the new workspaces, then `check:generic` and `check:docs`.

## Verification strategy (no Docker)

- **Unit tests:**
  - manifest validation (every schema rule we mirror);
  - option key derivation;
  - ballot validation (min/max selections, unknown option, abstain on an optional question only);
  - phase and deadline maths;
  - result summary (percentages, ties, `withheld`);
  - refusal decoding (slug-prefixed codes).
- **Client tests** with a fake `fetch`: exact task types, recipients and payload pass-through (the manifest bytes
  from `show` reach `register` and `vote` unchanged), and the `ticketHeld` skip.
- **Integration test** against the mock over real HTTP:
  - create, then list and show;
  - two members vote;
  - a revote is `replaced`;
  - a second vote under `refuse` is `alreadyVoted`;
  - `notTallied` before close;
  - an early close is refused without `allowEarlyClose`;
  - close, then results;
  - a vote after close is `notOpen`;
  - a non-manager gets `permissionDenied` on create.
- **Not verified live:**
  - every real VTC, VTA and ballot box exchange;
  - ballot box URL resolution from a real DID document;
  - `pcs-voter` capability grants;
  - the real member-DID binding;
  - the encrypted (`sealed` and `talliedEncrypted`) paths, which are out of scope.

## Open questions (defaults taken)

1. **Which task versions?** The newest upstream ones (create/0.5, list/0.5, show/0.6, tickets/issue/0.3, voter/read/0.6,
   voter/register/0.5, vote/0.4). The pinned VTC serves none of them anyway. The type URIs live in one table, so
   stepping down is a one-line change.
2. **Which secrecy levels?** `open` only. `sealed` and `talliedEncrypted` need `vote-encrypted` and trustees, which
   are refused client-side with a clear message.
3. **Which question types?** One `choice` question per poll in the friendly builder (single or multi via
   `maxSelections`). The raw manifest is accepted too, so any type can be sent. The results summary handles `choice`
   and shows raw counts for the rest.
4. **Who is the member?** It must be a DID the VTA holds keys for that is also a community member. Default:
   `POLL_MEMBER_DID`, else `APP_DID`. This is unverified, because the kit's app `did:key` key is not held by the VTA.
5. **Where is the ballot box?** `BALLOT_BOX_URL` if set, else resolved from the ballot box's `did:webvh` log
   (`TrustTaskHTTPS` service).
6. **Cast delay?** Random 0 to 20 s by default, as upstream does. Tests, the demo and the mock pass `castDelayMs: 0`.
7. **Who may create?** A signer with `vtc.elections.manage` (the kit's admin key in `.vta/admin.json`). The CLI uses
   it for create, close and cancel when `POLL_ADMIN=1`.
