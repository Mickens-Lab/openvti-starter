// Ping the VTA over TSP from a throwaway did:key (MODE=tunnel stack): `npm run tsp:ping`.
import "./lib/cli.js";
import { decodeCredential, seedFromMultibase } from "@starter/vta-client";
import { describePong, tspPing } from "@starter/tsp-client";
import { readTunnel } from "./lib/compose.js";
import { env } from "./env.js";

const state = readTunnel();
const vtaDid = process.env.VTA_DID ?? env("VTA_DID");
const mediatorDid = process.env.MEDIATOR_DID ?? state?.mediatorDid;
if (!state || !vtaDid || !mediatorDid) {
  console.error("tsp:ping needs a running MODE=tunnel stack (.vta/tunnel.json and .env). Start it with: npm run up -- --tunnel");
  process.exit(1);
}
// The app's own did:key (it is on the VTA's ACL); `--throwaway` uses a fresh DID that the VTA will refuse (403).
const cred = env("VTA_CREDENTIAL");
const seed = process.argv.includes("--throwaway") || !cred ? undefined : seedFromMultibase(decodeCredential(cred).privateKeyMultibase);
try {
  const r = await tspPing({ vtaDid, mediatorDid, ...(seed ? { seed } : {}), log: (l) => console.log(`  ${l}`) });
  console.log(describePong(r));
} catch (e) {
  console.error(`TSP ping FAILED: ${(e as Error).message}`);
  console.error("If the VTA log (docker compose logs vta) shows the ping dispatched with status 200 but \"failed to send TSP reply ... unsupported TSP major version\",");
  console.error("the request arrived and the mediator refused the VTA's answer: a TSP version mismatch between VTA and mediator (use the pinned mediator, docs/MESSAGING.md).");
  process.exit(1);
}
