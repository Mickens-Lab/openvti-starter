// Report a TSP call to the shared trace (same sink and event shape as @starter/vta-client's trace.ts; the sink lives on globalThis
// under a registered symbol, so this package needs no dependency on it).
export interface TspTraceEvent {
  ts: string;
  source: "tsp";
  transport: "tsp";
  type: string;
  id?: string;
  from?: string;
  to?: string;
  status?: number;
  ok: boolean;
  code?: string;
  ms: number;
}

export function emitTspTrace(e: TspTraceEvent): void {
  try { ((globalThis as Record<symbol, unknown>)[Symbol.for("buildathon.trace")] as ((e: TspTraceEvent) => void) | undefined)?.(e); } catch { /* ignore */ }
}
