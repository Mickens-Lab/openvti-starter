// A ballot (vta/pcs/vote/0.4 `$defs/Ballot`): `{ electionId, manifestDigest, answers[{ question, choice[] | abstain }] }`.
// Only `choice` questions are built here; the VTA and the ballot box check the ballot again against the manifest.
import type { Manifest } from "./manifest.js";

export interface Answer {
  question: string;
  choice?: string[];
  ranking?: string[];
  scores?: Record<string, number>;
  text?: string;
  abstain?: true;
}
export interface Ballot { electionId: string; manifestDigest: string; answers: Answer[] }

/** Per question key: the option keys chosen, or `"abstain"`. A question left out is abstained (if optional). */
export type Selections = Record<string, string[] | "abstain">;

export class BallotError extends Error {
  constructor(readonly problems: string[]) {
    super(`the ballot is not valid: ${problems.join("; ")}`);
    this.name = "BallotError";
  }
}

/** Accept option keys, labels (case-insensitive) or 1-based numbers, and return option keys. */
export function resolveOptions(m: Manifest, questionKey: string, picks: string[]): string[] {
  const q = m.questions.find((x) => x.key === questionKey);
  if (!q || q.type === "text") return picks;
  return picks.map((p) => {
    const byKey = q.options.find((o) => o.key === p);
    if (byKey) return byKey.key;
    const byLabel = q.options.find((o) => o.label?.toLowerCase() === p.toLowerCase());
    if (byLabel) return byLabel.key;
    const n = /^\d+$/.test(p) ? Number(p) : NaN;
    return n >= 1 && n <= q.options.length ? q.options[n - 1].key : p;
  });
}

/** Problems with `sel` for this manifest; empty when the ballot is fine. */
export function validateSelections(m: Manifest, sel: Selections): string[] {
  const out: string[] = [];
  for (const k of Object.keys(sel)) if (!m.questions.some((q) => q.key === k)) out.push(`no question "${k}" in this poll`);
  for (const q of m.questions) {
    const s = sel[q.key];
    if (s === undefined || s === "abstain") {
      if (!q.optional) out.push(`question "${q.key}" needs an answer`);
      continue;
    }
    if (q.type !== "choice") { out.push(`question "${q.key}" is a ${q.type} question; only choice questions are built by this client`); continue; }
    const known = new Set(q.options.map((o) => o.key));
    for (const c of s) if (!known.has(c)) out.push(`"${c}" is not an option of "${q.key}" (options: ${q.options.map((o) => o.key).join(", ")})`);
    if (new Set(s).size !== s.length) out.push(`an option is chosen twice in "${q.key}"`);
    if (s.length < q.minSelections) out.push(`choose at least ${q.minSelections} in "${q.key}"`);
    if (s.length > q.maxSelections) out.push(q.maxSelections === 1 ? `choose only one option in "${q.key}"` : `choose at most ${q.maxSelections} in "${q.key}"`);
  }
  return out;
}

/** The ballot for `sel`, in the manifest's question order. Throws {@link BallotError}. */
export function buildBallot(m: Manifest, manifestDigest: string, sel: Selections): Ballot {
  const problems = validateSelections(m, sel);
  if (problems.length) throw new BallotError(problems);
  return {
    electionId: m.electionId,
    manifestDigest,
    answers: m.questions.map((q) => {
      const s = sel[q.key];
      return s === undefined || s === "abstain" ? { question: q.key, abstain: true as const } : { question: q.key, choice: [...s] };
    }),
  };
}
