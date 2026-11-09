// MockRoomHost: an in-process rooms/* host for tests and the UI's no-stack demo. It keeps room-wide rising versions,
// list paging (cursor `v<version>`), create-only and expectedVersion conflicts, proxied blobs, and the tier rules
// (sealed rooms take sealed bodies only and store ciphertext only; `private` keeps no author).
// It checks that a presentation is present, names the room, is for the signer and confers the action. Verifying the
// room's credentials is the real host's job and is not mocked: any mockPresentation() is accepted.
import { DataIntegrityProofVerifier } from "@openvtc/trust-tasks-proof";
import { TT, TrustTaskError, type Identity } from "@starter/vta-client";
import { LIST_PAGE_CAP, ROOMS_TASK } from "../tasks.js";
import { blobRefOf, chunkWire, digestBytes, utf8, type BlobManifest, type Presentation, type RoomAction, type SealedContent, type Cleartext, type RecordStatus, type Visibility } from "../wire.js";
import type { HostTransport } from "../host.js";

const ERROR_TYPE = `${TT}/trust-task-error/0.5`;

/** A presentation the mock host accepts: membership names the room and the subject, authority the action. */
export function mockPresentation(roomId: string, subject: string, action: RoomAction): Presentation {
  return { membership: `mock:membership:${roomId}#${subject}`, authority: [`mock:authority:${roomId}#${action}`] };
}

export interface MockError {
  status: number;
  code: string;
  message?: string;
  /** Seconds, sent as Retry-After on a 429. */
  retryAfter?: number;
}

interface StoredRecord {
  key: string;
  version: number;
  epoch?: number;
  status: RecordStatus;
  pinned: boolean;
  updatedAt: string;
  author?: string;
  sealed?: SealedContent;
  cleartext?: Cleartext;
  blobs?: string[];
}

interface Room {
  roomId: string;
  visibility: Visibility;
  epoch: number;
  head: number;
  records: Map<string, StoredRecord>;
  blobs: Map<string, { manifest: BlobManifest; bytes: Uint8Array }>;
}

function fail(status: number, code: string, message = code, extra: Record<string, unknown> = {}): never {
  throw new TrustTaskError(status, { type: ERROR_TYPE, payload: { code, message, ...extra } });
}

/** The largest document the mock accepts, as the live host does. */
export const MOCK_DOCUMENT_CAP = 65536;

export class MockRoomHost {
  readonly rooms = new Map<string, Room>();
  /** Called before every task; return an error to refuse it (e.g. a 429 for the feed's backoff tests). */
  inject?: (type: string, payload: any, signer: string) => MockError | undefined;
  /** Every task seen, in order. */
  readonly calls: { type: string; signer: string }[] = [];
  private uploads = new Map<string, { roomId: string; uploadKey: string; manifest: BlobManifest; chunks: (Uint8Array | undefined)[] }>();
  private downloads = new Map<string, { roomId: string; blobRef: string }>();
  private seq = 0;

  constructor(readonly hostDid = "did:example:mock-room-host", private readonly now: () => Date = () => new Date()) {}

  /** Seed a room directly (no rooms/create round trip). */
  createRoom(roomId: string, visibility: Visibility, epoch = visibility === "open" ? 0 : 1): void {
    if (this.rooms.has(roomId)) throw new Error(`room ${roomId} exists`);
    this.rooms.set(roomId, { roomId, visibility, epoch, head: 0, records: new Map(), blobs: new Map() });
  }

  /** Move a sealed room to a new epoch (the owner committed a membership change). */
  setEpoch(roomId: string, epoch: number): void {
    this.room(roomId).epoch = epoch;
  }

  /** Every byte the host stores for a room: record JSON plus raw blob bytes. Tests search it for plaintext. */
  storedBytes(roomId: string): Uint8Array {
    const r = this.room(roomId);
    const parts = [utf8(JSON.stringify([...r.records.values()])), ...[...r.blobs.values()].map((b) => b.bytes)];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  }

  /** An in-process transport signing as `me` (no documents, no proofs). */
  transport(me: Identity | string): HostTransport {
    const did = typeof me === "string" ? me : me.did;
    return { send: (t, p) => this.send(t, p, did), sendAs: (s, t, p) => this.send(t, p, s.did) };
  }

  /** A fetch that serves `POST {any}/trust-tasks`: checks the proof, the issuer and the recipient, then dispatches. */
  fetchHandler(): typeof fetch {
    const verifier = new DataIntegrityProofVerifier();
    return (async (_input: any, init?: any) => {
      const body = String(init?.body ?? "{}");
      const doc = JSON.parse(body);
      const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
      try {
        if (doc.recipient !== this.hostDid) fail(400, "wrongRecipient");
        // A real host refuses documents over 65536 bytes (observed live on rooms/records/put/0.3).
        if (new TextEncoder().encode(body).length > MOCK_DOCUMENT_CAP) fail(400, "malformedRequest");
        if (!(await verifier.verify(doc).catch(() => false))) fail(401, "invalidProof");
        const payload = await this.send(String(doc.type), doc.payload ?? {}, String(doc.issuer));
        return reply(200, { id: globalThis.crypto.randomUUID(), threadId: doc.id, type: `${doc.type}#response`, payload });
      } catch (e) {
        if (!(e instanceof TrustTaskError)) throw e;
        const ra = (e as any).retryAfterMs;
        return reply(e.status, { ...(e.body as object), threadId: doc.id }, ra !== undefined ? { "retry-after": String(Math.ceil(ra / 1000)) } : {});
      }
    }) as typeof fetch;
  }

  /** Answer one rooms/* task as if `signer` had signed it. Throws TrustTaskError for a refusal. */
  async send(type: string, payload: any, signer: string): Promise<any> {
    this.calls.push({ type, signer });
    const injected = this.inject?.(type, payload, signer);
    if (injected) {
      const e = new TrustTaskError(injected.status, { type: ERROR_TYPE, payload: { code: injected.code, message: injected.message ?? injected.code } });
      if (injected.retryAfter !== undefined) (e as any).retryAfterMs = injected.retryAfter * 1000;
      throw e;
    }
    switch (type) {
      case ROOMS_TASK.info: return this.info(payload, signer);
      case ROOMS_TASK.recordsPut: return this.put(payload, signer);
      case ROOMS_TASK.recordsList: return this.list(payload, signer);
      case ROOMS_TASK.recordsGet: return this.get(payload, signer);
      case ROOMS_TASK.recordsCurate: return this.curate(payload, signer);
      case ROOMS_TASK.blobsUploadBegin: return this.uploadBegin(payload, signer);
      case ROOMS_TASK.blobsUploadChunk: return this.uploadChunk(payload, signer);
      case ROOMS_TASK.blobsUploadCommit: return this.uploadCommit(payload, signer);
      case ROOMS_TASK.blobsUploadAbort: return this.uploadAbort(payload, signer);
      case ROOMS_TASK.blobsGet: return this.blobGet(payload, signer);
      case ROOMS_TASK.blobsChunk: return this.blobChunk(payload);
      default: fail(400, "unsupportedType", `mock host does not serve ${type}`);
    }
  }

  private room(roomId: string): Room {
    const r = this.rooms.get(roomId);
    if (!r) fail(404, "rooms:roomNotFound", `no room ${roomId}`);
    return r;
  }

  private authorize(p: any, signer: string, action: RoomAction): Room {
    const room = this.room(String(p?.roomId));
    const pr = p?.presentation as Presentation | undefined;
    if (!pr || typeof pr.membership !== "string" || !Array.isArray(pr.authority)) fail(403, "rooms:presentationRequired");
    if (pr.membership !== `mock:membership:${room.roomId}#${signer}`) fail(403, "rooms:presentationMismatch", "presentation is not for this room and signer");
    if (!pr.authority.includes(`mock:authority:${room.roomId}#${action}`)) fail(403, "permissionDenied", `presentation does not confer ${action}`);
    return room;
  }

  private info(p: any, signer: string) {
    const r = this.authorize(p, signer, "read");
    return { roomId: r.roomId, visibility: r.visibility, epoch: r.epoch, limits: {}, usage: { room: { records: r.records.size } } };
  }

  private bump(r: Room): number {
    return ++r.head;
  }

  private put(p: any, signer: string) {
    const r = this.authorize(p, signer, "write");
    const key = String(p.key ?? "");
    if (!key) fail(400, "malformedPayload", "key is required");
    const sealedTier = r.visibility !== "open";
    if (p.sealed && p.cleartext) fail(400, "malformedPayload", "sealed or cleartext, not both");
    if (sealedTier && p.cleartext) fail(400, "rooms:cleartextOnSealedRoom", "this room accepts sealed records only");
    if (!sealedTier && p.sealed) fail(400, "rooms:sealedOnOpenRoom", "this room accepts cleartext records only");
    if (!p.sealed && !p.cleartext) fail(400, "malformedPayload", "a body is required");
    if (sealedTier && p.expectedVersion !== 0) fail(400, "rooms:createOnly", "sealed records are create-only (expectedVersion: 0)");
    if (sealedTier && !/^[A-Za-z0-9_-]{16,}$/.test(key)) fail(400, "rooms:opaqueKeyRequired", "sealed rooms need opaque keys");
    // The real host learns epochs from the owner's commits (rooms/epoch/*); the mock follows the highest it has seen.
    if (p.sealed) r.epoch = Math.max(r.epoch, Number(p.sealed.epoch));
    const cur = r.records.get(key);
    if (p.expectedVersion !== undefined && (cur?.version ?? 0) !== p.expectedVersion) {
      fail(409, "rooms:versionConflict", "the record moved", { details: { reason: "conflict", version: cur?.version ?? 0 } });
    }
    const version = this.bump(r);
    const rec: StoredRecord = {
      key, version, status: "active", pinned: cur?.pinned ?? false, updatedAt: this.now().toISOString(),
      ...(r.visibility !== "private" ? { author: signer } : {}),
      ...(p.sealed ? { sealed: { ciphertext: p.sealed.ciphertext, nonce: p.sealed.nonce, epoch: p.sealed.epoch, ...(p.sealed.version !== undefined ? { version: p.sealed.version } : {}) }, epoch: p.sealed.epoch } : {}),
      ...(p.cleartext ? { cleartext: p.cleartext } : {}),
      ...(Array.isArray(p.blobs) ? { blobs: p.blobs.map(String) } : {}),
    };
    for (const b of rec.blobs ?? []) if (!r.blobs.has(b)) fail(400, "rooms:unknownBlob", `no committed blob ${b}`);
    r.records.set(key, rec);
    return { key, version, ...(rec.epoch !== undefined ? { epoch: rec.epoch } : {}) };
  }

  private meta(rec: StoredRecord) {
    return {
      key: rec.key, version: rec.version, status: rec.status, updatedAt: rec.updatedAt,
      ...(rec.epoch !== undefined ? { epoch: rec.epoch } : {}),
      ...(rec.author ? { author: rec.author } : {}),
      ...(rec.cleartext?.title ? { title: rec.cleartext.title } : {}),
      ...(rec.cleartext?.description ? { description: rec.cleartext.description } : {}),
      ...(rec.blobs ? { blobs: rec.blobs } : {}),
    };
  }

  private list(p: any, signer: string) {
    const r = this.authorize(p, signer, "read");
    const limit = Math.max(1, Math.min(Number(p.limit ?? LIST_PAGE_CAP), LIST_PAGE_CAP));
    let after = Number(p.sinceVersion ?? 0);
    if (p.cursor !== undefined) {
      const m = /^v(\d+)$/.exec(String(p.cursor));
      if (!m) fail(400, "rooms:badCursor");
      after = Math.max(after, Number(m[1]));
    }
    const all = [...r.records.values()]
      .filter((x) => x.version > after && (p.prefix === undefined || x.key.startsWith(String(p.prefix))))
      .sort((a, b) => a.version - b.version);
    const page = all.slice(0, limit);
    return {
      records: page.map((x) => this.meta(x)),
      ...(all.length > limit ? { nextCursor: `v${page[page.length - 1].version}` } : {}),
      recordCount: r.records.size,
      headVersion: r.head,
    };
  }

  private get(p: any, signer: string) {
    const r = this.authorize(p, signer, "read");
    const rec = r.records.get(String(p.key));
    if (!rec) fail(404, "rooms:recordNotFound");
    return { ...this.meta(rec), pinned: rec.pinned, ...(rec.sealed ? { sealed: rec.sealed } : {}), ...(rec.cleartext ? { cleartext: rec.cleartext } : {}), headVersion: r.head };
  }

  private curate(p: any, signer: string) {
    const room = this.room(String(p?.roomId));
    const rec = room.records.get(String(p.key));
    if (!rec) fail(404, "rooms:recordNotFound");
    // The author may retract their own record with a write presentation; anyone else needs curate.
    const self = rec.author === signer;
    this.authorize(p, signer, self && p.presentation?.authority?.includes(`mock:authority:${room.roomId}#write`) ? "write" : "curate");
    if (p.expectedVersion !== undefined && p.expectedVersion !== rec.version) fail(409, "rooms:versionConflict", "the record moved", { details: { reason: "conflict" } });
    if (p.status) rec.status = p.status;
    if (p.pinned !== undefined) rec.pinned = !!p.pinned;
    rec.version = this.bump(room);
    rec.updatedAt = this.now().toISOString();
    return { key: rec.key, version: rec.version, status: rec.status, pinned: rec.pinned };
  }

  private uploadBegin(p: any, signer: string) {
    const r = this.authorize(p, signer, "write");
    const manifest = p.manifest as BlobManifest;
    if (!manifest?.chunks?.chunkDigests || manifest.chunks.chunkDigests.length !== manifest.chunks.chunkCount) fail(400, "malformedPayload", "bad manifest");
    if (typeof p.uploadKey !== "string" || !p.uploadKey.startsWith("did:key:")) fail(400, "rooms:directOnly", "mock host serves proxied uploads only; send uploadKey");
    if (p.uploadKey === signer) fail(400, "rooms:uploadKeyReused", "the upload key must be fresh");
    const uploadId = `up-${++this.seq}`;
    this.uploads.set(uploadId, { roomId: r.roomId, uploadKey: p.uploadKey, manifest, chunks: new Array(manifest.chunks.chunkCount).fill(undefined) });
    return { uploadId, mode: "proxied", missing: manifest.chunks.chunkDigests.map((_, i) => i), expiresAt: new Date(this.now().getTime() + 3600_000).toISOString() };
  }

  private upload(id: string, signer: string) {
    const u = this.uploads.get(id);
    if (!u) fail(404, "rooms:uploadNotFound");
    if (signer !== u.uploadKey) fail(403, "rooms:wrongUploadKey", "chunks and commit must be signed by the upload key");
    return u;
  }

  private uploadChunk(p: any, signer: string) {
    const c = chunkWire.readUpload(p);
    const u = this.upload(c.uploadId, signer);
    if (c.index < 0 || c.index >= u.chunks.length) fail(400, "chunkOutOfRange");
    if (digestBytes(c.data) !== c.digest || c.digest !== u.manifest.chunks.chunkDigests[c.index]) fail(400, "rooms:chunkDigestMismatch");
    u.chunks[c.index] = c.data;
    return { uploadId: c.uploadId, index: c.index, stored: true, remainingCount: u.chunks.filter((x) => !x).length, expiresAt: new Date(this.now().getTime() + 3600_000).toISOString() };
  }

  private uploadCommit(p: any, signer: string) {
    const u = this.upload(String(p.uploadId), signer);
    if (u.chunks.some((x) => !x)) fail(400, "rooms:uploadIncomplete");
    const bytes = new Uint8Array(u.manifest.size);
    let at = 0;
    for (const c of u.chunks as Uint8Array[]) { bytes.set(c, at); at += c.length; }
    if (digestBytes(bytes) !== u.manifest.digest) fail(400, "rooms:blobDigestMismatch");
    const blobRef = blobRefOf(u.manifest);
    this.room(u.roomId).blobs.set(blobRef, { manifest: u.manifest, bytes });
    this.uploads.delete(String(p.uploadId));
    return { blobRef, size: bytes.length };
  }

  private uploadAbort(p: any, signer: string) {
    this.upload(String(p.uploadId), signer);
    this.uploads.delete(String(p.uploadId));
    return {};
  }

  private blobGet(p: any, signer: string) {
    const r = this.authorize(p, signer, "read");
    const b = r.blobs.get(String(p.blobRef));
    if (!b) fail(404, "rooms:blobNotFound");
    const downloadId = `dl-${++this.seq}`;
    this.downloads.set(downloadId, { roomId: r.roomId, blobRef: String(p.blobRef) });
    return { mode: "proxied", manifest: b.manifest, downloadId, expiresAt: new Date(this.now().getTime() + 3600_000).toISOString() };
  }

  private blobChunk(p: any) {
    const q = chunkWire.readDownloadRequest(p);
    const d = this.downloads.get(q.downloadId);
    if (!d) fail(404, "rooms:downloadNotFound");
    const b = this.room(d.roomId).blobs.get(d.blobRef)!;
    const size = b.manifest.chunks.chunkSize;
    if (q.index < 0 || q.index >= b.manifest.chunks.chunkCount) fail(400, "chunkOutOfRange");
    return chunkWire.downloadReply(q.index, b.bytes.subarray(q.index * size, (q.index + 1) * size));
  }
}
