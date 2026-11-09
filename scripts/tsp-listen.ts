// Listen on the mediator socket as the applicant and log every TSP frame that reaches it:
//   npm run tsp:listen [-- --peer <did>] [--seconds 90] [--relate] [--until-issue 2]
// The applicant is the same one vtc:join and the dashboard apply as: in MODE=tunnel the did:peer:2 naming the mediator, or
// the app did:key with VTC_APPLICANT=did:key (or when the did:peer cannot be built; the note says why). Default peer is the VTC (VTC_DID). Used for the credential-push experiment in docs/MESSAGING.md: start this,
// then in another shell run `npm run vtc:join` and `npm run vtc:approve`, and see whether `credential-exchange/issue/0.1` arrives.
// A did:key first sends the VTC a relationship invite (the VTC learns it speaks TSP from that); a did:peer does not, unless --relate,
// because its DID already names the mediator. Exit code 0 when an issue frame arrived, 2 when none did. Read-only.
import "./lib/cli.js";
import { connectTsp, type PeerIdentity } from "@starter/tsp-client";
import { decodeCredential, seedFromMultibase } from "@starter/vta-client";
import { readTunnel } from "./lib/compose.js";
import { applicant, applicantOverride } from "./lib/applicant.js";
import { emptyTally, record, verdict, ISSUE_TYPE } from "./lib/listen.js";
import { die, env, mode } from "./env.js";

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const state = readTunnel();
const cred = env("VTA_CREDENTIAL");
// The VTC's DID: --peer, VTC_DID, or the did:webvh its public host serves.
async function vtcDid(): Promise<string | undefined> {
  const url = env("VTC_URL");
  if (!url) return undefined;
  try { return /"id":"(did:webvh:[^"#]+)"/.exec(await (await fetch(`${url}/.well-known/did.jsonl`)).text())?.[1]; } catch { return undefined; }
}
const peer = arg("peer") ?? env("VTC_DID") ?? (await vtcDid());
if (!state?.mediatorDid || !cred || !peer) {
  console.error("tsp:listen needs a MODE=tunnel stack with a VTC (npm run up -- --tunnel) and a provisioned app (.env).");
  process.exit(1);
}
const who = (() => {
  try {
    return applicant(seedFromMultibase(decodeCredential(cred).privateKeyMultibase), { mode: mode(), mediatorDid: state.mediatorDid, override: applicantOverride(env("VTC_APPLICANT")) });
  } catch (e) {
    return die((e as Error).message);
  }
})();
const seconds = Number(arg("seconds") ?? 90);
const untilIssue = Number(arg("until-issue") ?? 0);
const relate = who.kind === "did:key" || process.argv.includes("--relate");
const c = await connectTsp({
  vtaDid: peer, mediatorDid: state.mediatorDid, log: (l) => console.log(`  ${l}`),
  ...(who.kind === "did:peer" ? { identity: who.identity as PeerIdentity } : { seed: who.identity.seed }),
});
console.log(who.note);
let tally = emptyTally();
let done: () => void = () => {};
const finished = new Promise<void>((r) => { done = r; });
c.conn.onInboundTsp(async (bytes) => {
  try {
    const m = await c.session.open(bytes);
    if (m.control) {
      console.log(`frame from the peer: relationship ${m.control.controlType}`);
      tally = record(tally, { control: m.control.controlType });
      return;
    }
    const doc = (JSON.parse(new TextDecoder().decode(m.payload)) as { document?: { type?: string } }).document;
    console.log(`frame from the peer: ${doc?.type ?? "(no document type)"}`);
    tally = record(tally, { documentType: doc?.type });
    if (doc?.type === ISSUE_TYPE && untilIssue > 0 && tally.issues >= untilIssue) done();
  } catch (e) {
    console.log(`frame (${bytes.length} bytes) that is not from the peer or not readable: ${(e as Error).message}`);
    tally = record(tally, { unreadable: (e as Error).message });
  }
});
if (relate) {
  await c.session.relate(5000).then(() => console.log("relationship accepted by the peer"), (e) => console.log(`no accept from the peer: ${(e as Error).message}`));
}
console.log(`listening for up to ${seconds} s as ${c.did} ...`);
await Promise.race([finished, new Promise((r) => setTimeout(r, seconds * 1000))]);
c.close();
console.log(verdict(tally, { method: who.kind, related: relate }));
process.exit(tally.issues > 0 ? 0 : 2);
