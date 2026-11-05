// VTC checkpoint: resolve the community DID, read its public join manifest.
// No membership needed. Then report the app identity's latest join request, if any.
import "./lib/cli.js";
import { newIdentity } from "@buildathon/vta-client";
import { memberIdentity } from "./lib/member.js";
import { TrustTaskError, VtcClient } from "@buildathon/vtc-client";
import { env, mode, reachable, vtcUrl } from "./env.js";

const url = vtcUrl();
const cred = env("VTA_CREDENTIAL");
const me = cred ? memberIdentity(cred) : newIdentity();
const vtc = await reachable("VTC", url, () => VtcClient.connect(url, me, undefined, env("VTC_DID")));
console.log(`1. VTC DID        ${vtc.vtcDid}   (MODE=${mode()})`);

const m = await vtc.manifest();
console.log(`2. join manifest  ${m.criteria.length} criteria`);
for (const c of m.criteria) console.log(`   - ${c.id}: admission=${c.admission} digest=${c.requirementsDigest}`);
if (m.requestedAttributes?.length) console.log(`   requested attributes: ${m.requestedAttributes.map((a) => `${a.type}${a.required ? "*" : ""}`).join(", ")}`);

if (!cred) {
  console.log("3. membership     skipped (no VTA_CREDENTIAL; run `npm run up`)");
} else {
  // A signed join-requests/status needs no session. (`auth/authenticate` + `whoami`
  // are not used: a plain did:key member gets "authentication failed" there, see docs/VTC.md.)
  try {
    const s = await vtc.joinStatus();
    console.log(`3. membership     ${me.did}: latest join request ${s.requestId} is ${s.status}`);
  } catch (e) {
    if (!(e instanceof TrustTaskError)) throw e;
    console.log(`3. membership     ${me.did} has no join request yet (HTTP ${e.status}: ${JSON.stringify((e.body as any)?.payload?.message ?? e.body)}). Run \`npm run vtc:join\`.`);
  }
}
