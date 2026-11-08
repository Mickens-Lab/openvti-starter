// React hooks. All reads here are safe to run twice (StrictMode): they share one in-flight request per key.
// Anything that CHANGES state at the community (apply, withdraw, renew, leave, edit card) is NOT here:
// those run from event handlers in App.tsx only, never from an effect.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { JoinManifest } from "@starter/vtc-client";
import { callLog, describeError, getClient, identity, vtcBrowserUrl } from "./client.ts";
import { splitTaskType } from "./format.ts";
import { createPoller, inflight } from "./poll.ts";
import { detect } from "./probe.ts";
import { cooldownUntil, debounce, FOCUS_DEBOUNCE_MS, freshnessFrom, refreshEpoch, type Freshness } from "./refresh.ts";
import type { DashState } from "./state.ts";
import { createStore, type Store } from "./store.ts";

export function useStore<T>(s: Store<T>): T { return useSyncExternalStore(s.subscribe, s.get); }
export const useCallLog = () => useStore(callLog);

const shared = inflight<unknown>();
export const POLL_MS = 10_000;

// --- the request this browser remembers (to tell "left" from "never applied", and to date the timeline) ----
const key = () => `community-dashboard:${identity().did}`;
export interface Remembered { requestId?: string; appliedAt?: string; criterion?: string }
// This is a HINT, not a record: the community is the source of truth. The id is only used to ask about "my request"
// precisely (status with no id was seen to return an older approved request after a newer one was withdrawn).
export function readRemembered(): Remembered {
  try { return JSON.parse(localStorage.getItem(key()) ?? "{}"); } catch { return {}; }
}
/** Bumped whenever the hint changes, so a panel that shows it re-renders. */
export const hintsVersion = createStore(0);
export function writeRemembered(r: Remembered) {
  try { localStorage.setItem(key(), JSON.stringify(r)); } catch { /* private mode: the app works without it */ }
  hintsVersion.set((n) => n + 1);
}
/** "Forget local hints": drop what this browser remembers about this identity. The community keeps its own records. */
export function clearRemembered() {
  try { localStorage.removeItem(key()); } catch { /* nothing to forget */ }
  hintsVersion.set((n) => n + 1);
}
export const useHints = (): Remembered => { useStore(hintsVersion); return readRemembered(); };

/** What the call log says about the newest call to `match` (a task name or REST path fragment). */
export const lastFreshness = (match: string): Freshness | undefined => freshnessFrom(callLog.get(), match, (t) => splitTaskType(t).name);

export interface Dashboard {
  /** undefined until the first check finishes. */
  dash: DashState | undefined;
  checkedAt: Date | undefined;
  /** Where the state came from: the newest `join-requests/status` call in the log. */
  source: Freshness | undefined;
  refresh(): Promise<void>;
  paused: boolean;
  setPaused(p: boolean): void;
  manifest: JoinManifest | undefined;
}

/** The signed state check, run once on mount, on demand, and (while a request is open) every 10 s. */
export function useDashboard(): Dashboard {
  const [dash, setDash] = useState<DashState>();
  const [checkedAt, setCheckedAt] = useState<Date>();
  const [source, setSource] = useState<Freshness>();
  const [manifest, setManifest] = useState<JoinManifest>();
  const [paused, setPausedState] = useState(false);
  const pausedRef = useRef(false);
  const setPaused = useCallback((p: boolean) => { pausedRef.current = p; setPausedState(p); }, []);

  const check = useCallback(async (): Promise<DashState> => {
    return (await shared("detect", async () => {
      const client = await getClient();
      return detect(client, readRemembered().requestId);
    })) as DashState;
  }, []);
  const apply = useCallback((d: DashState) => { setDash(d); setCheckedAt(new Date()); setSource(lastFreshness("join-requests/status")); }, []);
  const refresh = useCallback(async () => { apply(await check()); }, [check, apply]);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const client = await getClient();
        const d = (await shared("detect", () => detect(client, readRemembered().requestId))) as DashState;
        if (live) apply(d);
        const m = (await shared("manifest", () => client.manifest())) as JoinManifest;
        if (live) setManifest(m);
      } catch (e) {
        if (live) setDash({ kind: "error", message: describeError(e), code: "network" });
      }
    })();
    return () => { live = false; };
  }, [apply]);

  // Poll only while a request is open. Never immediately (the mount check just ran); the poller is stopped on cleanup.
  const open = dash?.kind === "pending" || dash?.kind === "needs-info" || dash?.kind === "other";
  useEffect(() => {
    if (!open) { setPaused(false); return; } // a pause belongs to one open request, not to the next one
    return createPoller({
      intervalMs: POLL_MS,
      maxMs: 60_000,
      paused: () => pausedRef.current || document.hidden,
      tick: async () => { const d = await check(); if (d.kind === "error") throw new Error(d.message); apply(d); },
    });
  }, [open, check, apply, setPaused]);

  return { dash, checkedAt, source, refresh, paused, setPaused, manifest };
}

export interface Loaded<T> {
  data?: T;
  error?: unknown;
  /** True only until the first answer: later re-reads keep showing the last data (`refreshing`) rather than blanking the panel. */
  loading: boolean;
  refreshing: boolean;
  /** When, from which task and how long: the newest matching entry of the Under-the-hood log at the moment the read finished. */
  asOf?: Freshness;
  reload(): void;
}

/**
 * A read that runs on mount, on reload() and on every global refresh. `cacheKey` names the request so a StrictMode double
 * mount sends one. `task` is the fragment of the call's type to look up in the call log for the "as of" line.
 * `followEpoch=false` opts out of global refreshes (for a read that costs several rate-limited calls).
 */
export function useLoad<T>(cacheKey: string, fn: (c: Awaited<ReturnType<typeof getClient>>) => Promise<T>, enabled = true, task?: string, followEpoch = true): Loaded<T> {
  const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean; refreshing: boolean; asOf?: Freshness }>({ loading: enabled, refreshing: false });
  const [n, setN] = useState(0);
  const globalEpoch = useStore(refreshEpoch);
  const epoch = followEpoch ? globalEpoch : 0; // a read that is expensive for the budget re-runs only when asked directly
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setState((s) => (s.data === undefined ? { ...s, loading: true, error: undefined } : { ...s, refreshing: true, error: undefined }));
    (async () => {
      try {
        const c = await getClient();
        const data = (await shared(`${cacheKey}#${n}.${epoch}`, () => fnRef.current(c))) as T;
        if (live) setState({ data, loading: false, refreshing: false, asOf: task ? lastFreshness(task) : undefined });
      } catch (error) {
        if (live) setState((s) => ({ data: s.data, error, loading: false, refreshing: false, asOf: task ? lastFreshness(task) : s.asOf }));
      }
    })();
    return () => { live = false; };
  }, [cacheKey, n, epoch, enabled, task]);
  return { ...state, reload: () => setN((x) => x + 1) };
}

/** True while a refresh was started too recently to start another (all Refresh buttons share this). */
export function useCooling(): boolean {
  const until = useStore(cooldownUntil);
  const [, tick] = useState(0);
  useEffect(() => {
    const left = until - Date.now();
    if (left <= 0) return;
    const t = setTimeout(() => tick((x) => x + 1), left + 5);
    return () => clearTimeout(t);
  }, [until]);
  return Date.now() < until;
}

/**
 * Run `fn` when the tab becomes visible or the window gains focus, debounced, and only if the last read is old enough.
 * Listeners and the pending timer are removed on unmount.
 */
export function useRefreshOnFocus(fn: () => void, lastReadAt: () => number, minAgeMs: number) {
  const ref = useRef(fn);
  ref.current = fn;
  const ageRef = useRef(lastReadAt);
  ageRef.current = lastReadAt;
  useEffect(() => {
    const d = debounce(() => {
      if (document.hidden) return;
      if (Date.now() - ageRef.current() < minAgeMs) return;
      ref.current();
    }, FOCUS_DEBOUNCE_MS);
    const on = () => { if (!document.hidden) d.call(); };
    document.addEventListener("visibilitychange", on);
    window.addEventListener("focus", on);
    return () => { document.removeEventListener("visibilitychange", on); window.removeEventListener("focus", on); d.cancel(); };
  }, [minAgeMs]);
}

/** The community's public profile: plain REST, no signature. Undefined while loading or if the community serves none. */
let profileCache: Record<string, unknown> | undefined;
export function usePublicProfile(): Record<string, unknown> | undefined {
  const [p, setP] = useState<Record<string, unknown> | undefined>(profileCache);
  useEffect(() => {
    let live = true;
    if (profileCache) return;
    (shared("public-profile", async () => {
      const r = await fetch(`${vtcBrowserUrl().replace(/\/+$/, "")}/v1/community/public-profile`);
      return r.ok ? await r.json() : undefined;
    }) as Promise<Record<string, unknown> | undefined>).then((v) => { profileCache = v; if (live) setP(v); }, () => {});
    return () => { live = false; };
  }, []);
  return p;
}
