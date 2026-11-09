// The "Identity" section's words and decoding: this page's applicant DID decoded from the identifier itself (no resolver), and a
// summary of the mediator's DID document read from its did.jsonl. Pure except readMediatorDoc, which takes the fetch to use, so all
// of it is unit-tested (test/identity.test.ts). Read-only: nothing here signs, and only public key material is ever shown.
import { didDocFromLog, webvhLocation } from "@starter/status-panel";
import { parseDidPeer2 } from "@starter/tsp-client";
import { explainFetchFailure } from "@starter/vta-client";
import type { ApplicantKind, RunMode } from "./delivery.ts";

export interface KeyRow { id: string; type: string; purposes: string[]; publicKey: string }
export interface ServiceRow { id?: string; type: string; endpoint: string }
export interface DecodedDid { method: "did:peer:2" | "did:key" | "other"; did: string; keys: KeyRow[]; services: ServiceRow[]; mediatorDid?: string; note: string; error?: string }

// did:peer:2 purpose letters (the did:peer method spec, numalgo 2).
const PURPOSE: Record<string, string> = { E: "keyAgreement", V: "authentication", A: "assertionMethod", I: "capabilityInvocation", D: "capabilityDelegation" };
const CODEC = { "ed25519-pub": "Ed25519", "x25519-pub": "X25519", other: "unknown key type" } as const;

const endpointText = (ep: unknown): string => (typeof ep === "string" ? ep : JSON.stringify(ep));

/** The applicant DID decoded locally: its keys (ids by position, purposes, types) and services. Never throws. */
export function decodeApplicantDid(did: string): DecodedDid {
  if (did.startsWith("did:peer:2.")) {
    try {
      const p = parseDidPeer2(did);
      // The multibase as written in the identifier, in the same order parseDidPeer2 returns the keys.
      const multibase = did.slice("did:peer:2.".length).split(".").filter((s) => s && s[0] !== "S").map((s) => s.slice(1));
      const keys = p.keys.map((k, i) => ({ id: `#key-${i + 1}`, type: CODEC[k.codec], purposes: [PURPOSE[k.purpose] ?? `unknown (${k.purpose})`], publicKey: multibase[i] }));
      const services = p.services.map((s, i) => ({ id: i === 0 ? "#service" : `#service-${i}`, type: s.type, endpoint: endpointText(s.serviceEndpoint) }));
      const tsp = p.services.find((s) => s.type === "TSPTransport");
      const ep = tsp?.serviceEndpoint;
      const mediatorDid = typeof ep === "string" ? ep : ep && typeof ep === "object" && typeof (ep as { uri?: unknown }).uri === "string" ? (ep as { uri: string }).uri : undefined;
      return {
        method: "did:peer:2", did, keys, services, ...(mediatorDid ? { mediatorDid } : {}),
        note: `Decoded from the identifier itself: a did:peer:2 carries its keys and services, so no lookup is made. Key ids are by position, purposes by the did:peer:2 letter (E key agreement, V authentication).${mediatorDid ? " The TSPTransport service names the mediator by its DID: that is where the VTC sends TSP messages for this DID." : " It names no TSPTransport service, so it names no mediator."}`,
      };
    } catch (e) {
      return { method: "did:peer:2", did, keys: [], services: [], note: "This did:peer:2 could not be decoded.", error: (e as Error).message };
    }
  }
  if (did.startsWith("did:key:")) {
    const mb = did.slice("did:key:".length).split("#")[0];
    const type = mb.startsWith("z6Mk") ? "Ed25519" : "unknown key type";
    return {
      method: "did:key", did, services: [],
      keys: [{ id: `#${mb}`, type, purposes: ["authentication", "assertionMethod"], publicKey: mb }],
      note: "A did:key is its public key: decoded from the identifier, no lookup. It names no service, so no mediator; a did:key resolver also derives an X25519 key-agreement key from it.",
    };
  }
  return { method: "other", did, keys: [], services: [], note: "Not a did:peer:2 or did:key: this page does not decode it." };
}

/** What can be shown about the mediator in this mode; `did` set when there is one to read. */
export function mediatorGate(mode: RunMode, mediatorDid: string | null): { did?: string; text: string } {
  if (mode === "local") return { text: "No mediator in local mode: messaging is off, so there is no mediator DID document to show. MODE=tunnel turns messaging on (docs/MESSAGING.md)." };
  if (mode === "farm") return { text: "The kit runs no mediator for a hosted community, so there is no mediator DID document to show here." };
  if (!mediatorDid) return { text: ".vta/tunnel.json has no mediator DID. Is the tunnel stack up? Run `npm run up -- --tunnel`, then restart this dev server." };
  return { did: mediatorDid, text: "The mediator's DID document, as its did.jsonl serves it (the latest log entry). This page does not check the log's hashes or proofs." };
}

/** Which applicant this page uses, in words (the kind decides whether its DID can name the mediator). */
export function applicantLine(kind: ApplicantKind, why?: string): string {
  return kind === "did:peer"
    ? "This page applies as a did:peer:2 whose TSPTransport service names the stack's mediator."
    : `This page applies as its did:key.${why ? ` In tunnel mode it would apply as a did:peer:2, but ${why}` : ""}`;
}

export interface MediatorDocView {
  id: string;
  verificationMethods: { id: string; type: string; publicKey?: string }[];
  /** Verification relationships: name -> the method ids listed under it. */
  relationships: { name: string; ids: string[] }[];
  services: ServiceRow[];
}

const RELATIONSHIPS = ["authentication", "assertionMethod", "keyAgreement", "capabilityInvocation", "capabilityDelegation"];

// Only public fields are copied: an id, a type, publicKeyMultibase, and a JWK's public members. A private member (`d`,
// privateKeyMultibase) in a malformed document is never read.
function publicKeyOf(vm: Record<string, unknown>): string | undefined {
  if (typeof vm.publicKeyMultibase === "string") return vm.publicKeyMultibase;
  const j = vm.publicKeyJwk as Record<string, unknown> | undefined;
  if (j && typeof j === "object") return ["kty", "crv", "x", "y"].filter((k) => typeof j[k] === "string").map((k) => `${k}=${j[k]}`).join(" ");
  return undefined;
}

/** The parts of a DID document worth showing (from a did.jsonl body). Throws on a body that is not a did.jsonl. */
export function summarizeDidLog(body: string): MediatorDocView {
  const { id, doc } = didDocFromLog(body);
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
  const vmOf = (v: unknown) => {
    const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    const pk = publicKeyOf(o);
    return { id: String(o.id ?? "(no id)"), type: String(o.type ?? "(no type)"), ...(pk ? { publicKey: pk } : {}) };
  };
  const verificationMethods = arr(doc.verificationMethod).map(vmOf);
  const relationships: { name: string; ids: string[] }[] = [];
  for (const name of RELATIONSHIPS) {
    const ids = arr(doc[name]).map((r) => {
      if (typeof r === "string") return r;
      const vm = vmOf(r);
      verificationMethods.push(vm); // an embedded method
      return vm.id;
    });
    if (ids.length) relationships.push({ name, ids });
  }
  const services = arr(doc.service).map((s) => {
    const o = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
    return { ...(typeof o.id === "string" ? { id: o.id } : {}), type: Array.isArray(o.type) ? o.type.join(", ") : String(o.type ?? "(no type)"), endpoint: endpointText(o.serviceEndpoint) };
  });
  return { id, verificationMethods, relationships, services };
}

export type MediatorRead =
  | { ok: true; url: string; doc: MediatorDocView; idMatches: boolean }
  | { ok: false; url?: string; text: string };

/** Fetch and summarize the mediator's did.jsonl from the browser. Never throws: a failure comes back as words. */
export async function readMediatorDoc(mediatorDid: string, origin: string, f: typeof fetch = fetch): Promise<MediatorRead> {
  const loc = webvhLocation(mediatorDid);
  if (!loc) return { ok: false, text: "The mediator DID is not a did:webvh, so this page cannot tell where its DID document is." };
  let r: Response;
  try {
    r = await f(loc.url);
  } catch (e) {
    const hint = explainFetchFailure(e, { url: loc.url, origin, server: "mediator", mediatorHost: loc.host });
    return { ok: false, url: loc.url, text: `Could not read the mediator's DID document from this page (${e instanceof Error ? e.message : String(e)}). The applicant side above does not need it.${hint ? `\n\n${hint}` : ""}` };
  }
  if (!r.ok) return { ok: false, url: loc.url, text: `The mediator's host answered HTTP ${r.status} for ${loc.url}.` };
  try {
    const doc = summarizeDidLog(await r.text());
    return { ok: true, url: loc.url, doc, idMatches: doc.id === mediatorDid };
  } catch (e) {
    return { ok: false, url: loc.url, text: `${loc.url} did not hold a readable did.jsonl: ${(e as Error).message}` };
  }
}
