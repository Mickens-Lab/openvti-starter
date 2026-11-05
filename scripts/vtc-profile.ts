// What a member can read about the community and itself, all as signed documents (no session):
// community profile, the member's own directory card, the directory fields, who is in the directory,
// the groups it can see. An applicant or non-member is refused with a code; see docs/VTC-SURFACE.md.
//   npm run vtc:profile
import "./lib/cli.js";
import { memberIdentity } from "./lib/member.js";
import { TrustTaskError, VtcClient } from "@buildathon/vtc-client";
import { die, env, reachable, refusal, vtcUrl } from "./env.js";

const cred = env("VTA_CREDENTIAL");
if (!cred) die("VTA_CREDENTIAL not set. Run `npm run up` first.");
const url = vtcUrl();
const me = memberIdentity(cred);
const vtc = await reachable("VTC", url, () => VtcClient.connect(url, me, undefined, env("VTC_DID")));
console.log(`member ${me.did} -> ${vtc.vtcDid}`);

const show = async (label: string, fn: () => Promise<unknown>) => {
  try {
    console.log(`\n${label}\n${JSON.stringify(await fn(), null, 1).slice(0, 700)}`);
  } catch (e) {
    if (!(e instanceof TrustTaskError)) throw e;
    console.log(`\n${label}\n  refused (HTTP ${e.status}): ${refusal(e.body)}`);
  }
};
await show("community profile", () => vtc.communityProfile());
await show("my directory card", () => vtc.myCard());
await show("directory fields", () => vtc.directoryFields());
await show("directory entries", () => vtc.directoryEntries({ limit: 10 }));
await show("groups", () => vtc.groups({}));
