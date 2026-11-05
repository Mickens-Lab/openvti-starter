// Build the VTA, VTC and/or mediator image, each from its own ref pinned in pins.json
// (the releases come from different commits and repositories).
//   npm run images:build [vta|vtc|mediator|all|needed]   (`all` is vta + vtc; the mediator is only for MODE=tunnel)
//   npm run setup [-- --tunnel] [--no-vtc]   = images:build needed: builds only what the mode needs and is not built yet
//                                (local: vta + vtc; --tunnel / MODE=tunnel: + mediator; --no-vtc / WITH_VTC=0 leaves the VTC out),
//                                one after the other, with the time each took and a memory warning up front. Prebuilt images are
//                                not available yet (pins.json images.available), so this is how every machine gets its images.
// VTI_PATH   a verifiable-trust-infrastructure checkout (default ../verifiable-trust-infrastructure);
//            each pinned ref is exported with `git archive`, so its working tree is never used.
// VTI_LOCAL=1 build the checkout's working tree instead (development; the image is tagged :local only).
// --clone   clone the VTI checkout (and fetch its tags) if it is missing, without asking. Without it a terminal is asked; a pipe or CI gets the commands printed.
// TMPDIR     where the exported source goes (default the OS temp dir; use /var/tmp/<name> for heavy runs).
// CONTAINER_ENGINE=podman  build with podman instead of docker (the same --memory / --cpus limits are passed to `podman build` as memory, memory-swap and a CPU quota; rootless podman usually cannot delegate cpuset).
// --memory 8g / --cpus 4 / --no-limits (or BUILD_MEMORY / BUILD_CPUS / BUILD_LIMITS=0 in the environment or .env): the builds run on a capped,
//            low-priority buildx builder, default 6g memory (no swap) and a quarter of the cores, pinned (scripts/lib/build-limits.ts).
// Labels: the same provenance labels the published images carry (pinned ref, upstream source, Dockerfile sha256,
//         features, build-origin=local); `npm run images:verify --local` and `images:compare` read them (docs/VERIFY.md).
// Tags: <image>:<short-sha> and <image>:local (what compose defaults to).
import "./lib/cli.js";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { die, env, modeInfo, vtcChoice } from "./env.js";
import { parseModeFlags } from "./lib/modes.js";
import { imagesToBuild } from "./lib/doctor.js";
import { BUILD_ESTIMATE, formatElapsed, setupIntro } from "./lib/build-help.js";
import { buildLabels, imageSpecs, labelArgs, realDocker, type ImageKind } from "./lib/images.js";
import { missingCheckoutMessage, missingRefMessage, parseBuildArgs } from "./lib/build-help.js";
import { confirm } from "./lib/prompt.js";
import { MEDIATOR_BUILD_NOTICE, memoryWarning } from "./lib/tunnel.js";
import { pins } from "./pins.js";
import { ensureBuilder, limitedBuildArgv, limitsFromEnv, limitsNote, parseLimitFlags } from "./lib/build-limits.js";
import { cpus } from "node:os";

const limitFlags = parseLimitFlags(process.argv.slice(2));
if (limitFlags.error) die(limitFlags.error);
const flags = parseModeFlags(limitFlags.rest);
if (flags.error) die(flags.error);
const { which, clone } = parseBuildArgs(flags.rest);
if (!["vta", "vtc", "mediator", "all", "needed"].includes(which)) die("usage: npm run images:build [vta|vtc|mediator|all|needed] [--clone] [--memory 8g] [--cpus 4] [--no-limits]   (npm run setup = needed; mode flags --local/--tunnel/--no-vtc apply to `needed`)");
if (flags.mode) process.env.MODE = flags.mode;
if (flags.vtc !== undefined) process.env.WITH_VTC = flags.vtc ? "1" : "0";
const vti = pins().vti;
let limits: ReturnType<typeof limitsFromEnv>;
// CONTAINER_ENGINE=podman builds with podman (rootless, no docker access needed, e.g. on a shared build server). The memory/CPU
// caps then come from the caller (systemd-run / cgroup), so the buildx builder is not used.
const engine = process.env.CONTAINER_ENGINE ?? "docker";
try { limits = limitsFromEnv({ BUILD_MEMORY: env("BUILD_MEMORY"), BUILD_CPUS: env("BUILD_CPUS"), BUILD_LIMITS: env("BUILD_LIMITS"), ...limitFlags.env }, cpus().length); } catch (e) { die((e as Error).message); }
console.log(limitsNote(limits) + (engine === "docker" ? "" : `  [engine: ${engine}]`));
if (limits && engine === "docker") { const err = ensureBuilder(limits); if (err) die(err); }
/** `docker build <args>`, niced and (unless BUILD_LIMITS=0) run in the memory/CPU-capped builder. */
const dockerBuild = (args: string[]) => { const [cmd, ...rest] = engine === "docker" ? limitedBuildArgv(limits, args) : ["nice", "-n", "10", engine, "build", ...(limits ? ["--memory", limits.memory, "--memory-swap", limits.memory, "--cpu-period", "100000", "--cpu-quota", String(Math.round(limits.cpus * 100000))] : []), ...args]; sh(cmd, rest); };
const repo = resolve(process.env.VTI_PATH ?? "../verifiable-trust-infrastructure");
const local = process.env.VTI_LOCAL === "1";
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const sh = (cmd: string, args: string[], opts: object = {}) => {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) die(`\`${cmd} ${args.join(" ")}\` failed (exit ${r.status}).`);
};

function availKb(): number | undefined {
  try {
    const n = Number(/MemAvailable:\s+(\d+)/.exec(readFileSync("/proc/meminfo", "utf8"))?.[1]);
    return n && !Number.isNaN(n) ? n : undefined;
  } catch { return undefined; /* not Linux */ }
}

function buildMediator(): void {
  const m = pins().messaging.mediator;
  const short = m.ref.slice(0, 8);
  console.log(MEDIATOR_BUILD_NOTICE);
  const warn = memoryWarning(availKb(), 8);
  if (warn) console.warn(`WARNING: ${warn}`);
  const tags = [`${m.image}:${short}`, `${m.image}:local`];
  const dockerfile = resolve("docker/mediator.Dockerfile");
  const labels = labelArgs(buildLabels("mediator", pins(), { dockerfileSha256: sha256(dockerfile) }));
  console.log(`building ${tags.join(", ")} from ${m.repo} @ ${m.ref} (mediator ${m.version}, features ${m.features})`);
  dockerBuild(["-f", dockerfile, "--build-arg", `MEDIATOR_REF=${m.ref}`, "--build-arg", `FEATURES=${m.features}`, ...labels, ...tags.flatMap((t) => ["-t", t]), resolve("docker")]);
}

/** The VTA and VTC are built from a checkout of the upstream repository. Offer the clone, never do it unasked. */
async function ensureCheckout(ref: string, tag: string): Promise<void> {
  if (local) return;
  const isRepo = existsSync(repo) && spawnSync("git", ["-C", repo, "rev-parse", "--git-dir"], { stdio: "ignore" }).status === 0;
  if (!isRepo) {
    const message = missingCheckoutMessage({ dir: repo, repoUrl: vti.repo, explicitPath: Boolean(process.env.VTI_PATH) });
    if (existsSync(repo)) die(`${repo} exists but is not a git checkout. Move it away or set VTI_PATH.`);
    if (!clone && !(await confirm(`\n${message}\n\nClone it now (a few hundred MB)?`))) die(message);
    sh("git", ["clone", vti.repo, repo]);
    sh("git", ["-C", repo, "fetch", "--tags", "origin"]);
  }
  if (spawnSync("git", ["-C", repo, "cat-file", "-e", `${ref}^{commit}`]).status !== 0) {
    const message = missingRefMessage({ dir: repo, ref, tag });
    if (!clone && !(await confirm(`\n${message}\n\nRun that fetch now?`))) die(message);
    sh("git", ["-C", repo, "fetch", "--tags", "origin"]);
    if (spawnSync("git", ["-C", repo, "cat-file", "-e", `${ref}^{commit}`]).status !== 0) die(missingRefMessage({ dir: repo, ref, tag }));
  }
}

async function buildOne(name: "vta" | "vtc"): Promise<void> {
  const { image, ref, tag } = vti[name];
  const short = ref.slice(0, 8);
  let ctx = repo;
  let tmp = "";
  if (!local) {
    await ensureCheckout(ref, tag);
    tmp = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "vti-"));
    sh("sh", ["-c", `git -C '${repo}' archive ${ref} | tar -x -C '${tmp}'`]);
    ctx = tmp;
  }
  try {
    const tags = local ? [`${image}:local`] : [`${image}:${short}`, `${image}:local`];
    const file = name === "vta" ? join(ctx, "Dockerfile") : resolve("docker/vtc.Dockerfile");
    console.log(`building ${tags.join(", ")} from ${local ? `${repo} (working tree)` : `${tag} ${ref}`}`);
    // The VTA needs `tsp` for MODE=tunnel and the VTI Dockerfile's default feature list lacks it (pins.json vta.features).
    const features = name === "vta" && vti.vta.features ? ["--build-arg", `FEATURES=${vti.vta.features}`] : [];
    const labels = labelArgs(buildLabels(name, pins(), { dockerfileSha256: sha256(file), ref: local ? "local" : undefined }));
    dockerBuild(["-f", file, "--build-arg", `VTI_REF=${local ? "local" : ref}`, ...features, ...labels, ...tags.flatMap((t) => ["-t", t]), ctx]);
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

const mode = flags.mode ?? modeInfo().mode;
let plan: ImageKind[];
if (which === "needed") {
  if (mode === "farm") { console.log("MODE=farm runs no local images: nothing to build."); process.exit(0); }
  plan = imagesToBuild(mode, vtcChoice().on, imageSpecs(pins()), (ref) => realDocker.has(ref));
  console.log(setupIntro(plan, mode));
} else plan = which === "all" ? ["vta", "vtc"] : [which as ImageKind];
if (plan.some((k) => k !== "mediator")) {
  const warn = memoryWarning(availKb(), 4);
  if (warn) console.warn(`WARNING: ${warn}`);
}
const started = Date.now();
for (const kind of plan) {
  const t0 = Date.now();
  if (kind === "mediator") buildMediator(); else await buildOne(kind);
  console.log(`${kind}: built in ${formatElapsed(Date.now() - t0)} (estimate ${BUILD_ESTIMATE[kind]})`);
}
if (plan.length > 1) console.log(`all ${plan.length} images built in ${formatElapsed(Date.now() - started)}.`);
if (which === "needed" && plan.length) console.log("\nNext: npm run doctor, then npm run up.");
