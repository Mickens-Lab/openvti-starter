// Task consent ("approve on a second device"), the requester and approver halves, in plain TypeScript.
// Mirrors what the VTA documents for `consent` approval rules (vta-sdk `task_consent`): a gated task is refused with
// `auth:consent_required`; the refusal carries one VTA-signed `task-consent/request` per approver; an approver verifies it,
// compares a six-character match code with the requester's screen, and returns a signed `task-consent/decision`. The
// requester then re-submits the identical task. No Node-only imports: runs in browsers too.
//
// Labels: the shapes here are read from the VTA's published docs and checked against a live VTA 0.65.0 (docs/APPROVALS.md).
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import { resolveDIDFromLog } from "didwebvh-ts";
import { canonicalBytes, fromMultibase, signTrustTask } from "@openvtc/trust-tasks-proof";
import { TrustTaskError } from "./client.js";
import { rfc3339 } from "./time.js";
import { authenticationKey } from "./did-keys.js";

export { keyFromDidDocument, authenticationKey, keyForPurpose } from "./did-keys.js";
import { classifyReply, type Reply } from "./reply.js";
import type { Identity } from "./identity.js";

export const CONSENT_REQUEST = "https://trusttasks.org/spec/task-consent/request/0.1";
export const CONSENT_DECISION = "https://trusttasks.org/spec/task-consent/decision/0.2";
export const MATCH_CODE_LEN = 6;
/** The task the approvals demo gates (a harmless rename of a context). */
export const TASK_CONTEXT_UPDATE = "https://trusttasks.org/spec/vta/contexts/update/1.0";

/** The comparison code both screens show: the first six hex characters of the digest BYTES (not of the `zQm...` string,
 *  whose first characters are a constant). */
export function matchCode(payloadDigest: string): string {
  if (!payloadDigest.startsWith("z")) throw new Error("payloadDigest is not base58btc multibase");
  const bytes = base58.decode(payloadDigest.slice(1));
  if (bytes.length !== 34 || bytes[0] !== 0x12 || bytes[1] !== 0x20) throw new Error("payloadDigest is not a 32-byte sha2-256 multihash");
  return Array.from(bytes.slice(2, 2 + MATCH_CODE_LEN / 2), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The consent facts in a refusal. Detection keys on `details.reason`, not on the top-level code (the VTA uses `taskFailed`). */
export interface ConsentRequired {
  challenge: string;
  payloadDigest: string;
  approverSet?: string;
  minApprovals?: number;
  excludeRequester?: boolean;
  /** One VTA-signed request per approver, or empty when there were too many to carry (then approvers rely on the VTA's push). */
  requests: unknown[];
  matchCode: string;
}

/** Pick the request documents out of what an approver was handed: a request, an array, `{consentRequests}`, `{details}`, or a
 *  whole error document (`{payload:{details}}`). */
export function extractRequests(input: unknown): unknown[] {
  const isReq = (v: any) => v && typeof v === "object" && v.type === CONSENT_REQUEST;
  if (Array.isArray(input)) return input.filter(isReq);
  if (isReq(input)) return [input];
  if (input && typeof input === "object") {
    const o = input as any;
    const inner = o.consentRequests ?? o.details?.consentRequests ?? o.payload?.details?.consentRequests;
    if (inner !== undefined) return extractRequests(inner);
  }
  return [];
}

/** Read a Trust Task refusal body (the thing `TrustTaskError.body` holds) as a consent challenge, or undefined if it is another error. */
export function consentRequiredOf(body: unknown): ConsentRequired | undefined {
  const p: any = (body as any)?.payload ?? body;
  const d: any = p?.details;
  if (!d || typeof d !== "object" || d.reason !== "auth:consent_required") return undefined;
  if (typeof d.challenge !== "string" || typeof d.payloadDigest !== "string") return undefined;
  return {
    challenge: d.challenge,
    payloadDigest: d.payloadDigest,
    approverSet: d.approverSet,
    minApprovals: d.minApprovals,
    excludeRequester: d.excludeRequester,
    requests: extractRequests(d),
    matchCode: matchCode(d.payloadDigest),
  };
}

const ed25519Verifier = { verify: async (sig: Uint8Array, msg: Uint8Array, key: Uint8Array) => ed25519.verify(sig, msg, key) };

/**
 * Resolve a did:webvh from the text of its `did.jsonl`, VERIFYING the log with `didwebvh-ts` (SCID derivation, the
 * entry-hash/versionId chain, and each entry's proof by an authorised update key), not trusting the last line.
 * Throws if any check fails. `expectedDid`, when given, must be the resolved DID.
 */
export async function verifiedDidWebvh(logText: string, expectedDid?: string): Promise<{ did: string; doc: any }> {
  const log = logText.trim().split("\n").map((l) => JSON.parse(l));
  const r = await resolveDIDFromLog(log, { verifier: ed25519Verifier });
  if (expectedDid !== undefined && r.did !== expectedDid) throw new Error(`the DID log resolves to ${r.did}, not ${expectedDid}`);
  return { did: r.did, doc: r.doc };
}

/** The VTA's current DID document from its self-hosted log, after verifying the whole log (see {@link verifiedDidWebvh}). */
export async function fetchVtaDocument(baseUrl: string, fetchImpl: typeof fetch = (...a) => fetch(...a), expectedDid?: string): Promise<any> {
  const res = await fetchImpl(`${baseUrl}/.well-known/did.jsonl`);
  if (!res.ok) throw new Error(`GET /.well-known/did.jsonl -> HTTP ${res.status}`);
  try {
    return (await verifiedDidWebvh(await res.text(), expectedDid)).doc;
  } catch (e) {
    throw new Error(`the VTA's did:webvh log at ${baseUrl} does not verify: ${(e as Error).message}`);
  }
}

export interface VerifiedConsentRequest {
  document: any;
  payload: any;
  matchCode: string;
  /** Plain-language lines for the approver: effect summaries, then static consequences. */
  effects: string[];
  expiresAt: string;
}

export interface VerifyOptions {
  /** The VTA's DID: the only acceptable issuer. */
  vtaDid: string;
  /** The approver this request must be addressed to. */
  approverDid: string;
  /** The VTA's DID document (see {@link fetchVtaDocument}). */
  vtaDocument: any;
  now?: Date;
}

/** Check a request the way `vta_sdk::task_consent::ConsentRequest::verify` does: type, proof under `authentication` by a
 *  key the VTA's DID document lists under `authentication` and that the VTA controls, signer = issuer = this VTA, addressed to
 *  this approver, not expired. Throws with the reason. Pass a `vtaDocument` from {@link fetchVtaDocument} (log verified). */
export function verifyConsentRequest(doc: any, o: VerifyOptions): VerifiedConsentRequest {
  if (doc?.type !== CONSENT_REQUEST) throw new Error(`not a task-consent request (type ${doc?.type})`);
  const proof = doc.proof;
  if (!proof || proof.type !== "DataIntegrityProof" || proof.cryptosuite !== "eddsa-jcs-2022") throw new Error("request has no eddsa-jcs-2022 proof");
  if (proof.proofPurpose !== "authentication") throw new Error(`request proof purpose is ${proof.proofPurpose}, not authentication`);
  if (doc.issuer !== o.vtaDid) throw new Error("request was not issued by this VTA");
  if (typeof proof.verificationMethod !== "string" || proof.verificationMethod.split("#")[0] !== o.vtaDid) throw new Error("request is not signed by this VTA's key");
  if (o.vtaDocument?.id !== o.vtaDid) throw new Error("the DID document given is not the VTA's");
  const key = authenticationKey(o.vtaDocument, proof.verificationMethod, o.vtaDid);
  if (!key) throw new Error("the proof's verification method is not an Ed25519 key the VTA's DID document lists under authentication with the VTA as controller");
  const { proof: _p, ...body } = doc;
  const { proofValue, ...config } = proof;
  const hashData = new Uint8Array([...sha256(canonicalBytes(config)), ...sha256(canonicalBytes(body))]);
  let ok = false;
  try { ok = ed25519.verify(fromMultibase(proofValue), hashData, key); } catch { ok = false; }
  if (!ok) throw new Error("the request's signature does not verify");
  if (doc.recipient !== o.approverDid) throw new Error("request is addressed to a different approver");
  const p = doc.payload ?? {};
  if (typeof p.challenge !== "string" || typeof p.payloadDigest !== "string") throw new Error("request payload has no challenge or digest");
  if (!(Date.parse(p.expiresAt) > (o.now ?? new Date()).getTime())) throw new Error(`the request expired at ${p.expiresAt}`);
  const effects = [
    ...(Array.isArray(p.effects) ? p.effects.map((e: any) => String(e?.summary ?? JSON.stringify(e))) : []),
    ...(Array.isArray(p.consequences) ? p.consequences.map(String) : []),
  ];
  return { document: doc, payload: p, matchCode: matchCode(p.payloadDigest), effects, expiresAt: p.expiresAt };
}

/** The signed `task-consent/decision` an approver returns. Approving requires the typed code to equal the match code. */
export function buildDecision(v: VerifiedConsentRequest, approver: Identity, vtaDid: string, choice: { approve: true; typedCode: string } | { approve: false; reason?: string }): any {
  if (choice.approve && choice.typedCode.trim().toLowerCase() !== v.matchCode) {
    throw new Error("the code you typed does not match this request; do not approve something you cannot match");
  }
  const payload: Record<string, unknown> = {
    challenge: v.payload.challenge,
    payloadDigest: v.payload.payloadDigest,
    decision: choice.approve ? "approve" : "deny",
    ...(!choice.approve && choice.reason ? { reason: choice.reason } : {}),
  };
  return signTrustTask(
    { id: globalThis.crypto.randomUUID(), type: CONSENT_DECISION, issuer: approver.did, recipient: vtaDid, issuedAt: rfc3339(), payload } as any,
    approver.signer,
    { proofPurpose: "assertionMethod" }, // task-consent/decision is an attestation: its spec requires assertionMethod
  );
}

/**
 * POST a signed decision to the VTA with the approver's bearer token. The VTA's docs say an approver needs no ACL entry, but
 * that fallback is for the messaging transports: over REST the VTA answers 401 without a session, and an approver with no ACL
 * entry cannot get one ("authentication failed", observed on 0.65.0). So the demo gives the approver a minimal `monitor` entry.
 */
export async function submitDecision(baseUrl: string, decision: unknown, token: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<{ status: number; body: any; reply: Reply }> {
  const res = await fetchImpl(`${baseUrl}/trust-tasks`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(decision) });
  const text = await res.text();
  // `reply.kind` is the disposition (decided by the reply's type, SPEC 4.4.1); `status` is informative only.
  const reply = classifyReply(decision as { id?: string; type: string }, res.status, text);
  return { status: res.status, body: reply.document ?? text, reply };
}

export interface WithConsentOptions {
  /** Called once per challenge, with the match code to show the requester. */
  onChallenge: (c: ConsentRequired) => void | Promise<void>;
  intervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run a gated task and wait for the approval. The VTA has no "is it approved yet?" call: the only way to ask is to submit the
 * identical task again. While the request is pending the refusal repeats the SAME challenge (and does not re-notify the
 * approver); once approved the same call executes. A DIFFERENT challenge means the earlier request was denied or lapsed, and
 * this stops there rather than ringing the approver again (the VTA documents this as the habituation attack to avoid).
 */
export async function withConsent<R>(attempt: () => Promise<R>, o: WithConsentOptions): Promise<R> {
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (o.timeoutMs ?? 300_000);
  let first: string | undefined;
  for (;;) {
    try {
      return await attempt();
    } catch (e) {
      const c = e instanceof TrustTaskError ? consentRequiredOf(e.body) : undefined;
      if (!c) throw e;
      if (first === undefined) { first = c.challenge; await o.onChallenge(c); }
      else if (c.challenge !== first) throw new Error("the earlier approval request was denied or lapsed (the VTA raised a new one); not asking again automatically");
    }
    if (Date.now() >= deadline) throw new Error("timed out waiting for approval; the request stays pending for up to 15 minutes, so running this again resumes it");
    await sleep(o.intervalMs ?? 3000);
  }
}
