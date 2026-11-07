// The thin React layer over RoomSession. Decisions live in state.ts; this file only subscribes and re-renders.
import { createContext, useContext, useEffect, useState } from "react";
import { PollSource, type FeedStatus, type FileEnvelope, type RoomSession, type SessionItem } from "@buildathon/rooms-client";
import type { Backend, RoomRef } from "./backend.ts";

export interface RoomView {
  session: RoomSession;
  items: SessionItem[];
  /** Bumped on every change, profile updates included, so author labels re-resolve. */
  tick: number;
  status: FeedStatus;
  visible: boolean;
  lastChange?: "local" | "feed";
}

/** The open session for components deeper down (Author, ItemBody). */
export const RoomContext = createContext<RoomView | undefined>(undefined);
export function useRoomContext(): RoomView {
  const v = useContext(RoomContext);
  if (!v) throw new Error("useRoomContext outside a room");
  return v;
}

const isVisible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

/**
 * Subscribe to one session: re-read items() on every change, follow the poll status, and tell the PollSource when the
 * tab is hidden (15 s instead of 3 s).
 */
export function useRoom(session: RoomSession | undefined): RoomView | undefined {
  const [state, setState] = useState<{ tick: number; status: FeedStatus; visible: boolean; lastChange?: "local" | "feed" }>({ tick: 0, status: "idle", visible: isVisible() });
  useEffect(() => {
    if (!session) return;
    const source = session.feed.source instanceof PollSource ? session.feed.source : undefined;
    const off = session.onChange((c) => setState((s) => ({ ...s, tick: s.tick + 1, lastChange: c.origin })));
    const prev = source?.onStatus;
    if (source) {
      source.onStatus = (st, err) => { prev?.(st, err); setState((s) => ({ ...s, status: st })); };
      setState((s) => ({ ...s, status: source.status }));
    }
    const onVis = () => {
      const v = isVisible();
      source?.setVisible(v);
      setState((s) => ({ ...s, visible: v }));
    };
    document.addEventListener("visibilitychange", onVis);
    onVis();
    return () => {
      off();
      if (source) source.onStatus = prev;
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [session]);
  if (!session) return undefined;
  return { session, items: session.items(), ...state };
}

/** Open a session for the picked room; closes it when the room changes or the component unmounts. */
export function useSession(backend: Backend | undefined, room: RoomRef | undefined): { session?: RoomSession; error?: string; loading: boolean } {
  const [st, setSt] = useState<{ session?: RoomSession; error?: string; loading: boolean }>({ loading: false });
  useEffect(() => {
    if (!backend || !room) { setSt({ loading: false }); return; }
    let live = true;
    let opened: RoomSession | undefined;
    setSt({ loading: true });
    backend.open(room).then(
      (s) => { opened = s; if (live) setSt({ session: s, loading: false }); else s.close(); },
      (e) => { if (live) setSt({ error: errorText(e), loading: false }); },
    );
    return () => { live = false; opened?.close(); };
  }, [backend, room]);
  return st;
}

/** A file's bytes (inline, or downloaded once and cached by the session). */
export function useFileBytes(session: RoomSession, file: FileEnvelope, enabled: boolean): { bytes?: Uint8Array; error?: string } {
  const [st, setSt] = useState<{ bytes?: Uint8Array; error?: string }>({});
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    session.fileBytes(file).then((b) => { if (live) setSt({ bytes: b }); }, (e) => { if (live) setSt({ error: errorText(e) }); });
    return () => { live = false; };
  }, [session, file, enabled]);
  return st;
}

/** A blob: URL for bytes of a sniffed type, revoked when the bytes change or the component unmounts. */
export function useObjectUrl(bytes: Uint8Array | undefined, mime: string | undefined): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!bytes || !mime) { setUrl(undefined); return; }
    const u = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [bytes, mime]);
  return url;
}

/** Save bytes as a file: a short-lived blob: URL with the download attribute (never navigated to, never rendered). */
export function downloadBytes(bytes: Uint8Array, name: string): void {
  const u = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = u;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 1000);
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The element under `root` whose data-id is `id` (no selector built from room data). */
export function byDataId(root: HTMLElement | null, id: string): HTMLElement | undefined {
  return root ? Array.from(root.querySelectorAll<HTMLElement>("[data-id]")).find((el) => el.dataset.id === id) : undefined;
}
