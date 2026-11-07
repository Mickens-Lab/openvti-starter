// The whole poll life, offline, against the in-process mock: a manager creates a poll, three members vote (one changes
// their mind), the manager closes it early and everyone reads the result.
//   npm run demo -w @buildathon/polls
import { PollsClient, describePollError, formatSummary, pollManifest, summarize } from "@buildathon/polls-client";
import { startPollsMock } from "@buildathon/polls-client/mock";
import { VtaClient, newIdentity } from "@buildathon/vta-client";
import { VtcClient } from "@buildathon/vtc-client";

const admin = newIdentity();
const mock = await startPollsMock({ managers: [admin.did] });
try {
  const manager = new PollsClient({ vtc: await VtcClient.connect(mock.vtcUrl, admin) });
  const m = pollManifest({ community: mock.vtcDid, ballotBox: mock.boxDid, question: "Where should the team lunch be?", options: ["Pizza", "Sushi", "Salad"], durationMinutes: 60 });
  const created = await manager.create(m);
  console.log(`1. created    ${created.electionId} (${created.state}), closes ${m.votingClosesAt}`);

  const member = async (n: number) => {
    const vta = await VtaClient.connect(mock.vtaUrl, newIdentity());
    await vta.authenticate();
    return new PollsClient({ vtc: await VtcClient.connect(mock.vtcUrl, newIdentity()), vta, contextId: `member-${n}`, member: vta.me.did, castDelayMs: 0 });
  };
  const [ada, bob, cy] = [await member(1), await member(2), await member(3)];
  console.log(`2. listed     ${(await ada.list()).elections.map((e) => `${e.electionId} [${e.state}]`).join(", ")}`);
  for (const [who, c, pick] of [["ada", ada, "Sushi"], ["bob", bob, "pizza"], ["cy", cy, "3"], ["ada", ada, "Pizza"]] as const) {
    const v = await c.vote(created.electionId, [pick]);
    console.log(`3. ${who.padEnd(4)} voted ${pick.padEnd(6)} -> ${v.outcome}${v.ticketTaken ? " (ticket taken)" : ""}`);
  }
  try { await ada.results(created.electionId); } catch (e) { console.log(`4. too early  ${describePollError(e)}`); }
  await manager.close(created.electionId, "decided");
  console.log("5. closed early by the manager");
  const r = await bob.results(created.electionId);
  console.log("6. result\n" + formatSummary(summarize(r, m)));
} finally {
  await mock.close();
}
