// Trust Task client for a VTA: POST signed Trust Task documents to {baseUrl}/trust-tasks.
// Plain fetch plus @openvtc/trust-tasks-proof, so it works in Node and browsers.
import { signTrustTask } from "@openvtc/trust-tasks-proof";
import {
  decodeCredential,
  identityFromCredential,
  type CredentialBundle,
  remoteIdentity,
  type Identity,
} from "./identity.js";
import { emitTrace } from "./trace.js";
import { rfc3339 } from "./time.js";
import { purposeFor } from "./purpose.js";
import { checkReplyProof, fetchDidDocument, type ReplyProof } from "./reply-proof.js";
import { TrustTaskError, classifyReply, isAlreadyExists, replyCode, unwrapReply, type Reply, type ReplyKind } from "./reply.js";

export { TrustTaskError };

export const TT = "https://trusttasks.org/spec";
export const TASK = {
  discovery: `${TT}/trust-task-discovery/0.3`,
  challenge: `${TT}/auth/challenge/0.1`,
  authenticate: `${TT}/auth/authenticate/0.3`,
  whoami: `${TT}/auth/whoami/0.1`,
  contextsCreate: `${TT}/vta/contexts/create/1.0`,
  contextsList: `${TT}/vta/contexts/list/1.0`,
  aclGrant: `${TT}/acl/grant/0.2`,
  contextsUpdate: `${TT}/vta/contexts/update/1.0`,
} as const;

/** acl/*\/0.2 authority scope limited to one context (and its descendants). */
const contextScope = (context: string) => ({ scope: "contexts" as const, contexts: [context] });

export const DEFAULT_URL = "http://localhost:8100";

/** The VTA's DID, read from its self-hosted did:webvh log (last log entry). */
export async function fetchVtaDid(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(`${baseUrl}/.well-known/did.jsonl`);
  if (!res.ok) throw new Error(`GET /.well-known/did.jsonl -> HTTP ${res.status}`);
  const lines = (await res.text()).trim().split("\n");
  const did = JSON.parse(lines[lines.length - 1])?.state?.id;
  if (typeof did !== "string") throw new Error("did.jsonl has no state.id");
  return did;
}

/** Whether a refusal says the bearer session is gone: 401 `token superseded`, `expired`, or `needs a session`. */
export function isSessionLost(e: unknown): boolean {
  if (!(e instanceof TrustTaskError) || e.status !== 401) return false;
  return /token superseded|token expired|session expired|needs a session/i.test(JSON.stringify(e.body ?? ""));
}

/** One call the client made, reported to {@link VtaClient.onCall} after it settles. */
export interface CallEvent {
  /** Trust Task type URI. */
  type: string;
  /** Who signed (the client's own DID). */
  issuer: string;
  startedAt: string;
  durationMs: number;
  /** HTTP status; absent when the request never got a response (network error). */
  status?: number;
  ok: boolean;
  /** The refusal code from the error document, or `network` when nothing answered. */
  code?: string;
  /** The payload that was signed. */
  payload: Record<string, unknown>;
  /** The full signed document as POSTed. */
  request?: unknown;
  /** How the reply was classified (SPEC 4.4.1, plus the HTTPS binding's empty 202/204); absent on a network error. */
  kind?: ReplyKind;
  /** The reply named another exchange in `threadId` (reported, not refused: SPEC 4.9). */
  threadMismatch?: boolean;
  /** The reply document's own proof, checked against the VTA's DID document. Reported, never refused (see reply-proof.ts). */
  replyProof?: ReplyProof;
}

export interface Whoami {
  roles?: string[];
  scopes?: string[];
  capabilities?: string[];
  [k: string]: unknown;
}

export class VtaClient {
  token?: string;

  constructor(
    public readonly baseUrl: string,
    public readonly vtaDid: string,
    public readonly me: Identity,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  /** Resolve the VTA DID, then build a client. Does not authenticate. */
  static async connect(
    baseUrl: string,
    me: Identity,
    fetchImpl: typeof fetch = (...a) => fetch(...a),
    /** A DID you already know (e.g. `VTA_DID` from the VTA Farm portal): skips the
     *  `/.well-known/did.jsonl` fetch. A hosted VTA may publish its log elsewhere. */
    knownDid?: string,
  ) {
    return new VtaClient(baseUrl, knownDid ?? (await fetchVtaDid(baseUrl, fetchImpl)), me, fetchImpl);
  }

  /** From a `VTA_CREDENTIAL` value (base64url bundle). Does not authenticate. */
  static async fromCredential(
    credential: string | CredentialBundle,
    baseUrl?: string,
    fetchImpl?: typeof fetch,
    opts: { resolveDid?: boolean } = {},
  ) {
    const c = typeof credential === "string" ? decodeCredential(credential) : credential;
    const url = baseUrl ?? c.vtaUrl ?? DEFAULT_URL;
    // resolveDid:false trusts the DID recorded in the credential (farm mode).
    const client = await VtaClient.connect(
      url,
      identityFromCredential(c),
      fetchImpl,
      opts.resolveDid === false ? c.vtaDid : undefined,
    );
    if (client.vtaDid !== c.vtaDid) {
      throw new Error(`VTA DID changed (${client.vtaDid}); re-run \`npm run vta:provision\``);
    }
    return client;
  }

  /** Optional observer, called once per call after it settles (success or failure). Errors in it are swallowed. */
  onCall?: (e: CallEvent) => void;

  private didDoc?: Promise<any>;
  /** Check a reply's proof against the VTA's DID document (fetched once). Never throws; never fails the call. */
  private async checkReplyProof(reply: unknown): Promise<ReplyProof> {
    try {
      return await checkReplyProof(reply, this.vtaDid, () => (this.didDoc ??= fetchDidDocument(this.baseUrl, this.fetchImpl).catch((e) => { this.didDoc = undefined; throw e; })));
    } catch {
      return "unchecked";
    }
  }

  /** Build and sign one Trust Task document addressed to this VTA, without sending it. Keep it to resend the same bytes. */
  build(type: string, payload: Record<string, unknown> = {}, opts: { threadId?: string } = {}): Record<string, unknown> {
    return signTrustTask(
      {
        id: globalThis.crypto.randomUUID(),
        ...(opts.threadId ? { threadId: opts.threadId } : {}),
        type,
        issuer: this.me.did,
        recipient: this.vtaDid,
        issuedAt: rfc3339(),
        payload,
      } as any,
      this.me.signer,
      { proofPurpose: purposeFor(type) }, // authentication, except attestation tasks (SPEC 4.7.3)
    ) as unknown as Record<string, unknown>;
  }

  /**
   * POST one already-signed document and classify the reply (it does not throw for a refusal; it throws only when
   * nothing answered). Sending the same document again is a retry in the SPEC 8.4 sense: same `id`, same bytes.
   */
  async send(doc: Record<string, unknown>, opts: { bearer?: boolean } = {}): Promise<Reply> {
    const type = String(doc.type);
    const payload = (doc.payload ?? {}) as Record<string, unknown>;
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const done: CallEvent = { type, issuer: this.me.did, startedAt, durationMs: 0, ok: false, payload, request: doc };
    const report = (e: Partial<CallEvent>) => {
      const ev = { ...done, durationMs: Date.now() - t0, ...e };
      try { this.onCall?.(ev); } catch { /* an observer must never break a call */ }
      emitTrace({ ts: startedAt, source: "vta", transport: "rest", type, id: doc.id as string, from: this.me.did, to: this.vtaDid, status: ev.status, ok: ev.ok, code: ev.code, ms: ev.durationMs, proof: ev.replyProof });
    };
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.bearer !== false && this.token) headers.authorization = `Bearer ${this.token}`;
    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/trust-tasks`, { method: "POST", headers, body: JSON.stringify(doc) });
      text = await res.text();
    } catch (e) {
      report({ ok: false, code: "network" });
      throw e;
    }
    const reply = classifyReply(doc as { id?: string; type: string; threadId?: string }, res.status, text);
    const ok = reply.kind === "response" || reply.kind === "no-response";
    const replyProof = reply.document ? await this.checkReplyProof(reply.document) : undefined;
    report({ status: res.status, ok, code: replyCode(reply), kind: reply.kind, ...(reply.threadMismatch ? { threadMismatch: true } : {}), ...(replyProof ? { replyProof } : {}) });
    return reply;
  }

  /**
   * Build, sign and POST one Trust Task; returns the response payload (`{}` for a 204). Throws {@link TrustTaskError} for
   * a `trust-task-error` or a reply that is not this task's `#response`, and `TrustTaskPending` for a
   * `trust-task-next-step` continuation or a 202 (accepted, not finished; not a failure).
   */
  async call<R = any>(
    type: string,
    payload: Record<string, unknown> = {},
    opts: { bearer?: boolean } = {},
  ): Promise<R> {
    try {
      return unwrapReply<R>(await this.send(this.build(type, payload), opts));
    } catch (e) {
      // A session is one token per identity: another process authenticating as the same identity supersedes it (HTTP 401
      // "token superseded"). A client that had a session logs in again and retries that one call, so a long-running reader
      // survives a second command. Bounded to one retry per call; two busy processes take turns, they do not loop.
      if (opts.bearer !== false && this.token && isSessionLost(e)) {
        await this.authenticate();
        return unwrapReply<R>(await this.send(this.build(type, payload), opts));
      }
      throw e;
    }
  }

  /**
   * An identity for a DID this VTA holds keys for (a persona): every document is signed by the VTA's `keys/sign-document`
   * (needs the `sign-document` capability, which the application role has) under `keyId`, default `<did>#key-0`. Use it with
   * VtcClient to apply to a community or act in rooms as that DID. Each call costs one VTA round trip.
   */
  personaIdentity(did: string, keyId = `${did}#key-0`): Identity {
    return remoteIdentity(did, async (document, proofPurpose) => {
      const r = await this.call<{ document: Record<string, unknown> }>(`${TT}/keys/sign-document/0.1`, { keyId, document, proofPurpose });
      if (!r?.document || typeof r.document !== "object") throw new Error("keys/sign-document returned no document");
      return r.document;
    });
  }

  /** auth/challenge then auth/authenticate; stores the bearer in `token`. */
  async authenticate(): Promise<string> {
    const ch = await this.call<{ challenge: string; sessionId: string }>(
      TASK.challenge,
      { subject: this.me.did },
      { bearer: false },
    );
    const auth = await this.call<{ tokens: { accessToken: string } }>(
      TASK.authenticate,
      { challenge: ch.challenge, sessionId: ch.sessionId },
      { bearer: false },
    );
    this.token = auth.tokens.accessToken;
    return this.token;
  }

  // --- typed helpers -------------------------------------------------------

  /** Trust Tasks this VTA serves (answers authenticated callers only). */
  async discover(): Promise<string[]> {
    const r = await this.call<{ supportedTypes: unknown[] }>(TASK.discovery, {});
    return r.supportedTypes.map((t) => (typeof t === "string" ? t : JSON.stringify(t)));
  }

  whoami(): Promise<Whoami> {
    return this.call<Whoami>(TASK.whoami, {});
  }

  /** Admin only. Idempotent: an existing context is reported as `false`. */
  async createContext(id: string, name = id): Promise<boolean> {
    return this.idempotent(() => this.call(TASK.contextsCreate, { id, name }));
  }

  /** Admin only. Grants `subject` a role scoped to one context. */
  async grantAcl(subject: string, context: string, role = "application", label = `${context} app`): Promise<boolean> {
    return this.idempotent(() =>
      this.call(TASK.aclGrant, {
        // acl/grant/0.2 states every axis explicitly (0.1's `scopes` is gone): act in this context, every key it reaches,
        // and the role's whole capability ceiling.
        entry: { subject, role, act: contextScope(context), keys: { scope: "all" }, capabilities: { scope: "ceiling" }, label },
        reason: "buildathon provisioning",
      }),
    );
  }

  /**
   * Admin only. Grants `subject` an admin entry scoped to one context with the
   * one-time hand-off marker (`ext["org.openvtc.handoff"]`, VTI-ACL-054) and a
   * short expiry. This is what `vtc setup` needs for its ephemeral setup did:key:
   * the VTA refuses the setup DID's one rollover to a long-term admin without it.
   * The marker can only be set when the entry is created.
   */
  async grantHandoff(subject: string, context: string, expiresInMs = 3600_000, label = `${context} setup`): Promise<boolean> {
    return this.idempotent(() =>
      this.call(TASK.aclGrant, {
        entry: {
          subject,
          role: "admin",
          act: contextScope(context),
          keys: { scope: "all" },
          capabilities: { scope: "ceiling" },
          label,
          expiresAt: rfc3339(new Date(Date.now() + expiresInMs)),
          ext: { "org.openvtc.handoff": true },
        },
        reason: "VTC setup hand-off",
      }),
    );
  }

  /**
   * Admin only. Gives `subject` a `monitor` entry with no contexts: enough to open a REST session and answer a consent
   * request, not enough to do anything else. Over messaging an approver needs no entry at all; over REST it needs this.
   */
  async grantApprover(subject: string, label = "approver"): Promise<boolean> {
    return this.idempotent(() => this.call(TASK.aclGrant, { entry: { subject, role: "monitor", act: { scope: "none" }, keys: { scope: "none" }, capabilities: { scope: "ceiling" }, label }, reason: "approvals demo" }));
  }

  private async idempotent(fn: () => Promise<unknown>): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (e) {
      // By code only: a duplicate create is `taskFailed` + details.reason "conflict" at the VTA. `idConflict` (a reused
      // document id) is NOT "already exists" and is rethrown, as is anything else.
      if (e instanceof TrustTaskError && isAlreadyExists(e.body)) return false;
      throw e;
    }
  }
}
