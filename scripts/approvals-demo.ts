// "Approve on a second device", software approver first. As the VTA admin (the requester), try a task that the seeded consent
// rule gates (vta/contexts/update/1.0). The VTA refuses with auth:consent_required; this prints the match code, writes the
// refusal to .vta/refusal.json for the approver, and waits. Approve from a second terminal with `npm run approver`, or pass
// --self-approve to let this script play the approver too (one laptop, no human comparison: for tests and demos only).
import "./lib/cli.js";
import { existsSync, writeFileSync } from "node:fs";
import { TASK_CONTEXT_UPDATE, VtaClient, buildDecision, extractRequests, fetchVtaDocument, submitDecision, verifyConsentRequest, withConsent } from "@buildathon/vta-client";
import { devBanner } from "./banner.js";
import { die, env, loadAdmin, mode, reachable } from "./env.js";
import { APPROVER_FILE, loadApprover } from "./lib/approver.js";

devBanner();
if (mode() === "farm") die("the approvals demo needs your own VTA (MODE=local or MODE=tunnel). See docs/APPROVALS.md.");
const url = env("VTA_URL") ?? "http://localhost:8100";
const context = env("VTA_CONTEXT") ?? "my-app";
const self = process.argv.includes("--self-approve");
const phone = process.argv.includes("--phone");
if (phone && self) die("--phone and --self-approve cannot be combined: the phone is the approver.");
const admin = loadAdmin();
const vta = await reachable("VTA", url, () => VtaClient.connect(url, admin));
await vta.authenticate();
// --phone: a phone wallet approves over messaging. The software approver (a laptop fallback) is only granted if its key exists.
if (!phone || existsSync(APPROVER_FILE)) {
  const approver = loadApprover();
  if (await vta.grantApprover(approver.did, "demo software approver")) console.log(`gave the approver a minimal monitor entry (REST needs one to open a session): ${approver.did}`);
}
console.log(`requester: ${admin.did}\nrequesting: ${TASK_CONTEXT_UPDATE} on context "${context}"`);

let result;
const name = `My App (approved ${new Date().toISOString().slice(11, 19)})`;
try {
  result = await withConsent(() => vta.call(TASK_CONTEXT_UPDATE, { id: context, name }), {
  timeoutMs: Number(process.env.APPROVAL_TIMEOUT_MS ?? 300_000),
  onChallenge: async (c) => {
    console.log(`\nWAITING FOR APPROVAL   match code: ${c.matchCode}   (${c.minApprovals} of set "${c.approverSet}")`);
    if (!c.requests.length) console.log("the refusal carried no request documents; the approver relies on the VTA's own push (messaging), which is off in this mode.");
    writeFileSync(".vta/refusal.json", JSON.stringify({ details: { consentRequests: c.requests } }, null, 2), { mode: 0o600 });
    if (phone) { console.log("Check the phone: it should show this request and the same match code. Compare, then approve or deny there."); return; }
    if (!self) { console.log("Second terminal:  npm run approver        (type the code above when asked)"); return; }
    const me = loadApprover();
    const doc = await fetchVtaDocument(url);
    const mine = extractRequests({ details: { consentRequests: c.requests } }).find((r: any) => r.recipient === me.did);
    if (!mine) throw new Error("no request addressed to the demo approver; is APPROVER_DID the one in .env, and was the stack created after approvals:setup?");
    const v = verifyConsentRequest(mine, { vtaDid: doc.id, approverDid: me.did, vtaDocument: doc });
    if (v.matchCode !== c.matchCode) throw new Error("the approver's code differs from the requester's; stopping");
    const token = await (await VtaClient.connect(url, me, undefined, doc.id)).authenticate();
    const r = await submitDecision(url, buildDecision(v, me, doc.id, { approve: true, typedCode: v.matchCode }), token);
    console.log(`--self-approve: decision sent -> ${r.reply.kind} (HTTP ${r.status}) ${JSON.stringify(r.body?.payload)}`);
  },
});
} catch (e) {
  die((e as Error).message);
}
console.log("\napproved and executed:", JSON.stringify(result));
