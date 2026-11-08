// The throwaway software approver's key file; Node only. Guidance: this is a second key on the SAME machine, so it models the
// protocol, not the security of a second device (docs/APPROVALS.md).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { identityFromSeed, seedFromMultibase, seedToMultibase, type Identity } from "@starter/vta-client";

export const APPROVER_FILE = ".vta/approver.json";

export function saveApprover(id: Identity, file = APPROVER_FILE): void {
  mkdirSync(".vta", { recursive: true });
  writeFileSync(file, JSON.stringify({ did: id.did, privateKeyMultibase: seedToMultibase(id.seed) }, null, 2), { mode: 0o600 });
}

export function loadApprover(file = APPROVER_FILE): Identity {
  if (!existsSync(file)) throw new Error(`${file} not found. Run \`npm run approvals:setup\` first.`);
  return identityFromSeed(seedFromMultibase(JSON.parse(readFileSync(file, "utf8")).privateKeyMultibase));
}
