// Admin helper: list pending join requests and approve them (or one id).
// Needs an ADMIN ACL entry at the VTC for the key in .vta/admin.json.
// Local: `npm run vtc:up` seeds that entry. Farm: the farm VTC's admin is a
// different DID claimed with a passkey in the browser, so approve in the VTC
// admin console instead (see docs/FARM.md); this script will answer 403.
import "./lib/cli.js";
import { TrustTaskError } from "@starter/vta-client";
import { VtcClient } from "@starter/vtc-client";
import { die, env, loadAdmin, reachable, refusal, vtcUrl } from "./env.js";

const url = vtcUrl();
const vtc = await reachable("VTC", url, () => VtcClient.connect(url, loadAdmin(), undefined, env("VTC_DID")));
try {
  const only = process.argv[2];
  const { items } = await vtc.listJoinRequests({ status: "pending" });
  console.log(`${items.length} pending`);
  for (const r of items) {
    const id = r.id ?? r.requestId;
    if (only && only !== id) continue;
    const who = r.applicant ?? r.applicantDid ?? "?";
    if (who === vtc.me.did) console.warn(`warning: ${who} is applying and approving its own request (same key as the admin); use a separate key per role, see docs/ROLES.md. Continuing.`);
    try {
      await vtc.decideJoin(id, "approved");
      console.log(`approved ${id} (${who})`);
    } catch (e) {
      // One bad request (e.g. a duplicate from an applicant that is already a member) must not block the rest.
      if (!(e instanceof TrustTaskError) || e.status === 403) throw e;
      console.log(`could not approve ${id} (${who}): ${refusal(e.body)}`);
    }
  }
} catch (e) {
  if (e instanceof TrustTaskError) die(`the VTC refused (HTTP ${e.status}): ${refusal(e.body)}${e.status === 403 ? `\nThe admin DID ${vtc.me.did} needs an admin ACL entry at the VTC (a stale VTC volume from an earlier \`reset\` does this; reset with \`docker compose --profile vtc down -v\`).` : ""}`);
  throw e;
}
