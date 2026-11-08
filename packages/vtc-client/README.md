# @starter/vtc-client

The same idea as [vta-client](../vta-client/README.md) for a community (VTC): signed Trust Tasks to the VTC, plus the join flow and the member helpers. A member is sessionless:
every request is signed, there is no console session. Node and browser. DEV ONLY.

```ts
import { decodeCredential, identityFromCredential } from "@starter/vta-client";
import { VtcClient } from "@starter/vtc-client";

const me = identityFromCredential(decodeCredential(process.env.VTA_CREDENTIAL!));   // the app did:key your VTA granted access
const vtc = await VtcClient.connect("http://localhost:8200", me);

console.log((await vtc.manifest()).criteria);        // the public join manifest: which criteria, which admission
console.log(vtc.joinPayload());                      // preview the signed request before it is sent
await vtc.submitJoin({ /* criterion, name, ... */ });
console.log(await vtc.joinStatus());                 // pending, approved, rejected ...
```

## What is in it

| | |
|---|---|
| `manifest()`, `submitJoin()`, `joinPayload()`, `joinStatus()`, `withdrawJoin()`, `supplementJoin()` | Apply, preview, poll, withdraw. `pickCriterion(manifest)` chooses one. |
| `memberProof()`, `myCard()`, `updateMyCard()`, `renewMembership()`, `leaveCommunity({ confirm: true })` | As a member. |
| `sendMembershipCredential()`, `memberVmc()`, `signCredential()` | Send your own membership credential back (`vtc/members/vmc/0.1`): a DTG `MembershipCredential` you issue, naming the community, signed like every Trust Task. Pass `{ grant }` (the community's MembershipCredential from the `credential-exchange/issue` frame: `membershipGrantOf(doc, memberDid, communityDid)`) and it is bound to it (`digestMultibase`, `validUntil` capped; `MemberVmcNotPossible` for a grant it cannot acknowledge), so the community completes the pair; without it, no digest, so the community stores it unbound. Either turns the join status's `credentialsDelivered` true ([docs/MESSAGING.md](../../docs/MESSAGING.md#what-credentialsdelivered-means)). The unbound send is verified live 2026-10-30 (one machine, one run) through the community dashboard. |
| `communityProfile()`, `directoryEntries()`, `groups()`, `joinGroup()`, ... | What a member can read; who may call what is in [docs/VTC-SURFACE.md](../../docs/VTC-SURFACE.md). |
| `listJoinRequests()`, `decideJoin(id, "approved")`, `listMembers()` | Admin only. |
| `call(type, payload)` | Any VTC task by type URI. Refusals throw `TrustTaskError`; `refusalCode(body)` extracts the code. |
| `onCall` | `vtc.onCall = (e) => ...` reports every call (the dashboard's "Under the hood" log uses it). |

Every call also goes to the shared trace (`TRACE=1 npm run ...`, then `npm run trace`). Examples: `scripts/vtc-*.ts` in the repo root, [templates/community-dashboard](../../templates/community-dashboard), [docs/VTC.md](../../docs/VTC.md).
