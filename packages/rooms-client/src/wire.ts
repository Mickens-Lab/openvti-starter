// Wire shapes for rooms/* (from the @openvtc/trust-tasks bindings and vti-rooms wire.rs at the kit's pin), and the
// parsers that normalise what a host answers. Parsers are lenient on extra fields and strict on the ones we use.
import { sha256 } from "@noble/hashes/sha2.js";
import { base58, base64urlnopad } from "@scure/base";
import { canonicalBytes } from "@openvtc/trust-tasks-proof";
import { CHUNK_MAX } from "./tasks.js";

export type Visibility = "open" | "attributed" | "private";
export type RecordStatus = "active" | "deprecated" | "retracted";
export type RoomAction = "read" | "write" | "curate" | "admin";

/** Credentials the room issued: `authority` runs leaf to root. Minted by the member's VTA (`rooms/keys/present`). */
export interface Presentation {
  membership: string;
  authority: string[];
  subjectBinding?: string;
}

/** A sealed record body (vti-rooms sealed.rs). `ciphertext` and `nonce` are base64url without padding. */
export interface SealedContent {
  ciphertext: string;
  nonce: string;
  epoch: number;
  version?: number;
}

export interface Cleartext {
  title?: string;
  description?: string;
  body: string;
  tags?: string[];
}

/** What `records/list` returns per record: metadata only, no body. */
export interface RecordMeta {
  key: string;
  version: number;
  epoch?: number;
  status: RecordStatus;
  updatedAt: string;
  title?: string;
  description?: string;
  /** Absent on `private` rooms. */
  author?: string;
  blobs?: string[];
}

/** A record with its body, from `records/get`. */
export interface RoomRecord extends RecordMeta {
  pinned: boolean;
  sealed?: SealedContent;
  cleartext?: Cleartext;
}

export interface PutRequest {
  key: string;
  /** 0 = create only (required on sealed tiers). Omit to overwrite whatever is there (open tier only). */
  expectedVersion?: number;
  sealed?: SealedContent;
  cleartext?: Cleartext;
  blobs?: string[];
}

export interface PutResult {
  key: string;
  version: number;
  epoch?: number;
}

export interface ListPage {
  records: RecordMeta[];
  /** Absent means the end of the list (the only end-of-list signal). */
  nextCursor?: string;
  dataCommitment?: string;
  recordCount?: number;
  headVersion?: number;
}

export interface RoomInfo {
  roomId: string;
  visibility: Visibility;
  epoch: number;
  limits?: Record<string, unknown>;
  usage?: Record<string, unknown>;
}

/** A blob's manifest: what `upload/begin` commits to before any byte moves. Its JCS digest is the `blobRef`. */
export interface BlobManifest {
  size: number;
  chunks: { chunkSize: number; chunkCount: number; chunkDigests: string[] };
  digest: string;
}

export const b64u = (b: Uint8Array): string => base64urlnopad.encode(b);
export const unb64u = (s: string): Uint8Array => base64urlnopad.decode(s);
export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
export const fromUtf8 = (b: Uint8Array): string => new TextDecoder().decode(b);

/** `z` + base58btc of a sha2-256 multihash over `bytes`. */
export function digestBytes(bytes: Uint8Array): string {
  return "z" + base58.encode(Uint8Array.from([0x12, 0x20, ...sha256(bytes)]));
}

/** Split `bytes` into chunks and build the manifest. An empty file is one empty chunk. */
export function blobManifest(bytes: Uint8Array, chunkSize = CHUNK_MAX): { manifest: BlobManifest; chunks: Uint8Array[] } {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) chunks.push(bytes.subarray(i, i + chunkSize));
  if (chunks.length === 0) chunks.push(new Uint8Array());
  return {
    chunks,
    manifest: {
      size: bytes.length,
      chunks: { chunkSize, chunkCount: chunks.length, chunkDigests: chunks.map(digestBytes) },
      digest: digestBytes(bytes),
    },
  };
}

/** The blobRef: the digest of the manifest's RFC 8785 (JCS) form. */
export const blobRefOf = (m: BlobManifest): string => digestBytes(canonicalBytes(m as unknown as Record<string, unknown>));

// Chunk payload field names. Taken from the generated @openvtc/trust-tasks bindings for upload/chunk/0.2 and
// blobs/chunk/0.1; NOT checked against a live host [unverified]. Every builder and reader of a chunk is here, and the
// mock host uses the same functions.
export const chunkWire = {
  upload: (uploadId: string, index: number, data: Uint8Array) => ({ uploadId, index, digestMultibase: digestBytes(data), data: b64u(data) }),
  readUpload: (p: any) => ({ uploadId: String(p.uploadId), index: Number(p.index), digest: String(p.digestMultibase), data: unb64u(String(p.data)) }),
  download: (downloadId: string, index: number) => ({ downloadId, index }),
  readDownloadRequest: (p: any) => ({ downloadId: String(p.downloadId), index: Number(p.index) }),
  downloadReply: (index: number, data: Uint8Array) => ({ index, digestMultibase: digestBytes(data), data: b64u(data) }),
  readDownload: (p: any) => ({ index: Number(p.index), digest: String(p.digestMultibase), data: unb64u(String(p.data)) }),
} as const;

const STATUSES: RecordStatus[] = ["active", "deprecated", "retracted"];

function req<T>(v: T | undefined | null, what: string): T {
  if (v === undefined || v === null) throw new Error(`rooms reply is missing ${what}`);
  return v;
}

export function parseSealed(raw: any): SealedContent {
  return {
    ciphertext: String(req(raw?.ciphertext, "sealed.ciphertext")),
    nonce: String(req(raw?.nonce, "sealed.nonce")),
    epoch: Number(req(raw?.epoch, "sealed.epoch")),
    ...(raw.version !== undefined ? { version: Number(raw.version) } : {}),
  };
}

export function parseRecordMeta(raw: any): RecordMeta {
  const status = raw?.status ?? "active";
  if (!STATUSES.includes(status)) throw new Error(`unknown record status ${status}`);
  const m: RecordMeta = {
    key: String(req(raw?.key, "key")),
    version: Number(req(raw?.version, "version")),
    status,
    updatedAt: String(raw.updatedAt ?? ""),
  };
  if (raw.epoch !== undefined) m.epoch = Number(raw.epoch);
  if (typeof raw.title === "string") m.title = raw.title;
  if (typeof raw.description === "string") m.description = raw.description;
  if (typeof raw.author === "string") m.author = raw.author;
  if (Array.isArray(raw.blobs)) m.blobs = raw.blobs.map(String);
  return m;
}

/** `records/list` 0.5 says `nextCursor`; older versions said `cursor`. Both are accepted. */
export function parseListPage(raw: any): ListPage {
  const page: ListPage = { records: (req(raw?.records, "records") as unknown[]).map(parseRecordMeta) };
  const next = raw.nextCursor ?? raw.cursor;
  if (typeof next === "string" && next !== "") page.nextCursor = next;
  if (typeof raw.dataCommitment === "string") page.dataCommitment = raw.dataCommitment;
  if (raw.recordCount !== undefined) page.recordCount = Number(raw.recordCount);
  if (raw.headVersion !== undefined) page.headVersion = Number(raw.headVersion);
  return page;
}

/** `records/get` 0.2: the binding has the record's fields at the top level; a `{record: {...}}` wrapper is also accepted. */
export function parseGetReply(raw: any): { record: RoomRecord; headVersion?: number } {
  const r = raw?.record ?? raw;
  const record: RoomRecord = { ...parseRecordMeta(r), pinned: r.pinned === true };
  if (r.sealed) record.sealed = parseSealed(r.sealed);
  if (r.cleartext) {
    const c = r.cleartext;
    record.cleartext = { body: String(c.body ?? "") };
    if (typeof c.title === "string") record.cleartext.title = c.title;
    if (typeof c.description === "string") record.cleartext.description = c.description;
    if (Array.isArray(c.tags)) record.cleartext.tags = c.tags.map(String);
  }
  const head = raw.headVersion ?? r.headVersion;
  return { record, ...(head !== undefined ? { headVersion: Number(head) } : {}) };
}

export function parsePutReply(raw: any): PutResult {
  return {
    key: String(req(raw?.key, "key")),
    version: Number(req(raw?.version, "version")),
    ...(raw.epoch !== undefined ? { epoch: Number(raw.epoch) } : {}),
  };
}

export function parseInfo(raw: any): RoomInfo {
  const visibility = req(raw?.visibility, "visibility");
  if (!["open", "attributed", "private"].includes(visibility)) throw new Error(`unknown visibility ${visibility}`);
  return {
    roomId: String(req(raw.roomId, "roomId")),
    visibility,
    epoch: Number(raw.epoch ?? 0),
    ...(raw.limits ? { limits: raw.limits } : {}),
    ...(raw.usage ? { usage: raw.usage } : {}),
  };
}

export const isSealedTier = (v: Visibility): boolean => v !== "open";
