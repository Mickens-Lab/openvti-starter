// "Where do I stand?" for the app identity, with no session: the signed join status, and, once
// admitted, the member portal proof (`/v1/member/me`: role, joinedAt, personhood).
//   npm run vtc:status
import "./lib/cli.js";
import { memberIdentity } from "./lib/member.js";
import { TrustTaskError, VtcClient } from "@starter/vtc-client";
import { die, env, reachable, refusal, vtcUrl } from "./env.js";

const cred = env("VTA_CREDENTIAL");
if (!cred) die("VTA_CREDENTIAL not set. Run `npm run up` first.");
const url = vtcUrl();
const me = memberIdentity(cred);
const vtc = await reachable("VTC", url, () => VtcClient.connect(url, me, undefined, env("VTC_DID")));
console.log(`identity  ${me.did}\ncommunity ${vtc.vtcDid}`);

try {
  const s = await vtc.joinStatus();
  console.log(`join      request ${s.requestId} is ${s.status}`);
  const d = (s as { credentialsDelivered?: unknown }).credentialsDelivered;
  if (typeof d === "boolean") console.log(`delivery  credentialsDelivered=${d}${d ? " (the community holds a membership credential this identity sent back; docs/MESSAGING.md)" : " (true only once this identity sends its own membership credential back, e.g. the dashboard's \"Send my membership credential back\"; pushed frames do not set it; docs/MESSAGING.md)"}`);
} catch (e) {
  if (!(e instanceof TrustTaskError)) throw e;
  console.log(`join      ${refusal(e.body)}`);
}
try {
  const m = await vtc.memberProof();
  console.log(`member    yes: role=${m.role} joinedAt=${m.joinedAt} personhood=${m.personhood} (community "${m.community.name ?? "unnamed"}")`);
} catch (e) {
  if (!(e instanceof TrustTaskError)) throw e;
  console.log(`member    no (HTTP ${e.status}: ${refusal(e.body)})`);
}
