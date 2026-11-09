// The election manifest (vtc/elections/create/0.5 `$defs/Manifest`) and a friendlier builder for the common case:
// one choice question, single or multiple selection, a voting window. `validateManifest` mirrors the schema rules a
// client can check before signing, so most `invalidManifest` refusals become a local message instead.
import { rfc3339 } from "@starter/vta-client";

export type Secrecy = "open" | "sealed" | "talliedEncrypted";
export type Revote = "replace" | "refuse";
export type RollRule = { rule: "members" | "membersAndListed" | "listed" | "credential"; listed?: string[]; memberOf?: string };

export interface QuestionOption { key: string; label?: string }
export type Question =
  | { key: string; type: "choice"; text?: string; options: QuestionOption[]; minSelections: number; maxSelections: number; optional: boolean }
  | { key: string; type: "ranking"; text?: string; options: QuestionOption[]; partial: boolean; optional: boolean }
  | { key: string; type: "score"; text?: string; options: QuestionOption[]; min: number; max: number; optional: boolean }
  | { key: string; type: "text"; text?: string; maxLength: number; optional: boolean };

export interface Manifest {
  electionId: string;
  community: string;
  title?: string;
  description?: string;
  questions: Question[];
  secrecy: Secrecy;
  roll: RollRule;
  registrationOpensAt: string;
  votingOpensAt: string;
  votingClosesAt: string;
  revote: Revote;
  board: { visibility: "public" | "private"; auditors: string[] };
  ballotBox: string;
  binding: boolean;
  allowEarlyClose: boolean;
  resultsBeforeClose: boolean;
  textReleaseThreshold: number;
  trustees?: { dids: string[]; threshold: number };
  [k: string]: unknown;
}

const ID = /^[A-Za-z0-9._-]{1,128}$/;
const KEY = /^[A-Za-z0-9._-]{1,64}$/;

/** A key for an option label: lower case, letters/digits/`-`, at most 64 characters; `opt<n>` if nothing is left. */
export function optionKey(label: string, index: number): string {
  const k = label.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return k || `opt${index + 1}`;
}

/** Keys for a list of labels, made unique by suffixing `-2`, `-3` ... */
export function optionKeys(labels: string[]): string[] {
  const seen = new Map<string, number>();
  return labels.map((l, i) => {
    const base = optionKey(l, i);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base.slice(0, 60)}-${n}`;
  });
}

export interface PollInput {
  /** The community's DID (the manifest's `community`). */
  community: string;
  /** The ballot box's DID; `vtc/elections/ballot-boxes/list` names the ones the community trusts. */
  ballotBox: string;
  question: string;
  /** Two to 256 option labels. */
  options: string[];
  /** Allow more than one selection. `maxSelections` caps it (default: every option). */
  multiple?: boolean;
  maxSelections?: number;
  /** Members may hand in a blank ballot. Default true. */
  optional?: boolean;
  electionId?: string;
  title?: string;
  description?: string;
  /** When voting opens (default: now) and closes (default: opens + `durationMinutes`, itself 7 days by default). */
  opensAt?: Date;
  closesAt?: Date;
  durationMinutes?: number;
  /** Tickets can be taken from this time (default: now, or `opensAt` if earlier). */
  registrationOpensAt?: Date;
  /** Default `replace`: a later vote replaces the earlier one. */
  revote?: Revote;
  /** Who reads the board and the result. Default `public`. */
  visibility?: "public" | "private";
  auditors?: string[];
  /** Live running totals while voting is open. Default false. */
  resultsBeforeClose?: boolean;
  /** A manager may close before `votingClosesAt`. Default true (polls are often closed by hand). */
  allowEarlyClose?: boolean;
  /** Who may vote. Default: every member. */
  roll?: RollRule;
  /** A binding election also needs a second manager's consent at create. Default false. */
  binding?: boolean;
  now?: Date;
}

/** A manifest for one choice question. Validates it and throws {@link ManifestError} on the first problems. */
export function pollManifest(p: PollInput): Manifest {
  const now = p.now ?? new Date();
  const opens = p.opensAt ?? now;
  const closes = p.closesAt ?? new Date(opens.getTime() + (p.durationMinutes ?? 7 * 24 * 60) * 60_000);
  const reg = p.registrationOpensAt ?? (opens < now ? opens : now);
  const keys = optionKeys(p.options);
  const max = p.multiple ? Math.min(p.maxSelections ?? p.options.length, p.options.length) : 1;
  const m: Manifest = {
    electionId: p.electionId ?? `poll-${rfc3339(now).slice(0, 10)}-${globalThis.crypto.randomUUID().slice(0, 8)}`,
    community: p.community,
    ...(p.title !== undefined ? { title: p.title } : { title: p.question.slice(0, 200) }),
    ...(p.description !== undefined ? { description: p.description } : {}),
    questions: [{
      key: "q1",
      type: "choice",
      text: p.question,
      options: p.options.map((label, i) => ({ key: keys[i], label })),
      minSelections: 1,
      maxSelections: max,
      optional: p.optional ?? true,
    }],
    secrecy: "open",
    roll: p.roll ?? { rule: "members" },
    registrationOpensAt: rfc3339(reg),
    votingOpensAt: rfc3339(opens),
    votingClosesAt: rfc3339(closes),
    revote: p.revote ?? "replace",
    board: { visibility: p.visibility ?? "public", auditors: p.auditors ?? [] },
    ballotBox: p.ballotBox,
    binding: p.binding ?? false,
    allowEarlyClose: p.allowEarlyClose ?? true,
    resultsBeforeClose: p.resultsBeforeClose ?? false,
    textReleaseThreshold: 10,
  };
  const problems = validateManifest(m);
  if (problems.length) throw new ManifestError(problems);
  return m;
}

export class ManifestError extends Error {
  constructor(readonly problems: string[]) {
    super(`the poll is not valid: ${problems.join("; ")}`);
    this.name = "ManifestError";
  }
}

const time = (s: unknown) => (typeof s === "string" && !Number.isNaN(Date.parse(s)) ? Date.parse(s) : undefined);

/** Problems a community would refuse with `invalidManifest` (or `unsupportedSecrecy` for this client); empty when none. */
export function validateManifest(m: Manifest): string[] {
  const out: string[] = [];
  if (!ID.test(m.electionId ?? "")) out.push("electionId must be 1-128 letters, digits, `.`, `-` or `_`");
  if (!m.community) out.push("community (the community's DID) is required");
  if (!m.ballotBox) out.push("ballotBox (the ballot box's DID) is required");
  if (m.secrecy !== "open") out.push(`secrecy "${m.secrecy}" needs encrypted ballots and trustees, which this client does not do; use "open"`);
  if (!Array.isArray(m.questions) || m.questions.length < 1 || m.questions.length > 128) out.push("a poll has 1 to 128 questions");
  const qkeys = new Set<string>();
  for (const q of m.questions ?? []) {
    if (!KEY.test(q.key ?? "")) out.push(`question key "${q.key}" must be 1-64 letters, digits, \`.\`, \`-\` or \`_\``);
    if (qkeys.has(q.key)) out.push(`question key "${q.key}" is repeated`);
    qkeys.add(q.key);
    if (q.type === "text") {
      if (!(q.maxLength >= 1 && q.maxLength <= 4096)) out.push(`question "${q.key}": maxLength must be 1-4096`);
      continue;
    }
    const opts = q.options ?? [];
    if (opts.length < 2 || opts.length > 256) out.push(`question "${q.key}" needs 2 to 256 options`);
    const okeys = new Set<string>();
    for (const o of opts) {
      if (!KEY.test(o.key ?? "")) out.push(`option key "${o.key}" must be 1-64 letters, digits, \`.\`, \`-\` or \`_\``);
      if (okeys.has(o.key)) out.push(`option key "${o.key}" is repeated in question "${q.key}"`);
      okeys.add(o.key);
    }
    if (q.type === "choice") {
      if (!(Number.isInteger(q.minSelections) && q.minSelections >= 1)) out.push(`question "${q.key}": minSelections must be at least 1`);
      if (!(Number.isInteger(q.maxSelections) && q.maxSelections >= q.minSelections && q.maxSelections <= opts.length)) {
        out.push(`question "${q.key}": maxSelections must be between minSelections and the number of options`);
      }
    }
    if (q.type === "score" && !(q.max > q.min)) out.push(`question "${q.key}": max must be above min`);
  }
  const reg = time(m.registrationOpensAt), opens = time(m.votingOpensAt), closes = time(m.votingClosesAt);
  if (reg === undefined || opens === undefined || closes === undefined) out.push("registrationOpensAt, votingOpensAt and votingClosesAt must be RFC 3339 times");
  else {
    if (reg > opens) out.push("registration must open no later than voting");
    if (closes <= opens) out.push("voting must close after it opens");
  }
  if (!["replace", "refuse"].includes(m.revote)) out.push('revote must be "replace" or "refuse"');
  if (!["public", "private"].includes(m.board?.visibility)) out.push('board.visibility must be "public" or "private"');
  if (!Array.isArray(m.board?.auditors)) out.push("board.auditors must be a list (may be empty)");
  if (!["members", "membersAndListed", "listed", "credential"].includes(m.roll?.rule)) out.push("roll.rule must be members, membersAndListed, listed or credential");
  if ((m.roll?.rule === "listed" || m.roll?.rule === "membersAndListed") && !m.roll.listed?.length) out.push(`roll "${m.roll.rule}" needs a non-empty listed`);
  if (m.roll?.rule === "credential" && !m.roll.memberOf) out.push('roll "credential" needs memberOf');
  if (!(Number.isInteger(m.textReleaseThreshold) && m.textReleaseThreshold >= 1)) out.push("textReleaseThreshold must be at least 1");
  for (const f of ["binding", "allowEarlyClose", "resultsBeforeClose"] as const) if (typeof m[f] !== "boolean") out.push(`${f} must be true or false`);
  return out;
}
