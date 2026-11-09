// The app envelope: what a collaboration record's body carries, as JSON. On open rooms it is the cleartext `body`
// (with `title`/`description` mirroring the name and kind for other clients); on sealed rooms it is the plaintext
// that gets sealed, and the record key is opaque so the kind is only inside the ciphertext.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { b64u, isSealedTier, utf8, type Cleartext, type Visibility } from "./wire.js";

export const ENVELOPE_PROFILE = "openvti.collab/1";
/** Sealed rooms carry files inline in the sealed record, up to this size (blob file keys are not implemented). */
/**
 * The largest file a sealed room takes inline. The host refuses documents over 65536 bytes (`rooms/records/put/0.3`, observed live) and a
 * sealed inline file inflates about 1.8x plus ~4.5 KB of overhead, so the limit is just over 34,300 bytes (34,300 passed, 36,000 did not).
 * 32 KiB leaves headroom. Open rooms are not bound by it: their files are blobs.
 */
export const INLINE_FILE_CAP = 32 * 1024;
export const AVATAR_CAP = 64 * 1024;

export type EnvelopeKind = "chat" | "note" | "file" | "profile";

interface Base<K extends EnvelopeKind> {
  profile: typeof ENVELOPE_PROFILE;
  kind: K;
  /** Stable across versions of the same item (a note's edits share one id). A ULID. */
  id: string;
  /** The author's clock, RFC 3339. Display only: order comes from the host's version. */
  clientTs: string;
}

export interface ChatEnvelope extends Base<"chat"> { text: string; format: "text/plain" | "text/markdown" }
export interface NoteEnvelope extends Base<"note"> { title: string; body: string }
export interface FileEnvelope extends Base<"file"> {
  name: string;
  /** The author's claim; renderers sniff the bytes instead. */
  mediaType: string;
  size: number;
  /** Lowercase hex SHA-256 of the file bytes. */
  sha256: string;
  /** The bytes, base64url without padding (sealed rooms, or small files). */
  inline?: string;
  /** A committed blob (open rooms). */
  blobRef?: string;
}
export interface ProfileEnvelope extends Base<"profile"> {
  /** The DID this profile describes. Readers ignore it unless the record's author is this DID. */
  subject: string;
  displayName: string;
  avatar?: { mediaType: string; data: string };
}
export type Envelope = ChatEnvelope | NoteEnvelope | FileEnvelope | ProfileEnvelope;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID: 48-bit milliseconds and 80 random bits, Crockford base32, so ids sort by creation time. */
export function ulid(now = Date.now()): string {
  let t = "";
  for (let i = 0, n = now; i < 10; i++, n = Math.floor(n / 32)) t = CROCKFORD[n % 32] + t;
  const r = randomBytes(16);
  let s = "";
  for (let i = 0; i < 16; i++) s += CROCKFORD[r[i] % 32];
  return t + s;
}

const base = <K extends EnvelopeKind>(kind: K, id?: string, now = new Date()): Base<K> => ({ profile: ENVELOPE_PROFILE, kind, id: id ?? ulid(now.getTime()), clientTs: now.toISOString() });

export const makeChat = (text: string, format: ChatEnvelope["format"] = "text/plain", now?: Date): ChatEnvelope => ({ ...base("chat", undefined, now), text, format });

/** A note; pass the existing `id` to save a new version of the same note. */
export const makeNote = (title: string, body: string, id?: string, now?: Date): NoteEnvelope => ({ ...base("note", id, now), title, body });

export function makeFile(name: string, mediaType: string, bytes: Uint8Array, where: { inline: true } | { blobRef: string }, now?: Date): FileEnvelope {
  return {
    ...base("file", undefined, now), name, mediaType, size: bytes.length, sha256: bytesToHex(sha256(bytes)),
    ...("inline" in where ? { inline: b64u(bytes) } : { blobRef: where.blobRef }),
  };
}

export function makeProfile(subject: string, displayName: string, avatar?: { mediaType: string; bytes: Uint8Array }, now?: Date): ProfileEnvelope {
  if (avatar && avatar.bytes.length > AVATAR_CAP) throw new Error(`avatar is over ${AVATAR_CAP} bytes`);
  return { ...base("profile", undefined, now), subject, displayName, ...(avatar ? { avatar: { mediaType: avatar.mediaType, data: b64u(avatar.bytes) } } : {}) };
}

export const encodeEnvelope = (e: Envelope): string => JSON.stringify(e);

const str = (v: unknown): v is string => typeof v === "string";

/** Parse a record body. Undefined for anything that is not a well-formed envelope of this profile (other apps' records). */
export function decodeEnvelope(body: string | Uint8Array): Envelope | undefined {
  let o: any;
  try {
    o = JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body));
  } catch {
    return undefined;
  }
  if (!o || o.profile !== ENVELOPE_PROFILE || !str(o.id) || !str(o.clientTs)) return undefined;
  switch (o.kind) {
    case "chat":
      return str(o.text) && (o.format === "text/plain" || o.format === "text/markdown") ? o : undefined;
    case "note":
      return str(o.title) && str(o.body) ? o : undefined;
    case "file":
      return str(o.name) && str(o.mediaType) && Number.isInteger(o.size) && str(o.sha256) && (str(o.inline) || str(o.blobRef)) ? o : undefined;
    case "profile":
      return str(o.subject) && str(o.displayName) && (o.avatar === undefined || (str(o.avatar.mediaType) && str(o.avatar.data))) ? o : undefined;
    default:
      return undefined;
  }
}

/** A short stable hash of a DID for profile keys: 16 bytes of SHA-256, base64url. */
export const didHash = (did: string): string => b64u(sha256(utf8(did)).subarray(0, 16));

/** A random 128-bit opaque key, as sealed tiers require. */
export const opaqueKey = (): string => b64u(randomBytes(16));

/**
 * The record key for an envelope. Open rooms: `chat/<ulid>`, `note/<ulid>`, `file/<ulid>`, `profile/<did-hash>`; every
 * note version is its own record (`note/<id>/<ulid>`) so edits are create-only on both tiers. Sealed rooms: opaque.
 */
export function recordKeyFor(e: Envelope, visibility: Visibility): string {
  if (isSealedTier(visibility)) return opaqueKey();
  switch (e.kind) {
    case "profile": return `profile/${didHash(e.subject)}`;
    case "note": return `note/${e.id}/${ulid()}`;
    default: return `${e.kind}/${e.id}`;
  }
}

/** The cleartext record for an open room: the envelope as `body`, with a human title and the kind as description. */
export function cleartextFor(e: Envelope): Cleartext {
  const title = e.kind === "file" ? e.name : e.kind === "note" ? e.title : e.kind === "profile" ? e.displayName : e.text.slice(0, 80);
  return { title, description: e.kind, body: encodeEnvelope(e), tags: [e.kind] };
}

/** The image type judged from the bytes (PNG, JPEG, GIF, WebP), never from the author's claim. Undefined otherwise. */
export function sniffImage(b: Uint8Array): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | undefined {
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return undefined;
}
