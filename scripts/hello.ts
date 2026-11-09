// The checkpoint: discover, authenticate, make one signed call.
import "./lib/cli.js";
import { VtaClient } from "@starter/vta-client";
import { die, env, mode, reachable } from "./env.js";

const cred = env("VTA_CREDENTIAL");
if (!cred) {
  die(
    mode() === "farm"
      ? "VTA_CREDENTIAL not set. Run `npm run farm:setup`, finish the portal steps, then `npm run vta:provision`. See docs/FARM.md."
      : "VTA_CREDENTIAL not set. Run `npm run up` (or `npm run vta:provision`) first.",
  );
}

const url = env("VTA_URL") ?? "";
const vta = await reachable("VTA", url, () => VtaClient.fromCredential(cred, env("VTA_URL"), undefined, { resolveDid: mode() !== "farm" }));
console.log(`1. VTA DID        ${vta.vtaDid}   (MODE=${mode()})`);

await vta.authenticate();
console.log(`2. authenticated  as ${vta.me.did}`);

console.log(`3. discovery      ${(await vta.discover()).length} supported Trust Tasks`);

console.log("4. signed call    auth/whoami ->", JSON.stringify(await vta.whoami()));
