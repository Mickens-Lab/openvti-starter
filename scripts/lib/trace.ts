// TRACE=1: every call any client makes in this process is appended to .vta/trace.jsonl (one JSON object per line).
// `npm run trace` reads it. The file holds task types, ids, DIDs, status and timing, never payloads or keys.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { setTraceSink, type TraceEvent } from "@starter/vta-client";

export const TRACE_FILE = process.env.TRACE_FILE ?? ".vta/trace.jsonl";

export function installTrace(file: string = TRACE_FILE): void {
  mkdirSync(dirname(file), { recursive: true });
  setTraceSink((e) => {
    appendFileSync(file, JSON.stringify(e) + "\n", { mode: 0o600 });
  });
}

/** Parse JSONL, skipping blank and damaged lines (a writer may be mid-line). */
export function parseTrace(text: string): TraceEvent[] {
  const out: TraceEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e.type === "string" && typeof e.ts === "string") out.push(e);
    } catch { /* partial line */ }
  }
  return out;
}

const TT = "https://trusttasks.org/spec/";
const shortDid = (d?: string): string => (!d ? "?" : d.length <= 18 ? d : `${d.slice(0, 12)}...${d.slice(-5)}`);

/** One readable line: time, client, transport, task, outcome, duration, who to whom. */
export function formatTrace(e: TraceEvent): string {
  const time = e.ts.slice(11, 23);
  const task = e.type.startsWith(TT) ? e.type.slice(TT.length) : e.type;
  const outcome = e.ok ? `ok ${e.status ?? ""}`.trim() : `REFUSED ${[e.status, e.code].filter((x) => x !== undefined).join(" ")}`.trim();
  const id = e.id ? `  id ${e.id.replace(/^urn:uuid:/, "").slice(0, 8)}` : "";
  return `${time}  ${e.source.padEnd(3)} ${e.transport.padEnd(4)} ${task.padEnd(34)} ${outcome.padEnd(18)} ${String(e.ms).padStart(5)} ms  ${shortDid(e.from)} -> ${shortDid(e.to)}${id}${e.proof && e.proof !== "verified" ? `  reply proof ${e.proof}` : ""}`;
}

/** Keep the last `n` events (all when n <= 0). */
export const lastN = (events: TraceEvent[], n: number): TraceEvent[] => (n > 0 ? events.slice(-n) : events);
