// The software approver ("second device"): verify a VTA-signed consent request, compare the match code, sign a decision.
// Usage: npm run approver -- [refusal.json | -] [--match-code <code>] [--deny [reason]]
// The request comes from the requester's refusal (npm run approvals:demo writes .vta/refusal.json). Without --match-code
// it asks you to type the code shown on the requester's screen. This is a second KEY on the same machine: it demonstrates the
// protocol, not the security of a second device (docs/APPROVALS.md, docs/MOBILE-WALLET.md).
import "./lib/cli.js";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { VtaClient, buildDecision, extractRequests, fetchVtaDocument, submitDecision, verifyConsentRequest } from "@starter/vta-client";
import { devBanner } from "./banner.js";
import { die, env, mode, reachable } from "./env.js";
import { loadApprover } from "./lib/approver.js";
import { describeRequest } from "./lib/approvals.js";

devBanner();
const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); return i < 0 ? undefined : args[i + 1]; };
const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--match-code" && args[i - 1] !== "--deny") ?? ".vta/refusal.json";
const deny = args.includes("--deny");
if (mode() === "farm") die("the approvals demo needs your own VTA (MODE=local or MODE=tunnel). See docs/APPROVALS.md.");
const url = env("VTA_URL") ?? "http://localhost:8100";
const me = loadApprover();
const input = JSON.parse(file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8"));
const mine = extractRequests(input).filter((r: any) => r.recipient === me.did);
if (!mine.length) die(`no consent request addressed to ${me.did} in ${file}. Run \`npm run approvals:demo\` first.`);

const doc = await reachable("VTA", url, () => fetchVtaDocument(url));
const v = verifyConsentRequest(mine[0], { vtaDid: doc.id, approverDid: me.did, vtaDocument: doc });
console.log(describeRequest(v));

let decision;
if (deny) {
  decision = buildDecision(v, me, doc.id, { approve: false, reason: flag("--deny") && !flag("--deny")!.startsWith("--") ? flag("--deny") : "denied by approver" });
} else {
  let code = flag("--match-code");
  if (!code) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    code = await rl.question("Type the code shown on the requester's screen to approve (Enter to refuse): ");
    rl.close();
    if (!code.trim()) { console.log("not approved."); process.exit(0); }
  }
  try { decision = buildDecision(v, me, doc.id, { approve: true, typedCode: code }); } catch (e) { die((e as Error).message); }
}
const session = await reachable("VTA", url, () => VtaClient.connect(url, me, undefined, doc.id));
let token: string;
try { token = await session.authenticate(); } catch { die(`the VTA would not open a session for the approver ${me.did} (REST needs an ACL entry; \`npm run approvals:demo\` grants one). See docs/APPROVALS.md.`); }
const r = await submitDecision(url, decision, token);
const p = r.body?.payload;
if (r.reply.kind !== "response") die(`the VTA did not accept the decision (${r.reply.kind}, HTTP ${r.status}): ${JSON.stringify(p ?? r.body)}`);
console.log(`decision sent: ${deny ? "deny" : "approve"} -> ${p?.status ?? JSON.stringify(p)}${p?.needed ? ` (${p.approvals ?? 0}/${p.needed})` : ""}`);
