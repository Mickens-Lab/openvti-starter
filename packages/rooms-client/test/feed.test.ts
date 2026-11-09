import assert from "node:assert/strict";
import { test } from "node:test";
import { TrustTaskError } from "@starter/vta-client";
import { Feed, PollSource, type FeedChange, type RecordMeta, type RoomRecord } from "../src/index.js";
import { ManualClock } from "../src/mock/index.js";

/** A fake host log: list returns the newest version per key above sinceVersion. */
function fakeHost() {
  const log: RecordMeta[] = [];
  let head = 0;
  const calls = { list: [] as number[], get: 0 };
  let failWith: unknown;
  const write = (key: string, status: RecordMeta["status"] = "active") => {
    const v = ++head;
    const i = log.findIndex((m) => m.key === key);
    const m = { key, version: v, status, updatedAt: "" };
    if (i >= 0) log[i] = m; else log.push(m);
    return v;
  };
  return {
    write, calls, get head() { return head; }, set fail(e: unknown) { failWith = e; },
    list: async (since: number) => {
      calls.list.push(since);
      if (failWith) throw failWith;
      return { records: log.filter((m) => m.version > since), headVersion: head };
    },
    get: async (m: RecordMeta): Promise<RoomRecord> => { calls.get++; return { ...m, pinned: false, cleartext: { body: m.key } }; },
  };
}

function setup(o: { visible?: boolean } = {}) {
  const clock = new ManualClock();
  const host = fakeHost();
  const source = new PollSource({ clock, visible: o.visible });
  const feed = new Feed({ list: host.list, get: host.get, source });
  const changes: FeedChange[] = [];
  feed.onChange((c) => changes.push(c));
  return { clock, host, source, feed, changes };
}

test("polls at once, then every 3 s while visible; emits added, updated and retracted once", async () => {
  const { clock, host, feed, changes } = setup();
  host.write("a"); host.write("b");
  feed.start();
  await clock.advance(0);
  assert.deepEqual(changes[0].added.map((r) => r.key), ["a", "b"]);
  assert.equal(feed.watermark, 2);
  await clock.advance(3000);
  assert.equal(changes.length, 1, "nothing new, nothing emitted");
  assert.deepEqual(host.calls.list, [0, 2]);
  host.write("a"); host.write("b", "retracted"); host.write("c");
  await clock.advance(3000);
  assert.deepEqual(changes[1].updated.map((r) => [r.key, r.version]), [["a", 3]]);
  assert.deepEqual(changes[1].retracted.map((r) => r.key), ["b"]);
  assert.deepEqual(changes[1].added.map((r) => r.key), ["c"]);
  assert.equal(host.calls.get, 4, "no body fetched for a retraction");
  feed.stop();
});

test("dedupe by (key, version): overlapping syncs and own writes are not emitted twice", async () => {
  const { host, feed, changes } = setup();
  host.write("a");
  await Promise.all([feed.sync(), feed.sync(), feed.sync()]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].added.length, 1);
  const v = host.write("mine");
  feed.markSeen("mine", v);
  await feed.sync();
  assert.equal(changes.length, 1);
  assert.equal(feed.watermark, v);
});

test("watermark: headVersion advances it only when nothing was listed", async () => {
  const host = fakeHost();
  const feed = new Feed({ list: async (s) => ({ records: [], headVersion: s + 5 }), get: host.get, source: new PollSource({ clock: new ManualClock() }) });
  await feed.sync();
  assert.equal(feed.watermark, 5);
  const f2 = new Feed({ list: async () => ({ records: [{ key: "k", version: 2, status: "active", updatedAt: "" }], headVersion: 9 }), get: host.get });
  await f2.sync();
  assert.equal(f2.watermark, 2, "a head above the listed records is not trusted");
});

test("hidden polls every 15 s; becoming visible polls at once", async () => {
  const { clock, host, source, feed } = setup({ visible: false });
  feed.start();
  await clock.advance(0);
  assert.deepEqual(clock.pending(), [15000]);
  await clock.advance(14_999);
  assert.equal(host.calls.list.length, 1);
  source.setVisible(true);
  await clock.advance(0);
  assert.equal(host.calls.list.length, 2);
  assert.deepEqual(clock.pending(), [3000]);
  feed.stop();
});

test("kick polls right away after an own write", async () => {
  const { clock, host, feed, changes } = setup();
  feed.start();
  await clock.advance(0);
  host.write("x");
  feed.kick();
  await clock.advance(0);
  assert.equal(changes[0].added[0].key, "x");
  feed.stop();
});

test("errors back off exponentially to 60 s, then recover to the interval", async () => {
  const { clock, host, source, feed } = setup();
  host.fail = new Error("down");
  feed.start();
  const delays: number[] = [];
  for (let i = 0; i < 6; i++) { await clock.advance(i === 0 ? 0 : delays[i - 1]); delays.push(source.nextDelay); }
  assert.deepEqual(delays, [6000, 12000, 24000, 48000, 60000, 60000]);
  assert.equal(source.status, "backoff");
  host.fail = undefined;
  await clock.advance(60000);
  assert.equal(source.status, "live");
  assert.equal(source.nextDelay, 3000);
  feed.stop();
});

test("a 429 honours Retry-After", async () => {
  const { clock, host, source, feed } = setup();
  const e = new TrustTaskError(429, { payload: { code: "rateLimited" } });
  (e as any).retryAfterMs = 42_000;
  host.fail = e;
  feed.start();
  await clock.advance(0);
  assert.equal(source.nextDelay, 42_000);
  feed.stop();
  assert.equal(source.status, "stopped");
  assert.deepEqual(clock.pending(), []);
});

test("a body that cannot be fetched is reported once, not retried", async () => {
  const host = fakeHost();
  host.write("bad");
  const feed = new Feed({ list: host.list, get: async () => { throw new Error("cannot open"); } });
  const changes: FeedChange[] = [];
  feed.onChange((c) => changes.push(c));
  await feed.sync();
  await feed.sync();
  assert.equal(changes.length, 1);
  assert.equal(changes[0].failed[0].meta.key, "bad");
});

test("a custom ChangeSource replaces the timer", async () => {
  const host = fakeHost();
  let trigger: (() => Promise<void>) | undefined;
  const feed = new Feed({ list: host.list, get: host.get, source: { start: (s) => { trigger = s; }, stop: () => { trigger = undefined; } } });
  const changes: FeedChange[] = [];
  feed.onChange((c) => changes.push(c));
  feed.start();
  host.write("pushed");
  await trigger!();
  assert.equal(changes[0].added[0].key, "pushed");
});
