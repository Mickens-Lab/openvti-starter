// Mint the throwaway software approver (a second did:key) BEFORE the VTA first boots, and tell compose about it.
// The VTA entrypoint then seeds a consent rule (docs/APPROVALS.md). If a stack already exists, run `npm run reset` (it also deletes this key), THEN this script:
// the seed is applied once, on a volume's first boot.
import "./lib/cli.js";
import { existsSync } from "node:fs";
import { newIdentity } from "@starter/vta-client";
import { devBanner } from "./banner.js";
import { die, mode, updateEnv } from "./env.js";
import { APPROVER_FILE, saveApprover } from "./lib/approver.js";

devBanner();
if (mode() === "farm") die("the approvals demo needs your own VTA (MODE=local or MODE=tunnel); a hosted VTA is configured in its portal. See docs/APPROVALS.md.");
if (existsSync(APPROVER_FILE) && !process.argv.includes("--new")) {
  console.log(`${APPROVER_FILE} exists; keeping it (use --new for a fresh approver).`);
} else {
  saveApprover(newIdentity());
}
const { did } = (await import("./lib/approver.js")).loadApprover();
// --approver-did <did>: a phone wallet's DID. The approver set then holds the phone first and the software approver second,
// so `npm run approver` still works as a laptop fallback.
const i = process.argv.indexOf("--approver-did");
const phone = i < 0 ? undefined : process.argv[i + 1];
if (i >= 0 && (!phone || phone.startsWith("--") || /[\s,"]/.test(phone))) die("--approver-did needs one DID (no spaces, commas or quotes).");
updateEnv({ APPROVER_DID: phone ? `${phone},${did}` : did });
if (phone) console.log(`phone approver DID: ${phone}`);
console.log(`software approver DID: ${did}`);
console.log(`wrote ${APPROVER_FILE} (private key, git-ignored) and APPROVER_DID to .env`);
console.log("next: npm run up (on a fresh stack: after `npm run reset` if one exists), then npm run approvals:demo");
