// Withdraw the app identity's open join request (an applicant action; a member cannot).
//   npm run vtc:withdraw [-- --reason "text"]
import "./lib/cli.js";
import { memberIdentity } from "./lib/member.js";
import { TrustTaskError, VtcClient } from "@starter/vtc-client";
import { die, env, reachable, refusal, vtcUrl } from "./env.js";

const i = process.argv.indexOf("--reason");
const reason = i > 0 ? process.argv[i + 1] : undefined;
const cred = env("VTA_CREDENTIAL");
if (!cred) die("VTA_CREDENTIAL not set. Run `npm run up` first.");
const url = vtcUrl();
const me = memberIdentity(cred);
const vtc = await reachable("VTC", url, () => VtcClient.connect(url, me, undefined, env("VTC_DID")));
try {
  console.log("withdrawn:", JSON.stringify(await vtc.withdrawJoin({ reason })));
  console.log("Delete VTC_REQUEST_ID from .env before applying again.");
} catch (e) {
  if (e instanceof TrustTaskError) die(`the VTC refused (HTTP ${e.status}): ${refusal(e.body)}`);
  throw e;
}
