// Argument parsing for the polls CLI. Pure, so it is tested without a server.
import type { PollInput } from "@buildathon/polls-client";

export interface Parsed { cmd: string; rest: string[]; flags: Record<string, string | true>; options: string[] }

/** `--name value`, `--name=value`, bare `--flag`; `--option` repeats. */
export function parseArgs(argv: string[], booleans: ReadonlySet<string> = BOOLEAN_FLAGS): Parsed {
  const [cmd = "help", ...tail] = argv;
  const rest: string[] = [], flags: Record<string, string | true> = {}, options: string[] = [];
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i];
    if (!a.startsWith("--")) { rest.push(a); continue; }
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
    const value = eq > 0 ? a.slice(eq + 1) : booleans.has(name) ? true : tail[++i];
    if (value === undefined) throw new Error(`--${name} needs a value`);
    if (name === "option") options.push(String(value));
    else flags[name] = value;
  }
  return { cmd, rest, flags, options };
}

export const BOOLEAN_FLAGS = new Set(["multiple", "private", "live-results", "no-early-close", "required", "refuse-revote", "binding", "json"]);

/** `90m`, `2h`, `3d`, or minutes as a bare number. */
export function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([mhd]?)$/.exec(s.trim());
  if (!m) throw new Error(`not a duration: "${s}" (use 90m, 2h or 3d)`);
  return Number(m[1]) * ({ "": 1, m: 1, h: 60, d: 1440 } as const)[m[2] as "" | "m" | "h" | "d"];
}

function parseTime(s: string, what: string): Date {
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`--${what}: not a date/time: "${s}" (use RFC 3339, e.g. 2026-11-08T12:00:00Z)`);
  return new Date(t);
}

/** The PollInput a `create` command line describes (community and ballot box filled in by the caller). */
export function pollInputFrom(p: Parsed, community: string, ballotBox: string): PollInput {
  const f = p.flags;
  const question = typeof f.question === "string" ? f.question : p.rest.join(" ");
  if (!question) throw new Error('create needs --question "..." and at least two --option');
  return {
    community, ballotBox, question, options: p.options,
    ...(f.multiple ? { multiple: true } : {}),
    ...(typeof f.max === "string" ? { multiple: true, maxSelections: Number(f.max) } : {}),
    ...(f.required ? { optional: false } : {}),
    ...(typeof f.id === "string" ? { electionId: f.id } : {}),
    ...(typeof f.title === "string" ? { title: f.title } : {}),
    ...(typeof f.description === "string" ? { description: f.description } : {}),
    ...(typeof f.opens === "string" ? { opensAt: parseTime(f.opens, "opens") } : {}),
    ...(typeof f.closes === "string" ? (/^\d/.test(f.closes) && !f.closes.includes("-") ? { durationMinutes: parseDuration(f.closes) } : { closesAt: parseTime(f.closes, "closes") }) : {}),
    ...(f["refuse-revote"] ? { revote: "refuse" as const } : {}),
    ...(f.private ? { visibility: "private" as const } : {}),
    ...(f["live-results"] ? { resultsBeforeClose: true } : {}),
    ...(f["no-early-close"] ? { allowEarlyClose: false } : {}),
    ...(f.binding ? { binding: true } : {}),
  };
}
