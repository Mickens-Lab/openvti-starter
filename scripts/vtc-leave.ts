// LEAVE the community as the app identity (members/self-remove). Immediate; needs --yes.
//   npm run vtc:leave -- --yes
import "./lib/cli.js";
import { memberIdentity } from "./lib/member.js";
import { TrustTaskError, VtcClient } from "@starter/vtc-client";
import { die, env, reachable, refusal, vtcUrl } from "./env.js";

if (!process.argv.includes("--yes")) die("this removes the app identity from the community immediately. Re-run with --yes.");
const cred = env("VTA_CREDENTIAL");
if (!cred) die("VTA_CREDENTIAL not set. Run `npm run up` first.");
const url = vtcUrl();
const me = memberIdentity(cred);
const vtc = await reachable("VTC", url, () => VtcClient.connect(url, me, undefined, env("VTC_DID")));
try {
  console.log("left:", JSON.stringify(await vtc.leaveCommunity({ confirm: true })));
} catch (e) {
  if (e instanceof TrustTaskError) die(`the VTC refused (HTTP ${e.status}): ${refusal(e.body)}`);
  throw e;
}
