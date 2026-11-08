// Practise "one key per role": throwaway applicant / member / admin identities under .vta/personas/ (git-ignored).
// Warnings only; nothing here blocks anything.
//   npm run roles:personas -- create <name> <applicant|member|admin> [--expires-hours N]
//   npm run roles:personas -- list | check | clean
// Add --strict (or ROLES_STRICT=1) for extra guardrails: recorded expiry hints by default, hygiene warnings.
import "./lib/cli.js";
import { existsSync, readFileSync } from "node:fs";
import { decodeCredential } from "@starter/vta-client";
import { ADMIN_FILE, ENV_FILE, env } from "./env.js";
import { PERSONA_DIR, ROLES, STRICT_EXPIRY_HOURS, collectEntries, createPersona, listPersonas, removePersonas, separationWarnings, type PersonaRole } from "./lib/personas.js";

const args = process.argv.slice(2);
const strict = args.includes("--strict") || process.env.ROLES_STRICT === "1";
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const pos = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--expires-hours");
const [cmd = "list", name, role] = pos;

function repoDids() {
  const adminDid = existsSync(ADMIN_FILE) ? JSON.parse(readFileSync(ADMIN_FILE, "utf8")).did as string : undefined;
  const cred = env("VTA_CREDENTIAL");
  let appDid: string | undefined;
  try { appDid = cred ? decodeCredential(cred).did : undefined; } catch { /* not a credential; ignore */ }
  return { adminDid, appDid };
}

function check(): void {
  const { adminDid, appDid } = repoDids();
  const ws = separationWarnings(collectEntries({ adminDid, appDid }), { strict, embeddedDids: appDid ? [appDid] : [] });
  if (!ws.length) console.log(`no separation-of-duties warnings${strict ? " (strict)" : ""}.`);
  for (const w of ws) console.log(`warning${w.level === "strict" ? " (strict)" : ""}: ${w.text}`);
  console.log("These are warnings, not errors: nothing was blocked.");
}

switch (cmd) {
  case "create": {
    if (!name || !ROLES.includes(role as PersonaRole)) { console.error(`usage: create <name> <${ROLES.join("|")}> [--expires-hours N]`); process.exit(2); }
    const hours = flag("expires-hours") ? Number(flag("expires-hours")) : strict ? STRICT_EXPIRY_HOURS[role as PersonaRole] : undefined;
    const vtaDid = env("VTA_DID");
    const { file, envPath } = createPersona(name, role as PersonaRole, {
      expiresInHours: hours,
      vta: vtaDid ? { vtaDid, vtaUrl: env("VTA_URL"), context: env("VTA_CONTEXT") } : undefined,
    });
    console.log(`created ${role} persona "${name}": ${file.did}`);
    console.log(`key in ${PERSONA_DIR}/${name}.json (mode 0600, git-ignored); never paste it anywhere.`);
    if (file.expiresAt) console.log(`expiry hint ${file.expiresAt} (recorded locally only; the VTA is not told).`);
    if (role === "admin") console.log("admin persona: no env file is written, so no dev server can embed its key. Granting it an admin entry is done by the existing admin; see docs/ROLES.md.");
    else if (envPath) console.log(`use it: ENV_FILE=${envPath} npm run vta:provision   (grants the ACL entry; reuses this identity)\n        then ENV_FILE=${envPath} npm run vtc:join`);
    else console.log(`no ${ENV_FILE} with VTA_DID found, so no env file was written; run \`npm run up\` first, then create the persona again.`);
    check();
    break;
  }
  case "list":
    for (const p of listPersonas()) console.log(`${p.name.padEnd(16)} ${p.role.padEnd(10)} ${p.did}${p.expiresAt ? `  expires ${p.expiresAt}` : ""}`);
    if (!listPersonas().length) console.log("no personas. Create one: npm run roles:personas -- create alice applicant");
    break;
  case "check": check(); break;
  case "clean": console.log(`removed ${removePersonas()} persona(s) from ${PERSONA_DIR}`); break;
  default: console.error(`unknown command "${cmd}": create | list | check | clean`); process.exit(2);
}
