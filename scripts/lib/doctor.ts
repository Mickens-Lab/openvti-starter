// `npm run doctor`: the checks, as pure functions over probe results, so the messages are tested without Docker.
// scripts/doctor.ts gathers the real probes; `up` runs the blocking subset first.
import { BUILD_ESTIMATE, cloneCommand, DEFAULT_VTI_DIR } from "./build-help.js";
import type { ImageKind, ImageSpec, StatusRow } from "./images.js";

export type Level = "ok" | "warn" | "fail";
export interface Check { level: Level; name: string; detail: string; fix?: string }

/** Ports the kit uses. `stack` ports must be free (or held by this stack) for `up`; `dev` ports only matter for the templates. */
export const STACK_PORTS = [{ port: 8100, what: "VTA", env: "VTA_PORT" }, { port: 8200, what: "VTC", env: "VTC_PORT" }] as const;
export const DEV_PORTS = [
  { port: 5173, what: "web-vta-app and community-dashboard (Vite)", use: (p: number) => `npm run dev -w @starter/web-vta-app -- --port ${p}` },
  { port: 3000, what: "tsp-ping page and npm run e2e", use: (p: number) => `npm run dev -w @starter/tsp-ping -- --port ${p}` },
  { port: 4000, what: "inbox-verifier", server: true, use: (p: number) => `INBOX_PORT=${p} npm start -w @starter/inbox-verifier` },
] as const;
export const MEDIATOR_PORT = 7037;
/** Preferred origins to suggest when a template port is busy. The full default list is in packages/vta-client/src/cors.ts. */
export const CORS_PORTS = [3000, 5173, 8000];
/** Where a Vite dev server may land (3000s, vite preview, 5173+, 8000s); `detectViteServers` looks only here. */
export const DEV_SCAN_RANGES: ReadonlyArray<readonly [number, number]> = [[3000, 3099], [4173, 4173], [5173, 5199], [8000, 8099]];

export function nodeCheck(version: string, minMajor = 20): Check {
  const major = Number(/^v?(\d+)/.exec(version)?.[1]);
  return major >= minMajor
    ? { level: "ok", name: "Node", detail: version }
    : { level: "fail", name: "Node", detail: `${version} is too old`, fix: `install Node ${minMajor} or newer (nvm install ${minMajor})` };
}

export function dockerCheck(p: { cli: boolean; daemon: boolean; compose: boolean }): Check {
  if (!p.cli) return { level: "fail", name: "Docker", detail: "the docker command was not found", fix: "install Docker (https://docs.docker.com/get-docker/), or use MODE=farm (docs/FARM.md)" };
  if (!p.daemon) return { level: "fail", name: "Docker", detail: "installed, but the daemon does not answer", fix: "start Docker Desktop or the docker service (sudo systemctl start docker), then run this again" };
  if (!p.compose) return { level: "fail", name: "Docker Compose", detail: "`docker compose` (v2) is missing", fix: "install the Compose v2 plugin (https://docs.docker.com/compose/install/)" };
  return { level: "ok", name: "Docker", detail: "running, Compose v2 available" };
}

export function memoryCheck(availKb: number | undefined, needGb: number, forWhat: string): Check {
  if (availKb === undefined) return { level: "ok", name: "Memory", detail: "not measured on this OS" };
  const gb = availKb / 1024 / 1024;
  return gb >= needGb
    ? { level: "ok", name: "Memory", detail: `${gb.toFixed(1)} GB available` }
    : { level: "warn", name: "Memory", detail: `${gb.toFixed(1)} GB available; ${forWhat} wants about ${needGb} GB`, fix: "close other applications (a Rust image build is the heavy part)" };
}

export interface PortProbe { port: number; busy: boolean; ownStack: boolean }

/** A busy stack port is fine when this very stack holds it (a second `up`), a failure otherwise. */
export function stackPortCheck(p: PortProbe & { what: string; env: string }, free: number | undefined): Check {
  const name = `Port ${p.port} (${p.what})`;
  if (!p.busy) return { level: "ok", name, detail: "free" };
  if (p.ownStack) return { level: "ok", name, detail: "in use by this stack" };
  return {
    level: "fail", name, detail: `already in use by another program`,
    fix: free
      ? `stop that program, or start on another port: ${p.env}=${free} npm run up (a fresh stack only; set the matching ${p.env === "VTA_PORT" ? "VTA_URL" : "VTC_URL"}). Find the program with: lsof -i :${p.port}`
      : `stop that program (lsof -i :${p.port})`,
  };
}

/** A busy template port is only a warning: the templates proxy the VTA, so Vite's next free port (or `--port <n>`) works. */
export function devPortCheck(p: PortProbe & { what: string; server?: boolean; use?: (port: number) => string }, free: number | undefined): Check {
  const name = `Port ${p.port} (${p.what})`;
  if (!p.busy) return { level: "ok", name, detail: "free" };
  return {
    level: "warn", name, detail: "in use",
    fix: free ? `use port ${free}: ${(p.use ?? ((n: number) => `npm run dev -w <template> -- --port ${n}`))(free)}${p.server ? "" : " (the browser templates proxy the VTA through Vite, so any port works; Vite also moves on by itself)"}` : "use another port with -- --port <n>",
  };
}

/**
 * A running Vite dev server whose origin the VTA's CORS list refuses. The browser templates are not affected (they proxy /__vta);
 * code that calls the VTA directly from that page is. `allowed` is undefined when the VTA could not be asked.
 */
export function viteOriginCheck(port: number, allowed: boolean | undefined): Check | undefined {
  if (allowed !== false) return undefined;
  const origin = `http://localhost:${port}`;
  return {
    level: "warn", name: `Dev server on port ${port}`, detail: `a Vite server at ${origin} is outside the VTA's CORS list`,
    fix: `the templates still work (they proxy /__vta). Your own code calling the VTA directly from this page gets "NetworkError": serve it on a port in the list (3000-3009, 5173-5183, ...; docs/MODES.md), or set CORS_ORIGINS_TOML to include ${origin} and run npm run reset && npm run up`,
  };
}

export function mediatorPortCheck(busy: boolean): Check {
  return busy
    ? { level: "fail", name: `Port ${MEDIATOR_PORT} (mediator)`, detail: "already in use by another program", fix: `stop it (lsof -i :${MEDIATOR_PORT}); MODE=tunnel needs this port for the mediator` }
    : { level: "ok", name: `Port ${MEDIATOR_PORT} (mediator)`, detail: "free" };
}

/** Which images a mode needs. */
export function imagesNeeded(mode: "local" | "tunnel" | "farm", withVtc: boolean): ImageKind[] {
  if (mode === "farm") return [];
  return ["vta", ...(withVtc ? ["vtc" as const] : []), ...(mode === "tunnel" ? ["mediator" as const] : [])];
}

const WHY: Record<ImageKind, string> = {
  vta: `the VTA (build: ${BUILD_ESTIMATE.vta})`,
  vtc: `the community, VTC (build: ${BUILD_ESTIMATE.vtc})`,
  mediator: `the mediator (build: ${BUILD_ESTIMATE.mediator}, 8 GB RAM advised)`,
};

/** Which of the needed images are not built yet (nothing is present under `<name>:local`), in build order. */
export function imagesToBuild(mode: "local" | "tunnel" | "farm", withVtc: boolean, specs: Record<ImageKind, ImageSpec>, has: (ref: string) => boolean): ImageKind[] {
  return imagesNeeded(mode, withVtc).filter((k) => !has(specs[k].local));
}

/** The fix for an image that has to be built here: the exact command first, then the time, the checkout and the tunnel hint. */
export function localBuildFix(spec: ImageSpec, mode?: "local" | "tunnel" | "farm"): string {
  const needsVti = spec.kind !== "mediator";
  return [
    `${spec.buildCmd}   (${BUILD_ESTIMATE[spec.kind]}, once)`,
    needsVti ? "needs the VTI checkout (see the VTI checkout line; --clone makes it)" : "needs no VTI checkout, but about 8 GB of memory",
    spec.kind === "mediator" ? "MODE=tunnel needs the mediator" : mode === "tunnel" ? undefined : "MODE=tunnel also needs the mediator: npm run images:build mediator",
    "or build everything your mode needs in one go: npm run setup   (-- --tunnel for MODE=tunnel)",
  ].filter(Boolean).join("; ");
}

/**
 * Judge the rows of imageStatus() (lib/images.ts). While prebuilt images are not available (`opts.available` false) a missing image is built here: the exact build command comes first.
 * When they are, a prebuilt image that is only missing locally is a warning, since `up` pulls it; the pull command comes first and the local build second. Nothing obtainable (IMAGES=local, or an override that
 * is absent) blocks, except an unrequested VTC, which `up` leaves out.
 */
export function imageChecks(rows: StatusRow[], specs: Record<ImageKind, ImageSpec>, vtcOptional = false, opts: { available?: boolean; mode?: "local" | "tunnel" | "farm" } = {}): Check[] {
  return rows.map((r): Check => {
    const name = `Image ${r.ref}`;
    const spec = specs[r.kind];
    if (r.state === "ready") return { level: "ok", name, detail: r.source === "local-build" ? "present (built here; npm run images:verify -- --local shows its labels)" : r.source === "env" ? "present (your override)" : "present (prebuilt; check what you run: npm run images:verify, docs/VERIFY.md)" };
    if (r.state === "pullable") {
      return { level: "warn", name, detail: `not on this machine yet; \`up\` will pull it (${WHY[r.kind]})`, fix: `${r.fix}   (or build locally: ${spec.buildCmd}; docs/PINS.md#where-the-images-come-from)` };
    }
    if (opts.available === false && r.ref === spec.local) {
      const fix = localBuildFix(spec, opts.mode);
      return r.kind === "vtc" && vtcOptional
        ? { level: "warn", name, detail: `not built yet, so the community (VTC) is left out of \`up\` (${WHY[r.kind]})`, fix: `${fix}; or WITH_VTC=0 to stop seeing this` }
        : { level: "fail", name, detail: `not built yet (${WHY[r.kind]}); prebuilt images are not available, so build it here`, fix };
    }
    const optional = r.kind === "vtc" && vtcOptional;
    return optional
      ? { level: "warn", name, detail: `not available, so the community (VTC) is left out of \`up\` (${WHY[r.kind]})`, fix: `${r.fix}   (or WITH_VTC=0 to stop seeing this)` }
      : { level: "fail", name, detail: `not available (${WHY[r.kind]})`, fix: `${r.fix}   (docs/PINS.md#where-the-images-come-from)` };
  });
}

export function vtiCheckout(p: { exists: boolean; dir: string; repoUrl: string }): Check {
  return p.exists
    ? { level: "ok", name: "VTI checkout", detail: p.dir }
    : { level: "warn", name: "VTI checkout", detail: `not at ${p.dir}; needed only to build the VTA and VTC images`, fix: `${cloneCommand(p.repoUrl, DEFAULT_VTI_DIR)}  (or: npm run images:build -- --clone)` };
}

export function cloudflaredCheck(have: boolean): Check {
  return have
    ? { level: "ok", name: "cloudflared", detail: "found" }
    : { level: "fail", name: "cloudflared", detail: "not on PATH (MODE=tunnel needs it)", fix: "install it: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" };
}

export const blocking = (cs: Check[]): Check[] => cs.filter((c) => c.level === "fail");

const MARK: Record<Level, string> = { ok: "ok  ", warn: "warn", fail: "FAIL" };

/** One line per check, with the fix indented under any warning or failure. */
export function formatChecks(cs: Check[]): string {
  return cs
    .map((c) => `  ${MARK[c.level]}  ${c.name}: ${c.detail}${c.level !== "ok" && c.fix ? `\n        -> ${c.fix}` : ""}`)
    .join("\n");
}

export function summary(cs: Check[]): string {
  const f = cs.filter((c) => c.level === "fail").length;
  const w = cs.filter((c) => c.level === "warn").length;
  return f ? `${f} problem(s) block \`npm run up\`${w ? `, ${w} warning(s)` : ""}. Fix the lines marked FAIL.` : w ? `Ready to start, ${w} warning(s) above.` : "All good.";
}
