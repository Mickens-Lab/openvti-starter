// HostClient: rooms/{info,records,blobs}/* at a room's host. It runs over any HostTransport: a VtcClient (the VTC's
// /v1/trust-tasks door), a standalone room-host URL (/trust-tasks), or the in-process mock.
//  - Every payload carries a presentation the member's VTA minted for the action (KeyService.present).
//  - The signer of the document is the presenter. Proxied blob chunks and the commit are signed by a fresh,
//    single-use upload did:key instead, named in upload/begin as `uploadKey`.
import { signTrustTask } from "@openvtc/trust-tasks-proof";
import {
  TrustTaskError, classifyReply, newIdentity, purposeFor, refusalCode, refusalDetails, rfc3339, unwrapReply, type Identity,
} from "@starter/vta-client";
import type { VtcClient } from "@starter/vtc-client";
import { LIST_PAGE_CAP, ROOMS_TASK } from "./tasks.js";
import {
  blobManifest, blobRefOf, chunkWire, digestBytes, parseGetReply, parseInfo, parseListPage, parsePutReply,
  type BlobManifest, type ListPage, type PutRequest, type PutResult, type Presentation, type RecordMeta, type RecordStatus,
  type RoomAction, type RoomInfo, type RoomRecord,
} from "./wire.js";

type Payload = Record<string, unknown>;

/** How a HostClient reaches a host. `send` signs as the member; `sendAs` signs as another identity (an upload key). */
export interface HostTransport {
  send(type: string, payload: Payload): Promise<any>;
  sendAs(signer: Identity, type: string, payload: Payload): Promise<any>;
}

/** Mints the presentation for one room action (normally `KeyService.present`). */
export type Presenter = (roomId: string, action: RoomAction) => Promise<{ presentation: Presentation; expiresAt?: string }>;

/** A transport over a VtcClient: the member signs as `vtc.me`, upload keys sign documents addressed to the same VTC. */
export function vtcTransport(vtc: VtcClient): HostTransport {
  return {
    send: (type, payload) => vtc.call(type, payload),
    sendAs: async (signer, type, payload) => unwrapReply(await vtc.send(signDoc(signer, vtc.vtcDid, type, payload))),
  };
}

export interface RoomHostOpts {
  /** The room-host's base URL; documents go to `{url}/trust-tasks`. */
  url: string;
  /** The host's DID, the documents' `recipient`. [unverified] how a room-host publishes it. */
  hostDid: string;
  me: Identity;
  fetch?: typeof fetch;
  /** Mount of the trust-tasks door: "" for a room-host (the default), "/v1" for a VTC. */
  mount?: string;
}

/** A transport straight to a room-host URL, signing documents the way VtcClient.build does. */
export function roomHostTransport(o: RoomHostOpts): HostTransport {
  const f = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const endpoint = `${o.url.replace(/\/+$/, "")}${o.mount ?? ""}/trust-tasks`;
  const post = async (signer: Identity, type: string, payload: Payload) => {
    const doc = signDoc(signer, o.hostDid, type, payload);
    const res = await f(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(doc) });
    const text = await res.text();
    const reply = classifyReply(doc as { id: string; type: string }, res.status, text);
    try {
      return unwrapReply(reply);
    } catch (e) {
      if (e instanceof TrustTaskError && res.status === 429) (e as RateLimitedError).retryAfterMs = retryAfterMs(res.headers.get("retry-after"));
      throw e;
    }
  };
  return { send: (type, payload) => post(o.me, type, payload), sendAs: post };
}

/** A TrustTaskError for a 429 carries the host's Retry-After, in ms, when the transport saw the header. */
export type RateLimitedError = TrustTaskError & { retryAfterMs?: number };

function retryAfterMs(h: string | null): number | undefined {
  if (!h) return undefined;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(h);
  return Number.isNaN(t) ? undefined : Math.max(0, t - Date.now());
}

/** One signed Trust Task document, the same shape VtcClient.build produces. */
export function signDoc(signer: Identity, recipient: string, type: string, payload: Payload): Record<string, unknown> {
  return signTrustTask(
    { id: globalThis.crypto.randomUUID(), type, issuer: signer.did, recipient, issuedAt: rfc3339(), payload } as any,
    signer.signer,
    { proofPurpose: purposeFor(type) },
  ) as unknown as Record<string, unknown>;
}

/** True when a put was refused because the record moved (expectedVersion). [unverified] the host's exact code. */
export function isVersionConflict(e: unknown): boolean {
  if (!(e instanceof TrustTaskError)) return false;
  const code = refusalCode(e.body) ?? "";
  return /(^|:)(versionConflict|conflict|alreadyExists)$/.test(code) || refusalDetails(e.body)?.reason === "conflict";
}

export interface ListOpts {
  prefix?: string;
  sinceVersion?: number;
  /** Page size, capped at 500. */
  limit?: number;
  /** Stop after this many pages (default: follow the cursor to the end). */
  maxPages?: number;
}

export class HostClient {
  private cache = new Map<string, { p: Presentation; until: number }>();

  constructor(
    readonly transport: HostTransport,
    private readonly presenter: Presenter,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** A presentation for `action`, cached until five minutes before it expires (4 hours when the VTA did not say). */
  async presentation(roomId: string, action: RoomAction): Promise<Presentation> {
    const id = `${roomId}|${action}`;
    const hit = this.cache.get(id);
    if (hit && hit.until > this.now()) return hit.p;
    const { presentation, expiresAt } = await this.presenter(roomId, action);
    const exp = expiresAt ? Date.parse(expiresAt) : this.now() + 4 * 3600_000;
    this.cache.set(id, { p: presentation, until: exp - 5 * 60_000 });
    return presentation;
  }

  async info(roomId: string): Promise<RoomInfo> {
    return parseInfo(await this.transport.send(ROOMS_TASK.info, { roomId, presentation: await this.presentation(roomId, "read") }));
  }

  /** One page of `records/list`. */
  async listPage(roomId: string, o: ListOpts & { cursor?: string } = {}): Promise<ListPage> {
    const p: Payload = { roomId, presentation: await this.presentation(roomId, "read") };
    if (o.prefix !== undefined) p.prefix = o.prefix;
    if (o.sinceVersion !== undefined) p.sinceVersion = o.sinceVersion;
    if (o.cursor !== undefined) p.cursor = o.cursor;
    p.limit = Math.min(o.limit ?? LIST_PAGE_CAP, LIST_PAGE_CAP);
    return parseListPage(await this.transport.send(ROOMS_TASK.recordsList, p));
  }

  /** Every record's metadata, following `nextCursor` until it is absent. `headVersion` is the highest the host reported. */
  async list(roomId: string, o: ListOpts = {}): Promise<{ records: RecordMeta[]; headVersion?: number }> {
    const records: RecordMeta[] = [];
    let cursor: string | undefined;
    let head: number | undefined;
    for (let page = 0; page < (o.maxPages ?? Infinity); page++) {
      const r = await this.listPage(roomId, { ...o, ...(cursor ? { cursor } : {}) });
      records.push(...r.records);
      if (r.headVersion !== undefined) head = Math.max(head ?? 0, r.headVersion);
      if (!r.nextCursor || r.nextCursor === cursor) break;
      cursor = r.nextCursor;
    }
    return { records, ...(head !== undefined ? { headVersion: head } : {}) };
  }

  async get(roomId: string, key: string): Promise<{ record: RoomRecord; headVersion?: number }> {
    return parseGetReply(await this.transport.send(ROOMS_TASK.recordsGet, { roomId, key, presentation: await this.presentation(roomId, "read") }));
  }

  /** Write a record. A sealed body must be create-only (`expectedVersion: 0`); this is checked before anything is sent. */
  async put(roomId: string, r: PutRequest): Promise<PutResult> {
    if (r.sealed && r.cleartext) throw new Error("a record is either sealed or cleartext, not both");
    if (r.sealed && r.expectedVersion !== 0) throw new Error("a sealed record must be written create-only (expectedVersion: 0)");
    const p: Payload = { roomId, key: r.key, presentation: await this.presentation(roomId, "write") };
    if (r.expectedVersion !== undefined) p.expectedVersion = r.expectedVersion;
    if (r.sealed) p.sealed = r.sealed;
    if (r.cleartext) p.cleartext = r.cleartext;
    if (r.blobs?.length) p.blobs = r.blobs;
    return parsePutReply(await this.transport.send(ROOMS_TASK.recordsPut, p));
  }

  /** Change a record's status or pin (`records/curate/0.1`). [unverified] against the pinned VTC, which does not list it. */
  async curate(roomId: string, key: string, o: { status?: RecordStatus; pinned?: boolean; reason?: string }): Promise<{ key: string; version: number; status: RecordStatus }> {
    const r = await this.transport.send(ROOMS_TASK.recordsCurate, { roomId, key, presentation: await this.presentation(roomId, "curate"), ...o });
    return { key: String(r.key), version: Number(r.version), status: r.status };
  }

  /**
   * Upload one blob in proxied mode: begin (as the member, naming a fresh upload did:key), then every missing chunk and
   * the commit signed by that key. Returns the host's blobRef, checked against the manifest's own digest.
   */
  async blobUpload(roomId: string, bytes: Uint8Array, o: { chunkSize?: number } = {}): Promise<{ blobRef: string; size: number }> {
    const { manifest, chunks } = blobManifest(bytes, o.chunkSize);
    const uploadKey = newIdentity();
    const begin = await this.transport.send(ROOMS_TASK.blobsUploadBegin, {
      roomId, presentation: await this.presentation(roomId, "write"), uploadKey: uploadKey.did, manifest,
    });
    const uploadId = String(begin.uploadId);
    if (begin.mode && begin.mode !== "proxied") throw new Error(`host offered ${begin.mode} upload; only proxied is implemented`);
    try {
      const missing: number[] = begin.alreadyCommitted ? [] : Array.isArray(begin.missing) ? begin.missing : chunks.map((_, i) => i);
      for (const i of missing) await this.transport.sendAs(uploadKey, ROOMS_TASK.blobsUploadChunk, chunkWire.upload(uploadId, i, chunks[i]));
      const done = await this.transport.sendAs(uploadKey, ROOMS_TASK.blobsUploadCommit, { uploadId });
      const blobRef = String(done.blobRef);
      if (blobRef !== blobRefOf(manifest)) throw new Error("host blobRef does not match the manifest digest");
      return { blobRef, size: Number(done.size ?? bytes.length) };
    } catch (e) {
      await this.transport.sendAs(uploadKey, ROOMS_TASK.blobsUploadAbort, { uploadId }).catch(() => undefined);
      throw e;
    }
  }

  /** Download one blob in proxied mode (`blobs/get`, then `blobs/chunk` per index); every chunk and the whole are checked. */
  async blobDownload(roomId: string, blobRef: string): Promise<Uint8Array> {
    const g = await this.transport.send(ROOMS_TASK.blobsGet, { roomId, presentation: await this.presentation(roomId, "read"), blobRef });
    const manifest = g.manifest as BlobManifest;
    if (blobRefOf(manifest) !== blobRef) throw new Error("blob manifest does not match its blobRef");
    if (!g.downloadId) throw new Error(`host offered ${g.mode} download; only proxied is implemented`);
    const out = new Uint8Array(manifest.size);
    let at = 0;
    for (let i = 0; i < manifest.chunks.chunkCount; i++) {
      const c = chunkWire.readDownload(await this.transport.send(ROOMS_TASK.blobsChunk, chunkWire.download(String(g.downloadId), i)));
      if (digestBytes(c.data) !== manifest.chunks.chunkDigests[i]) throw new Error(`blob chunk ${i} digest mismatch`);
      out.set(c.data, at);
      at += c.data.length;
    }
    if (at !== manifest.size || digestBytes(out) !== manifest.digest) throw new Error("blob digest mismatch");
    return out;
  }
}
