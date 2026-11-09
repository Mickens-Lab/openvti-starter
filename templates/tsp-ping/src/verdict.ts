// The words in the page's verdict box. Pure (no DOM, no network), so it is unit-tested (test/verdict.test.ts).
//
// The mediator's URL comes from its DID document (a did:webvh fetched from the mediator's own host), so this page cannot proxy it:
// its origin must be allowed (MEDIATOR_CORS_ALLOW_ORIGIN), both for that did.jsonl fetch and for the socket. When either is blocked
// the browser reports a bare "Failed to fetch" (wrapped by the resolver as "did:webvh resolve failed: invalidDid — Failed to fetch"),
// so the verdict adds the exact line to set and, when the mediator DID names its host, the command that recreates only the mediator.
import { mediatorHostOf } from "@starter/tsp-client";
import { explainFetchFailure, looksLikeFetchFailure } from "@starter/vta-client";

/** The verdict for a failed ping: the error, then for a fetch or socket the browser could not complete, how to open the mediator to `origin`. */
export function noPongText(e: unknown, origin: string, mediatorDid: string): string {
  const msg = e instanceof Error ? e.message : String(e);
  const host = mediatorHostOf(mediatorDid.trim());
  const resolve = /did:webvh resolve failed|did\.jsonl/i.test(msg);
  const socket = /websocket|socket (closed|error)/i.test(msg);
  const url = resolve && host
    ? `https://${host}/.well-known/did.jsonl (its DID document)`
    : host ? `its tunnel host ${host} (the URL in its DID document)` : "its URL (from its DID document)";
  const hint = looksLikeFetchFailure(e) || socket
    ? explainFetchFailure(new TypeError(msg), { url, origin, server: "mediator", ...(host ? { mediatorHost: host } : {}) })
    : undefined;
  return `No pong: ${msg}${hint ? `\n\n${hint}` : ""}`;
}
