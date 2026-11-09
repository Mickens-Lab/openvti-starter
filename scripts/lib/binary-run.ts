// RUNTIME=binary, the side-effecting half (see ./binary.ts for the pure half): start, stop and reset the VTA and VTC
// as detached host processes. State is under .vta/run/ (config, data, pid files, logs); it is gitignored.
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { VtaClient } from "@buildathon/vta-client";
import { pins } from "../pins.js";
import { LOCAL_VTA_URL, die, env, loadAdmin, reachable } from "../env.js";
import {
  ALLOW_MISMATCH_VAR, binaryCheck, daemonEnv, judgeVersion, type VersionVerdict, fillVtcCors, renderVtaSetup, renderVtcSetup, resolveBinaries, runPaths, setupKeyDid, vtaDidFromLog, applyApproverPolicy,
  type BinaryResolution, type RunPaths,
} from "./binary.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const RUN_DIR = resolve(".vta/run");
export const paths = (): RunPaths => runPaths(RUN_DIR);

const isExecutable = (p: string): boolean => { try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; } };
const isDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };

export function resolveNow(withVtc: boolean): BinaryResolution {
  return resolveBinaries({ binDir: env("VTI_BIN_DIR"), vtaBin: env("VTA_BIN"), vtcBin: env("VTC_BIN"), withVtc, isExecutable, isDir });
}
export function binaryChecks(withVtc: boolean) {
  const r = resolveNow(withVtc);
  const rows = binaryCheck(r);
  if (!r.ok) return rows;
  const vs = versionVerdicts(r);
  return rows.flatMap((row) => {
    const v = vs.find((x) => row.name.toLowerCase().startsWith(x.name));
    return [row, ...(v ? [{ level: v.level, name: `${v.name.toUpperCase()} version`, detail: v.detail, ...(v.fix ? { fix: v.fix } : {}) }] : [])];
  });
}

/** Run `<bin> --version` and judge it against pins.json. */
export function versionVerdicts(bins: { vta: string; vtc?: string }): VersionVerdict[] {
  const p = pins().vti;
  const allow = env(ALLOW_MISMATCH_VAR) === "1";
  return (["vta", "vtc"] as const).flatMap((name) => {
    const bin = bins[name];
    if (!bin) return [];
    const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 5000 });
    const error = r.error ? r.error.message : r.status !== 0 ? `exit ${r.status ?? r.signal}` : undefined;
    return [judgeVersion({ name, bin, pinTag: p[name].tag, output: r.stdout, error }, allow)];
  });
}

/** The resolved binaries, or exit with a message that names the variable to set. A version that is not the pinned one is fatal unless VTI_ALLOW_VERSION_MISMATCH=1. */
export function requireBinaries(withVtc: boolean): { vta: string; vtc?: string } {
  const r = resolveNow(withVtc);
  if (!r.ok) die(`RUNTIME=binary: ${r.problems.join("\n")}\n(docs/BINARIES.md)`);
  const vs = versionVerdicts(r);
  for (const v of vs.filter((x) => x.level === "warn")) console.warn(`\nWARNING: ${v.detail}\n  ${v.fix}\n`);
  const bad = vs.filter((x) => x.level === "fail");
  if (bad.length) die(`RUNTIME=binary: binary versions do not match pins.json:\n${bad.map((v) => `  ${v.detail}\n    fix: ${v.fix}`).join("\n")}\n(docs/BINARIES.md)`);
  return r;
}

const vtaPort = () => process.env.VTA_PORT ?? env("VTA_PORT") ?? "8100";
const vtcPort = () => process.env.VTC_PORT ?? env("VTC_PORT") ?? "8200";
const vtcContext = () => process.env.VTC_CONTEXT ?? "vtc";
const childEnv = (): NodeJS.ProcessEnv => ({ ...process.env, ...daemonEnv({ vtaPort: vtaPort(), vtcPort: vtcPort(), context: vtcContext() }) });

function adminDid(): string {
  try { const m = /^ADMIN_DID=(.+)$/m.exec(readFileSync(".vta/admin.env", "utf8")); if (m) return m[1].trim(); } catch { /* fall through */ }
  return die("ADMIN_DID is not set (.vta/admin.env is missing). Run `npm run vta:keygen` first.");
}

/** Run a setup-style command to completion, output to the console. */
function runCli(bin: string, args: string[], quiet = false): number {
  const r = spawnSync(bin, args, { stdio: quiet ? "ignore" : "inherit", env: childEnv(), cwd: RUN_DIR });
  return r.status ?? 1;
}

// ---- processes -------------------------------------------------------------------------------------------------

function readPid(file: string): number | undefined {
  try { const n = Number(readFileSync(file, "utf8").trim()); return Number.isInteger(n) && n > 0 ? n : undefined; } catch { return undefined; }
}
/** Is this pid alive AND still the program we started (a stale pid file must never make us kill something else)? */
function isOurs(pid: number, name: string): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  const r = spawnSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" });
  return r.status === 0 && basename(r.stdout.trim().split(/\s+/)[0] ?? "") === name;
}
export const isRunning = (which: "vta" | "vtc"): boolean => {
  const pid = readPid(which === "vta" ? paths().vtaPid : paths().vtcPid);
  return pid !== undefined && isOurs(pid, which);
};
export const anyRunning = (): boolean => isRunning("vta") || isRunning("vtc");
export const anyRunFiles = (): boolean => existsSync(RUN_DIR);

function launch(which: "vta" | "vtc", bin: string, config: string, pidFile: string, logFile: string): void {
  const fd = openSync(logFile, "a", 0o600);
  const child = spawn(bin, ["--config", config], { detached: true, stdio: ["ignore", fd, fd], env: childEnv(), cwd: RUN_DIR });
  child.unref();
  if (!child.pid) die(`could not start ${bin}`);
  writeFileSync(pidFile, String(child.pid), { mode: 0o600 });
  console.log(`started ${which} (pid ${child.pid}), log: ${logFile.replace(`${process.cwd()}/`, "")}`);
}

async function stopOne(which: "vta" | "vtc", pidFile: string): Promise<boolean> {
  const pid = readPid(pidFile);
  rmSync(pidFile, { force: true });
  if (pid === undefined || !isOurs(pid, which)) return false;
  try { process.kill(pid, "SIGTERM"); } catch { return false; }
  for (let i = 0; i < 50 && isOurs(pid, which); i++) await sleep(200);
  if (isOurs(pid, which)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  return true;
}
/** Stop the VTC first, then the VTA. Returns the names stopped. State and logs are kept. */
export async function stopBinaries(): Promise<string[]> {
  const p = paths();
  const out: string[] = [];
  if (await stopOne("vtc", p.vtcPid)) out.push("vtc");
  if (await stopOne("vta", p.vtaPid)) out.push("vta");
  return out;
}
/** `reset`: stop both and delete .vta/run (config, data, logs); the next `up` provisions a new VTA. */
export async function resetBinaries(): Promise<string[]> {
  const stopped = await stopBinaries();
  rmSync(RUN_DIR, { recursive: true, force: true });
  return stopped;
}

async function waitHealthy(name: string, port: string, log: string, timeoutMs = 90_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const a = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(3000) });
      if (a.ok) {
        if (name !== "vta") return;
        const b = await fetch(`http://localhost:${port}/.well-known/did.jsonl`, { signal: AbortSignal.timeout(3000) });
        if (b.ok) return;
      }
    } catch { /* not up yet */ }
    await sleep(1000);
  }
  die(`the ${name} did not become healthy in ${timeoutMs / 1000} s. See ${log} (npm run vta:logs).`);
}

// ---- VTA --------------------------------------------------------------------------------------------------------

/** First boot (`vta setup --from`) when there is no config yet, then serve detached and wait for /health and the DID log. */
export async function startVta(vta: string): Promise<void> {
  const p = paths();
  mkdirSync(p.vtaData, { recursive: true });
  if (isRunning("vta")) { console.log("vta is already running"); return; }
  if (!existsSync(p.vtaConfig)) {
    writeFileSync(p.vtaSetup, renderVtaSetup({
      configPath: p.vtaConfig, dataDir: p.vtaData, port: vtaPort(), adminDid: adminDid(), cors: process.env.CORS_ORIGINS_TOML || undefined,
    }), { mode: 0o600 });
    if (runCli(vta, ["setup", "--from", p.vtaSetup]) !== 0) die(`\`vta setup --from\` failed (output above). If the binary is a different version than the kit expects, see docs/BINARIES.md.`);
    const approver = env("APPROVER_DID");
    if (approver) {
      try { writeFileSync(p.vtaConfig, applyApproverPolicy(readFileSync(p.vtaConfig, "utf8"), approver)); } catch (e) { die((e as Error).message); }
      console.log("approvals demo: consent required for vta/contexts/update/1.0, approver set = 1 software approver, enforcement on");
    }
  }
  launch("vta", vta, p.vtaConfig, p.vtaPid, p.vtaLog);
  process.stdout.write("waiting for the VTA");
  await waitHealthy("vta", vtaPort(), p.vtaLog);
  console.log(" ... healthy");
}

// ---- VTC --------------------------------------------------------------------------------------------------------

/** Mirror vtc-entrypoint.sh: phase 1, grant at the VTA, phase 2 (retried), CORS, offline ACL write, then serve detached. */
export async function startVtc(vtc: string): Promise<void> {
  const p = paths();
  mkdirSync(p.vtcDir, { recursive: true });
  if (isRunning("vtc")) { console.log("vtc is already running"); return; }
  const ctx = vtcContext();
  if (!existsSync(p.vtcConfig)) {
    if (!existsSync(p.vtcKey) && runCli(vtc, ["setup", "--setup-key-out", p.vtcKey, "--context", ctx]) !== 0) die("`vtc setup --setup-key-out` failed (output above). See docs/BINARIES.md.");
    const did = setupKeyDid(readFileSync(p.vtcKey, "utf8"));
    if (!did) die(`no setup did:key found in ${p.vtcKey}.`);
    console.log(`VTC setup DID: ${did}`);
    const baseUrl = (process.env.VTA_URL ?? LOCAL_VTA_URL).replace(/\/+$/, "");
    const admin = await reachable("VTA", baseUrl, () => VtaClient.connect(baseUrl, loadAdmin(), undefined));
    await reachable("VTA", baseUrl, () => admin.authenticate());
    await admin.createContext(ctx, "VTC");
    console.log((await admin.grantHandoff(did, ctx)) ? `granted one-time hand-off admin on "${ctx}" to ${did}` : "setup DID already granted");
    const log = await (await fetch(`http://localhost:${vtaPort()}/.well-known/did.jsonl`, { signal: AbortSignal.timeout(10_000) })).text();
    const vtaDid = vtaDidFromLog(log);
    if (!vtaDid) die("could not read the VTA's DID from its /.well-known/did.jsonl.");
    writeFileSync(p.vtcSetup, renderVtcSetup({ configPath: p.vtcConfig, port: vtcPort(), vtaDid, context: ctx, keyFile: p.vtcKey }), { mode: 0o600 });
    let ok = false;
    for (let i = 0; i < 20 && !ok; i++) {
      ok = runCli(vtc, ["setup", "--from", p.vtcSetup], i > 0) === 0;
      if (!ok) await sleep(3000);
    }
    if (!ok) die("`vtc setup --from` kept failing (first error above). If the binary is a different version than the kit expects, see docs/BINARIES.md.");
    const filled = fillVtcCors(readFileSync(p.vtcConfig, "utf8"), process.env.VTC_CORS_ORIGINS_TOML || undefined);
    if (filled === undefined) die(`could not set [cors] allowed_origins in ${p.vtcConfig}: \`vtc setup\` wrote no empty allowed_origins line (a different VTC version?).`);
    writeFileSync(p.vtcConfig, filled);
    if (runCli(vtc, ["--config", p.vtcConfig, "acl", "add", "--did", adminDid(), "--role", "admin", "--label", "buildathon-admin"]) !== 0) die("`vtc acl add` failed (output above).");
  }
  launch("vtc", vtc, p.vtcConfig, p.vtcPid, p.vtcLog);
}

export const logFile = (which: "vta" | "vtc"): string => (which === "vta" ? paths().vtaLog : paths().vtcLog);
