// RUNTIME=binary: run the VTA (and optional VTC) as host binaries instead of Docker containers.
// This file is the pure part (validation, path resolution, config rendering; tested in scripts/test/binary.test.ts).
// The side effects (processes, files) are in ./binary-run.ts. The first-boot logic mirrors vta-entrypoint.sh and
// vtc-entrypoint.sh; scripts/test/binary.test.ts renders the entrypoints' own heredocs and compares them with these.
import { join } from "node:path";
import { corsTomlBody } from "@buildathon/vta-client";

export type Runtime = "docker" | "binary";

/** Validate a RUNTIME value (default docker). */
export function parseRuntime(raw: string | undefined, where = ".env"): Runtime {
  const r = (raw ?? "docker").trim() || "docker";
  if (r !== "docker" && r !== "binary") throw new Error(`RUNTIME must be "docker" or "binary", got "${r}". Edit ${where}.`);
  return r;
}

/** The binary runtime has no mediator, so it cannot do MODE=tunnel. Returns the message, or undefined when the pair is fine. */
export function runtimeModeError(runtime: Runtime, mode: string): string | undefined {
  return runtime === "binary" && mode === "tunnel"
    ? "RUNTIME=binary cannot run MODE=tunnel: tunnel mode needs a mediator (and cloudflared), which only exists as a Docker image. Use RUNTIME=docker for --tunnel, or MODE=local with RUNTIME=binary."
    : undefined;
}

export interface BinaryInputs {
  /** VTI_BIN_DIR: a folder holding `vta` (and `vtc`). No default. */
  binDir?: string;
  /** VTA_BIN / VTC_BIN: a full path that overrides the one in the folder. */
  vtaBin?: string;
  vtcBin?: string;
  withVtc: boolean;
  /** Is this an existing, executable regular file? */
  isExecutable: (path: string) => boolean;
  /** Is this an existing directory? */
  isDir: (path: string) => boolean;
}

export type BinaryResolution = { ok: true; vta: string; vtc?: string } | { ok: false; problems: string[] };

/** Where `vta` and `vtc` come from, or every reason they cannot be found (each names the variable to set). */
export function resolveBinaries(i: BinaryInputs): BinaryResolution {
  const problems: string[] = [];
  const dir = i.binDir?.trim() || undefined;
  if (dir && !i.isDir(dir)) problems.push(`VTI_BIN_DIR=${dir} is not a directory.`);
  const pick = (name: "vta" | "vtc", override: string | undefined, varName: string): string | undefined => {
    const o = override?.trim();
    if (o) {
      if (i.isExecutable(o)) return o;
      problems.push(`${varName}=${o} is not an executable file.`);
      return undefined;
    }
    if (!dir) {
      problems.push(`${varName} or VTI_BIN_DIR is not set: RUNTIME=binary has no default location. Set VTI_BIN_DIR=<folder that contains \`${name}\`> in the env file (or ${varName}=<path to ${name}>).`);
      return undefined;
    }
    if (!i.isDir(dir)) return undefined;
    const p = join(dir, name);
    if (i.isExecutable(p)) return p;
    problems.push(`VTI_BIN_DIR=${dir} has no executable \`${name}\` (looked for ${p}). Fix VTI_BIN_DIR or set ${varName}=<path to ${name}>.`);
    return undefined;
  };
  const vta = pick("vta", i.vtaBin, "VTA_BIN");
  const vtc = i.withVtc ? pick("vtc", i.vtcBin, "VTC_BIN") : undefined;
  if (problems.length || !vta || (i.withVtc && !vtc)) return { ok: false, problems };
  return { ok: true, vta, vtc };
}

/** Everything the binary runtime keeps lives under one gitignored folder (.vta/ is ignored). */
export function runPaths(runDir: string) {
  return {
    dir: runDir,
    vtaDir: join(runDir, "vta"),
    vtaConfig: join(runDir, "vta", "config.toml"),
    vtaData: join(runDir, "vta", "data"),
    vtaSetup: join(runDir, "vta", "setup.toml"),
    vtaPid: join(runDir, "vta.pid"),
    vtaLog: join(runDir, "vta.log"),
    vtcDir: join(runDir, "vtc"),
    vtcConfig: join(runDir, "vtc", "config.toml"),
    vtcKey: join(runDir, "vtc", "setup-key.json"),
    vtcSetup: join(runDir, "vtc", "setup.toml"),
    vtcPid: join(runDir, "vtc.pid"),
    vtcLog: join(runDir, "vtc.log"),
  };
}
export type RunPaths = ReturnType<typeof runPaths>;

export interface VtaSetupInputs {
  configPath: string;
  dataDir: string;
  port: number | string;
  adminDid: string;
  /** TOML array body; default is the loopback dev-port list shared with the entrypoints. */
  cors?: string;
  /** Interface to bind. The container binds 0.0.0.0; on the host loopback is enough and safer. */
  host?: string;
}

/** The first-boot setup file for `vta setup --from` (local mode: loopback DID, REST only, no mediator). Mirrors vta-entrypoint.sh. */
export function renderVtaSetup(i: VtaSetupInputs): string {
  const publicUrl = `http://localhost:${i.port}`;
  return `config_path = "${i.configPath}"
data_dir    = "${i.dataDir}"
vta_name    = "buildathon-vta"
public_url  = "${publicUrl}"
admin_did   = "${i.adminDid}"
admin_label = "buildathon-admin"

[server]
host = "${i.host ?? "127.0.0.1"}"
port = ${i.port}
# Exact-match origins; the VTA accepts no wildcard (default: loopback dev ports only). Edit and re-create the
# volume (docker compose down -v) to change.
cors_origins = [${i.cors || corsTomlBody()}]
# Dev loop: refill auth tokens quickly instead of 1 per 5 s.
rate_limit_interval_secs = 1
rate_limit_burst = 60

[log]
level  = "info"
format = "text"

[secrets]
backend = "plaintext"

[messaging]
kind = "skip"

[services]
didcomm = false
tsp     = false

[vta_did]
kind = "create_webvh"
url  = "${publicUrl}"
`;
}

/** The approvals demo seed, appended to the generated VTA config (mirrors the sed + heredoc in vta-entrypoint.sh). Throws if enforcement cannot be switched on. */
export function applyApproverPolicy(config: string, approverDid: string): string {
  const lines = config.split("\n");
  let inPolicy = false;
  const out: string[] = [];
  for (const l of lines) {
    if (l === "[policy]") inPolicy = true;
    if (inPolicy && l === "enforcement = false") { out.push("enforcement = true"); continue; }
    if (inPolicy && l === "approvals = []") continue;
    if (l === "[policy.approver_sets]") {
      inPolicy = false;
      out.push(l, `demo-approvers = ["${approverDid}"]`);
      continue;
    }
    out.push(l);
  }
  const text = out.join("\n");
  if (!/^enforcement = true$/m.test(text)) throw new Error("approvals demo: could not switch policy.enforcement on; refusing to start with a rule that gates nothing");
  return `${text.replace(/\n*$/, "\n")}
[[policy.approvals]]
taskType         = "https://trusttasks.org/spec/vta/contexts/update/1.0"
requires         = "consent"
approverSet      = "demo-approvers"
minApprovals     = 1
excludeRequester = true
`;
}

/** The VTA's DID: the first `"id":"did:..."` without a #fragment in its did.jsonl (a greedy match would pick the #vta-rest service id). */
export function vtaDidFromLog(text: string): string | undefined {
  return /"id":"(did:[^"#]*)"/.exec(text)?.[1];
}

export interface VtcSetupInputs { configPath: string; port: number | string; vtaDid: string; context: string; keyFile: string }

/** Phase 2 setup file for `vtc setup --from` (local mode, no mediator). Mirrors vtc-entrypoint.sh. */
export function renderVtcSetup(i: VtcSetupInputs): string {
  return `config_path    = "${i.configPath}"
base_url       = "http://localhost:${i.port}"
vta_did        = "${i.vtaDid}"
context        = "${i.context}"
setup_key_file = "${i.keyFile}"
provision_transport = "rest"
single_admin_mode = true

[secrets]
backend = "plaintext"
`;
}

/** Fill in the `[cors]` line `vtc setup` writes (a second [cors] table would be a duplicate-key error). Returns undefined if the line is missing. */
export function fillVtcCors(config: string, cors: string = corsTomlBody()): string | undefined {
  const re = /^allowed_origins = \[\]$/m;
  return re.test(config) ? config.replace(re, () => `allowed_origins = [${cors}]`) : undefined;
}

/** The setup did:key `vtc setup --setup-key-out` wrote. */
export function setupKeyDid(keyJson: string): string | undefined {
  return /(did:key:z[A-Za-z0-9]+)/.exec(keyJson)?.[1];
}

/** Environment both daemons need on the host (the container sets the same in compose). */
export function daemonEnv(o: { vtaPort: string; vtcPort: string; context: string }): Record<string, string> {
  return {
    VTA_ALLOW_PRIVATE_ENDPOINTS: process.env.VTA_ALLOW_PRIVATE_ENDPOINTS ?? "1",
    VTA_PORT: o.vtaPort,
    VTC_PORT: o.vtcPort,
    VTC_SERVER_PORT: o.vtcPort,
    VTC_CONTEXT: o.context,
  };
}

/** doctor rows for the binary runtime (pure over probe results). */
export function binaryCheck(r: BinaryResolution): { level: "ok" | "fail"; name: string; detail: string; fix?: string }[] {
  if (r.ok) return [{ level: "ok", name: "VTA binary", detail: r.vta }, ...(r.vtc ? [{ level: "ok" as const, name: "VTC binary", detail: r.vtc }] : [])];
  return r.problems.map((p) => ({ level: "fail" as const, name: "Binaries (RUNTIME=binary)", detail: p, fix: "see docs/BINARIES.md" }));
}

// ---- version check against pins.json ----------------------------------------------------------------------------

/** `vta-service-v0.65.0` -> `0.65.0`; undefined if the tag carries no x.y.z. */
export function semverFromTag(tag: string): string | undefined {
  return /v(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(tag.trim())?.[1];
}

/** `vta 0.78.0` (the first line `<name> --version` prints) -> `0.78.0`. */
export function parseVersionOutput(name: "vta" | "vtc", out: string): string | undefined {
  return new RegExp(`^${name}\\s+v?(\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?)\\s*$`, "m").exec(out.trim())?.[1];
}

export interface VersionProbe { name: "vta" | "vtc"; bin: string; pinTag: string; /** stdout of `<bin> --version`, or undefined if it could not be run */ output?: string; /** why it could not be run */ error?: string }
export interface VersionVerdict { name: "vta" | "vtc"; status: "match" | "mismatch" | "unreadable"; level: "ok" | "warn" | "fail"; found?: string; pinned?: string; detail: string; fix?: string }

export const ALLOW_MISMATCH_VAR = "VTI_ALLOW_VERSION_MISMATCH";

/** Exact match with the pin or nothing. `allow` (VTI_ALLOW_VERSION_MISMATCH=1) turns a mismatch or an unreadable version into a warning. */
export function judgeVersion(p: VersionProbe, allow: boolean): VersionVerdict {
  const pinned = semverFromTag(p.pinTag);
  const soften = (v: Omit<VersionVerdict, "level">): VersionVerdict => ({ ...v, level: allow ? "warn" : "fail", detail: allow ? `${v.detail} (${ALLOW_MISMATCH_VAR}=1: continuing anyway, expect unexpected errors)` : v.detail });
  if (!pinned) return soften({ name: p.name, status: "unreadable", detail: `${p.bin}: pins.json tag "${p.pinTag}" holds no version`, fix: "fix pins.json (docs/PINS.md)" });
  const found = p.error === undefined && p.output !== undefined ? parseVersionOutput(p.name, p.output) : undefined;
  if (!found) {
    return soften({
      name: p.name, status: "unreadable", pinned,
      detail: `${p.bin}: could not read its version (${p.error ?? `\`${p.name} --version\` printed "${(p.output ?? "").trim().slice(0, 60)}", expected "${p.name} x.y.z"`}); the pin is ${pinned}`,
      fix: `check that ${p.bin} is a ${p.name} binary that runs here, or set ${ALLOW_MISMATCH_VAR}=1 to skip this check`,
    });
  }
  if (found === pinned) return { name: p.name, status: "match", level: "ok", found, pinned, detail: `${p.bin}: ${found} (matches the pin)` };
  return soften({
    name: p.name, status: "mismatch", found, pinned,
    detail: `${p.bin} is ${p.name} ${found}, but pins.json pins ${pinned} (${p.pinTag})`,
    fix: `use ${p.name} ${pinned} binaries (VTI_BIN_DIR / ${p.name.toUpperCase()}_BIN), or update the pins deliberately (docs/PINS.md), or set ${ALLOW_MISMATCH_VAR}=1 to run anyway`,
  });
}
