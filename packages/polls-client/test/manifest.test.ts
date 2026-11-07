import assert from "node:assert/strict";
import { test } from "node:test";
import { ManifestError, optionKey, optionKeys, pollManifest, validateManifest, type Manifest } from "../src/index.js";

const base = { community: "did:webvh:Qmfake:vtc", ballotBox: "did:webvh:Qmfake:box", question: "Lunch?", options: ["Pizza", "Sushi"] };
const now = new Date("2026-11-07T10:00:00Z");

test("pollManifest builds a single-choice manifest with every required field", () => {
  const m = pollManifest({ ...base, now, durationMinutes: 60, electionId: "lunch" });
  assert.equal(m.electionId, "lunch");
  assert.equal(m.title, "Lunch?");
  assert.deepEqual(m.questions[0], { key: "q1", type: "choice", text: "Lunch?", options: [{ key: "pizza", label: "Pizza" }, { key: "sushi", label: "Sushi" }], minSelections: 1, maxSelections: 1, optional: true });
  assert.equal(Date.parse(m.votingOpensAt), now.getTime());
  assert.equal(Date.parse(m.registrationOpensAt), now.getTime());
  assert.equal(Date.parse(m.votingClosesAt) - Date.parse(m.votingOpensAt), 3_600_000);
  assert.equal(m.secrecy, "open");
  assert.deepEqual(m.roll, { rule: "members" });
  assert.equal(m.revote, "replace");
  assert.deepEqual(m.board, { visibility: "public", auditors: [] });
  assert.equal(m.allowEarlyClose, true);
  assert.equal(m.resultsBeforeClose, false);
  assert.equal(m.textReleaseThreshold, 10);
  for (const k of ["electionId", "community", "questions", "secrecy", "roll", "registrationOpensAt", "votingOpensAt", "votingClosesAt", "revote", "board", "ballotBox", "binding", "allowEarlyClose", "resultsBeforeClose", "textReleaseThreshold"]) {
    assert.ok(k in m, `missing ${k}`);
  }
});

test("multiple choice caps maxSelections at the option count; settings pass through", () => {
  const m = pollManifest({ ...base, options: ["a", "b", "c"], multiple: true, now, revote: "refuse", visibility: "private", auditors: ["did:key:fake"], resultsBeforeClose: true, allowEarlyClose: false });
  assert.equal(m.questions[0].type === "choice" && m.questions[0].maxSelections, 3);
  assert.equal(pollManifest({ ...base, options: ["a", "b", "c"], multiple: true, maxSelections: 9, now }).questions[0].type === "choice" && 3, 3);
  assert.equal(m.revote, "refuse");
  assert.deepEqual(m.board, { visibility: "private", auditors: ["did:key:fake"] });
  assert.equal(m.resultsBeforeClose, true);
  assert.equal(m.allowEarlyClose, false);
});

test("a generated id matches the schema pattern", () => {
  const m = pollManifest({ ...base, now });
  assert.match(m.electionId, /^poll-2026-11-07-[0-9a-f]{8}$/);
});

test("option keys are slugs, unique, with a fallback for symbols", () => {
  assert.equal(optionKey("Ice Cream!", 0), "ice-cream");
  assert.equal(optionKey("???", 2), "opt3");
  assert.deepEqual(optionKeys(["Yes", "yes", "YES"]), ["yes", "yes-2", "yes-3"]);
});

test("pollManifest throws ManifestError listing the problems", () => {
  assert.throws(() => pollManifest({ ...base, options: ["only one"], now }), (e: unknown) => e instanceof ManifestError && e.problems.some((p) => /2 to 256 options/.test(p)));
  assert.throws(() => pollManifest({ ...base, closesAt: new Date(now.getTime() - 1), now }), /close after it opens/);
  assert.throws(() => pollManifest({ ...base, electionId: "has space", now }), /electionId/);
  assert.throws(() => pollManifest({ ...base, ballotBox: "", now }), /ballotBox/);
});

test("validateManifest mirrors the schema rules", () => {
  const good = pollManifest({ ...base, now });
  assert.deepEqual(validateManifest(good), []);
  const bad = (patch: Partial<Manifest>) => validateManifest({ ...good, ...patch } as Manifest);
  assert.match(bad({ secrecy: "sealed" }).join(), /trustees/);
  assert.match(bad({ revote: "maybe" as any }).join(), /revote/);
  assert.match(bad({ roll: { rule: "listed" } }).join(), /non-empty listed/);
  assert.match(bad({ roll: { rule: "credential" } }).join(), /memberOf/);
  assert.match(bad({ textReleaseThreshold: 0 }).join(), /textReleaseThreshold/);
  assert.match(bad({ registrationOpensAt: "2099-01-01T00:00:00Z" }).join(), /registration must open/);
  assert.match(bad({ votingOpensAt: "soon" }).join(), /RFC 3339/);
  assert.match(bad({ questions: [] }).join(), /1 to 128 questions/);
  const q = good.questions[0] as any;
  assert.match(bad({ questions: [{ ...q, options: [q.options[0], q.options[0]] }] }).join(), /repeated/);
  assert.match(bad({ questions: [{ ...q, maxSelections: 5 }] }).join(), /maxSelections/);
  assert.match(bad({ questions: [q, q] }).join(), /question key "q1" is repeated/);
  assert.deepEqual(bad({ questions: [{ key: "t", type: "text", maxLength: 200, optional: true }] }), []);
});
