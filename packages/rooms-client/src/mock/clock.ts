// A manual Clock for feed tests: timers run only when advance() reaches them.
import type { Clock } from "../feed.js";

export class ManualClock implements Clock {
  private t = 0;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();

  constructor(start = 0) { this.t = start; }

  now(): number { return this.t; }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(handle: unknown): void { this.timers.delete(handle as number); }

  /** The delays of pending timers, from now. */
  pending(): number[] { return [...this.timers.values()].map((x) => x.at - this.t).sort((a, b) => a - b); }

  /** Move time forward, running each due timer in order and letting its promises settle. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      await settle();
      const next = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next || next[1].at > end) break;
      this.timers.delete(next[0]);
      this.t = next[1].at;
      next[1].fn();
    }
    this.t = end;
    await settle();
  }
}

/** Let pending promise chains run (several macrotask turns). */
export async function settle(turns = 20): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setImmediate(r));
}
