// The "Credential frames" panel's words and decisions: when it may listen, what each frame is called, the running tally and the
// closing line, and the explanation for a failed connect. Pure, so it is unit-tested (test/frames.test.ts). The frame kinds and the
// tally are the ones `npm run tsp:listen` uses (@starter/tsp-client src/frames.ts). Nothing here reads or verifies a credential.
import { explainFetchFailure, looksLikeFetchFailure } from "@starter/vta-client";
import { ISSUE_TYPE, mediatorHostOf, type Frame, type Tally } from "@starter/tsp-client";
import type { ApplicantKind, RunMode } from "./delivery.ts";

/** Whether this page can listen, and if not, why (shown instead of the button). */
export type FramesGate = { listen: false; title: string; text: string } | { listen: true; relate: boolean; mediatorDid: string };

export function framesGate(mode: RunMode, applicant: { kind: ApplicantKind; mediatorDid: string | null }): FramesGate {
  if (mode === "local") {
    return { listen: false, title: "No mediator in local mode", text: "Credential frames travel over TSP through the tunnel stack's mediator. The local stack has messaging off and no mediator, so there is nothing to listen to. MODE=tunnel turns messaging on (docs/MESSAGING.md)." };
  }
  if (mode === "farm") {
    return { listen: false, title: "Not available in farm mode", text: "The kit runs no mediator for a hosted community, so this page has none to log in to. Whether a hosted community pushes to this identity is unverified (docs/MODES.md)." };
  }
  if (!applicant.mediatorDid) {
    return { listen: false, title: "Mediator not known", text: ".vta/tunnel.json has no mediator DID. Is the tunnel stack up? Run `npm run up -- --tunnel`, then restart this dev server." };
  }
  // A did:key names no mediator: the VTC learns its route only from TSP contact, so it sends a relationship invite first (as tsp:listen does).
  return { listen: true, relate: applicant.kind === "did:key", mediatorDid: applicant.mediatorDid };
}

/** One frame, in words. */
export function frameKind(f: Frame): string {
  if ("control" in f) return f.control === "invite" ? "relationship invite" : f.control === "accept" ? "relationship accept" : `relationship ${f.control}`;
  if ("unreadable" in f) return "unreadable, or not from the VTC";
  if (f.documentType === ISSUE_TYPE) return "credential-exchange/issue/0.1";
  return `other document: ${f.documentType ?? "(no document type)"}`;
}

export function tallyLine(t: Tally): string {
  const total = t.invites + t.accepts + t.issues + t.other.length + t.unreadable;
  return `${total} frame${total === 1 ? "" : "s"}: ${t.invites} invite, ${t.accepts} accept, ${t.issues} credential-exchange/issue, ${t.other.length} other, ${t.unreadable} unreadable`;
}

/** The running conclusion: what arrived, and that it is not credentialsDelivered. */
export function framesVerdict(t: Tally): string {
  if (t.issues > 0) return `${t.issues} credential-exchange/issue/0.1 frame${t.issues === 1 ? "" : "s"} arrived from the VTC. This page keeps the community's membership credential from them in memory, so "Send my membership credential back" can bind to it; it does not verify that credential's proof (the community checks the digest against the one it issued).`;
  return "No credential-exchange/issue/0.1 frame yet. It is pushed right after an administrator approves the request (`npm run vtc:approve`).";
}

export const NOT_DELIVERED_FLAG = "Frames arriving is not credentialsDelivered. That flag turns true only when the community holds your own membership credential sent back to it (vtc/members/vmc/0.1), so frames alone leave it false; the membership card's \"Send my membership credential back\" sends one (docs/MESSAGING.md, \"What credentialsDelivered means\").";

export const ONE_LISTENER = "The mediator keeps one live-delivery socket per DID. If `npm run tsp:listen` runs as the same DID at the same time, a frame may go to that listener instead of this page.";

/** Re-exported: the host extraction is shared with the tsp-ping page (@starter/tsp-client src/webvh.ts). */
export { mediatorHostOf };

export const CONNECT_TIMEOUT_MS = 20_000;
export class ConnectTimeout extends Error {
  constructor(ms: number) { super(`no answer from the mediator within ${Math.round(ms / 1000)} s (login, socket and DID resolution)`); this.name = "ConnectTimeout"; }
}

/** The text for a failed or timed-out connect: the error, and for a browser fetch/socket failure the exact MEDIATOR_CORS_ALLOW_ORIGIN line. */
export function connectFailureText(e: unknown, origin: string, mediatorDid: string): string {
  const msg = e instanceof Error ? e.message : String(e);
  const ctx = { url: "its tunnel host (the URL in its DID document)", origin, server: "mediator" as const, mediatorHost: mediatorHostOf(mediatorDid) };
  // A refused WebSocket upgrade (403 to a browser Origin) reaches the page with no detail, like a blocked fetch: give the same explanation.
  const socket = /websocket|socket (closed|error)|\b403\b/i.test(msg);
  const hint = looksLikeFetchFailure(e) || socket ? explainFetchFailure(new TypeError(msg), ctx) : undefined;
  if (e instanceof ConnectTimeout) return `Could not start listening: ${msg}. Is the tunnel stack up (\`npm run doctor\`)? Then try again.`;
  return `Could not start listening: ${msg}${hint ? `\n\n${hint}` : ""}`;
}
