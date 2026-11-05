# A mobile wallet as a second device (optional)

This page says what a phone wallet could add to the [approvals demo](APPROVALS.md), what has to be true for it to work, and what was and was not checked. It describes
protocols, not a product. Back to the [docs index](README.md).

Labels: **[V]** verified in source or live while preparing this kit, **[D]** stated in documentation only, **[I]** inferred, **[unverified]** not checked.
**No phone, wallet app or real device was used for this kit.** The phone leg below is a plan and a checklist, not a result.

## Where a phone fits

| Pattern | What the phone does | Works in this kit's local mode? | Needs |
|---|---|---|---|
| A. Approver | answers a consent request with a signed decision (the demo's software approver does the same) | no | a VTA reachable by messaging at a resolvable (HTTPS) DID, with the phone linked to that VTA and its DID in the approver set |
| B. Holds the app's signing key | signs Trust Tasks or a login for a web page | no | a relay between page and phone plus a "sign this document" capability **[unverified]** that is not known to exist |
| C. Hardware-attested key on the ACL | proves a key lives in secure hardware | no | the VTA to verify attestation, which it does **not** in 0.65.0 **[V]** (it stores the evidence) |
| D. Holds the membership credential | receives the VTC's credential by messaging | no | a VTC with messaging and a mediator the phone reaches; this kit's applicant is a plain `did:key` with no mediator ([MESSAGING.md](MESSAGING.md)) |

Only A is demonstrated, and only with a software stand-in.

## Pattern A, step by step

1. Run `MODE=tunnel` so the VTA has a public `did:webvh` DID and a mediator ([MODES.md](MODES.md)). Local mode cannot work: the DID names `localhost`, which a phone cannot reach and
   which `did:webvh` resolution does not allow over plain http **[D]**.
2. Link the phone to the VTA. A wallet can be enrolled by a QR or link that carries the VTA's DID, label and URL, after which an admin grants it **[D]**. A QR in the dashboard
   would be the *link step*, not the approval channel: the approval travels VTA to mediator to phone **[V]**.
3. Put the phone's DID in the approver set, with enforcement on (`APPROVALS.md`).
4. The requester sends the gated task; the VTA pushes a signed request; the phone verifies it, shows the match code and effects, asks the person, and returns the signed decision.
5. Compare the six-character code on both screens. It is derived from the exact payload digest.

## What a phone does and does not add

- It adds a separate machine and a human decision bound to the exact task: a stolen app key (the one in `.env`) cannot run a gated task alone.
- It does not make the approval key hardware-bound. In the wallet we reviewed the approval key is a software key inside the app's encrypted store; only some actions add a fresh biometric or passcode prompt, and
  whether answering a consent request does is **unconfirmed** **[V/unverified]**. A stolen, unlocked phone can therefore approve. Other wallets may differ.
- Keys that are hardware-held (secure enclave or StrongBox) exist in that wallet for relationship signing, but no Trust Task or ACL entry uses an attested key today **[D]**.
- Unprotected at every stage: the VTA operator, mediator metadata, and the VTA's own signing oracle.

## What was not checked

- Any phone, any emulator, `did:webvh` resolution from a device, whether a wallet accepts a quick-tunnel VTA, whether a developer build is needed, or whether the relevant features are in store builds.
- Whether a wallet would accept this kit's mediator (the wallet's own developer mediator is not known to be compatible with the VTA's) **[I]**.
- Whether a wallet's TSP version matches: the pinned VTA, VTC and mediator (0.48.0) all speak TSP 1.0, and a TSP client of this kit gets pongs and credential frames through that mediator ([MESSAGING.md](MESSAGING.md)) **[V]**; whether a phone wallet speaks the same revision was not tried **[unverified]**.
- Whether the wallet's mediator CORS needs `cors_allow_origin` for a direct connection ([MODES.md](MODES.md)).
- The trigger-link sign-in (`auth/oob`): no path with that name exists in the VTA or VTC OpenAPI documents **[V]**, and its step-up purpose is reserved, not defined **[V]**.

## Manual checklist (only with a spare device and a go from the organiser)

- [ ] `npm run up -- --tunnel` is green, and the VTA's DID resolves from the phone's browser over mobile data.
- [ ] The wallet can add the VTA (by DID or enrolment link) and shows it.
- [ ] An admin grants it, and its DID is added to the approver set (needs a VTA restart with a fresh volume to re-seed; the stored rules win after first boot).
- [ ] `MODE=tunnel npm run approvals:demo` (it works in tunnel mode, with the software approver) is run, and a prompt is raised on the phone with the same code.
- [ ] Deny once and approve once; note whether a biometric prompt appeared.
- [ ] `npm run down`; remove the VTA from the wallet.

Write the results into the status notes, with what you saw rather than what is documented.
