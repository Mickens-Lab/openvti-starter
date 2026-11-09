// Role matrix contract test (LIVE: needs your own stack, `WITH_VTC=1 npm run up` (MODE=local or MODE=tunnel); not part of `npm test`).
//   npm run test:roles
// Probes safe READ tasks as four callers and asserts who-can-call-what as written in docs/VTC-SURFACE.md:
//   stranger (fresh did:key), applicant (pending request), member (approved), admin (.vta/admin.json).
// Mutations: one throwaway applicant applies, the admin approves it, and it leaves at the end (the community keeps a
// tombstoned entry for it). Your own app identity in .env is not touched. Calls are paced to the admission budgets.
import "./lib/cli.js";
import { TT, newIdentity, type Identity } from "@starter/vta-client";
import { TrustTaskError, VtcClient, pickCriterion } from "@starter/vtc-client";
import { env, loadAdmin, vtcUrl } from "./env.js";
import { MATRIX, type Persona } from "./lib/live-matrix.js";
import { anonymousPacer, knownPacer, skip, stackProblem } from "./lib/live.js";

const problem = await stackProblem();
if (problem) skip("test:roles", problem);

const url = vtcUrl();
const connect = (id: Identity) => VtcClient.connect(url, id, undefined, env("VTC_DID"));

type Outcome = "ok" | "notFound" | "refused" | `other: ${string}`;
async function probe(vtc: VtcClient, task: string): Promise<Outcome> {
  try { await vtc.call(`${TT}/${task}`, {}); return "ok"; } catch (e) {
    if (!(e instanceof TrustTaskError)) throw e;
    const p = (e.body as any)?.payload ?? {};
    const text = `${p.code ?? ""} ${p.message ?? ""}`;
    if (/notfound/i.test(text) || e.status === 404) return "notFound";
    if (e.status === 429) throw new Error(`rate limited on ${task}: the pacing is too fast for this VTC (${text})`);
    if (e.status === 403 || /permissiondenied|notmember|holds no entry|notpermitted|not in acl|unauthori[sz]ed/i.test(text)) return "refused";
    return `other: HTTP ${e.status} ${text.trim().slice(0, 80)}`;
  }
}

const failures: string[] = [];
let checks = 0;
async function runPersona(persona: Persona, id: Identity, pacer: { next(): Promise<void> }) {
  const vtc = await connect(id);
  for (const row of MATRIX) {
    const want = row.expect[persona];
    if (!want) continue;
    await pacer.next();
    const got = await probe(vtc, row.task);
    checks++;
    const ok = want.includes(got as any);
    console.log(`  ${ok ? "ok  " : "FAIL"} ${persona.padEnd(9)} ${row.task.padEnd(34)} got ${got}${ok ? "" : `, expected ${want.join(" or ")}`}`);
    if (!ok) failures.push(`${persona} ${row.task}: got ${got}, expected ${want.join(" or ")}`);
  }
}

const anon = anonymousPacer();
const known = knownPacer();
const admin = loadAdmin();
const adminClient = await connect(admin);
const applicant = newIdentity();
const applicantClient = await connect(applicant);
let requestId: string | undefined;
let joined = false;
try {
  console.log("stranger (fresh did:key, no request)");
  await runPersona("stranger", newIdentity(), anon);

  const m = await applicantClient.manifest();
  const crit = pickCriterion(m);
  const wanted = m.requestedAttributes ?? [];
  const attributes = wanted.some((a) => a.type === "name.display") ? [{ type: "name.display", value: "roles-test" }] : [];
  await anon.next();
  requestId = (await applicantClient.submitJoin({ criterion: crit?.requirementsDigest, attributes })).requestId;
  console.log("applicant (pending request)");
  await runPersona("applicant", applicant, anon);

  await known.next();
  await adminClient.decideJoin(requestId, "approved");
  joined = true;
  console.log("member (approved)");
  await runPersona("member", applicant, known);

  console.log("admin (.vta/admin.json)");
  await runPersona("admin", admin, known);
} finally {
  if (joined) { try { await applicantClient.leaveCommunity({ confirm: true }); } catch (e) { console.error("cleanup: throwaway member could not leave:", (e as Error).message); } }
  else if (requestId) { try { await applicantClient.withdrawJoin({ requestId }); } catch { /* best effort */ } }
}

if (failures.length) {
  console.error(`\ntest:roles FAILED: ${failures.length} of ${checks} probes differ from docs/VTC-SURFACE.md\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`\ntest:roles ok: ${checks} probes match docs/VTC-SURFACE.md`);
