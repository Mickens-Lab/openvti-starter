// MODE=tunnel logic that needs no Docker or network, so it is unit-tested (scripts/test/tunnel.test.ts).
// The side-effecting parts live in scripts/up.ts, scripts/lib/compose.ts and scripts/tunnel-probe.ts.
import { basename } from "node:path";

export const TUNNEL_FILE = ".vta/tunnel.json";
export const MODE_FILE = ".vta/mode.json";

/** What `npm run up` records about the running tunnel stack. Lives in the git-ignored .vta/. */
export interface TunnelState {
  vtaHost: string;
  /** Empty when the VTC is not started (WITH_VTC=0). */
  vtcHost: string;
  medHost: string;
  mediatorDid?: string;
  startedAt: string;
  /** cloudflared process ids, so `npm run down` can stop exactly what `up` started. */
  pids: number[];
}

/** The first quick-tunnel host in cloudflared's output. `api.trycloudflare.com` is its control plane, not a tunnel. */
export function hostFromLog(text: string): string | undefined {
  for (const m of text.matchAll(/\b([a-z0-9][a-z0-9-]*)\.trycloudflare\.com\b/g)) {
    if (m[1] !== "api") return m[0];
  }
  return undefined;
}

/**
 * The mediator's own DID from its generated mediator.toml (`mediator_did = "did://<did>"`). In MODE=tunnel it is a short
 * did:webvh bound to the mediator's tunnel host (mediator-entrypoint.sh); a did:peer is still accepted.
 */
export function mediatorDidFromToml(text: string): string | undefined {
  return /^\s*mediator_did\s*=\s*"(?:did:\/\/)?(did:(?:webvh|peer):[A-Za-z0-9._%=:-]+)"/m.exec(text)?.[1];
}

/** The did:webvh a `did.jsonl` log names, and whether it is bound to `host` (the tunnel host this run serves it at). */
export function webvhAtHost(logText: string, host: string): { ok: boolean; did?: string; detail: string } {
  const did = /"id":"(did:webvh:[^"#]+)"/.exec(logText)?.[1];
  if (!did) return { ok: false, detail: "no did:webvh in the log" };
  return did.endsWith(`:${host}`)
    ? { ok: true, did, detail: "DID is bound to the current tunnel host" }
    : { ok: false, did, detail: "DID names a different host: this volume is stale, reset with `npm run down`" };
}

/** Variables the compose file reads (see docker-compose.yml). Empty hosts leave a service in local-mode behaviour. */
export function composeEnv(s: TunnelState): Record<string, string> {
  return {
    VTA_PUBLIC_HOST: s.vtaHost,
    VTC_PUBLIC_HOST: s.vtcHost,
    MEDIATOR_PUBLIC_HOST: s.medHost,
    MEDIATOR_DID: s.mediatorDid ?? "",
    // The VTA resolves its own did:webvh over the public network here, so the loopback allowance is off.
    VTA_ALLOW_PRIVATE_ENDPOINTS: "0",
  };
}

export const tunnelUrls = (s: TunnelState) => ({
  vta: `https://${s.vtaHost}`,
  vtc: s.vtcHost ? `https://${s.vtcHost}` : undefined,
  mediator: `https://${s.medHost}`,
});

/** `docker compose` profile flags for a mode (always includes vtc so down/exec see the VTC). */
export function profileArgs(mode: "local" | "tunnel", withVtc: boolean): string[] {
  const a = withVtc || mode === "tunnel" ? ["--profile", "vtc"] : [];
  return mode === "tunnel" ? [...a, "--profile", "messaging"] : a;
}

/** Compose names volumes `<project>_<volume>`; the project defaults to the directory name. */
export function composeProject(cwd: string, override = process.env.COMPOSE_PROJECT_NAME): string {
  return override || basename(cwd).toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

const VOLUMES = ["vta-data", "vtc-data", "mediator-data"] as const;
/** Which of this stack's volumes exist, from `docker volume ls -q` output lines. */
export function existingVolumes(all: string[], project: string): string[] {
  return VOLUMES.filter((v) => all.includes(`${project}_${v}`));
}

export type StackMode = "local" | "tunnel";
export type Guard = { ok: true } | { ok: false; message: string };

/**
 * Never silently reuse a volume across modes. A tunnel run is never resumable (the DIDs are bound to
 * hostnames that die with the tunnel), so ANY existing volume refuses `tunnel`; a tunnel leftover refuses
 * `local`. A local volume with no marker (made before modes existed) is still local.
 */
export function volumeGuard(i: { want: StackMode; marker: StackMode | null; volumes: string[] }): Guard {
  if (i.volumes.length === 0) return { ok: true };
  const had: StackMode | null = i.marker ?? (i.volumes.includes("mediator-data") ? "tunnel" : "local");
  if (i.want === "local" && had === "local") return { ok: true };
  if (i.want === "local") {
    return { ok: false, message: `Found volumes from a MODE=tunnel run (${i.volumes.join(", ")}). Their DIDs are bound to tunnel hosts that no longer exist, and a local VTA must not reuse them.\nReset: npm run reset   (stops tunnels, deletes those volumes), then npm run up.` };
  }
  return {
    ok: false,
    message: had === "local"
      ? `Found volumes from a MODE=local run (${i.volumes.join(", ")}). MODE=tunnel needs a fresh VTA: a did:webvh DID is bound to its host, so the local one cannot move to a tunnel host. Your local data would be lost.\nReset: npm run reset (deletes the local VTA/VTC volumes, .vta and the kit's keys in .env), then npm run up -- --tunnel.`
      : `Found volumes from an earlier MODE=tunnel run (${i.volumes.join(", ")}). Every tunnel run gets new hostnames and therefore new DIDs; the old ones are dead.\nReset: npm run reset, then npm run up -- --tunnel.`,
  };
}

/** Warning text before the heavy mediator build, or undefined when memory looks fine. */
export function memoryWarning(availKb: number | undefined, needGb = 8): string | undefined {
  if (availKb === undefined) return undefined;
  const gb = availKb / 1024 / 1024;
  return gb < needGb
    ? `only ${gb.toFixed(1)} GB of memory is available; the upstream estimate for this build is ${needGb} GB (one observed build stayed within about 1.5 GB above idle). Close other builds, or expect it to fail or swap.`
    : undefined;
}

export const MEDIATOR_BUILD_NOTICE =
  "Building the mediator from source: about 12 minutes cold on a 12-core machine (upstream estimate 20+ min and 8 GB RAM), run under `nice -n 10`. It is built once; later runs reuse the image.";

// --- messaging state -------------------------------------------------------------------------------

export type MessagingState = "ok" | "degraded" | "unknown";
export interface MessagingVerdict { state: MessagingState; text: string }

/**
 * Judge the VTA's messaging from what `messaging/ping/0.2` reports ("protocols" it can serve).
 * A VTA whose mediator connection failed keeps serving REST and only logs a WARN, so a missing
 * didcomm/tsp here is the loud signal. "ok" means transport connected; it does NOT prove a round trip.
 */
export function messagingVerdict(protocols: string[] | undefined, who = "VTA"): MessagingVerdict {
  if (!protocols) return { state: "unknown", text: `the ${who} did not report its protocols` };
  const has = (p: string) => protocols.includes(p);
  if (has("didcomm") && has("tsp")) {
    return { state: "ok", text: `transport connected (${protocols.join(", ")}), not a peer ping` };
  }
  const missing = ["didcomm", "tsp"].filter((p) => !has(p));
  return { state: "degraded", text: `MESSAGING DEGRADED: ${missing.join(" and ")} not available (reports ${protocols.join(", ") || "nothing"}). The ${who} has fallen back to REST only, usually because the mediator refused it or was unreachable.` };
}

/** Extract the protocol list from a ping payload, tolerating a bare array or `{ protocols: [...] }`. */
export function protocolsOf(payload: unknown): string[] | undefined {
  const arr = Array.isArray(payload) ? payload : (payload as { protocols?: unknown } | null)?.protocols;
  return Array.isArray(arr) && arr.every((x) => typeof x === "string") ? (arr as string[]) : undefined;
}

/**
 * The VTC's public-profile `transports`: `[{ protocol, advertised, serviceable, endpoint }]` (observed against
 * vtc-service 0.15.0). Counts a protocol only when it is both advertised and serviceable.
 */
export function vtcMessagingVerdict(profile: unknown): MessagingVerdict {
  const t = (profile as { transports?: unknown } | null)?.transports;
  if (!Array.isArray(t)) return messagingVerdict(undefined, "VTC");
  const live = t
    .filter((x) => x && typeof x === "object" && (x as any).advertised === true && (x as any).serviceable === true && typeof (x as any).protocol === "string")
    .map((x) => (x as { protocol: string }).protocol);
  const v = messagingVerdict(live, "VTC");
  // The public profile only says what the VTC advertises and can serve; it does not prove the mediator link.
  return v.state === "ok" ? { state: "ok", text: `advertised and serviceable (${live.join(", ")}), not a peer ping` } : v;
}
