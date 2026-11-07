import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs, parseDuration, pollInputFrom } from "../src/args.js";

test("parseArgs: repeated --option, --flag=value, booleans, positionals", () => {
  const p = parseArgs(["create", "--question", "Lunch?", "--option", "A", "--option=B", "--multiple", "--closes", "2h", "extra"]);
  assert.equal(p.cmd, "create");
  assert.deepEqual(p.options, ["A", "B"]);
  assert.deepEqual(p.flags, { question: "Lunch?", multiple: true, closes: "2h" });
  assert.deepEqual(p.rest, ["extra"]);
  assert.throws(() => parseArgs(["create", "--question"]), /needs a value/);
  assert.equal(parseArgs([]).cmd, "help");
});

test("parseDuration", () => {
  assert.equal(parseDuration("90m"), 90);
  assert.equal(parseDuration("2h"), 120);
  assert.equal(parseDuration("3d"), 4320);
  assert.equal(parseDuration("15"), 15);
  assert.throws(() => parseDuration("soon"), /not a duration/);
});

test("pollInputFrom maps flags to poll settings", () => {
  const i = pollInputFrom(parseArgs(["create", "--question", "Q", "--option", "A", "--option", "B", "--max", "2", "--closes", "90m", "--refuse-revote", "--private", "--live-results", "--no-early-close", "--required", "--id", "q-1"]), "did:c", "did:b");
  assert.deepEqual(i, { community: "did:c", ballotBox: "did:b", question: "Q", options: ["A", "B"], multiple: true, maxSelections: 2, optional: false, electionId: "q-1", durationMinutes: 90, revote: "refuse", visibility: "private", resultsBeforeClose: true, allowEarlyClose: false });
  const t = pollInputFrom(parseArgs(["create", "--question", "Q", "--closes", "2026-11-08T12:00:00Z"]), "c", "b");
  assert.equal(t.closesAt?.toISOString(), "2026-11-08T12:00:00.000Z");
  assert.throws(() => pollInputFrom(parseArgs(["create", "--opens", "whenever", "--question", "Q"]), "c", "b"), /not a date/);
  assert.throws(() => pollInputFrom(parseArgs(["create"]), "c", "b"), /needs --question/);
});
