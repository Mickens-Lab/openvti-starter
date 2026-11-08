// Connection-status panel: vanilla TS, no dependencies. Call mountStatusPanel(container, options).
import { CSS } from "./style.ts";
import { custodyRows, type CustodyInput } from "./custody.ts";
import { messagingRow, PING_TASK, protocolsOf } from "./messaging.ts";
import { applicantCardRows, cardMediator, webvhLocation, type ApplicantInfo, type LogProbe } from "./applicant.ts";
import { TUNNEL_LIFETIME } from "./tunnel.ts";
import {
  compareVersions, compatHints, didDocFromLog, groupTasks, mediatorDid, parseDidDocServices, relativeTime,
  shortDid, versionFromOpenApi, type DidService,
} from "./parse.ts";

export type Pill = "ok" | "warn" | "bad" | "unknown" | "info";

/** The slice of `VtaClient` the panel uses. Pass your already-built client or let `connect` build one. */
export interface PanelClient {
  vtaDid: string;
  me: { did: string };
  token?: string;
  whoami(): Promise<Record<string, any>>;
  discover(): Promise<string[]>;
  /** Optional generic Trust Task call (VtaClient has it); used for messaging/ping/0.2 in tunnel mode. */
  call?(type: string, payload?: Record<string, unknown>): Promise<unknown>;
}

export interface PanelOptions {
  mode: "local" | "tunnel" | "farm";
  /** Where the browser sends VTA requests (farm mode: a same-origin proxy path such as `/__vta`). Absolute or origin-relative. */
  vtaUrl: string;
  /** The real VTA URL to show people (farm mode: the hosted URL behind the proxy). Defaults to vtaUrl. */
  vtaDisplayUrl?: string;
  /** Is an app credential configured at all? false renders the "credential missing" fix. */
  credentialPresent: boolean;
  /** Build and AUTHENTICATE a client. Called on refresh when no working session exists. Throw to report failure. */
  connect?: () => Promise<PanelClient>;
  /** Version pin from pins.json, and the Farm image name to pick. */
  pin: { version: string; imageTag: string; portalDefault?: string };
  /** The selected VTA Farm (FARM=...), shown in farm mode: id, display name, portal URL, known issues. */
  farm?: { id: string; name: string; portalUrl: string; issues?: string[] };
  /** Show the "dev-only: the app key is embedded in this page" warning. */
  keyEmbedded?: boolean;
  /** Where the badge links to (a README/docs URL). */
  keyNoteUrl?: string;
  /** Set when the app moved the key off the page: "backend" (level 1) or "webcrypto" (level 2). Feeds the Key custody card. */
  keyCustody?: CustodyInput["custody"];
  /**
   * What the page knows about the identity that applies to the community (feeds the "Applicant and messaging" card): kind, the DID
   * when built, why a tunnel-mode did:peer:2 fell back to the did:key, and the stack's mediator DID (.vta/tunnel.json). Optional.
   */
  applicant?: ApplicantInfo;
  vtc?: {
    url: string;
    displayUrl?: string;
    did?: string;
    /** Read-only manifest fetch (e.g. VtcClient.manifest). Optional: without it only /health is checked. */
    manifest?: () => Promise<{ communityDid?: string; criteria?: unknown[]; branding?: Record<string, unknown>; [k: string]: unknown }>;
  };
  title?: string;
  /** 0 = off. The panel offers 15 s / 30 s in a menu. */
  autoRefreshMs?: number;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface PanelHandle { refresh(): Promise<void>; destroy(): void }

interface Row { pill: Pill; label: string; value?: Node | string; note?: string; fix?: string; extra?: Node }
/** `advisory` cards show their own state but do not move the overall connection status. */
interface Card { title: string; rows: Row[]; details?: unknown; advisory?: boolean }

// --- tiny DOM helper -----------------------------------------------------------
type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string> | null, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) el.setAttribute(k, v);
  for (const k of kids) if (k) el.append(k);
  return el;
}
const code = (s: string) => h("code", null, s);
const PILL_TEXT: Record<Pill, string> = { ok: "OK", warn: "Warning", bad: "Problem", unknown: "Unknown", info: "Info" };
/** Worst state; "unknown" rows are informational and only count when nothing is known at all. */
const worst = (ps: Pill[]): Pill => (ps.includes("bad") ? "bad" : ps.includes("warn") ? "warn" : ps.includes("ok") ? "ok" : "unknown");

/** Text with `code` spans rendered as <code>. */
function rich(t: string): (Node | string)[] {
  return t.split(/`([^`]+)`/).map((part, i) => (i % 2 ? code(part) : part));
}
function rowEl(r: Row): HTMLElement {
  return h("div", { class: "sp-row" },
    h("span", { class: `sp-pill sp-${r.pill}` }, PILL_TEXT[r.pill]),
    h("div", { class: "sp-body" },
      h("div", { class: "sp-label" }, r.label),
      r.value !== undefined && h("div", { class: "sp-val" }, ...(typeof r.value === "string" ? rich(r.value) : [r.value])),
      r.note && h("div", { class: "sp-note" }, ...rich(r.note)),
      r.fix && h("div", { class: "sp-fix" }, ...rich(r.fix)),
      r.extra));
}
function cardEl(c: Card): HTMLElement {
  const sum: Pill = c.rows.every((r) => r.pill === "info") ? "info" : worst(c.rows.map((r) => r.pill));
  const el = h("section", { class: "sp-card" },
    h("h2", null, c.title, h("span", { class: `sp-pill sp-sum sp-${sum}` }, PILL_TEXT[sum])),
    ...c.rows.map(rowEl));
  if (c.details !== undefined) {
    el.append(h("details", null, h("summary", null, "details"), h("pre", null, JSON.stringify(c.details, null, 2))));
  }
  return el;
}

// --- network helpers -------------------------------------------------------------
interface Probe { ok: boolean; status?: number; ms: number; body?: string; error?: string; corsBlocked?: boolean }

async function probe(f: typeof fetch, url: string, timeoutMs: number): Promise<Probe> {
  const t0 = performance.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await f(url, { signal: ac.signal, cache: "no-store" });
    const body = await res.text();
    return { ok: res.ok, status: res.status, ms: Math.round(performance.now() - t0), body };
  } catch (e) {
    const ms = Math.round(performance.now() - t0);
    if (ac.signal.aborted) return { ok: false, ms, error: `no answer within ${timeoutMs / 1000} s` };
    // A blocked CORS request and a dead host both surface as TypeError. A no-cors retry tells them apart:
    // it resolves (opaque) when something is listening, and still fails when nothing is.
    let corsBlocked = false;
    try {
      const ac2 = new AbortController();
      const t2 = setTimeout(() => ac2.abort(), timeoutMs);
      await f(url, { mode: "no-cors", signal: ac2.signal });
      clearTimeout(t2);
      corsBlocked = true;
    } catch { /* really unreachable */ }
    return { ok: false, ms, corsBlocked, error: String((e as Error)?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}
const json = (p: Probe): any => { try { return p.body ? JSON.parse(p.body) : undefined; } catch { return undefined; } };
const within = <T,>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000} s`)), ms))]);
const join = (base: string, path: string) => base.replace(/\/+$/, "") + path;

function reachRow(name: string, p: Probe, url: string, origin: string, mode: string): Row {
  if (p.ok) return { pill: "ok", label: "Reachable", value: `yes, round trip ${p.ms} ms`, note: `${name} answered GET /health (HTTP ${p.status}).` };
  if (p.status && (mode === "farm" || p.status === 502) && p.status >= 500) {
    return { pill: "bad", label: "Reachable", value: `no: the dev-server proxy got HTTP ${p.status} from ${url}`, note: `The proxy (/__vta) could not reach the VTA at ${url}, or the host answered with a server error.`,
      fix: mode === "farm" ? "Check VTA_URL in the repo-root .env against the URL in the VTA Farm portal, that the agent shows \"online\", then restart `npm run dev`." : "Is the stack up? Run `npm run doctor`, then `npm run up`; if VTA_URL in the repo-root .env changed, restart `npm run dev`." };
  }
  if (p.status) {
    return { pill: "bad", label: "Reachable", value: `answered HTTP ${p.status} on /health`, note: `Something is listening at ${url} but it is not healthy (or not a ${name}).`,
      fix: `Check ${url} is the ${name} URL (${mode === "farm" ? "VTA_URL in .env must match the Farm portal" : "run `npm run up`"}) and look at the service logs.` };
  }
  if (p.corsBlocked) {
    return { pill: "bad", label: "Reachable", value: "blocked by the browser (CORS)", note: `${name} is up, but it does not allow this page's origin (${origin}).`,
      fix: mode === "farm" ? "Use MODE=farm so Vite proxies the hosted VTA (the page stays same-origin), and restart `npm run dev`." : `This page calls the VTA directly, so the VTA's CORS list applies. Call it through the dev proxy (/__vta, as the templates do), or allow ${origin}: set CORS_ORIGINS_TOML to a list that includes it (it replaces the default), then \`npm run reset && npm run up\`.` };
  }
  return { pill: "bad", label: "Reachable", value: `no (${p.error ?? "no answer"})`, note: `Nothing answered at ${url}.`,
    fix: mode === "farm" ? "Check VTA_URL in the repo-root .env against the Farm portal, and that the agent shows \"online\"." : "Start the stack with `npm run up` (or `npm run up`), then refresh." };
}

/** Classify a thrown connect/call error into a pill row with a fix. */
function authError(e: unknown, o: PanelOptions): Row {
  const msg = String((e as Error)?.message ?? e);
  const status = (e as { status?: number })?.status;
  let note = msg.length > 300 ? msg.slice(0, 300) + "…" : msg;
  let fix = "Re-run `npm run vta:provision` (local) or `npm run farm:setup` (Farm), restart `npm run dev`, and refresh.";
  if (/DID changed/i.test(msg)) note = "The VTA's DID is not the one in the credential: the stack was reset after the credential was made.";
  else if (status === 401 || status === 403 || /unauthor|forbidden|aclDenied|not.?found.*acl/i.test(msg)) note = `The VTA refused this app (${note}). The app DID may not be in the VTA's ACL any more.`;
  else if (/did\.jsonl|\/\.well-known/i.test(msg)) { note = "Could not read the VTA's DID log."; fix = o.mode === "farm" ? "Farm VTAs may not publish did.jsonl at the root; farm mode should trust the DID from the credential." : fix; }
  return { pill: "bad", label: "Authenticated", value: "no", note, fix };
}

// --- the panel ----------------------------------------------------------------------
let cssInjected = false;

export function mountStatusPanel(container: HTMLElement, o: PanelOptions): PanelHandle {
  if (!cssInjected) { document.head.append(h("style", { "data-status-panel": "" }, CSS)); cssInjected = true; }
  const f = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const timeoutMs = o.timeoutMs ?? 8000;
  const vtaShown = o.vtaDisplayUrl ?? o.vtaUrl;
  const origin = location.origin;
  const root = h("div", { class: "sp-root" });
  container.replaceChildren(root);

  let client: PanelClient | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let busy = false;
  let destroyed = false;
  let lastRun = "";

  const btn = h("button", { type: "button" }, "Refresh");
  const auto = h("select", { "aria-label": "Auto-refresh" },
    h("option", { value: "0" }, "Auto-refresh: off"), h("option", { value: "15000" }, "every 15 s"), h("option", { value: "30000" }, "every 30 s"));
  const stamp = h("span", { class: "sp-stamp" }, "not checked yet");
  const overall = h("span", { class: "sp-pill sp-unknown" }, "Checking");
  const bar = h("div", { class: "sp-bar" }, h("h2", { class: "sp-title" }, o.title ?? "Connection status"), overall, stamp, auto, btn);
  const banner = o.keyEmbedded
    ? h("div", { class: "sp-banner", role: "note" }, h("b", null, "Dev-only: the app key is embedded in this page. "),
        "Anyone who can load it can act as this app. Use it for local demos; for anything real keep the key on a backend or sign with the wallet. ",
        o.keyNoteUrl ? h("a", { href: o.keyNoteUrl, target: "_blank", rel: "noopener" }, "Read the note") : null)
    : null;
  const grid = h("div", { class: "sp-grid" });
  root.append(bar); if (banner) root.append(banner); root.append(grid);

  auto.onchange = () => setAuto(Number(auto.value));
  function setAuto(ms: number) {
    if (timer) clearInterval(timer);
    timer = ms > 0 ? setInterval(() => void refresh(), ms) : undefined;
    auto.value = String(ms);
  }
  if (o.autoRefreshMs) setAuto(o.autoRefreshMs);

  async function collect(): Promise<Card[]> {
    const cards: Card[] = [];
    const base = o.vtaUrl;
    // Public reads in parallel.
    const [health, openapi, didlog] = await Promise.all([
      probe(f, join(base, "/health"), timeoutMs),
      probe(f, join(base, "/openapi.json"), timeoutMs),
      probe(f, join(base, "/.well-known/did.jsonl"), timeoutMs),
    ]);
    const reachable = health.ok || (!!health.status && !(o.mode === "farm" && health.status >= 500));

    // 1. Connection
    const hb = json(health);
    cards.push({
      title: "1. Connection",
      rows: [
        { pill: o.mode === "tunnel" ? "warn" : "ok", label: "Mode", value: o.mode, note: o.mode === "tunnel" ? `Local containers behind public Cloudflare quick tunnels, with an OPEN mediator (messaging on). ${TUNNEL_LIFETIME}; demo data only (docs/MODES.md).` : o.mode === "farm" ? `Hosted VTA on the VTA Farm${o.farm ? ` "${o.farm.name}" (FARM=${o.farm.id}, portal ${o.farm.portalUrl})` : ""}, reached through the dev server's /__vta proxy.${o.farm?.issues?.length ? " Known issue: " + o.farm.issues.join(" ") : ""}` : "Local VTA from this repo's docker compose stack." },
        { pill: "info", label: "VTA URL", value: vtaShown, note: o.vtaUrl !== vtaShown ? `The browser calls ${o.vtaUrl} (same-origin proxy).` : undefined },
        reachRow("VTA", health, vtaShown, origin, o.mode),
        health.ok
          ? { pill: hb?.status === "ok" ? "ok" : "warn", label: "/health", value: hb ? `status: ${String(hb.status ?? "?")}` : `HTTP ${health.status}`, note: hb?.status === "ok" ? "The VTA reports itself healthy." : "The VTA answered but did not say status ok." }
          : { pill: "unknown", label: "/health", value: "no result", note: "Needs a reachable VTA." },
      ],
      details: { health: hb ?? health.body ?? health.error, httpStatus: health.status, roundTripMs: health.ms },
    });

    // 2. Identity
    const idRows: Row[] = [];
    let didDoc: Record<string, unknown> | undefined;
    let logDid: string | undefined;
    let logErr: string | undefined;
    if (didlog.ok) {
      try { const d = didDocFromLog(didlog.body ?? ""); didDoc = d.doc; logDid = d.id; } catch (e) { logErr = String((e as Error).message); }
    }
    const knownDid = client?.vtaDid;
    const did = logDid ?? knownDid;
    if (did) {
      idRows.push({ pill: "ok", label: "VTA DID", value: h("code", { title: did }, did) });
      const how = o.mode === "farm"
        ? logDid ? "Read from the VTA's did.jsonl and it is also the DID trusted from the credential (farm mode)." : "Trusted from your credential/.env (farm mode). A hosted VTA may not serve did.jsonl at its root."
        : logDid ? "Resolved from the VTA's /.well-known/did.jsonl (last log entry)." : "Known from the credential; the VTA's did.jsonl could not be read.";
      idRows.push({ pill: logDid || o.mode === "farm" ? "ok" : "warn", label: "How it was resolved", value: logDid ? "did.jsonl at the VTA" : o.mode === "farm" ? "trusted from config" : "from credential only", note: how });
      if (logDid && knownDid && logDid !== knownDid) idRows.push({ pill: "bad", label: "DID matches credential", value: "no", note: "The VTA now publishes a different DID than your credential names.", fix: "The stack was reset: re-run `npm run vta:provision` and restart the dev server." });
    } else {
      idRows.push({ pill: "bad", label: "VTA DID", value: "unknown", note: reachable ? `Could not read the DID log${logErr ? ` (${logErr})` : didlog.status ? ` (HTTP ${didlog.status})` : ""}.` : "The VTA is not reachable.", fix: reachable ? "Open /.well-known/did.jsonl on the VTA, or set VTA_DID in .env." : "Fix the connection first." });
    }
    let services: DidService[] = [];
    let mediator: string | undefined;
    if (didDoc) { services = parseDidDocServices(didDoc); mediator = mediatorDid(didDoc); }
    const svcRow = (label: string, kind: DidService["kind"], what: string): Row => {
      const s = services.filter((x) => x.kind === kind);
      return s.length
        ? { pill: "ok", label, value: s.flatMap((x) => x.endpoints).join(", ") || "(no endpoint)", note: `${what} Advertised in the DID document.` }
        : { pill: "unknown", label, value: didDoc ? "not advertised" : "unknown", note: didDoc ? `The DID document does not advertise ${label.replace(" service","")}. ${o.mode === "local" ? "That is normal for a local VTA." : "Hosted VTAs may advertise these only when configured."}` : "No DID document to read." };
    };
    idRows.push(svcRow("REST service", "rest", "HTTP endpoint for Trust Tasks."));
    idRows.push(svcRow("DIDComm service", "didcomm", "Messaging endpoint."));
    idRows.push(svcRow("TSP service", "tsp", "Trust Spanning Protocol endpoint."));
    idRows.push(mediator
      ? { pill: "ok", label: "Mediator DID", value: h("code", null, mediator), note: "DIDComm messages are routed through this mediator." }
      : { pill: "unknown", label: "Mediator DID", value: didDoc ? "not advertised" : "unknown", note: didDoc ? "No mediator in the DID document." : undefined });
    const others = services.filter((x) => x.kind === "other");
    if (others.length) idRows.push({ pill: "info", label: "Other services", value: others.map((x) => `${x.type}: ${x.endpoints.join(", ")}`).join("; ") });
    cards.push({ title: "2. VTA identity", rows: idRows, details: { didDocumentServices: didDoc ? (didDoc as any).service ?? [] : undefined } });

    // 3. Version
    const verRows: Row[] = [];
    const oa = openapi.ok ? json(openapi) : undefined;
    const observed = versionFromOpenApi(oa);
    const verdict = compareVersions(observed, o.pin.version);
    const tag = o.pin.imageTag;
    if (!reachable) verRows.push({ pill: "unknown", label: "vta-service version", value: "unknown", note: "The VTA is not reachable." });
    else if (!observed) verRows.push({ pill: "warn", label: "vta-service version", value: "unavailable", note: `GET /openapi.json ${openapi.status ? `returned HTTP ${openapi.status}` : "failed"}, so the version cannot be read. The pin is ${o.pin.version}; /health carries no version.` });
    else verRows.push({ pill: verdict === "match" ? "ok" : "warn", label: "vta-service version", value: observed, note: "From GET /openapi.json info.version." });
    verRows.push({ pill: "info", label: "Pinned in this kit", value: o.pin.version, note: "From pins.json (the version this kit was validated against)." });
    if (reachable && observed) {
      const text = { match: "Same as the pin.", older: `Older than the pin: newer Trust Task versions this kit sends may be refused.`, newer: "Newer than the pin: usually fine, but not validated here.", different: "Differs from the pin (pre-release or custom build).", unknown: "" }[verdict];
      verRows.push({ pill: verdict === "match" ? "ok" : "warn", label: "Compared with the pin", value: verdict === "match" ? "match" : verdict, note: text });
    }
    if (o.mode === "farm") {
      verRows.push({ pill: verdict === "match" ? "ok" : "warn", label: "Farm image to pick", value: h("code", null, tag),
        note: `In the VTA Farm portal pick the VTA image "${tag}" when creating the agent. The portal's default image${o.pin.portalDefault ? ` (${o.pin.portalDefault})` : ""} is NOT compatible with this kit.`,
        fix: verdict === "match" ? undefined : `Delete the agent and create a new one with image "${tag}" (see docs/FARM.md).` });
    }
    cards.push({ title: "3. Version", rows: verRows, details: { observed, pinned: o.pin.version, imageTag: tag, verdict, openapiInfo: oa?.info } });

    // 4/5. Auth + capabilities
    const authRows: Row[] = [];
    const capRows: Row[] = [];
    let who: Record<string, any> | undefined;
    let types: string[] | undefined;
    let authFailed = false;
    if (!o.credentialPresent) {
      authRows.push({ pill: "bad", label: "Authenticated", value: "no", note: "No app credential (VTA_CREDENTIAL) was found when this page was built.",
        fix: o.mode === "farm" ? "Run `npm run farm:setup`, then restart `npm run dev`." : "Run `npm run up` at the repo root, then restart `npm run dev`." });
    } else if (!reachable) {
      authRows.push({ pill: "unknown", label: "Authenticated", value: "unknown", note: "Cannot sign in: the VTA is not reachable. A credential is configured." });
    } else if (!o.connect) {
      authRows.push({ pill: "unknown", label: "Authenticated", value: "not attempted", note: "This page was mounted without a connect() function." });
    } else {
      try {
        if (client) { try { who = await client.whoami(); } catch { client = undefined; } }
        if (!client) { client = await within(o.connect(), timeoutMs * 2, "sign-in"); who = await client.whoami(); }
        if (!who) who = await client.whoami();
      } catch (e) { client = undefined; authFailed = true; authRows.push(authError(e, o)); }
    }
    if (who && client) {
      const roles = (who.roles as string[] | undefined) ?? [];
      const scopes = (who.scopes as string[] | undefined) ?? [];
      const ctx = scopes.filter((s) => s.startsWith("ctx:")).map((s) => s.slice(4));
      const exp = who.session?.expiresAt as string | undefined;
      const rel = relativeTime(exp);
      authRows.push({ pill: "ok", label: "Authenticated", value: "yes", note: "The VTA accepted this app's signed challenge and returned a session." });
      authRows.push({ pill: "info", label: "App DID", value: h("code", null, client.me.did) });
      authRows.push({ pill: roles.length ? "ok" : "warn", label: "Role", value: roles.join(", ") || "none", note: roles.length ? "What the VTA's ACL lets this app do." : "No role reported: the app may not be in the ACL." });
      authRows.push({ pill: ctx.length ? "ok" : "unknown", label: "Context", value: ctx.join(", ") || "none", note: "The VTA context this app is scoped to (from ctx: scopes)." });
      authRows.push({ pill: "info", label: "Scopes", value: scopes.length ? h("div", { class: "sp-chips" }, ...scopes.map((s) => h("span", { class: "sp-chip" }, s))) : "none" });
      authRows.push(exp
        ? { pill: rel?.startsWith("expired") ? "warn" : "ok", label: "Session expires", value: `${exp} (${rel})`, note: "The page signs in again on refresh when the session has lapsed." }
        : { pill: "unknown", label: "Session expires", value: "not reported" });
      try { types = await client.discover(); } catch (e) {
        capRows.push({ pill: "bad", label: "Capabilities", value: "discovery failed", note: String((e as Error).message).slice(0, 300), fix: "Check the app role: discovery answers authenticated callers only." });
      }
    } else if (!authFailed) {
      capRows.push({ pill: "unknown", label: "Capabilities", value: "unknown", note: "Needs an authenticated session (discovery answers authenticated callers only)." });
    } else {
      capRows.push({ pill: "unknown", label: "Capabilities", value: "unknown", note: "Needs an authenticated session." });
    }
    if (types) {
      const groups = groupTasks(types);
      const list = h("details", null, h("summary", null, `all ${types.length} Trust Task types`),
        h("pre", null, groups.map((g) => `${g.family} (${g.count})\n` + g.types.map((t) => `  ${t.uri.replace(/^https:\/\/trusttasks\.org\/spec\//, "")}`).join("\n")).join("\n")));
      capRows.push({ pill: types.length ? "ok" : "warn", label: "Discovery", value: `${types.length} Trust Task types, ${groups.length} families`, note: "From trust-task-discovery: what this VTA says it serves.",
        extra: h("div", null, h("div", { class: "sp-chips" }, ...groups.map((g) => h("span", { class: "sp-chip", title: g.names.join(", ") }, `${g.family} ${g.count}`))), list) });
      for (const hint of compatHints(types)) capRows.push({ pill: hint.ok === undefined ? "unknown" : hint.ok ? "ok" : "warn", label: hint.label, value: hint.ok ? "supported" : hint.ok === false ? "check" : "unknown", note: hint.text });
    }
    // Messaging state: in tunnel mode ask the VTA which protocols it serves (a silent REST-only fallback shows up here).
    let protocols: string[] | undefined;
    let pingError: string | undefined;
    if (client && who && o.mode === "tunnel" && client.call) {
      try { protocols = protocolsOf(await within(client.call(PING_TASK, {}), timeoutMs, "messaging ping")); } catch (e) { pingError = String((e as Error).message).slice(0, 200); }
    }
    idRows.push(messagingRow({ mode: o.mode, services, protocols, pingError, haveDidDoc: !!didDoc }));
    cards.push({ title: "4. Auth and session", rows: authRows, details: who ? { whoami: who } : undefined });
    cards.push({ title: "5. Capabilities", rows: capRows, details: types ? { supportedTypes: types } : undefined });

    // 6. Wallet
    const w = (window as unknown as { vtaWallet?: Record<string, unknown> }).vtaWallet;
    const fns = w ? Object.keys(w).filter((k) => typeof w[k] === "function").sort() : [];
    cards.push({
      title: "6. Wallet",
      rows: [w
        ? { pill: "ok", label: "window.vtaWallet", value: "detected", note: fns.length ? "The browser wallet can sign Trust Tasks and look up your profile." : "Detected, but it exposes no functions I can see.",
            extra: fns.length ? h("div", { class: "sp-chips" }, ...fns.map((n) => h("span", { class: "sp-chip" }, n))) : undefined }
        : { pill: "info", label: "window.vtaWallet", value: "not detected", note: "Optional. Without the VTA browser extension the rest of the app still works; wallet sign-in is simply unavailable." }],
    });

    // 7. VTC
    if (o.vtc) {
      const v = o.vtc;
      const shown = v.displayUrl ?? v.url;
      const vh = await probe(f, join(v.url, "/health"), timeoutMs);
      const vb = json(vh);
      const rows: Row[] = [reachRow("VTC", vh, shown, origin, o.mode)];
      rows[0].label = "VTC reachable";
      rows.unshift({ pill: "info", label: "VTC URL", value: shown });
      if (vh.ok && vb) {
        rows.push({ pill: "ok", label: "VTC version", value: String(vb.version ?? "unknown"), note: "From the VTC's public /health." });
        const vdid = (vb.vtc_did as string | undefined) ?? v.did;
        if (vdid) rows.push({ pill: "info", label: "VTC DID", value: h("code", { title: vdid }, shortDid(vdid, 64)) });
      }
      let manifest: unknown;
      if (v.manifest && vh.ok) {
        try {
          const m = await within(v.manifest(), timeoutMs, "manifest call");
          manifest = m;
          const b = (m.branding ?? {}) as Record<string, unknown>;
          const name = [b.name, b.communityName, b.title, (m as any).communityName, (m as any).name].find((x) => typeof x === "string") as string | undefined;
          rows.push({ pill: "ok", label: "Join manifest", value: `${(m.criteria ?? []).length} join criteria${name ? `, community "${name}"` : ""}`, note: name ? undefined : "The manifest has no community name; showing the DID instead.", extra: !name && m.communityDid ? h("code", null, shortDid(String(m.communityDid), 64)) : undefined });
        } catch (e) { rows.push({ pill: "warn", label: "Join manifest", value: "could not read", note: String((e as Error).message).slice(0, 240), fix: "The VTC answers /health but the manifest call failed; check VTC_DID and the VTC logs." }); }
      } else if (!v.manifest) {
        rows.push({ pill: "unknown", label: "Join manifest", value: "not checked", note: "Only the public /health was read; the manifest request is signed, so it needs the app credential (or a manifest helper) which this page does not have." });
      }
      cards.push({ title: "7. Community (VTC)", rows, details: { health: vb ?? vh.body, manifest } });
    } else {
      cards.push({ title: "7. Community (VTC)", rows: [{ pill: "unknown", label: "VTC link", value: "not configured", note: "Optional. Set VTC_URL (and VTC_DID in farm mode) in the repo-root .env and restart the dev server to see the community here." }] });
    }
    cards.push({ title: "8. Key custody", advisory: true, rows: custodyRows({ mode: o.mode, keyEmbedded: o.keyEmbedded, credentialPresent: o.credentialPresent, custody: o.keyCustody, vtaUrl: vtaShown, docsUrl: o.keyNoteUrl }) });

    // 9. Applicant and messaging. Tunnel mode only fetches anything: the mediator's did.jsonl at its did:webvh host, from the browser.
    const medForCard = cardMediator({ mode: o.mode, applicant: o.applicant, advertisedMediator: mediator });
    const loc = medForCard ? webvhLocation(medForCard) : undefined;
    let medLog: LogProbe | undefined;
    if (loc) medLog = await probe(f, loc.url, timeoutMs);
    cards.push({ title: "9. Applicant and messaging", advisory: true,
      rows: applicantCardRows({ mode: o.mode, applicant: o.applicant, advertisedMediator: mediator, probe: medLog, origin }),
      details: o.mode === "tunnel" ? { applicant: o.applicant, mediatorDid: medForCard, didJsonl: loc?.url, httpStatus: medLog?.status, corsBlocked: medLog?.corsBlocked } : undefined });
    return cards;
  }

  async function refresh() {
    if (busy || destroyed) return;
    busy = true;
    btn.disabled = true;
    btn.textContent = "Checking…";
    overall.className = "sp-pill sp-unknown";
    overall.textContent = "Checking";
    let cards: Card[];
    try {
      cards = await collect();
    } catch (e) {
      cards = [{ title: "Status check failed", rows: [{ pill: "bad", label: "Unexpected error", value: String((e as Error)?.message ?? e), fix: "Reload the page; if it persists, open the browser console." }] }];
    }
    if (destroyed) return;
    grid.replaceChildren(...cards.map(cardEl));
    const w = worst(cards.filter((c) => !c.advisory).flatMap((c) => c.rows.map((r) => r.pill)));
    overall.className = `sp-pill sp-${w}`;
    overall.textContent = { ok: "All good", warn: "Warnings", bad: "Problems", unknown: "Unknown", info: "Unknown" }[w];
    lastRun = new Date().toLocaleTimeString();
    stamp.textContent = `checked ${lastRun}`;
    btn.disabled = false;
    btn.textContent = "Refresh";
    busy = false;
  }
  btn.onclick = () => void refresh();
  void refresh();
  return { refresh, destroy() { destroyed = true; if (timer) clearInterval(timer); root.remove(); } };
}
