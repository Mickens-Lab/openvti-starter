// The change feed. No member push exists upstream, so the default source polls `records/list` with
// `sinceVersion = watermark`: every 3 s while visible, 15 s while hidden, at once after the client's own write,
// exponential backoff to 60 s on errors, and a 429's Retry-After honoured. A ChangeSource (DIDComm/TSP, or a future
// member SSE) can replace the poll timer: it only decides when to sync.
import type { RecordMeta, RoomRecord } from "./wire.js";

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Decides when the feed syncs. `sync` rejects when the host failed; a source may back off on that. */
export interface ChangeSource {
  start(sync: () => Promise<void>): void;
  stop(): void;
  /** Sync as soon as possible (after the client's own write). */
  kick?(): void;
}

export type FeedStatus = "idle" | "live" | "backoff" | "stopped";

export interface PollOpts {
  clock?: Clock;
  visibleMs?: number;
  hiddenMs?: number;
  maxBackoffMs?: number;
  visible?: boolean;
}

/** The default ChangeSource: a poll timer with visibility intervals, backoff and Retry-After. */
export class PollSource implements ChangeSource {
  status: FeedStatus = "idle";
  failures = 0;
  lastError?: unknown;
  /** The delay the next poll was scheduled with (ms). */
  nextDelay = 0;
  onStatus?: (s: FeedStatus, err?: unknown) => void;
  private sync?: () => Promise<void>;
  private handle: unknown;
  private visible: boolean;
  private readonly clock: Clock;

  constructor(private readonly o: PollOpts = {}) {
    this.clock = o.clock ?? systemClock;
    this.visible = o.visible ?? true;
  }

  get interval(): number {
    return this.visible ? (this.o.visibleMs ?? 3000) : (this.o.hiddenMs ?? 15000);
  }

  start(sync: () => Promise<void>): void {
    this.sync = sync;
    this.schedule(0);
  }

  stop(): void {
    this.clock.clearTimeout(this.handle);
    this.sync = undefined;
    this.set("stopped");
  }

  kick(): void {
    if (this.sync) this.schedule(0);
  }

  /** Wire to `document.visibilitychange`. Becoming visible polls at once unless backing off. */
  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    if (this.sync && this.status !== "backoff") this.schedule(visible ? 0 : this.interval);
  }

  private schedule(ms: number): void {
    this.clock.clearTimeout(this.handle);
    this.nextDelay = ms;
    this.handle = this.clock.setTimeout(() => void this.tick(), ms);
  }

  private async tick(): Promise<void> {
    const sync = this.sync;
    if (!sync) return;
    try {
      await sync();
      if (this.sync !== sync) return;
      this.failures = 0;
      this.lastError = undefined;
      this.set("live");
      this.schedule(this.interval);
    } catch (e) {
      if (this.sync !== sync) return;
      this.failures++;
      this.lastError = e;
      const retryAfter = (e as { status?: number; retryAfterMs?: number })?.status === 429 ? (e as { retryAfterMs?: number }).retryAfterMs : undefined;
      const max = this.o.maxBackoffMs ?? 60_000;
      this.set("backoff", e);
      this.schedule(retryAfter ?? Math.min(max, this.interval * 2 ** this.failures));
    }
  }

  private set(s: FeedStatus, err?: unknown) {
    this.status = s;
    try { this.onStatus?.(s, err); } catch { /* a listener must not break the feed */ }
  }
}

export interface FeedChange {
  /** Keys not seen before. */
  added: RoomRecord[];
  /** Keys seen at a lower version (including `deprecated`). */
  updated: RoomRecord[];
  /** Records now `retracted` (metadata only; no body is fetched). */
  retracted: RecordMeta[];
  /** Records whose body could not be fetched; they are not retried. */
  failed: { meta: RecordMeta; error: unknown }[];
}

export interface FeedOpts {
  /** Metadata of every record above `sinceVersion` (HostClient.list). */
  list(sinceVersion: number): Promise<{ records: RecordMeta[]; headVersion?: number }>;
  /** One record with its body (HostClient.get). */
  get(meta: RecordMeta): Promise<RoomRecord>;
  source?: ChangeSource;
  /** Start above this version (0 = from the beginning). */
  sinceVersion?: number;
}

export class Feed {
  /** The highest version synced; the next poll asks for records above it. */
  watermark: number;
  readonly source: ChangeSource;
  private seen = new Map<string, number>();
  private listeners = new Set<(c: FeedChange) => void>();
  private running?: Promise<void>;
  private again = false;

  constructor(private readonly o: FeedOpts) {
    this.watermark = o.sinceVersion ?? 0;
    this.source = o.source ?? new PollSource();
  }

  onChange(fn: (c: FeedChange) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  start(): void {
    this.source.start(() => this.sync());
  }

  stop(): void {
    this.source.stop();
  }

  /** Sync now, through the source when it can (so its timer restarts), else directly. */
  kick(): void {
    if (this.source.kick) this.source.kick();
    else void this.sync().catch(() => undefined);
  }

  /** Mark a record the client wrote and already shows, so the feed does not emit its echo. */
  markSeen(key: string, version: number): void {
    this.seen.set(key, Math.max(this.seen.get(key) ?? 0, version));
  }

  /** One sync, serialised: a call during a running sync runs one more after it. */
  sync(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.once();
        } while (this.again);
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  private async once(): Promise<void> {
    const page = await this.o.list(this.watermark);
    const change: FeedChange = { added: [], updated: [], retracted: [], failed: [] };
    let top = this.watermark;
    for (const m of [...page.records].sort((a, b) => a.version - b.version)) {
      top = Math.max(top, m.version);
      const prev = this.seen.get(m.key);
      if (prev !== undefined && prev >= m.version) continue;
      this.seen.set(m.key, m.version);
      if (m.status === "retracted") {
        change.retracted.push(m);
        continue;
      }
      try {
        const r = await this.o.get(m);
        this.seen.set(m.key, Math.max(m.version, r.version));
        (prev === undefined ? change.added : change.updated).push(r);
      } catch (error) {
        change.failed.push({ meta: m, error });
      }
    }
    // headVersion moves the watermark only when nothing was listed (pruned or filtered versions).
    if (page.records.length === 0 && page.headVersion !== undefined) top = Math.max(top, page.headVersion);
    this.watermark = top;
    if (change.added.length + change.updated.length + change.retracted.length + change.failed.length === 0) return;
    for (const fn of this.listeners) {
      try { fn(change); } catch { /* a listener must not break the feed */ }
    }
  }
}
