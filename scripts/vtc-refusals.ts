// Read refusals: the same signed calls as a stranger (fresh did:key) and as your app identity.
// The VTC decides by the signer's records at the moment of the call (see docs/VTC-SURFACE.md).
//   npm run vtc:refusals
import "./lib/cli.js";
import { TT, newIdentity } from "@buildathon/vta-client";
import { memberIdentity } from "./lib/member.js";
import { TrustTaskError, VtcClient } from "@buildathon/vtc-client";
import { die, env, reachable, vtcUrl } from "./env.js";

const cred = env("VTA_CREDENTIAL");
if (!cred) die("no VTA_CREDENTIAL in .env. Run `npm run up` first.");
const url = vtcUrl();
const callers = {
  stranger: newIdentity(),
  "app identity": memberIdentity(cred),
};
const tasks = [
  "vtc/join-requests/manifest/0.4", // public
  "vtc/community/profile/show/0.1", // members and admins
  "vtc/members/list/0.2", // admins only
  "auth/whoami/0.1", // admin sessions only
];
console.log(`community at ${url}`);
for (const [who, me] of Object.entries(callers)) {
  const vtc = await reachable("VTC", url, () => VtcClient.connect(url, me, undefined, env("VTC_DID")));
  console.log(`\n${who} (${me.did.slice(0, 20)}...)`);
  for (const t of tasks) {
    try {
      await vtc.call(`${TT}/${t}`, {});
      console.log(`  answered   ${t}`);
    } catch (e) {
      if (!(e instanceof TrustTaskError)) throw e;
      const p = (e.body as any)?.payload;
      console.log(`  refused    ${t}  ${p?.code ?? "?"}: ${String(p?.message ?? "").slice(0, 70)}`);
    }
  }
}
