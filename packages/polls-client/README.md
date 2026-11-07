# @buildathon/polls-client

Community polls on the VTI election tasks. A poll in VTI *is* an election (`vtc/elections/*`); there is no separate poll
family. Three parties take part:

- **the community (VTC)**: creates the poll, issues a blind voting ticket to each member on its roll, closes and cancels;
- **the member's VTA**: holds the ticket and builds the cast; all PCS crypto happens there;
- **the ballot box** (`vti-voting-service`): counts one ballot per ticket and publishes the result.

This client only carries the signed documents between them, byte for byte. The community never sees a ballot and the
ballot box never learns who cast it. Node and browser. DEV ONLY.

> **Not served by this kit's stack.** The pinned VTC is built without the `voting` feature, so `vtc/elections/*` is
> refused (`unsupportedType`), and the local stack runs no ballot box ([docs/VTC-SURFACE.md](../../docs/VTC-SURFACE.md)).
> Everything here is tested against the in-process mock (`./mock`). Running it live needs a VTC built with
> `--features voting` that trusts a provisioned ballot box. Design notes: [the plan](../../docs/plans/2026-11-07-polls-client-plan.md).

```ts
import { PollsClient, pollManifest, summarize, formatSummary } from "@buildathon/polls-client";

const manager = new PollsClient({ vtc });                        // a VtcClient whose signer holds vtc.elections.manage
const m = pollManifest({ community: vtc.vtcDid, ballotBox, question: "Lunch?", options: ["Pizza", "Sushi"], durationMinutes: 60 });
await manager.create(m);

const me = new PollsClient({ vtc, vta, contextId: "my-app", member }); // vta: an authenticated VtaClient with pcs-voter
await me.vote(m.electionId, ["Sushi"]);                          // option keys, labels or 1-based numbers
await manager.close(m.electionId);                               // early close; otherwise it closes at the deadline
console.log(formatSummary(summarize(await me.results(m.electionId), m)));
```

## What is in it

| | |
|---|---|
| `pollManifest(input)`, `validateManifest(m)` | Build a manifest for one choice question and check it against the `create/0.5` schema rules before signing. Settings: single or multiple choice (`multiple`, `maxSelections`), `optional` (abstain allowed), `opensAt`/`closesAt`/`durationMinutes`, `revote` (`replace`/`refuse`), `visibility` (`public`/`private` board, `auditors`), `resultsBeforeClose` (live totals), `allowEarlyClose`, `roll` (`members`, `listed`, ...), `binding`. Any raw manifest (ranking, score, text questions) can be passed to `create` too. |
| `buildBallot`, `validateSelections`, `resolveOptions` | A ballot with local checks: unknown option, too many or too few selections, abstaining on a required question. |
| `PollsClient` | Manager calls: `create`, `close`, `cancel`, `ballotBoxes`. Reads: `list`, `show`; with a VTA and `member` set, the VTA signs them as the member (`vta/pcs/voter/read`). Member calls: `takeTicket`, `vote` (register, issue, accept, vote, cast, receipt) and `results`. |
| `pollPhase`, `timeLeft`, `summarize`, `formatSummary` | Upcoming, open, closed or cancelled; time to the deadline; counts, percentages and the leading options. |
| `pollRefusal`, `explainPollRefusal`, `describePollError` | Split slug-scoped codes (`voting/ballot/cast:alreadyVoted`) and put them in plain words. |
| `POLL_TASK` | Every type URI used: create/0.5, list/0.5, show/0.6, close, cancel, tickets/issue/0.3, `vta/pcs/voter/*`, `vta/pcs/vote/0.4`, `voting/ballot/cast/0.1`, `voting/result/show/0.1`. |
| `@buildathon/polls-client/mock` | `startPollsMock()`: one `node:http` server that plays all three parties. It enforces the rules (who may manage, the ticket window, one ticket each, revote, early close, `notTallied`, private boards, rolls) but checks **no cryptography**. Node only. |

## Semantics worth knowing

- **One ballot per ticket.** A second vote is `replaced` under `revote: "replace"` and refused with `alreadyVoted`
  under `"refuse"`. Re-sending the same ballot is `alreadyCounted`.
- **Results** come after the deadline or an early close (a manager can close early only if `allowEarlyClose`). Before
  then `results` is refused with `notTallied`, unless `resultsBeforeClose` is set, which gives `provisional: true`.
- **Cast delay.** `vote` waits a random 0 to 20 s before casting, as upstream does, so the ticket and the cast cannot be
  paired by time. Set `castDelayMs: 0` in tests. Upstream also advises taking the ticket (`takeTicket`) in an earlier
  session than the vote.
- **Secrecy.** Only `open` is supported. `sealed` and `talliedEncrypted` need `vote-encrypted` and trustees.

## Verified and not

| What | Status |
|---|---|
| Manifest and ballot rules, phase, summary, refusal decoding | Unit tests (`npm test -w @buildathon/polls-client`) |
| Exact task types, recipients, pass-through of server JSON, ticket skip, receipt best effort | Client tests with a fake `fetch` |
| Full create, vote, revote, close and results flow, and the error paths | Integration test over real HTTP against the mock, plus `npm run demo -w @buildathon/polls` |
| A real VTC, VTA or ballot box; PCS tickets and casts; `pcs-voter` and `vtc.elections.manage` grants; ballot box URL from a real DID document | **Not verified live** (see the banner above) |
| Which member DID to use | **Unverified.** The VTA must hold that DID's key and the community must know it as a member. The kit's app `did:key` key is not held by the VTA. Set `member` (CLI: `POLL_MEMBER_DID`). |
