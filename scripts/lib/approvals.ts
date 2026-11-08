// Plain-text rendering for the software approver. Pure, so it is unit-tested.
import type { VerifiedConsentRequest } from "@starter/vta-client";

/** What the approver sees. Never blank about effects: when the VTA gave none, say so (the spec forbids presenting that as "no effects"). */
export function describeRequest(v: VerifiedConsentRequest): string {
  const p = v.payload;
  const lines = [
    "",
    "Approval requested",
    `  task          ${p.taskType}${p.subject ? `  (on ${p.subject})` : ""}`,
    `  side effects  ${p.sideEffects}`,
    `  requested by  ${p.requester}`,
    `  needs         ${p.minApprovals} approval(s) from set "${p.approverSet}"${p.excludeRequester ? ", requester excluded" : ""}`,
    `  expires       ${v.expiresAt}`,
  ];
  if (v.effects.length) lines.push("  effects", ...v.effects.map((e) => `    - ${e}`));
  else lines.push("  effects       NOT DETERMINED: the VTA gave no dry-run result for this task. Do not read that as 'no effects'.");
  if (p.note) lines.push(`  note from the requester (untrusted, unverified): ${String(p.note)}`);
  lines.push("", `  MATCH CODE    ${v.matchCode}   (it must equal the code on the requester's screen)`, "");
  return lines.join("\n");
}
