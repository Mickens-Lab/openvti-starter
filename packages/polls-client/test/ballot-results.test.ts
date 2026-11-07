import assert from "node:assert/strict";
import { test } from "node:test";
import { TrustTaskError } from "@buildathon/vta-client";
import {
  BallotError, buildBallot, describePollError, explainPollRefusal, formatSummary, pollManifest, pollPhase, pollRefusal, resolveOptions, splitCode, summarize, timeLeft,
} from "../src/index.js";

const now = new Date("2026-11-07T10:00:00Z");
const single = pollManifest({ community: "did:x:c", ballotBox: "did:x:b", question: "Lunch?", options: ["Pizza", "Sushi", "Salad"], now, electionId: "p1", optional: false });
const multi = pollManifest({ community: "did:x:c", ballotBox: "did:x:b", question: "Which days?", options: ["Mon", "Tue", "Wed"], multiple: true, maxSelections: 2, now, electionId: "p2" });

test("buildBallot: one choice, in manifest order, carrying the digest", () => {
  assert.deepEqual(buildBallot(single, "udigest", { q1: ["sushi"] }), { electionId: "p1", manifestDigest: "udigest", answers: [{ question: "q1", choice: ["sushi"] }] });
  assert.deepEqual(buildBallot(multi, "u", {}).answers, [{ question: "q1", abstain: true }]);
  assert.deepEqual(buildBallot(multi, "u", { q1: "abstain" }).answers, [{ question: "q1", abstain: true }]);
});

test("buildBallot refuses bad selections with every problem", () => {
  const bad = (m: typeof single, s: any, re: RegExp) => assert.throws(() => buildBallot(m, "u", s), (e: unknown) => e instanceof BallotError && re.test(e.message));
  bad(single, { q1: ["pizza", "sushi"] }, /only one/);
  bad(single, { q1: [] }, /at least 1/);
  bad(single, { q1: ["tacos"] }, /not an option/);
  bad(single, {}, /needs an answer/); // not optional
  bad(multi, { q1: ["mon", "tue", "wed"] }, /at most 2/);
  bad(multi, { q1: ["mon", "mon"] }, /chosen twice/);
  bad(multi, { q9: ["mon"] }, /no question "q9"/);
});

test("resolveOptions accepts keys, labels and 1-based numbers", () => {
  assert.deepEqual(resolveOptions(single, "q1", ["pizza", "SUSHI", "3", "9", "x"]), ["pizza", "sushi", "salad", "9", "x"]);
});

test("pollPhase: state wins over the clock", () => {
  const w = { votingOpensAt: "2026-11-07T10:00:00Z", votingClosesAt: "2026-11-07T11:00:00Z" };
  assert.equal(pollPhase(w, "registration", new Date("2026-11-07T09:00:00Z")), "upcoming");
  assert.equal(pollPhase(w, "voting", new Date("2026-11-07T10:30:00Z")), "open");
  assert.equal(pollPhase(w, "voting", new Date("2026-11-07T11:00:00Z")), "closed"); // deadline reached
  assert.equal(pollPhase(w, "closed", new Date("2026-11-07T10:30:00Z")), "closed"); // closed early
  assert.equal(pollPhase(w, "cancelled", new Date("2026-11-07T10:30:00Z")), "cancelled");
  assert.equal(pollPhase(w, "registrationRefused"), "failed");
});

test("timeLeft", () => {
  assert.equal(timeLeft("2026-11-10T14:00:00Z", now), "3d 4h");
  assert.equal(timeLeft("2026-11-07T10:12:00Z", now), "12m");
  assert.equal(timeLeft("2026-11-07T10:00:40Z", now), "40s");
  assert.equal(timeLeft("2026-11-07T09:00:00Z", now), undefined);
});

test("summarize: percentages over answered ballots, ties lead, zero-vote options listed", () => {
  const s = summarize({ provisional: false, state: "tallied", result: { electionId: "p1", manifestDigest: "u", ballotsCounted: 5, questions: [{ question: "q1", abstained: 1, choice: { pizza: 2, sushi: 2 } }] } }, single);
  assert.equal(s.ballots, 5);
  assert.deepEqual(s.questions[0].options.map((o) => [o.key, o.label, o.votes, o.percent, o.leading]), [["pizza", "Pizza", 2, 50, true], ["sushi", "Sushi", 2, 50, true], ["salad", "Salad", 0, 0, false]]);
  assert.match(formatSummary(s), /\* Pizza/);
  const empty = summarize({ provisional: true, state: "voting", result: { electionId: "p1", manifestDigest: "u", ballotsCounted: 0, questions: [{ question: "q1", abstained: 0, choice: {} }] } }, single);
  assert.ok(empty.questions[0].options.every((o) => !o.leading && o.percent === 0));
  assert.match(formatSummary(empty), /provisional/);
  const withheld = summarize({ provisional: false, state: "tallied", result: { electionId: "p1", manifestDigest: "u", ballotsCounted: 1, questions: [{ question: "q1", abstained: 0, withheld: true }] } });
  assert.match(formatSummary(withheld), /withheld/);
});

test("refusals: slug-scoped codes are split; framework codes kept; plain words", () => {
  assert.deepEqual(splitCode("vtc/elections/create:invalidManifest"), { code: "invalidManifest", slug: "vtc/elections/create" });
  assert.deepEqual(splitCode("permissionDenied"), { code: "permissionDenied" });
  const err = new TrustTaskError(422, { type: "https://trusttasks.org/spec/trust-task-error/0.5", payload: { code: "voting/ballot/cast:alreadyVoted", message: "x" } });
  assert.equal(pollRefusal(err)?.code, "alreadyVoted");
  assert.match(describePollError(err), /already voted/);
  const inv = new TrustTaskError(422, { payload: { code: "vtc/elections/create:invalidManifest", details: { reason: "bad times" } } });
  assert.match(describePollError(inv), /invalid\. \(bad times\)/);
  assert.equal(pollRefusal(new TypeError("fetch failed"))?.code, "network");
  assert.equal(pollRefusal(new Error("local")), undefined);
  assert.match(explainPollRefusal({ code: "somethingNew", message: "detail" }), /Refused \(somethingNew\)\. detail/);
  assert.match(describePollError(new TrustTaskError(429, { error: "rateLimited" })), /Rate limited/);
});
