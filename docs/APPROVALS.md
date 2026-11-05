# Approve on a second device (software approver first)

A VTA can refuse a task until a *different* party agrees to *that exact task*. This kit lets you try it on one laptop with a throwaway
software approver standing in for a second device. Back to the [docs index](README.md). Read [SECURITY.md](SECURITY.md) first.

Labels: **[verified]** observed live against the pinned VTA (0.65.0), `MODE=local` and `MODE=tunnel`, while building this; **[docs]** stated in the VTA's
documentation, not exercised here; **[unverified]** not observed.

## What it is

An approval *rule* says "task type X needs consent from approver set S". Then:

1. The requester submits X. The VTA does not run it; it refuses with `auth:consent_required` and a **challenge**, and signs a
   `task-consent/request` for each approver in the set **[verified]**.
2. The requester shows a six-character **match code**: the first six hex characters of the bytes of the request's payload digest **[verified]**.
3. The approver verifies the request (signed by the VTA with a key its verified did:webvh log lists under `authentication`,
   addressed to it, not expired; see [SECURITY.md](SECURITY.md#whose-did-is-this-trust-in-didjsonl)), compares the code on both screens, and returns a
   signed `task-consent/decision` **[verified]**.
4. The requester submits the *identical* task again; the VTA runs it once and spends the approval **[verified]**.

Approval is bound to the payload, not to a session: approving one rename does not approve a different one. The requester can be
excluded from counting as an approver, so one stolen key cannot both ask and agree.

## Try it

```sh
npm run reset              # only if a stack already exists: the rule is seeded once, on a volume's first boot
npm run approvals:setup        # mints the approver key (.vta/approver.json) and writes APPROVER_DID to .env
WITH_VTC=1 npm run up          # the VTA entrypoint turns enforcement on and seeds one rule (below)
npm run approvals:demo         # the admin (requester) renames the context my-app; the VTA refuses and the demo waits
```

The demo prints `WAITING FOR APPROVAL   match code: 032df1` and writes the refusal to `.vta/refusal.json`. In a second terminal:

```sh
npm run approver                       # shows what is asked, then asks you to type the code
npm run approver -- --match-code 032df1
npm run approver -- --deny "not expected"
```

A wrong code is refused before anything is signed **[verified]**. After an approval the demo prints `approved and executed` **[verified]**; after a denial it
stops with "denied or lapsed" and does not ask again **[verified]**. For a test with no human, `npm run approvals:demo -- --self-approve` plays both parts
(there is no human comparison then).

The rule that is seeded: `vta/contexts/update/1.0` needs 1 approval from the set `demo-approvers`, requester excluded. Pending requests
last 15 minutes and an approval 10 **[docs]**.

## With a phone wallet as the approver (untested)

```sh
npm run reset
MODE=tunnel npm run approvals:setup -- --approver-did <the phone's DID>   # approver set = phone, then the software approver as a laptop fallback
npm run up -- --tunnel
MODE=tunnel npm run approvals:demo -- --phone                            # waits; the request should appear on the phone
```

`APPROVER_DID` in `.env` may be a comma-separated list; the VTA entrypoint puts each into the `demo-approvers` set. Checked on VTA 0.72.0 with a stand-in DID in the phone's place:
the VTA starts with both DIDs in the set, enforcement stays on, and the software approver (second in the list) approved and the request executed **[verified]**; bad `--approver-did`
values and `--phone --self-approve` are refused. Not tried with a real phone: whether the VTA accepts a non-`did:key` approver, and whether the push reaches the wallet, are
**[unverified]** ([MOBILE-WALLET.md](MOBILE-WALLET.md)). If it does not arrive, `npm run approver` still approves with the software key.

## Things that were not as documented

- **VTA 0.72 serves `task-consent/decision/0.2` only** (the request is still 0.1; 0.2 only adds the optional `actionId` and `evidence`). The 0.65-era client sent 0.1 and got `unsupportedVersion` on approve; the client now sends 0.2 **[verified on 0.72.0, MODE=local]**.
- **The config field names are camelCase** (`taskType`, `approverSet`, `minApprovals`, `excludeRequester`); the VTA's docs show snake_case and
  the VTA 0.65.0 rejected it ("unknown field") **[verified]**. The setup wizard cannot carry a policy section, so `vta-entrypoint.sh` edits the
  generated `config.toml` and refuses to start if enforcement did not switch on.
- **Over REST an approver needs a session**, and a DID with no ACL entry cannot open one (401, then "authentication failed") **[verified]**. The
  docs say an approver needs no ACL entry; that holds for the messaging transports **[docs]**. The demo therefore grants the approver a `monitor` entry
  with no contexts. Over messaging the sealed sender is the caller and the decision's `issuer` must equal it; there is no session
  ([REST bearer vs messaging sender](trust-tasks/01-concepts.md#who-is-the-caller-rest-bearer-vs-messaging-sender)). In `MODE=tunnel` the VTA also pushes the request to the approver over messaging, which this kit cannot receive ([MESSAGING.md](MESSAGING.md)).
- **No effects are shown.** The VTA's request carried an empty `effects` list for this task **[verified]**, so the approver says "NOT DETERMINED", never "no effects".
- **There is no "is it approved yet?" call.** The requester asks again by submitting again; while pending the VTA repeats the same challenge **[verified]**.
- `npm run reset` deletes `.vta/` including the approver key; run `approvals:setup` again afterwards.

## What this does and does not protect

It models the protocol. It is **not** a second device: the approver key is a file on the same machine, so malware on this laptop can
use both keys. A real second device (a phone) adds a separate machine and, if the app asks for it, a biometric gate; see
[MOBILE-WALLET.md](MOBILE-WALLET.md). Approvals only exist while `policy.enforcement = true`; a rule stored without it gates nothing and the VTA's
`approvals list` does not tell you which state you are in **[docs]**. `MODE=tunnel` works the same way **[verified]**: the demo and approver talk to the public VTA URL. There the VTA also tries to push the request to the approver
over DIDComm (the outbox shows it), but a plain `did:key` approver has no inbox, so the relay through `.vta/refusal.json` is what carries it. The demo refuses `MODE=farm`.
Setting up in tunnel mode: `MODE=tunnel npm run approvals:setup`, then `npm run up -- --tunnel`, then `MODE=tunnel npm run approvals:demo` (the same for `approver`).

Code: `packages/vta-client/src/consent.ts` (match code, request verification, decision, `withConsent`), `scripts/approver.ts`,
`scripts/approvals-demo.ts`. Unit tests cover verification (tampering, wrong issuer, recipient, purpose, key, expiry), the code check and the wait loop.
