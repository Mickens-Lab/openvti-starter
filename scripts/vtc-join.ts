// Apply to the VTC. MODE=tunnel: as a did:peer:2 from the app credential's seed that names the stack's mediator (the VTC
// then pushes the credential over TSP with no earlier contact; docs/MESSAGING.md). MODE=local/farm (or VTC_APPLICANT=did:key):
// as the app identity, the did:key your VTA granted an ACL entry.
// Then poll the request. Re-running reuses the saved request id.
//   npm run vtc:join [-- --criterion <requirementsDigest>] [--name "Display Name"]
import "./lib/cli.js";
import { decodeCredential, seedFromMultibase } from "@starter/vta-client";
import { VtcClient, pickCriterion } from "@starter/vtc-client";
import { TrustTaskError } from "@starter/vta-client";
import { existsSync, readFileSync } from "node:fs";
import { ADMIN_FILE, die, env, mode, reachable, refusal, updateEnv, vtcUrl } from "./env.js";
import { applicant, applicantOverride } from "./lib/applicant.js";
import { readTunnel } from "./lib/compose.js";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const cred = env("VTA_CREDENTIAL");
if (!cred) die("VTA_CREDENTIAL not set. Run `npm run up` (local) or `npm run farm:setup` + `npm run vta:provision` (farm) first.");

const url = vtcUrl();
const who = (() => {
  try {
    return applicant(seedFromMultibase(decodeCredential(cred).privateKeyMultibase), { mode: mode(), mediatorDid: readTunnel()?.mediatorDid, override: applicantOverride(env("VTC_APPLICANT")) });
  } catch (e) {
    return die((e as Error).message);
  }
})();
const me = who.identity;
const vtc = await reachable("VTC", url, () => VtcClient.connect(url, me, undefined, env("VTC_DID")));
if (existsSync(ADMIN_FILE) && JSON.parse(readFileSync(ADMIN_FILE, "utf8")).did === me.did) {
  console.warn("warning: this applicant key is the admin key; one identity should not both apply and approve. Use a separate persona (npm run roles:personas), see docs/ROLES.md. Continuing.");
}
console.log(`community ${vtc.vtcDid}\napplicant ${me.did}\n${who.note}`);

try {
  let requestId = env(who.requestIdKey);
  if (!requestId) {
    const m = await vtc.manifest();
    const criterion = arg("criterion") ?? pickCriterion(m)?.requirementsDigest;
    const name = arg("name");
    const wanted = m.requestedAttributes ?? [];
    const attributes = name && wanted.some((a) => a.type === "name.display") ? [{ type: "name.display", value: name }] : [];
    const missing = wanted.filter((a) => a.required !== false && !attributes.some((x) => x.type === a.type));
    if (missing.length) die(`the community requires attributes: ${missing.map((a) => a.type).join(", ")}. Pass --name "..." for name.display; others need code (see packages/vtc-client submitJoin).`);
    const r = await vtc.submitJoin({ criterion, attributes });
    requestId = r.requestId;
    updateEnv({ [who.requestIdKey]: requestId });
    console.log("submitted; verdict:", JSON.stringify(r.verdict));
  } else {
    console.log(`reusing request ${requestId} (delete ${who.requestIdKey} from .env to resubmit)`);
  }
  const s = await vtc.joinStatus(requestId);
  console.log("status:", JSON.stringify(s));
  if (s.status === "pending") console.log("pending: an administrator must approve it (`npm run vtc:approve`, or the VTC admin console).");
} catch (e) {
  if (e instanceof TrustTaskError) die(`the VTC refused (HTTP ${e.status}): ${refusal(e.body)}`);
  throw e;
}
