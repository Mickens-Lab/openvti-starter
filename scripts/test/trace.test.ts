import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { emitTrace, setTraceSink, type TraceEvent } from "@starter/vta-client";
import { formatTrace, installTrace, lastN, parseTrace } from "../lib/trace.js";

const ev = (over: Partial<TraceEvent> = {}): TraceEvent => ({
  ts: "2026-10-30T18:01:28.940Z", source: "vta", transport: "rest", type: "https://trusttasks.org/spec/vta/memory/put/0.1",
  id: "urn:uuid:12345678-aaaa", from: "did:key:z6MkfakefakefakefakeAAAAA", to: "did:webvh:Qmfake:localhost%3A8100", status: 200, ok: true, ms: 12, ...over,
});

test("a line shows time, client, task, outcome, duration and who to whom", () => {
  const l = formatTrace(ev());
  assert.match(l, /^18:01:28\.940 {2}vta rest vta\/memory\/put\/0\.1/);
  assert.match(l, /ok 200/);
  assert.match(l, / 12 ms /);
  assert.match(l, /did:key:z6Mk\.\.\.AAAAA -> did:webvh:Qm\.\.\.A8100/);
  assert.match(l, /id 12345678$/);
});

test("a refusal and a network error are marked", () => {
  assert.match(formatTrace(ev({ ok: false, status: 403, code: "permissionDenied" })), /REFUSED 403 permissionDenied/);
  assert.match(formatTrace(ev({ proof: "invalid" })), /reply proof invalid/);
  assert.doesNotMatch(formatTrace(ev({ proof: "verified" })), /reply proof/);
  assert.match(formatTrace(ev({ ok: false, status: undefined, code: "network", source: "tsp", transport: "tsp" })), /tsp tsp .*REFUSED network/);
});

test("parseTrace skips blank and damaged lines; lastN keeps the end", () => {
  const text = [JSON.stringify(ev({ ms: 1 })), "", "{not json", JSON.stringify(ev({ ms: 2 })), '{"half":'].join("\n");
  const all = parseTrace(text);
  assert.deepEqual(all.map((e) => e.ms), [1, 2]);
  assert.deepEqual(lastN(all, 1).map((e) => e.ms), [2]);
  assert.equal(lastN(all, 0).length, 2);
});

test("installTrace appends one JSON line per event, with no payload or key fields", () => {
  const file = join(mkdtempSync(join(tmpdir(), "trace-")), "sub", "t.jsonl");
  installTrace(file);
  try {
    emitTrace(ev({ ms: 5 }));
    emitTrace(ev({ ms: 6 }));
  } finally {
    setTraceSink(undefined);
  }
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(Object.keys(JSON.parse(lines[0])).sort(), ["from", "id", "ms", "ok", "source", "status", "to", "transport", "ts", "type"]);
});
