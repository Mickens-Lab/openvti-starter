// Throwaway persona identities for practising "one key per role". Guidance only: nothing here blocks anything.
// Files live under .vta/personas/ (git-ignored). A persona is a did:key plus, for applicant and member, an env file you
// can pass as ENV_FILE=... to the other scripts. An admin persona never gets an env file, so no dev server (which reads
// the root .env) can embed its key in a page.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeCredential, newIdentity, seedToMultibase } from "@starter/vta-client";

export const ROLES = ["applicant", "member", "admin"] as const;
export type PersonaRole = (typeof ROLES)[number];
export const PERSONA_DIR = ".vta/personas";
/** Default expiry hints (hours) in strict mode. A hint recorded here; the VTA is not told (see docs/ROLES.md). */
export const STRICT_EXPIRY_HOURS: Record<PersonaRole, number> = { applicant: 8, member: 24, admin: 1 };

export interface PersonaFile {
  name: string;
  role: PersonaRole;
  did: string;
  privateKeyMultibase: string;
  createdAt: string;
  expiresAt?: string;
}
export interface Entry { did: string; role: string; source: string }
export interface Warning { level: "warn" | "strict"; text: string }

export interface CreateOpts {
  dir?: string;
  now?: Date;
  /** Hours until the recorded expiry hint; undefined means none (the default). */
  expiresInHours?: number;
  /** VTA coordinates for the env file (applicant/member). Without a vtaDid no env file is written. */
  vta?: { vtaDid: string; vtaUrl?: string; context?: string };
}

const safeName = (n: string) => {
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(n)) throw new Error(`persona name "${n}" must be lowercase letters, digits, hyphens`);
  return n;
};

export function createPersona(name: string, role: PersonaRole, o: CreateOpts = {}): { file: PersonaFile; envPath?: string } {
  const dir = o.dir ?? PERSONA_DIR;
  safeName(name);
  const jsonPath = join(dir, `${name}.json`);
  if (existsSync(jsonPath)) throw new Error(`persona "${name}" already exists (${jsonPath}); remove it first or pick another name`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = newIdentity();
  const now = o.now ?? new Date();
  const file: PersonaFile = {
    name, role, did: id.did, privateKeyMultibase: seedToMultibase(id.seed), createdAt: now.toISOString(),
    ...(o.expiresInHours ? { expiresAt: new Date(now.getTime() + o.expiresInHours * 3600_000).toISOString() } : {}),
  };
  writeFileSync(jsonPath, JSON.stringify(file, null, 2), { mode: 0o600 });
  let envPath: string | undefined;
  if (role !== "admin" && o.vta?.vtaDid) {
    envPath = join(dir, `${name}.env`);
    const cred = encodeCredential({ did: id.did, privateKeyMultibase: file.privateKeyMultibase, vtaDid: o.vta.vtaDid, vtaUrl: o.vta.vtaUrl });
    const lines = [`VTA_DID=${o.vta.vtaDid}`, ...(o.vta.vtaUrl ? [`VTA_URL=${o.vta.vtaUrl}`] : []), `VTA_CONTEXT=${o.vta.context ?? "my-app"}`, `APP_DID=${id.did}`, `VTA_CREDENTIAL=${cred}`];
    writeFileSync(envPath, lines.join("\n") + "\n", { mode: 0o600 });
  }
  return { file, envPath };
}

export function listPersonas(dir = PERSONA_DIR): PersonaFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as PersonaFile);
}

export function removePersonas(dir = PERSONA_DIR): number {
  const n = listPersonas(dir).length;
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  return n;
}

/** Entries to check: personas, plus the repo's admin key and app identity when present. */
export function collectEntries(o: { dir?: string; adminDid?: string; appDid?: string } = {}): Entry[] {
  const out: Entry[] = listPersonas(o.dir).map((p) => ({ did: p.did, role: p.role, source: `persona ${p.name}` }));
  if (o.adminDid) out.push({ did: o.adminDid, role: "admin", source: ".vta/admin.json" });
  if (o.appDid) out.push({ did: o.appDid, role: "applicant", source: "the app identity (.env)" });
  return out;
}

/**
 * Separation-of-duties warnings. One DID acting as applicant (or member) and admin is the case worth flagging:
 * it could apply and approve its own request. Never blocks. Strict mode adds hygiene checks.
 */
export function separationWarnings(entries: Entry[], o: { strict?: boolean; dir?: string; now?: Date; embeddedDids?: string[] } = {}): Warning[] {
  const w: Warning[] = [];
  const byDid = new Map<string, Entry[]>();
  for (const e of entries) byDid.set(e.did, [...(byDid.get(e.did) ?? []), e]);
  for (const [did, es] of byDid) {
    const roles = new Set(es.map((e) => e.role));
    if (roles.has("admin") && (roles.has("applicant") || roles.has("member"))) {
      w.push({ level: "warn", text: `one identity (${did.slice(0, 16)}...) is both admin and applicant/member (${es.map((e) => e.source).join(", ")}): it could apply and approve its own request. Use a separate key per persona.` });
    }
  }
  if (o.strict) {
    const adminDids = new Set(entries.filter((e) => e.role === "admin").map((e) => e.did));
    for (const d of o.embeddedDids ?? []) {
      if (adminDids.has(d)) w.push({ level: "strict", text: "an admin key is embedded as VTA_CREDENTIAL in an env file a dev server may read; keep the admin key out of the browser." });
    }
    const now = (o.now ?? new Date()).getTime();
    for (const p of listPersonas(o.dir)) {
      if (!p.expiresAt) w.push({ level: "strict", text: `persona ${p.name} has no expiry hint; strict mode prefers short-lived identities.` });
      else if (Date.parse(p.expiresAt) < now) w.push({ level: "strict", text: `persona ${p.name} expired at ${p.expiresAt}; remove it (roles:personas clean).` });
    }
    const dir = o.dir ?? PERSONA_DIR;
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        const mode = statSync(join(dir, f)).mode & 0o077;
        if (mode) w.push({ level: "strict", text: `${join(dir, f)} is readable by others; chmod 600 it.` });
      }
    }
  }
  return w;
}
