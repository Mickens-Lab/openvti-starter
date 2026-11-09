// The one VtcClient for this page, its call log, and error wording. The identity is the user's own
// generated credential (VTA_CREDENTIAL, as in web-vta-app), in MODE=tunnel as a did:peer:2 naming the mediator, otherwise (or VTC_APPLICANT=did:key) as its did:key;
// the community is VTC_URL / VTC_DID.
import { decodeCredential, explainFetchFailure, identityFromSeed, seedFromMultibase, type Identity } from "@starter/vta-client";
import { didPeerFits, didPeerFromSeed } from "@starter/tsp-client";
import { builtApplicant } from "./delivery.ts";
import { TrustTaskError, VtcClient, refusalCode, type CallEvent } from "@starter/vtc-client";
import { explainRefusal } from "./format.ts";
import { createStore } from "./store.ts";

export const abs = (u: string) => (u.startsWith("/") ? location.origin + u : u);
export const vtcBrowserUrl = () => abs(__VTC_BROWSER_URL__);
export const vtaBrowserUrl = () => abs(__VTA_BROWSER_URL__);
export const credential = (): string | undefined => import.meta.env.VTA_CREDENTIAL || undefined;

export interface LoggedCall extends CallEvent { id: number }
const MAX_LOG = 20;
export const callLog = createStore<LoggedCall[]>([]);
let seq = 0;

export function identity(): Identity {
  const c = credential();
  if (!c) throw new Error("No app credential. Run `npm run up` at the repo root, then restart the dev server.");
  const seed = seedFromMultibase(decodeCredential(c).privateKeyMultibase);
  // MODE=tunnel: a did:peer:2 from the same seed, naming the stack's mediator, unless VTC_APPLICANT=did:key (docs/MESSAGING.md).
  const a = builtApplicant(didPeerFits);
  return a.kind === "did:peer" && a.mediatorDid ? didPeerFromSeed(seed, a.mediatorDid) : identityFromSeed(seed);
}

let clientPromise: Promise<VtcClient> | undefined;
/** One client per page load. Concurrent callers (React StrictMode runs effects twice) share the same connection. */
export function getClient(): Promise<VtcClient> {
  clientPromise ??= (async () => {
    const c = await VtcClient.connect(vtcBrowserUrl(), identity(), undefined, import.meta.env.VTC_DID || undefined);
    c.onCall = (e) => callLog.set((prev) => [{ ...e, id: ++seq }, ...prev].slice(0, MAX_LOG));
    return c;
  })();
  clientPromise.catch(() => { clientPromise = undefined; }); // allow a retry after a failed connect
  return clientPromise;
}

export interface Refusal { status?: number; code?: string; message?: string; network?: boolean }

export function refusalOf(e: unknown): Refusal {
  if (e instanceof TrustTaskError) {
    const p = (e.body as any)?.payload ?? {};
    // A rate-limit answer is not a Trust Task error document: `{ error, message, retryAfterSecs }` at the top level.
    const msg = typeof p.message === "string" ? p.message : typeof (e.body as any)?.message === "string" ? (e.body as any).message : undefined;
    return { status: e.status, code: refusalCode(e.body) ?? (e.status === 429 ? "rateLimited" : undefined), message: msg };
  }
  return { network: true, code: "network", message: e instanceof Error ? e.message : String(e) };
}

/** Plain-words text for any thrown value, for toasts and inline errors. */
export function describeError(e: unknown): string {
  const net = explainFetchFailure(e, { url: vtcBrowserUrl(), origin: location.origin, proxied: __VTC_BROWSER_URL__.startsWith("/"), target: __VTC_URL__, server: "vtc" });
  const r = refusalOf(e);
  if (net) return `${explainRefusal(undefined, "network")}\n${net}`;
  if (r.network && e instanceof Error && !(e instanceof TypeError)) return e.message; // configuration errors are already plain
  return explainRefusal(r.status, r.code, r.message);
}
