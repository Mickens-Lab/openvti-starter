// `npm run doctor`: is this machine ready for the kit, and if not, exactly what to run?
//   npm run doctor                 # mode from .env or the environment
//   npm run doctor -- --tunnel     # check as if MODE=tunnel (also --local); --no-vtc leaves the community out
// `npm run up` runs the blocking subset first (runPreflight), so a missing image or a busy port is a short message, not a Docker error.
import "./lib/cli.js";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { resolve } from "node:path";
import { devBanner } from "./banner.js";
import { env, type Mode, modeInfo, runtime, vtcChoice } from "./env.js";
import { runtimeModeError } from "./lib/binary.js";
import { anyRunning, binaryChecks } from "./lib/binary-run.js";
import { modeLine, parseModeFlags } from "./lib/modes.js";
import {
  blocking, cloudflaredCheck, type Check, dockerCheck, DEV_PORTS, devPortCheck, formatChecks, imageChecks, imagesNeeded, CORS_PORTS, DEV_SCAN_RANGES, MEDIATOR_PORT, mediatorPortCheck, viteOriginCheck,
  memoryCheck, nodeCheck, STACK_PORTS, stackPortCheck, summary, vtiCheckout,
} from "./lib/doctor.js";
import { have } from "./lib/compose.js";
import { currentMode, imagesAvailable, imageSpecs, imageStatus, realDocker } from "./lib/images.js";
import { pins } from "./pins.js";

/** Busy = something accepts a connection on loopback (IPv4 or IPv6). */
const portBusy = (port: number): Promise<boolean> =>
  new Promise((done) => {
    const tryHost = (host: string, next?: () => void) => {
      const s = net.connect({ port, host });
      s.setTimeout(500);
      s.once("connect", () => { s.destroy(); done(true); });
      s.once("timeout", () => { s.destroy(); next ? next() : done(false); });
      s.once("error", () => { s.destroy(); next ? next() : done(false); });
    };
    tryHost("127.0.0.1", () => tryHost("::1"));
  });

/** Ask the running VTA whether it would answer a browser page on `origin` (a CORS preflight). undefined = the VTA did not answer. */
async function vtaAllowsOrigin(origin: string, vtaUrl: string): Promise<boolean | undefined> {
  try {
    const r = await fetch(`${vtaUrl.replace(/\/+$/, "")}/trust-tasks`, {
      method: "OPTIONS", signal: AbortSignal.timeout(2000),
      headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    });
    return r.headers.get("access-control-allow-origin") === origin;
  } catch { return undefined; }
}

/** Is a Vite dev server answering on this port? Vite serves its client script at /@vite/client. */
async function isViteServer(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://localhost:${port}/@vite/client`, { signal: AbortSignal.timeout(800) });
    return r.ok && /javascript/.test(r.headers.get("content-type") ?? "");
  } catch { return false; }
}

const ownStackRunning = (): boolean => {
  const r = spawnSync("docker", ["compose", "--profile", "vtc", "--profile", "messaging", "ps", "--status", "running", "-q"], { encoding: "utf8", timeout: 20_000 });
  return r.status === 0 && r.stdout.trim() !== "";
};

function availKb(): number | undefined {
  try { return Number(/MemAvailable:\s+(\d+)/.exec(readFileSync("/proc/meminfo", "utf8"))?.[1]) || undefined; } catch { return undefined; }
}

export interface DoctorOptions { mode: Mode; withVtc: boolean; scope: "full" | "up"; /** WITH_VTC was not set: a missing VTC image is a warning. */ vtcOptional?: boolean }

/** Gather the real probes and judge them. `scope: "up"` skips the template ports and the mode line. */
export async function runChecks(o: DoctorOptions): Promise<Check[]> {
  const out: Check[] = [nodeCheck(process.version)];
  if (o.mode === "farm") {
    return out;
  }
  const binary = runtime() === "binary";
  const rtErr = runtimeModeError(runtime(), o.mode);
  if (rtErr) out.push({ level: "fail", name: "Runtime", detail: rtErr, fix: "RUNTIME=docker, or MODE=local (docs/BINARIES.md)" });
  let daemon = false;
  if (binary) {
    out.push({ level: "ok", name: "Runtime", detail: "RUNTIME=binary: the VTA" + (o.withVtc ? " and VTC run" : " runs") + " as host binaries, no Docker or images needed" });
    out.push(...binaryChecks(o.withVtc));
  } else {
    const cli = have("docker");
    daemon = cli && spawnSync("docker", ["info"], { stdio: "ignore", timeout: 20_000 }).status === 0;
    const compose = cli && spawnSync("docker", ["compose", "version"], { stdio: "ignore", timeout: 20_000 }).status === 0;
    const docker = dockerCheck({ cli, daemon, compose });
    out.push(docker);
    const needs = imagesNeeded(o.mode, o.withVtc);
    out.push(memoryCheck(availKb(), o.mode === "tunnel" ? 8 : 4, o.mode === "tunnel" ? "building the mediator" : "building an image"));
    if (docker.level === "ok") {
      let images: Check[];
      try {
        const specs = imageSpecs(pins(), env("IMAGE_REGISTRY"));
        const over = { vta: env("VTA_IMAGE"), vtc: env("VTC_IMAGE"), mediator: env("MEDIATOR_IMAGE") };
        images = imageChecks(imageStatus(specs, realDocker, currentMode(env), needs, over, imagesAvailable(pins())), specs, o.vtcOptional, { available: imagesAvailable(pins()), mode: o.mode });
      } catch (e) {
        images = [{ level: "fail", name: "Images", detail: (e as Error).message, fix: "see docs/IMAGES.md" }];
      }
      out.push(...images);
      const buildsVti = images.some((c) => c.level !== "ok" && /vta|vtc/.test(c.name));
      if (buildsVti) {
        const dir = resolve(process.env.VTI_PATH ?? "../verifiable-trust-infrastructure");
        out.push(vtiCheckout({ exists: existsSync(dir), dir: process.env.VTI_PATH ? dir : "../verifiable-trust-infrastructure", repoUrl: pins().vti.repo }));
      }
    }
  }
  const own = binary ? anyRunning() : daemon ? ownStackRunning() : false;
  const busyCache = new Map<number, boolean>();
  const busy = async (p: number) => { if (!busyCache.has(p)) busyCache.set(p, await portBusy(p)); return busyCache.get(p)!; };
  for (const p of STACK_PORTS) {
    if (p.port === 8200 && !o.withVtc) continue;
    const isBusy = await busy(p.port);
    let free: number | undefined;
    if (isBusy && !own) for (let c = p.port + 1; c < p.port + 30 && free === undefined; c++) if (!(await busy(c))) free = c;
    out.push(stackPortCheck({ port: p.port, what: p.what, env: p.env, busy: isBusy, ownStack: own }, free));
  }
  if (o.mode === "tunnel") {
    out.push(cloudflaredCheck(have("cloudflared")));
    out.push(mediatorPortCheck(await busy(MEDIATOR_PORT) && !own));
  }
  if (o.scope === "full") {
    const allowed = new Map<number, boolean>();
    for (const p of CORS_PORTS) allowed.set(p, await busy(p));
    const scan: number[] = [];
    for (const [lo, hi] of DEV_SCAN_RANGES) for (let p = lo; p <= hi; p++) scan.push(p);
    const stackPorts: number[] = STACK_PORTS.map((s) => s.port);
    const listening = (await Promise.all(scan.filter((p) => !stackPorts.includes(p)).map(async (p) => ((await busy(p)) ? p : 0)))).filter(Boolean);
    const vtaUrl = process.env.VTA_URL ?? "http://localhost:8100";
    for (const p of listening) {
      if (!(await isViteServer(p))) continue;
      const c = viteOriginCheck(p, await vtaAllowsOrigin(`http://localhost:${p}`, vtaUrl));
      if (c) out.push(c);
    }
    const freeAllowed = CORS_PORTS.find((p) => !allowed.get(p));
    for (const p of DEV_PORTS) {
      const isBusy = await busy(p.port);
      let free = freeAllowed;
      if (p.port === 4000 && isBusy) { free = undefined; for (let c = 4001; c < 4020 && free === undefined; c++) if (!(await busy(c))) free = c; }
      out.push(devPortCheck({ port: p.port, what: p.what, busy: isBusy, ownStack: false, use: p.use, server: "server" in p }, free));
    }
  }
  return out;
}

/** Called by `up`: print only failures and warnings, exit if anything blocks. */
export async function runPreflight(o: Omit<DoctorOptions, "scope">): Promise<void> {
  const cs = await runChecks({ ...o, scope: "up" });
  const bad = cs.filter((c) => c.level !== "ok");
  if (bad.length) console.log(`\nchecking this machine first:\n${formatChecks(bad)}\n`);
  if (blocking(cs).length) {
    console.error(`${summary(cs)} (\`npm run doctor\` shows everything.)\n`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  devBanner();
  const flags = parseModeFlags(process.argv.slice(2));
  if (flags.error) { console.error(flags.error); process.exit(1); }
  const info = flags.mode ? { mode: flags.mode, source: "flag" as const } : modeInfo();
  if (flags.mode) process.env.MODE = flags.mode;
  if (flags.vtc !== undefined) process.env.WITH_VTC = flags.vtc ? "1" : "0";
  const choice = vtcChoice();
  console.log(modeLine(info.mode, info.source, choice.on));
  const cs = await runChecks({ mode: info.mode, withVtc: choice.on, vtcOptional: !choice.explicit, scope: "full" });
  console.log(`\nOpenVTI starter: machine check\n\n${formatChecks(cs)}\n\n${summary(cs)}`);
  process.exit(blocking(cs).length ? 1 : 0);
}
