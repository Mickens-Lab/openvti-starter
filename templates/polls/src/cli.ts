// Polls from the command line: create a poll at the community, list and show polls, vote through your VTA, read the result.
//   npm start -w @buildathon/polls -- help
// Reads .env (VTC_URL, VTA_URL, VTA_CREDENTIAL, VTA_CONTEXT, APP_DID) like hello-node. Poll settings: POLL_MEMBER_DID,
// BALLOT_BOX_URL, POLL_BALLOT_BOX (the ballot box DID for create). `--admin` (or POLL_ADMIN=1) signs community calls with
// the kit's admin key (.vta/admin.json), which holds vtc.elections.manage.
// The kit's pinned VTC does not serve elections; try it offline first: `npm run mock -w @buildathon/polls` (see README).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PollsClient, describePollError, formatSummary, pollManifest, pollPhase, pollRefusal, summarize, timeLeft } from "@buildathon/polls-client";
import { VtaClient, identityFromSeed, newIdentity, seedFromMultibase, type Identity } from "@buildathon/vta-client";
import { VtcClient } from "@buildathon/vtc-client";
import { parseArgs, pollInputFrom } from "./args.js";
import { loadEnv } from "./env.js";

const HELP = `polls <command>
  create --question "..." --option A --option B [--multiple | --max N] [--required]
         [--closes 2h | 2026-11-08T12:00:00Z] [--opens <time>] [--id ID] [--title T]
         [--refuse-revote] [--private] [--live-results] [--no-early-close] [--ballot-box DID]
  list                       polls you can see (state, deadline)
  show <id>                  the question, options and settings
  vote <id> <option...>      option keys, labels or numbers; "abstain" for a blank ballot
  ticket <id>                take your voting ticket now, vote later (harder to pair the two)
  results <id>               counts and percentages (after close, or live with --live-results)
  close <id> [reason]        close early (manager)       cancel <id> <reason>   (manager)
  boxes                      ballot boxes the community trusts (manager)
flags: --admin  sign community calls with .vta/admin.json   --json  raw replies`;

function findUp(name: string, from = process.cwd()): string | undefined {
  for (let d = from; ; d = dirname(d)) {
    if (existsSync(join(d, name))) return join(d, name);
    if (dirname(d) === d) return undefined;
  }
}

async function main() {
  const p = parseArgs(process.argv.slice(2));
  if (p.cmd === "help" || p.flags.help) return console.log(HELP);
  const env = loadEnv();
  const vtcUrl = env.VTC_URL ?? "http://localhost:8200";
  const vtaUrl = env.VTA_URL ?? "http://localhost:8100";
  let vta: VtaClient | undefined;
  let app: Identity;
  if (env.VTA_CREDENTIAL) {
    vta = await VtaClient.fromCredential(env.VTA_CREDENTIAL, vtaUrl);
    app = vta.me;
  } else {
    console.error("(no VTA_CREDENTIAL: using a throwaway identity, which only the mock accepts)");
    app = newIdentity();
    vta = await VtaClient.connect(vtaUrl, app).catch(() => undefined);
  }
  let signer = app;
  if (p.flags.admin || env.POLL_ADMIN === "1") {
    const f = findUp(".vta/admin.json");
    if (!f) throw new Error(".vta/admin.json not found: run `npm run up` at the repo root (it writes the admin key)");
    signer = identityFromSeed(seedFromMultibase(JSON.parse(readFileSync(f, "utf8")).privateKeyMultibase));
  }
  const vtc = await VtcClient.connect(vtcUrl, signer, undefined, env.VTC_DID || undefined);
  const voting = ["vote", "ticket"].includes(p.cmd) || (["list", "show"].includes(p.cmd) && !p.flags.admin);
  if (vta && voting) await vta.authenticate();
  const polls = new PollsClient({
    vtc, vta: voting ? vta : undefined,
    contextId: env.VTA_CONTEXT || "my-app",
    member: env.POLL_MEMBER_DID || env.APP_DID || app.did,
    ...(env.BALLOT_BOX_URL ? { ballotBoxUrl: env.BALLOT_BOX_URL } : {}),
    ...(env.POLL_CAST_DELAY_MS ? { castDelayMs: Number(env.POLL_CAST_DELAY_MS) } : {}),
  });
  const out = (v: unknown, text: () => string) => console.log(p.flags.json ? JSON.stringify(v, null, 2) : text());
  const id = () => p.rest[0] ?? (() => { throw new Error(`${p.cmd} needs a poll id (see \`list\`)`); })();

  switch (p.cmd) {
    case "create": {
      const box = typeof p.flags["ballot-box"] === "string" ? p.flags["ballot-box"] : env.POLL_BALLOT_BOX;
      if (!box) throw new Error("create needs the ballot box DID: --ballot-box DID or POLL_BALLOT_BOX (`boxes` lists the trusted ones)");
      const m = pollManifest(pollInputFrom(p, vtc.vtcDid, box));
      const r = await polls.create(m);
      return out(r, () => `created ${r.electionId} (${r.state}); voting ${m.votingOpensAt} to ${m.votingClosesAt}`);
    }
    case "list": {
      const r = await polls.list();
      return out(r, () => r.elections.length
        ? r.elections.map((e) => `${e.electionId.padEnd(28)} ${pollPhase(e, e.state).padEnd(9)} ${e.ticketHeld ? "ticket " : "       "}${timeLeft(e.votingClosesAt) ? `closes in ${timeLeft(e.votingClosesAt)}` : `closed ${e.votingClosesAt}`}  ${e.title ?? ""}`).join("\n")
        : "no polls you can see");
    }
    case "show": {
      const s = await polls.show(id());
      const m = s.manifest;
      return out(s, () => [
        `${m.title ?? m.electionId}  [${pollPhase(m, s.state)}, state ${s.state}]`,
        ...m.questions.map((q) => q.type === "choice"
          ? `  ${q.text ?? q.key} (choose ${q.minSelections === q.maxSelections ? q.maxSelections : `${q.minSelections}-${q.maxSelections}`}${q.optional ? ", or abstain" : ""})\n${q.options.map((o, i) => `    ${i + 1}. ${o.label ?? o.key}  [${o.key}]`).join("\n")}`
          : `  ${q.text ?? q.key} (${q.type})`),
        `  voting ${m.votingOpensAt} to ${m.votingClosesAt}; revote ${m.revote}; board ${m.board.visibility}; results ${m.resultsBeforeClose ? "live" : "after close"}`,
      ].join("\n"));
    }
    case "vote": {
      const picks = p.rest.slice(1);
      if (!picks.length) throw new Error("vote needs at least one option (or abstain)");
      const r = await polls.vote(id(), picks.length === 1 && picks[0] === "abstain" ? {} : picks);
      return out(r, () => `${r.outcome} (receipt leaf ${r.receipt.leafIndex}${r.kept ? `, ${r.kept} at your VTA` : ""})`);
    }
    case "ticket": {
      const took = await polls.takeTicket(await polls.show(id()));
      return console.log(took ? "ticket taken; vote any time while the poll is open" : "your VTA already holds a ticket for this poll");
    }
    case "results": {
      const s = await polls.show(id()).catch(() => undefined);
      try {
        const r = await polls.results(id(), s ? { shown: s } : {});
        return out(r, () => formatSummary(summarize(r, s?.manifest)));
      } catch (e) {
        if (pollRefusal(e)?.code !== "notTallied") throw e;
        return console.log(`no result yet${s ? `: voting closes in ${timeLeft(s.manifest.votingClosesAt) ?? "a moment"}` : ""}`);
      }
    }
    case "close": return out(await polls.close(id(), p.rest.slice(1).join(" ") || undefined), () => "closed; the ballot box is counting");
    case "cancel": return out(await polls.cancel(id(), p.rest.slice(1).join(" ")), () => "cancelled");
    case "boxes": {
      const r = await polls.ballotBoxes();
      return out(r, () => r.ballotBoxes.map((b) => `${b.did}${b.operator ? `  (operator ${b.operator})` : ""}`).join("\n") || "the community trusts no ballot box");
    }
    default:
      console.log(HELP);
      process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(describePollError(e));
  process.exitCode = 1;
});
