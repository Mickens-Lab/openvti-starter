// Pure view state and decisions for the UI: no React, no DOM, no network. Tested under node:test (test/state.test.ts).
import { sniffImage, type FeedStatus, type FileEnvelope, type Range, type SessionItem } from "@buildathon/rooms-client";

export type Tab = "chat" | "notes" | "files";
export const TABS: { id: Tab; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "notes", label: "Notes" },
  { id: "files", label: "Files" },
];

/** Which tab shows an item. */
export const tabFor = (kind: SessionItem["kind"]): Tab => (kind === "chat" ? "chat" : kind === "note" ? "notes" : "files");

/** Chat ascending by host version (the order everyone agrees on), notes and files newest first. */
export function split(items: SessionItem[]): { chat: SessionItem[]; notes: SessionItem[]; files: SessionItem[] } {
  const chat: SessionItem[] = [];
  const notes: SessionItem[] = [];
  const files: SessionItem[] = [];
  for (const it of items) (it.envelope.kind === "chat" ? chat : it.envelope.kind === "note" ? notes : files).push(it);
  const asc = (a: SessionItem, b: SessionItem) => a.version - b.version;
  return { chat: chat.sort(asc), notes: notes.sort((a, b) => b.version - a.version), files: files.sort((a, b) => b.version - a.version) };
}

// --- chat window ----------------------------------------------------------------------------------------------------------

export const CHAT_PAGE = 20;

/** The newest `shown` messages, still ascending, and whether older ones exist. */
export function chatWindow<T>(chat: T[], shown: number): { visible: T[]; older: number } {
  const n = Math.max(0, Math.min(chat.length, shown));
  return { visible: chat.slice(chat.length - n), older: chat.length - n };
}

export const loadOlder = (shown: number, total: number, page = CHAT_PAGE): number => Math.min(total, shown + page);

/** True when the scroll position is at (or within `slack` px of) the bottom. */
export function atBottom(m: { scrollTop: number; scrollHeight: number; clientHeight: number }, slack = 24): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= slack;
}

/**
 * Whether new messages should scroll the list down: only when the reader was already at the bottom, or the newest one is
 * their own. Someone reading older history is not yanked away.
 */
export const shouldAutoScroll = (wasAtBottom: boolean, newestIsMine: boolean): boolean => wasAtBottom || newestIsMine;

// --- composer -----------------------------------------------------------------------------------------------------------

export type ChatFormat = "text/plain" | "text/markdown";
export const toggleFormat = (f: ChatFormat): ChatFormat => (f === "text/plain" ? "text/markdown" : "text/plain");
export const canSend = (text: string, busy: boolean): boolean => !busy && text.trim().length > 0;

// --- notes --------------------------------------------------------------------------------------------------------------

export interface NoteDraft { id?: string; title: string; body: string }
export const emptyDraft = (): NoteDraft => ({ title: "", body: "" });
export const draftOf = (it: SessionItem): NoteDraft =>
  it.envelope.kind === "note" ? { id: it.id, title: it.envelope.title, body: it.envelope.body } : emptyDraft();
export const canSave = (d: NoteDraft, busy: boolean): boolean => !busy && d.title.trim().length > 0;
export const isDirty = (d: NoteDraft, it: SessionItem | undefined): boolean => {
  const base = it ? draftOf(it) : emptyDraft();
  return d.title !== base.title || d.body !== base.body;
};

// --- files --------------------------------------------------------------------------------------------------------------

/** Text files at most this size are shown inline (plan section 5). */
export const TEXT_SHOW_CAP = 1024 * 1024;
/** Bytes are fetched for a preview only up to this size; larger files are download-only. */
export const PREVIEW_FETCH_CAP = 8 * 1024 * 1024;

export type FileView =
  | { show: "image"; mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp" }
  | { show: "text"; text: string }
  | { show: "markdown"; text: string }
  | { show: "download"; reason: string };

const TEXTY = /\.(txt|md|markdown|json|csv|log)$/i;
const isMd = (name: string) => /\.(md|markdown)$/i.test(name);

/** Whether to fetch a file's bytes to preview it (images by sniffing, text files by decoding). */
export function wantsPreview(f: Pick<FileEnvelope, "name" | "mediaType" | "size">): boolean {
  if (isSvg(f)) return false;
  return f.size <= PREVIEW_FETCH_CAP;
}

const isSvg = (f: Pick<FileEnvelope, "name" | "mediaType">) => /svg/i.test(f.mediaType) || /\.svgz?$/i.test(f.name);

/**
 * How to show a file. The media type is the author's claim, so it decides nothing about images: only the bytes' magic
 * (PNG, JPEG, GIF, WebP) does. SVG and anything unknown are download-only. Text is shown when the name or claimed type is
 * textual, the file is at most 1 MiB, and the bytes are valid UTF-8; `.md` goes through the inert markdown renderer.
 */
export function classifyFile(f: Pick<FileEnvelope, "name" | "mediaType" | "size">, bytes: Uint8Array | undefined): FileView {
  if (isSvg(f)) return { show: "download", reason: "SVG files are never displayed (they can carry scripts); download to view." };
  if (!bytes) return { show: "download", reason: f.size > PREVIEW_FETCH_CAP ? "Too large to preview." : "No preview." };
  const mime = sniffImage(bytes);
  if (mime) return { show: "image", mime };
  const textual = f.mediaType.startsWith("text/") || f.mediaType === "application/json" || TEXTY.test(f.name);
  if (textual && bytes.length <= TEXT_SHOW_CAP) {
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return { show: "download", reason: "Not valid UTF-8 text." }; }
    return isMd(f.name) ? { show: "markdown", text } : { show: "text", text };
  }
  if (textual) return { show: "download", reason: "Text files over 1 MiB are not shown." };
  if (f.mediaType.startsWith("image/")) return { show: "download", reason: `Claimed ${f.mediaType}, but the bytes are not a PNG, JPEG, GIF or WebP image.` };
  return { show: "download", reason: "No preview for this type." };
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

// --- search -------------------------------------------------------------------------------------------------------------

export type SearchMode = "names" | "text";
export const SEARCH_MODES: { id: SearchMode; label: string }[] = [
  { id: "names", label: "File names" },
  { id: "text", label: "Full text" },
];

export interface Segment { text: string; mark: boolean }

/** Split `s` at highlight ranges, for <mark>. Ranges are clamped, sorted and merged; bad ones are dropped. */
export function highlight(s: string, ranges: Range[]): Segment[] {
  const rs = ranges
    .map(([a, b]) => [Math.max(0, Math.min(s.length, a)), Math.max(0, Math.min(s.length, b))] as Range)
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  const merged: Range[] = [];
  for (const r of rs) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  const out: Segment[] = [];
  let at = 0;
  for (const [a, b] of merged) {
    if (a > at) out.push({ text: s.slice(at, a), mark: false });
    out.push({ text: s.slice(a, b), mark: true });
    at = b;
  }
  if (at < s.length) out.push({ text: s.slice(at), mark: false });
  return out;
}

/** What a search result is, in a few words. */
export function resultLabel(it: SessionItem): string {
  const e = it.envelope;
  return e.kind === "chat" ? "Chat message" : e.kind === "note" ? `Note: ${e.title}` : `File: ${e.name}`;
}

// --- live badge ---------------------------------------------------------------------------------------------------------

export function liveLabel(status: FeedStatus, visible: boolean): { text: string; tone: "ok" | "warn" | "bad" | "info" } {
  switch (status) {
    case "live": return visible ? { text: "Live (polling every 3 s)", tone: "ok" } : { text: "Live (tab hidden: every 15 s)", tone: "info" };
    case "backoff": return { text: "Reconnecting (backing off)", tone: "warn" };
    case "stopped": return { text: "Stopped", tone: "bad" };
    default: return { text: "Connecting", tone: "info" };
  }
}

export function formatTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const same = d.toDateString() === now.toDateString();
  return same ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}

/** Rooms in a memberships list the member can open now. */
export function admitted<T extends { state?: string }>(rooms: T[]): T[] {
  return rooms.filter((r) => r.state === undefined || r.state === "admitted");
}
