// Phase of a poll (from its times and the registrar's state) and a readable summary of a result
// (voting/result/show/0.1 -> `{ result: ElectionResult, provisional, state }`).
import type { Manifest } from "./manifest.js";

/** The registrar's states (`vtc/elections/list/0.5` `$defs/RegistrarState`). */
export type PollState = "registered" | "registration" | "voting" | "closed" | "tallied" | "cancelled" | "pendingRegistration" | "registrationRefused";

export type Phase = "upcoming" | "open" | "closed" | "cancelled" | "failed";

/** What a member can do now. The registrar's state wins over the clock (an early close, a cancellation). */
export function pollPhase(m: Pick<Manifest, "votingOpensAt" | "votingClosesAt">, state: string | undefined, now: Date = new Date()): Phase {
  if (state === "cancelled") return "cancelled";
  if (state === "registrationRefused") return "failed";
  if (state === "closed" || state === "tallied") return "closed";
  const t = now.getTime();
  if (t >= Date.parse(m.votingClosesAt)) return "closed";
  if (t < Date.parse(m.votingOpensAt)) return "upcoming";
  return "open";
}

/** "3d 4h", "12m", "40s": time from `now` to `at`, or undefined once past. */
export function timeLeft(at: string, now: Date = new Date()): string | undefined {
  let s = Math.floor((Date.parse(at) - now.getTime()) / 1000);
  if (!(s > 0)) return undefined;
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  if (d) return h ? `${d}d ${h}h` : `${d}d`;
  if (h) return m ? `${h}h ${m}m` : `${h}h`;
  return m ? `${m}m` : `${s}s`;
}

export interface QuestionResult {
  question: string;
  abstained: number;
  choice?: Record<string, number>;
  ranking?: Record<string, number[]>;
  score?: Record<string, { sum: number; count: number }>;
  text?: string[];
  withheld?: boolean;
}
export interface ElectionResult { electionId: string; manifestDigest: string; ballotsCounted: number; head?: unknown; questions: QuestionResult[] }
export interface ResultReply { result: ElectionResult; provisional: boolean; state: string }

export interface OptionLine { key: string; label: string; votes: number; percent: number; leading: boolean }
export interface QuestionSummary { question: string; text?: string; abstained: number; options: OptionLine[]; withheld: boolean }
export interface ResultSummary { electionId: string; ballots: number; provisional: boolean; questions: QuestionSummary[] }

/**
 * Counts per option with percentages of the ballots that answered (abstentions excluded) and the leaders (ties all
 * lead; nobody leads with zero votes). Options with no votes are listed too, in manifest order.
 */
export function summarize(r: ResultReply, m?: Manifest): ResultSummary {
  return {
    electionId: r.result.electionId,
    ballots: r.result.ballotsCounted,
    provisional: r.provisional,
    questions: r.result.questions.map((qr) => {
      const q = m?.questions.find((x) => x.key === qr.question);
      const opts = q && q.type !== "text" ? q.options : Object.keys(qr.choice ?? {}).map((key) => ({ key, label: key }));
      const counts = qr.choice ?? {};
      const answered = Math.max(0, r.result.ballotsCounted - qr.abstained);
      const top = Math.max(0, ...Object.values(counts));
      return {
        question: qr.question,
        ...(q?.text ? { text: q.text } : {}),
        abstained: qr.abstained,
        withheld: qr.withheld === true,
        options: opts.map((o) => {
          const votes = counts[o.key] ?? 0;
          return { key: o.key, label: o.label ?? o.key, votes, percent: answered ? Math.round((votes / answered) * 1000) / 10 : 0, leading: top > 0 && votes === top };
        }),
      };
    }),
  };
}

/** Plain-text bars for a terminal. */
export function formatSummary(s: ResultSummary, width = 20): string {
  const lines = [`${s.electionId}: ${s.ballots} ballot${s.ballots === 1 ? "" : "s"}${s.provisional ? " (provisional, voting still open)" : ""}`];
  for (const q of s.questions) {
    lines.push(`  ${q.text ?? q.question}${q.abstained ? `  (${q.abstained} abstained)` : ""}`);
    if (q.withheld) { lines.push("    withheld until enough ballots are counted"); continue; }
    for (const o of q.options) {
      const bar = "#".repeat(Math.round((o.percent / 100) * width)).padEnd(width, ".");
      lines.push(`    ${o.leading ? "*" : " "} ${o.label.padEnd(16)} ${bar} ${String(o.votes).padStart(3)}  ${o.percent}%`);
    }
  }
  return lines.join("\n");
}
