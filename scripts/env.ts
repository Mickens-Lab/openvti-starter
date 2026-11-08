// Tiny .env reader and the admin key file; Node only.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type Mode, type ModeSource, resolveMode, resolveVtc, validMode } from "./lib/modes.js";
import { identityFromSeed, seedFromMultibase, seedToMultibase, type Identity } from "@buildathon/vta-client";

export const ADMIN_FILE = ".vta/admin.json";
/** `ENV_FILE=.env.other` lets one repo hold several app identities. */
export const ENV_FILE = process.env.ENV_FILE ?? ".env";

export function env(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  try {
    return readFileSync(ENV_FILE, "utf8").match(new RegExp(`^${name}=(.+)$`, "m"))?.[1];
  } catch {
    return undefined;
  }
}

export function saveAdmin(id: Identity): void {
  mkdirSync(".vta", { recursive: true });
  writeFileSync(
    ADMIN_FILE,
    JSON.stringify({ did: id.did, privateKeyMultibase: seedToMultibase(id.seed) }, null, 2),
    { mode: 0o600 },
  );
}

export function loadAdmin(): Identity {
  if (!existsSync(ADMIN_FILE)) throw new Error(`${ADMIN_FILE} not found. Run \`npm run vta:keygen\` first.`);
  return identityFromSeed(seedFromMultibase(JSON.parse(readFileSync(ADMIN_FILE, "utf8")).privateKeyMultibase));
}

export type { Mode } from "./lib/modes.js";

/** Validate a MODE value (pure; tested). */
export function parseMode(raw: string | undefined, where = ENV_FILE): Mode {
  return validMode(raw, where);
}

/** The stack the kit last started here (`.vta/mode.json`), so later commands follow it without a MODE prefix. */
function stackMarker(): Mode | null {
  try {
    const m = JSON.parse(readFileSync(".vta/mode.json", "utf8")).mode;
    return m === "local" || m === "tunnel" ? m : null;
  } catch { return null; }
}

/** Mode and where it came from: environment, .env, the running stack, else local. A flag on `up` sets the environment for that run. */
export function modeInfo(): { mode: Mode; source: ModeSource } {
  return resolveMode({ env: process.env.MODE, dotenv: readEnvFile("MODE"), marker: stackMarker(), where: ENV_FILE });
}

/** `MODE=local|tunnel|farm`. */
export function mode(): Mode {
  return modeInfo().mode;
}

/** Keys the kit itself writes to `.env`. `reset` removes exactly these and leaves any line you added. */
export const GENERATED_ENV_KEYS = ["MODE", "FARM", "VTA_URL", "VTA_DID", "VTA_CONTEXT", "APP_DID", "VTA_CREDENTIAL", "VTC_URL", "VTC_DID", "VTC_REQUEST_ID", "VTC_PEER_REQUEST_ID", "APPROVER_DID", "ROOM_PERSONA", "ROOM_PERSONA_REQUEST_ID"];

/** Remove the kit's own keys from the env file; delete the file if nothing else is left. Returns the keys that stay. */
export function clearGeneratedEnv(): string[] {
  if (!existsSync(ENV_FILE)) return [];
  removeEnv(GENERATED_ENV_KEYS);
  const left = readFileSync(ENV_FILE, "utf8").split("\n").filter((l) => l.trim() !== "");
  if (left.length === 0) rmSync(ENV_FILE, { force: true });
  return left.map((l) => l.split("=")[0]);
}

/** Where the mode came from, for messages. */
export function modeSource(): ModeSource {
  return modeInfo().source;
}
function readEnvFile(name: string): string | undefined {
  try { return readFileSync(ENV_FILE, "utf8").match(new RegExp(`^${name}=(.+)$`, "m"))?.[1]; } catch { return undefined; }
}

/** Is the VTC part of this run? On by default in every mode; `WITH_VTC=0` (or `--no-vtc` on `up`) turns it off. */
export function vtcChoice(): { on: boolean; explicit: boolean } {
  return resolveVtc({ env: process.env.WITH_VTC });
}
export const withVtc = (): boolean => vtcChoice().on;

/** Drop KEY=value lines from the env file (used when a tunnel stack is torn down and its URLs and credential are dead). */
export function removeEnv(keys: string[]): void {
  if (!existsSync(ENV_FILE)) return;
  const kept = readFileSync(ENV_FILE, "utf8").split("\n").filter((l) => l !== "" && !keys.some((k) => l.startsWith(`${k}=`)));
  writeFileSync(ENV_FILE, kept.length ? kept.join("\n") + "\n" : "", { mode: 0o600 });
}

/** Merge KEY=value pairs into the env file, keeping every other line (MODE, VTC_URL, ...). */
export function updateEnv(updates: Record<string, string | undefined>): void {
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8").split("\n").filter((l) => l !== "") : [];
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined) continue;
    const i = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (i >= 0) lines[i] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
  }
  writeFileSync(ENV_FILE, lines.join("\n") + "\n", { mode: 0o600 });
}

export const LOCAL_VTA_URL = "http://localhost:8100";
export const LOCAL_VTC_URL = "http://localhost:8200";

/** Exit with a short actionable message instead of a stack trace. */
export function die(msg: string): never {
  console.error(`\nerror: ${msg}\n`);
  process.exit(1);
}

/** Run `fn`; on a network failure print what to check for the current mode. */
export async function reachable<T>(what: string, url: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const cause = String((e as any)?.cause?.code ?? (e as any)?.cause?.message ?? (e as Error).message);
    const hint =
      mode() === "farm"
        ? `MODE=farm: check ${what === "VTA" ? "VTA_URL" : "VTC_URL"} in ${ENV_FILE} against the URL shown in the VTA Farm portal (FARM=ic3: https://vtafarm.ic3.dev, FARM=firstperson: https://vtafarm.firstperson.dev), or set FARM_AGENT=<name>, and that the agent shows "online". See docs/FARM.md.`
        : mode() === "tunnel"
          ? `MODE=tunnel: is the stack up and are the tunnels alive? Quick-tunnel URLs die when cloudflared stops, and every run gets new ones. Run \`npm run tunnel:probe\`, or \`npm run down\` then \`npm run up -- --tunnel\`. See docs/MODES.md.`
          : `MODE=local: is the stack up? Run \`npm run up\` (docker compose ps / npm run vta:logs).`;
    die(`could not reach the ${what} at ${url} (${cause}).\n${hint}`);
  }
}

/** VTC base URL for the current mode (no trailing slash). */
export function vtcUrl(): string {
  const u = process.env.VTC_URL ?? env("VTC_URL") ?? (mode() === "local" ? LOCAL_VTC_URL : undefined);
  if (!u) {
    die(`MODE=farm needs VTC_URL=https://vtc-<name>.<domain> in ${ENV_FILE}. A VTC exists only if you created a community (full stack) in the VTA Farm portal. See docs/FARM.md.`);
  }
  return u.replace(/\/+$/, "");
}

/** One line for a Trust Task refusal: `code: message`, not the whole signed error document. */
export function refusal(body: unknown): string {
  const p = (body as any)?.payload;
  return p?.code ? `${p.code}${p.message ? ` - ${p.message}` : ""}` : JSON.stringify(body);
}
