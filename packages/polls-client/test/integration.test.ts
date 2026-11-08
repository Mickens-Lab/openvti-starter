// The whole poll life over real HTTP against the in-process mock (src/mock.ts): VtcClient, VtaClient (authenticated)
// and the ballot box resolved from its did:webvh. The mock applies the rules, not the crypto.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { VtaClient, newIdentity } from "@starter/vta-client";
import { VtcClient } from "@starter/vtc-client";
import { PollsClient, pollManifest, pollRefusal, summarize, type Manifest } from "../src/index.js";
import { startPollsMock, type PollsMock } from "../src/mock.js";

let clock = new Date("2026-11-07T10:00:00Z");
const admin = newIdentity();
const stranger = newIdentity();
let mock: PollsMock;

before(async () => { mock = await startPollsMock({ managers: [admin.did], now: () => clock }); });
after(async () => { await mock.close(); });

const managerClient = async () => new PollsClient({ vtc: await VtcClient.connect(mock.vtcUrl, admin), castDelayMs: 0 });
async function voter(n: number) {
  const vta = await VtaClient.connect(mock.vtaUrl, newIdentity());
  await vta.authenticate();
  return new PollsClient({ vtc: await VtcClient.connect(mock.vtcUrl, newIdentity()), vta, contextId: `ctx-${n}`, member: `did:key:fake-member-${n}`, castDelayMs: 0 });
}
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return pollRefusal(e)?.code ?? (e as Error).message; } return "ok"; };
const poll = (patch: Partial<Parameters<typeof pollManifest>[0]> = {}): Manifest =>
  pollManifest({ community: mock.vtcDid, ballotBox: mock.boxDid, question: "Team lunch?", options: ["Pizza", "Sushi", "Salad"], durationMinutes: 60, now: clock, ...patch });

test("create, list, show, two members vote, revote replaces, results only after close", async () => {
  const mgr = await managerClient();
  const created = await mgr.create(poll({ electionId: "lunch" }));
  assert.equal(created.state, "registered");
  assert.equal(await code(mgr.create(poll({ electionId: "lunch" }))), "electionExists");

  const [ada, bob] = [await voter(1), await voter(2)];
  const listed = await ada.list();
  assert.deepEqual(listed.elections.map((e) => [e.electionId, e.state, e.ticketHeld]), [["lunch", "voting", false]]);
  const shown = await ada.show("lunch");
  assert.equal(shown.manifest.questions[0].type, "choice");

  const v1 = await ada.vote("lunch", ["Sushi"]);
  assert.deepEqual([v1.outcome, v1.ticketTaken, v1.kept], ["counted", true, "included"]);
  assert.equal((await ada.list()).elections[0].ticketHeld, true);
  const v2 = await ada.vote("lunch", ["pizza"]); // change of mind: same tag, replaced, no second ticket
  assert.deepEqual([v2.outcome, v2.ticketTaken, v2.tag], ["replaced", false, v1.tag]);
  assert.equal((await bob.vote("lunch", ["1"])).outcome, "counted");

  assert.equal(await code(ada.results("lunch")), "notTallied");
  await mgr.close("lunch", "lunch is at noon");
  const r = await ada.results("lunch");
  assert.equal(r.provisional, false);
  const s = summarize(r, shown.manifest);
  assert.equal(s.ballots, 2);
  assert.deepEqual(s.questions[0].options.map((o) => [o.key, o.votes]), [["pizza", 2], ["sushi", 0], ["salad", 0]]);

  assert.equal(await code(bob.vote("lunch", ["salad"])), "the poll is tallied; it takes no more votes");
  assert.equal(await code(mgr.close("lunch")), "notOpen");
});

test("revote refuse, multiple choice, running totals, early close refused, deadline closes", async () => {
  const mgr = await managerClient();
  await mgr.create(poll({ electionId: "days", options: ["Mon", "Tue", "Wed"], multiple: true, maxSelections: 2, revote: "refuse", resultsBeforeClose: true, allowEarlyClose: false }));
  const ada = await voter(3);
  assert.equal((await ada.vote("days", ["mon", "wed"])).outcome, "counted");
  assert.equal(await code(ada.vote("days", ["tue"])), "alreadyVoted");
  assert.equal(await code(ada.vote("days", ["mon", "tue", "wed"])), "the ballot is not valid: choose at most 2 in \"q1\"");
  const live = await ada.results("days");
  assert.equal(live.provisional, true);
  assert.deepEqual(live.result.questions[0].choice, { mon: 1, tue: 0, wed: 1 });
  assert.equal(await code(mgr.close("days")), "earlyCloseNotAllowed");
  clock = new Date(clock.getTime() + 61 * 60_000); // past the deadline
  try {
    assert.equal((await ada.results("days")).provisional, false);
    assert.equal((await ada.show("days")).state, "tallied");
    const late = await voter(4);
    assert.equal(await code(late.vote("days", ["mon"], { shown: { ...(await late.show("days")), state: "voting" } })), "notOpen"); // ticket window shut
  } finally {
    clock = new Date("2026-11-07T10:00:00Z");
  }
});

test("upcoming polls take tickets but not casts; cancel; permissions; private board", async () => {
  const mgr = await managerClient();
  await mgr.create(poll({ electionId: "later", opensAt: new Date(clock.getTime() + 3_600_000) }));
  const ada = await voter(5);
  const shown = await ada.show("later");
  assert.equal(shown.state, "registration");
  assert.equal(await ada.takeTicket(shown), true);
  assert.equal(await ada.takeTicket(shown), false);
  assert.equal(await code(ada.vote("later", ["pizza"])), "notOpen");
  assert.equal((await mgr.cancel("later", "wrong date")).state, "cancelled");
  assert.equal(await code(ada.results("later")), "electionUnknown");

  const nobody = new PollsClient({ vtc: await VtcClient.connect(mock.vtcUrl, stranger) });
  assert.equal(await code(nobody.create(poll({ electionId: "x" }))), "permissionDenied");
  assert.equal(await code(nobody.close("lunch")), "permissionDenied");
  assert.equal(await code(mgr.create(poll({ electionId: "y", ballotBox: "did:webvh:Qmfake:elsewhere" }))), "ballotBoxNotTrusted");
  assert.equal(await code(ada.show("nope")), "electionUnknown");

  await mgr.create(poll({ electionId: "secret", visibility: "private", resultsBeforeClose: true }));
  assert.equal(await code(nobody.results("secret", { ballotBox: mock.boxDid })), "permissionDenied");
  assert.equal((await mgr.results("secret")).provisional, true);
});

test("listed roll: only the listed member sees and can vote", async () => {
  const mgr = await managerClient();
  await mgr.create(poll({ electionId: "board", roll: { rule: "listed", listed: ["did:key:fake-member-7"] } }));
  const listed = await voter(7), other = await voter(8);
  assert.equal((await listed.vote("board", ["salad"])).outcome, "counted");
  assert.equal(await code(other.show("board")), "electionUnknown");
  assert.ok(!(await other.list()).elections.some((e) => e.electionId === "board"));
});
