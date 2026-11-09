// TSP ping: a throwaway did:key logs in to the mediator, resolves the VTA's DID, and sends a signed
// messaging/ping/0.2 Trust Task to the VTA over TSP; the VTA's sealed answer is the "pong".
// Built on @openvtc/pnm-core (mediator login, DID -> TSP keys, TspChannel) and @openvtc/vti-tsp-js (the wire format).
import { emitTspTrace } from "./trace.js";
import {
  Identity, buildTrustTask, connectMediatorSession, didcommKeyAgreementFromSigning, generateSigningIdentity, resolveVtaTspEndpoint, signingIdentityFromSecret, signOutboundTask,
  type MediatorConnection, type TaskSigner, type WebSocketCtor,
} from "@openvtc/pnm-core";
import { ed25519 } from "@noble/curves/ed25519.js";
import { signTrustTask } from "@openvtc/trust-tasks-proof";
import { classifyDocument, rfc3339 } from "@starter/vta-client";
import { TspSession, type TspKeys } from "./session.js";
import type { PeerIdentity } from "./peer.js";

export const PING_TYPE = "https://trusttasks.org/spec/messaging/ping/0.2";
export const PING_RESPONSE_TYPE = `${PING_TYPE}#response`;

export interface PingOptions {
  /** The VTA's DID (did:webvh at its tunnel host). */
  vtaDid: string;
  /** The mediator's DID (a did:webvh bound to its tunnel host, in .vta/tunnel.json). */
  mediatorDid: string;
  /**
   * Ed25519 seed of the did:key to log in as. Omit for a throwaway did:key. The VTA only answers DIDs on its ACL,
   * so use the app identity from VTA_CREDENTIAL (the starter's `application` DID) unless you grant the throwaway.
   */
  seed?: Uint8Array;
  /** Reply timeout in ms (default 20000). */
  timeoutMs?: number;
  /** Allow ws:// and http:// mediator endpoints (never needed for the https tunnel). */
  allowInsecure?: boolean;
  /** WebSocket constructor; defaults to the global one (Node 22+ and browsers). */
  webSocketImpl?: WebSocketCtor;
  /** Progress callback, one line per step. */
  log?: (line: string) => void;
}

export interface PingResult {
  /** The throwaway client DID that logged in. */
  clientDid: string;
  nonce: string;
  /** The VTA's pong payload (respondedAt, status, protocols, nonce echo; 0.1 called it serverTime). */
  pong: PongPayload;
  elapsedMs: number;
}

export interface PongPayload {
  respondedAt?: string;
  /** The 0.1 name of `respondedAt`; kept so an older VTA's pong still reads. */
  serverTime?: string;
  status?: string;
  protocols?: string[];
  nonce?: string;
  [k: string]: unknown;
}

/** True only for a genuine pong: the nonce we sent comes back and the status is ok or degraded. */
export function isPong(p: unknown, nonce: string): p is PongPayload {
  if (!p || typeof p !== "object") return false;
  const o = p as PongPayload;
  return o.nonce === nonce && (o.status === "ok" || o.status === "degraded");
}

/** One line a human can read from a pong. */
export function describePong(r: PingResult): string {
  const p = r.pong;
  return `pong from the VTA in ${r.elapsedMs} ms: status ${p.status}, protocols [${(p.protocols ?? []).join(", ")}], nonce echoed, server time ${p.respondedAt ?? p.serverTime}`;
}

/**
 * Sign outbound documents with `@openvtc/trust-tasks-proof` (eddsa-jcs-2022) rather than pnm-core's own signer, whose
 * `proof.created` comes from `toISOString()` and so ends in `.000Z` on an exact second; the VTA re-serialises timestamps
 * before it hashes, so that form fails as "signature invalid" about once in a thousand calls (see vta-client `rfc3339`).
 */
export function documentSigner(signing: { did: string; kid: string; privateKey: Uint8Array }, proofPurpose?: string): TaskSigner {
  const signer = { curve: "ed25519" as const, did: signing.did, verificationMethod: signing.kid, sign: (h: Uint8Array) => ed25519.sign(h, signing.privateKey) };
  return {
    did: signing.did,
    sign: async (doc) => {
      const signed = signTrustTask(doc as any, signer, proofPurpose ? { proofPurpose } : {}) as { proof: unknown };
      (doc as { proof?: unknown }).proof = signed.proof;
    },
  };
}

/**
 * A reply to the ping is a pong only if its `type` says so (SPEC 4.4.1): a `trust-task-error` is thrown with its code, a
 * `trust-task-next-step` or another type is refused. In-band `issuer`/`recipient`, when present, must be the peer and us
 * (the TSP layer already authenticated the sender VID).
 */
export function checkPingReply(request: { id?: string; type: string }, reply: any, ownVid: string, peerVid: string): void {
  const r = classifyDocument(request, reply);
  if (r.kind === "error") throw new Error(`the VTA refused the ping: ${r.code ?? "no code"}${reply?.payload?.message ? ` (${reply.payload.message})` : ""}`);
  if (r.kind !== "response") throw new Error(`the reply is not a ${PING_RESPONSE_TYPE} (${r.kind}: ${reply?.type})`);
  if (reply.issuer !== undefined && reply.issuer !== peerVid) throw new Error(`the reply's issuer ${reply.issuer} is not the VTA ${peerVid}`);
  if (reply.recipient !== undefined && reply.recipient !== ownVid) throw new Error(`the reply is addressed to ${reply.recipient}, not to ${ownVid}`);
}

export interface TspClient {
  /** The DID that logged in (a did:key, or the did:peer:2 passed as `identity`). */
  did: string;
  conn: MediatorConnection;
  session: TspSession;
  signing: ReturnType<typeof generateSigningIdentity>;
  close(): void;
}

/** Log in to the mediator as a did:key, open the socket and resolve the peer and the mediator to TSP keys. */
/** The DID, TSP keys and mediator-login secret for a did:key from `seed` (or a throwaway), or for a did:peer:2 identity. */
export function clientKeys(opts: { seed?: Uint8Array; identity?: PeerIdentity }): { signing: ReturnType<typeof generateSigningIdentity>; keys: TspKeys; login: { did: string; kid: string; jwk: { kty: "OKP"; crv: "X25519"; x: string; d: string } }; method: "did:key" | "did:peer" } {
  const p = opts.identity;
  if (p) {
    // The did:peer logs in to the mediator as itself: the mediator delivers what is addressed to this DID to this socket.
    return {
      signing: { did: p.did, kid: p.authKid, privateKey: p.seed, publicKey: p.ed25519PublicKey },
      keys: { vid: p.did, signingKey: p.seed, decryptionKey: p.decryptionKey },
      login: { did: p.did, kid: p.keyAgreementKid, jwk: p.secretJwk },
      method: "did:peer",
    };
  }
  const signing = opts.seed ? signingIdentityFromSecret(opts.seed) : generateSigningIdentity();
  const ka = didcommKeyAgreementFromSigning(signing);
  return {
    signing,
    keys: { vid: signing.did, signingKey: signing.privateKey, decryptionKey: ed25519.utils.toMontgomerySecret(signing.privateKey) },
    login: { did: signing.did, kid: ka.keyAgreementKid, jwk: ka.secretJwk },
    method: "did:key",
  };
}

export async function connectTsp(opts: Pick<PingOptions, "vtaDid" | "mediatorDid" | "seed" | "allowInsecure" | "webSocketImpl" | "log"> & { identity?: PeerIdentity }): Promise<TspClient> {
  const log = opts.log ?? (() => {});
  const { signing, keys, login, method } = clientKeys(opts);
  const holder = Identity.fromSecretJwk(login);
  log(`client DID (${method}): ${signing.did}`);
  log("logging in to the mediator and opening the socket");
  const conn = await connectMediatorSession({
    holder, mediatorDid: opts.mediatorDid, vtaDid: opts.vtaDid,
    ...(opts.allowInsecure ? { allowInsecure: true } : {}),
    ...(opts.webSocketImpl ? { webSocketImpl: opts.webSocketImpl } : {}),
  });
  try {
    log("resolving the peer DID to its TSP keys");
    const peer = await resolveVtaTspEndpoint(opts.vtaDid);
    log("resolving the mediator DID to its TSP keys");
    const mediator = await resolveVtaTspEndpoint(opts.mediatorDid);
    const session = new TspSession(conn, keys, mediator, peer, log);
    return { did: signing.did, conn, session, signing, close: () => { conn.close(); holder.dispose(); } };
  } catch (e) {
    conn.close();
    holder.dispose();
    throw e;
  }
}

export async function tspPing(opts: PingOptions): Promise<PingResult> {
  const log = opts.log ?? (() => {});
  const t0 = Date.now();
  const ts = new Date().toISOString();
  let id: string | undefined;
  let from: string | undefined;
  let err: unknown;
  try {
    const c = await connectTsp(opts);
    from = c.did;
    return await ping(c);
  } catch (e) {
    err = e;
    throw e;
  } finally {
    emitTspTrace({ ts, source: "tsp", transport: "tsp", type: PING_TYPE, id, from, to: opts.vtaDid, ok: err === undefined, code: err === undefined ? undefined : /timed out|timeout/i.test(String((err as Error).message)) ? "timeout" : "failed", ms: Date.now() - t0 });
  }

  async function ping(c: TspClient): Promise<PingResult> {
  try {
    const timeoutMs = opts.timeoutMs ?? 20_000;
    log("TSP relationship invite (waiting for the accept)");
    await c.session.relate(4000).catch((e) => log(`no accept seen, continuing: ${(e as Error).message}`));
    const nonce = crypto.randomUUID();
    // The Trust Task document; the session wraps it in the TSP binding's {type, document} envelope.
    const doc = buildTrustTask(PING_TYPE, { nonce }, { issuer: c.did, recipient: opts.vtaDid, issuedAt: rfc3339() });
    id = doc.id;
    // The ping spec lets the proof be omitted over TSP; the VTA requires one by local policy (`proofRequired`).
    await signOutboundTask(doc, documentSigner(c.signing, "authentication"));
    log("sending messaging/ping/0.2 over TSP");
    const reply = await c.session.request(doc, timeoutMs, (d) => d.threadId === doc.id);
    checkPingReply(doc, reply, c.did, opts.vtaDid);
    const pong = reply.payload as PongPayload;
    if (!isPong(pong, nonce)) throw new Error(`the reply was not a pong for this ping: ${JSON.stringify(pong)}`);
    return { clientDid: c.did, nonce, pong, elapsedMs: Date.now() - t0 };
  } finally {
    c.close();
  }
  }
}
