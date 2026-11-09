// RoomSession: one member's view of one room. It ties the host (HostClient), the key boundary (KeyService, sealed
// tiers only), the envelope, the change feed, the search index and profile resolution together:
//  - open() reads the room's tier from rooms/info, loads the history, publishes the member's profile when it is
//    missing or stale, and starts the feed;
//  - items() are the chat, note and file items sorted by host version (a note's versions collapse to the newest);
//  - writes are create-only records: cleartext on `open` rooms (files as blobs), sealed through the KeyService on
//    `attributed`/`private` rooms (files inline, up to INLINE_FILE_CAP);
//  - search runs over decrypted content in memory only. Text files on open rooms are fetched the first time a
//    full-text search needs them.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  INLINE_FILE_CAP, cleartextFor, decodeEnvelope, encodeEnvelope, makeChat, makeFile, makeNote, makeProfile, opaqueKey,
  recordKeyFor, type ChatEnvelope, type Envelope, type FileEnvelope, type NoteEnvelope, type ProfileEnvelope,
} from "./envelope.js";
import { Feed, type ChangeSource, type FeedChange } from "./feed.js";
import type { HostClient } from "./host.js";
import { sealedVersion, type KeyService } from "./keys.js";
import { ProfileResolver, type SelfCard } from "./profiles.js";
import { SearchIndex, isIndexableText, type NameHit, type TextHit } from "./search.js";
import { b64u, isSealedTier, unb64u, utf8, type RecordStatus, type RoomInfo, type RoomRecord, type Visibility } from "./wire.js";

export type ItemEnvelope = ChatEnvelope | NoteEnvelope | FileEnvelope;
export type ItemKind = ItemEnvelope["kind"];

/** A chat message, note or file as the UI shows it. */
export interface SessionItem<E extends ItemEnvelope = ItemEnvelope> {
  /** The envelope id: stable across a note's versions. */
  id: string;
  kind: E["kind"];
  /** The record key of the version shown. */
  key: string;
  /** The host version of the version shown; items sort by it. */
  version: number;
  /** The record author as the host reports it (absent on `private` rooms). Resolve it with `session.profiles`. */
  author?: string;
  status: RecordStatus;
  updatedAt: string;
  envelope: E;
  /** Written by this session's member. */
  mine: boolean;
}

export interface SessionChange {
  /** Items not shown before. */
  added: SessionItem[];
  /** Items shown before, now at a newer version (a note edit, an open-room overwrite). */
  updated: SessionItem[];
  /** Ids of items no longer shown (every version retracted). */
  removed: string[];
  /** DIDs whose room profile changed: re-resolve their author labels. */
  profiles: string[];
  /** Records that could not be fetched or opened (for example an epoch this member has no key for). */
  failed: { key: string; version: number; error: unknown }[];
  /** "local" for this session's own writes, "feed" for what the host delivered. */
  origin: "local" | "feed";
}

export type SearchMode = "names" | "text";
export type NameResult = NameHit & { item: SessionItem<FileEnvelope> };
export type TextResult = TextHit & { item: SessionItem };

export interface RoomSessionOpts {
  roomId: string;
  host: HostClient;
  /** Required on sealed tiers (`attributed`, `private`): seals and opens record bodies. */
  keys?: KeyService;
  /** The member's DID: the identity that signs host documents, so the host records it as the author. */
  self: string;
  /** The profile to publish in the room. Falls back to `selfCard`; with neither, nothing is published. */
  profile?: { displayName: string; avatar?: { mediaType: string; bytes: Uint8Array } };
  /** The member's VTC card (`directory/card/show`), for the profile to publish and for resolving self. */
  selfCard?: SelfCard;
  /** What drives the feed (default a PollSource: 3 s visible, 15 s hidden). */
  source?: ChangeSource;
  /** Start the feed after the history loads (default true). With false, call `session.feed.sync()` yourself. */
  start?: boolean;
}

export class RoomSession {
  readonly feed: Feed;
  readonly profiles: ProfileResolver;
  private readonly index = new SearchIndex();
  /** envelope id -> record key -> item (a note has one record per version). */
  private readonly versions = new Map<string, Map<string, SessionItem>>();
  /** record key -> envelope id */
  private readonly keyToId = new Map<string, string>();
  /** Opened bodies the feed fetched, waiting for its change event: `key|version` -> envelope. */
  private readonly opened = new Map<string, Envelope | undefined>();
  private readonly listeners = new Set<(c: SessionChange) => void>();
  /** Decoded text of text files, by envelope id (inline at once; open-room blobs on first full-text search). */
  private readonly texts = new Map<string, Promise<string | undefined>>();
  /** Downloaded blob bytes, memory only. */
  private readonly blobs = new Map<string, Promise<Uint8Array>>();
  private readonly unsubscribe: () => void;
  private closed = false;

  private constructor(
    private readonly o: RoomSessionOpts,
    readonly info: RoomInfo,
  ) {
    if (isSealedTier(info.visibility) && !o.keys) throw new Error(`room ${o.roomId} is ${info.visibility}: a KeyService is required to read or write it`);
    this.profiles = new ProfileResolver({ self: o.self, ...(o.selfCard ? { selfCard: o.selfCard } : {}) });
    this.feed = new Feed({
      list: (since) => o.host.list(o.roomId, { sinceVersion: since }),
      get: (meta) => this.fetch(meta.key),
      ...(o.source ? { source: o.source } : {}),
    });
    this.unsubscribe = this.feed.onChange((c) => this.onFeed(c));
  }

  /** Open a session: rooms/info, the history, profile publish, then the feed (unless `start: false`). */
  static async open(o: RoomSessionOpts): Promise<RoomSession> {
    const s = new RoomSession(o, await o.host.info(o.roomId));
    // A member added since this one joined moved the group on; apply the commits first so those records open.
    if (s.sealed && o.keys?.catchUp) { try { await o.keys.catchUp(o.roomId, o.host); } catch { /* a host without rooms/epoch/commits: read what opens */ } }
    await s.feed.sync();
    await s.publishProfile();
    if (o.start !== false) s.feed.start();
    return s;
  }

  get roomId(): string { return this.o.roomId; }
  get visibility(): Visibility { return this.info.visibility; }
  get sealed(): boolean { return isSealedTier(this.info.visibility); }
  get self(): string { return this.o.self; }

  /** Chat, notes and files, ascending by host version. */
  items(): SessionItem[] {
    const out: SessionItem[] = [];
    for (const id of this.versions.keys()) { const it = this.current(id); if (it) out.push(it); }
    return out.sort((a, b) => a.version - b.version);
  }

  item(id: string): SessionItem | undefined {
    return this.current(id);
  }

  /** Every version of a note (or the one version of anything else), ascending. */
  history(id: string): SessionItem[] {
    return [...(this.versions.get(id)?.values() ?? [])].sort((a, b) => a.version - b.version);
  }

  onChange(fn: (c: SessionChange) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Post a chat message. */
  async post(text: string, format: ChatEnvelope["format"] = "text/plain"): Promise<SessionItem<ChatEnvelope>> {
    return this.write(makeChat(text, format)) as Promise<SessionItem<ChatEnvelope>>;
  }

  /** Save a note; pass an existing note's `id` to save a new version of it. */
  async saveNote(title: string, body: string, id?: string): Promise<SessionItem<NoteEnvelope>> {
    return this.write(makeNote(title, body, id)) as Promise<SessionItem<NoteEnvelope>>;
  }

  /**
   * Upload a file. Open rooms: a blob (proxied upload), then a record naming it. Sealed rooms: inline in the sealed
   * record, refused above INLINE_FILE_CAP because sealed blob file keys are not implemented.
   */
  async upload(name: string, mediaType: string, bytes: Uint8Array): Promise<SessionItem<FileEnvelope>> {
    this.alive();
    let env: FileEnvelope;
    if (this.sealed) {
      if (bytes.length > INLINE_FILE_CAP) {
        throw new Error(`"${name}" is ${bytes.length} bytes; files in a ${this.visibility} room are sealed inline and limited to ${INLINE_FILE_CAP} bytes (32 KiB; the host takes documents of at most 65536 bytes). Sealed blob files are not implemented.`);
      }
      env = makeFile(name, mediaType, bytes, { inline: true });
    } else {
      const { blobRef } = await this.o.host.blobUpload(this.o.roomId, bytes);
      this.blobs.set(blobRef, Promise.resolve(bytes));
      env = makeFile(name, mediaType, bytes, { blobRef });
    }
    return this.write(env) as Promise<SessionItem<FileEnvelope>>;
  }

  /** A file's bytes (inline, or the blob downloaded and cached in memory), checked against the envelope's SHA-256. */
  async fileBytes(item: SessionItem<FileEnvelope> | FileEnvelope): Promise<Uint8Array> {
    const env = "envelope" in item ? item.envelope : item;
    let bytes: Uint8Array;
    if (env.inline !== undefined) bytes = unb64u(env.inline);
    else if (env.blobRef) {
      const ref = env.blobRef;
      let p = this.blobs.get(ref);
      if (!p) {
        p = this.o.host.blobDownload(this.o.roomId, ref);
        this.blobs.set(ref, p);
        p.catch(() => this.blobs.delete(ref));
      }
      bytes = await p;
    } else throw new Error(`file ${env.name} has neither inline bytes nor a blobRef`);
    if (bytesToHex(sha256(bytes)) !== env.sha256) throw new Error(`file ${env.name} does not match its SHA-256`);
    return bytes;
  }

  /**
   * Search. "names": file names (exact, prefix, substring). "text": chat, note titles and bodies, file names and the
   * content of text files (text/*, .md, .json, .csv, at most 1 MiB); on open rooms those are downloaded first, once.
   */
  search(query: string, mode: "names"): Promise<NameResult[]>;
  search(query: string, mode: "text"): Promise<TextResult[]>;
  search(query: string, mode: SearchMode): Promise<NameResult[] | TextResult[]>;
  async search(query: string, mode: SearchMode): Promise<NameResult[] | TextResult[]> {
    if (mode === "names") {
      return this.index.searchNames(query).flatMap((h) => {
        const item = this.current(h.id);
        return item?.kind === "file" ? [{ ...h, item: item as SessionItem<FileEnvelope> }] : [];
      });
    }
    await this.loadTexts();
    return this.index.searchText(query).flatMap((h) => {
      const item = this.current(h.id);
      return item ? [{ ...h, item }] : [];
    });
  }

  /** Stop the feed and drop everything held in memory (decrypted items, the index, downloaded bytes). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.feed.stop();
    this.unsubscribe();
    this.listeners.clear();
    this.index.clear();
    this.versions.clear();
    this.keyToId.clear();
    this.opened.clear();
    this.texts.clear();
    this.blobs.clear();
  }

  // ---- writes ----

  private alive(): void {
    if (this.closed) throw new Error("the room session is closed");
  }

  /** Write one envelope as a new record, show it at once, and let the feed catch up. */
  private async write(env: Envelope, overwrite = false): Promise<SessionItem | undefined> {
    this.alive();
    const { roomId, host } = this.o;
    let key: string;
    let version: number;
    if (this.sealed) {
      // The version is sealed into the AAD, so seal for the version the put should get: sync first so the watermark is
      // the host's head. If another write lands in between, `sealed.version` still names the version that was sealed.
      await this.feed.sync();
      key = opaqueKey();
      const sealed = await this.o.keys!.seal(roomId, key, this.feed.watermark + 1, utf8(encodeEnvelope(env)));
      version = (await host.put(roomId, { key, expectedVersion: 0, sealed })).version;
    } else {
      key = recordKeyFor(env, "open");
      const blobs = env.kind === "file" && env.blobRef ? [env.blobRef] : undefined;
      version = (await host.put(roomId, { key, ...(overwrite ? {} : { expectedVersion: 0 }), cleartext: cleartextFor(env), ...(blobs ? { blobs } : {}) })).version;
    }
    this.feed.markSeen(key, version);
    const change = this.blank("local");
    this.apply({ key, version, author: this.o.self, status: "active", updatedAt: new Date().toISOString() }, env, change);
    this.emit(change);
    this.feed.kick();
    return env.kind === "profile" ? undefined : this.current(env.id);
  }

  /** Publish the member's profile once when the room holds none from them, or a different one. */
  private async publishProfile(): Promise<void> {
    const want = this.o.profile ?? (await this.o.selfCard?.().catch(() => undefined));
    if (!want?.displayName) return;
    const have = this.profiles.roomProfile(this.o.self);
    const avatar = want.avatar ? { mediaType: want.avatar.mediaType, data: b64u(want.avatar.bytes) } : undefined;
    if (have && have.displayName === want.displayName && have.avatar?.data === avatar?.data) return;
    await this.write(makeProfile(this.o.self, want.displayName, want.avatar), true);
  }

  // ---- reads ----

  /** The feed's `get`: fetch the record and open its body, holding the envelope for the change event. */
  private async fetch(key: string): Promise<RoomRecord> {
    const { record } = await this.o.host.get(this.o.roomId, key);
    let env: Envelope | undefined;
    if (record.sealed) {
      if (!this.o.keys) throw new Error("sealed record and no KeyService");
      env = decodeEnvelope(await this.o.keys.open(this.o.roomId, record.key, sealedVersion(record.version, record.sealed), record.sealed));
    } else if (record.cleartext) env = decodeEnvelope(record.cleartext.body);
    this.opened.set(`${record.key}|${record.version}`, env);
    return record;
  }

  private onFeed(c: FeedChange): void {
    if (this.closed) return;
    const change = this.blank("feed");
    for (const r of [...c.added, ...c.updated]) {
      const k = `${r.key}|${r.version}`;
      const env = this.opened.get(k);
      this.opened.delete(k);
      // Not an envelope of this profile (another app's record): skipped.
      if (env) this.apply(r, env, change);
    }
    for (const m of c.retracted) this.retract(m.key, change);
    for (const f of c.failed) change.failed.push({ key: f.meta.key, version: f.meta.version, error: f.error });
    this.emit(change);
  }

  private apply(r: Pick<RoomRecord, "key" | "version" | "author" | "status" | "updatedAt">, env: Envelope, change: SessionChange): void {
    if (env.kind === "profile") {
      if (this.profiles.offer(env as ProfileEnvelope, r.author, r.version)) change.profiles.push(env.subject);
      return;
    }
    // A record key belongs to one envelope id; a body claiming another id under a known key is ignored.
    const known = this.keyToId.get(r.key);
    if (known !== undefined && known !== env.id) return;
    const before = this.current(env.id);
    // Items of one id must keep one kind (a chat cannot replace a note).
    if (before && before.kind !== env.kind) return;
    let vs = this.versions.get(env.id);
    if (!vs) this.versions.set(env.id, (vs = new Map()));
    vs.set(r.key, {
      id: env.id, kind: env.kind, key: r.key, version: r.version, status: r.status, updatedAt: r.updatedAt, envelope: env,
      mine: r.author === this.o.self, ...(r.author ? { author: r.author } : {}),
    });
    this.keyToId.set(r.key, env.id);
    const now = this.current(env.id)!;
    if (before && before.version >= now.version) return;
    this.reindex(now);
    (before ? change.updated : change.added).push(now);
  }

  private retract(key: string, change: SessionChange): void {
    const id = this.keyToId.get(key);
    if (id === undefined) return;
    const vs = this.versions.get(id)!;
    const before = this.current(id);
    vs.delete(key);
    this.keyToId.delete(key);
    const now = this.current(id);
    if (!now) {
      this.versions.delete(id);
      this.index.remove(id);
      this.texts.delete(id);
      change.removed.push(id);
    } else if (now !== before) {
      this.reindex(now);
      change.updated.push(now);
    }
  }

  private current(id: string): SessionItem | undefined {
    let best: SessionItem | undefined;
    for (const it of this.versions.get(id)?.values() ?? []) if (!best || it.version > best.version) best = it;
    return best;
  }

  private reindex(it: SessionItem): void {
    const e = it.envelope;
    if (e.kind === "chat") this.index.upsert({ id: it.id, kind: "chat", version: it.version, text: e.text });
    else if (e.kind === "note") this.index.upsert({ id: it.id, kind: "note", version: it.version, title: e.title, text: e.body });
    else {
      this.index.upsert({ id: it.id, kind: "file", version: it.version, name: e.name });
      // Inline text is indexed at once; blob text waits for the first full-text search.
      if (e.inline !== undefined && isIndexableText(e.name, e.mediaType, e.size)) void this.loadText(it as SessionItem<FileEnvelope>);
    }
  }

  /** Decode a text file and add its content to the index. Undefined when it is not valid UTF-8 or cannot be read. */
  private loadText(it: SessionItem<FileEnvelope>): Promise<string | undefined> {
    let p = this.texts.get(it.id);
    if (p) return p;
    p = (async () => {
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(await this.fileBytes(it));
        const cur = this.current(it.id);
        if (cur && cur.version === it.version) this.index.upsert({ id: it.id, kind: "file", version: it.version, name: it.envelope.name, text });
        return text;
      } catch {
        return undefined;
      }
    })();
    this.texts.set(it.id, p);
    return p;
  }

  private async loadTexts(): Promise<void> {
    const pending: Promise<unknown>[] = [];
    for (const it of this.items()) {
      if (it.kind !== "file") continue;
      const e = it.envelope as FileEnvelope;
      if (isIndexableText(e.name, e.mediaType, e.size)) pending.push(this.loadText(it as SessionItem<FileEnvelope>));
    }
    await Promise.all(pending);
  }

  private blank(origin: SessionChange["origin"]): SessionChange {
    return { added: [], updated: [], removed: [], profiles: [], failed: [], origin };
  }

  private emit(c: SessionChange): void {
    // One change may add an item and then update it (two note versions in one sync), or update and then remove it:
    // report each id once, at its current state.
    const removed = new Set(c.removed);
    const added = new Set(c.added.map((i) => i.id));
    c.added = [...added].filter((id) => !removed.has(id)).map((id) => this.current(id)!).filter(Boolean);
    c.updated = [...new Set(c.updated.map((i) => i.id))].filter((id) => !added.has(id) && !removed.has(id)).map((id) => this.current(id)!).filter(Boolean);
    c.removed = [...removed].filter((id) => !added.has(id) || !this.current(id));
    c.profiles = [...new Set(c.profiles)];
    if (c.added.length + c.updated.length + c.removed.length + c.profiles.length + c.failed.length === 0) return;
    for (const fn of this.listeners) {
      try { fn(c); } catch { /* a listener must not break the session */ }
    }
  }
}
