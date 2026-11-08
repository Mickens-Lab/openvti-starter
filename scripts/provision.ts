// As the admin: create a context, grant a fresh app did:key a context-scoped
// ACL entry, write the app's `.env` (merging, so MODE/VTC_* survive). Idempotent.
//
// MODE=local: the admin key from `npm run vta:keygen` is seeded by the compose VTA.
// MODE=tunnel: like local, but the VTA is reached at its public quick-tunnel URL (VTA_URL, set by `npm run up`).
// MODE=farm:  the same key must have been pasted into the VTA Farm portal as the
//             agent's "Admin DID" (see docs/FARM.md). Needs VTA_URL (+ VTA_DID).
import "./lib/cli.js";
import { existsSync } from "node:fs";
import {
  TrustTaskError,
  VtaClient,
  decodeCredential,
  encodeCredential,
  identityFromCredential,
  newIdentity,
  seedToMultibase,
} from "@starter/vta-client";
import { devBanner } from "./banner.js";
import { resolveFarmAgent } from "./farm-config.js";
import { ADMIN_FILE, ENV_FILE, LOCAL_VTA_URL, die, env, loadAdmin, mode, reachable, updateEnv } from "./env.js";

devBanner();
const m = mode();
if (m === "farm") for (const n of (await resolveFarmAgent()).notes) console.log(n);
const baseUrl = (process.env.VTA_URL ?? (m !== "local" ? env("VTA_URL") : undefined) ?? LOCAL_VTA_URL).replace(/\/+$/, "");
if (m === "farm" && !/^https:\/\//.test(baseUrl)) {
  die(`MODE=farm needs VTA_URL=https://vta-<name>.<domain> in ${ENV_FILE} (copy it from the VTA Farm portal), or set FARM=ic3|firstperson and FARM_AGENT=<name>. See docs/FARM.md.`);
}
if (m === "farm" && !existsSync(ADMIN_FILE)) {
  die(`${ADMIN_FILE} not found. Run \`npm run farm:setup\` first: it mints the admin DID you paste into the portal.`);
}
const context = process.argv[2] ?? process.env.VTA_CONTEXT ?? "my-app";
const role = process.env.APP_ROLE ?? "application";
if (!/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/.test(context)) {
  throw new Error(`context "${context}" must be a slug: lowercase letters, digits, hyphens`);
}

// Farm: trust a DID copied from the portal (a hosted VTA may publish its log on the
// farm's DID host, not at /.well-known/did.jsonl). Local: read it from the VTA.
const knownDid = m === "farm" ? env("VTA_DID") : undefined;
const admin = await reachable("VTA", baseUrl, () => VtaClient.connect(baseUrl, loadAdmin(), undefined, knownDid));
try {
  await reachable("VTA", baseUrl, () => admin.authenticate());
} catch (e) {
  if (e instanceof TrustTaskError) {
    die(
      `the VTA at ${baseUrl} refused the admin (HTTP ${e.status}): ${JSON.stringify(e.body)}\n` +
        (m === "farm"
          ? `Is ${admin.me.did} the "Admin DID" you gave the portal, and does the agent show "online"? A VTA older than the Trust Task door also answers 404 on /trust-tasks. See docs/FARM.md.`
          : "Run `npm run reset && npm run up` if you changed the admin key."),
    );
  }
  throw e;
}
console.log(`authenticated as admin ${admin.me.did}\nVTA DID: ${admin.vtaDid}`);

console.log((await admin.createContext(context)) ? `created context "${context}"` : `context "${context}" already exists`);

// Reuse the app identity from an existing .env for this context and this VTA.
let app = newIdentity();
if (existsSync(ENV_FILE) && env("VTA_CONTEXT") === context && env("VTA_CREDENTIAL")) {
  const c = decodeCredential(env("VTA_CREDENTIAL")!);
  if (c.vtaDid === admin.vtaDid) app = identityFromCredential(c);
}

console.log(
  (await admin.grantAcl(app.did, context, role))
    ? `granted ${role} on "${context}" to ${app.did}`
    : `ACL entry for ${app.did} already exists`,
);

const credential = encodeCredential({
  did: app.did,
  privateKeyMultibase: seedToMultibase(app.seed),
  vtaDid: admin.vtaDid,
  vtaUrl: baseUrl,
});
updateEnv({
  ...(m === "farm" ? { MODE: m } : {}),
  VTA_URL: baseUrl,
  VTA_DID: admin.vtaDid,
  VTA_CONTEXT: context,
  APP_DID: app.did,
  VTA_CREDENTIAL: credential,
});
console.log(`wrote ${ENV_FILE} (VTA_URL, VTA_DID, VTA_CONTEXT, APP_DID, VTA_CREDENTIAL)`);
