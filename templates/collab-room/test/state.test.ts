// Pure view state: ordering, the chat window, auto-scroll, file classification by bytes, highlights, labels.
import assert from "node:assert/strict";
import { test } from "node:test";
import { utf8, type SessionItem } from "@starter/rooms-client";
import { demoGif, demoPng } from "../src/demo-media.ts";
import {
  admitted, atBottom, canSave, canSend, chatWindow, classifyFile, draftOf, formatSize, highlight, isDirty, liveLabel, loadOlder,
  shouldAutoScroll, split, tabFor, toggleFormat, wantsPreview,
} from "../src/state.ts";

const item = (kind: "chat" | "note" | "file", version: number, extra: Record<string, unknown> = {}): SessionItem => ({
  id: `${kind}-${version}`, kind, key: `k${version}`, version, status: "active", updatedAt: "", mine: false,
  envelope: { profile: "openvti.collab/1", kind, id: `${kind}-${version}`, clientTs: "2026-11-07T10:00:00Z",
    ...(kind === "chat" ? { text: "t", format: "text/plain" } : kind === "note" ? { title: "T", body: "b" } : { name: "f", mediaType: "", size: 1, sha256: "" }), ...extra } as any,
});

test("split: chat ascending by version, notes and files newest first", () => {
  const s = split([item("chat", 5), item("note", 2), item("file", 3), item("chat", 1), item("note", 7), item("file", 9)]);
  assert.deepEqual(s.chat.map((i) => i.version), [1, 5]);
  assert.deepEqual(s.notes.map((i) => i.version), [7, 2]);
  assert.deepEqual(s.files.map((i) => i.version), [9, 3]);
  assert.equal(tabFor("chat"), "chat");
  assert.equal(tabFor("note"), "notes");
  assert.equal(tabFor("file"), "files");
});

test("chat window: newest N ascending, load older, bounds", () => {
  const all = Array.from({ length: 45 }, (_, i) => i);
  assert.deepEqual(chatWindow(all, 20), { visible: all.slice(25), older: 25 });
  assert.equal(loadOlder(20, 45), 40);
  assert.equal(loadOlder(40, 45), 45);
  assert.deepEqual(chatWindow(all, 100), { visible: all, older: 0 });
  assert.deepEqual(chatWindow([], 20), { visible: [], older: 0 });
});

test("auto-scroll only at the bottom or for one's own message", () => {
  assert.equal(atBottom({ scrollTop: 480, scrollHeight: 1000, clientHeight: 500 }), true);
  assert.equal(atBottom({ scrollTop: 100, scrollHeight: 1000, clientHeight: 500 }), false);
  assert.equal(shouldAutoScroll(true, false), true);
  assert.equal(shouldAutoScroll(false, false), false);
  assert.equal(shouldAutoScroll(false, true), true);
});

test("composer and note drafts", () => {
  assert.equal(toggleFormat("text/plain"), "text/markdown");
  assert.equal(toggleFormat("text/markdown"), "text/plain");
  assert.equal(canSend("  ", false), false);
  assert.equal(canSend("hi", true), false);
  assert.equal(canSend("hi", false), true);
  const n = item("note", 3);
  const d = draftOf(n);
  assert.deepEqual(d, { id: "note-3", title: "T", body: "b" });
  assert.equal(isDirty(d, n), false);
  assert.equal(isDirty({ ...d, body: "c" }, n), true);
  assert.equal(canSave({ title: " ", body: "x" }, false), false);
});

test("files: images by sniffed bytes only; SVG and mislabelled files download-only; text and markdown", () => {
  const f = (name: string, mediaType: string, size = 10) => ({ name, mediaType, size });
  assert.deepEqual(classifyFile(f("a.png", "image/png"), demoPng()), { show: "image", mime: "image/png" });
  assert.deepEqual(classifyFile(f("a.gif", "image/gif"), demoGif()), { show: "image", mime: "image/gif" });
  // The claim does not matter: a PNG named .txt is shown as an image; HTML claiming image/png is not.
  assert.deepEqual(classifyFile(f("a.txt", "text/plain"), demoPng()), { show: "image", mime: "image/png" });
  assert.equal(classifyFile(f("photo.png", "image/png"), utf8("<html>x</html>")).show, "download");
  assert.equal(classifyFile(f("d.svg", "image/svg+xml"), utf8("<svg/>")).show, "download");
  assert.equal(classifyFile(f("d.png", "image/svg+xml"), demoPng()).show, "download", "an SVG claim is never previewed");
  assert.equal(wantsPreview(f("d.svg", "image/svg+xml")), false);
  assert.deepEqual(classifyFile(f("n.txt", "text/plain"), utf8("hello")), { show: "text", text: "hello" });
  assert.deepEqual(classifyFile(f("r.md", "text/markdown"), utf8("# hi")), { show: "markdown", text: "# hi" });
  assert.deepEqual(classifyFile(f("r.json", "application/json"), utf8("{}")), { show: "text", text: "{}" });
  assert.equal(classifyFile(f("bad.txt", "text/plain"), new Uint8Array([0xff, 0xfe, 0x00])).show, "download");
  assert.equal(classifyFile(f("big.txt", "text/plain"), new Uint8Array(1024 * 1024 + 1).fill(65)).show, "download");
  assert.equal(classifyFile(f("x.bin", "application/octet-stream"), new Uint8Array([1, 2, 3])).show, "download");
  assert.equal(wantsPreview(f("huge.png", "image/png", 9 * 1024 * 1024)), false);
  assert.equal(classifyFile(f("huge.png", "image/png", 9 * 1024 * 1024), undefined).show, "download");
});

test("highlight: segments from ranges, clamped and merged", () => {
  assert.deepEqual(highlight("the escrow terms", [[4, 10]]), [
    { text: "the ", mark: false }, { text: "escrow", mark: true }, { text: " terms", mark: false },
  ]);
  assert.deepEqual(highlight("abcdef", [[3, 5], [0, 2], [1, 3], [10, 20], [4, 4]]), [{ text: "abcde", mark: true }, { text: "f", mark: false }]);
  assert.deepEqual(highlight("", []), []);
});

test("labels and helpers", () => {
  assert.equal(liveLabel("live", true).tone, "ok");
  assert.match(liveLabel("live", false).text, /15 s/);
  assert.equal(liveLabel("backoff", true).tone, "warn");
  assert.equal(liveLabel("idle", true).text, "Connecting");
  assert.equal(formatSize(512), "512 B");
  assert.equal(formatSize(2048), "2.0 KiB");
  assert.equal(formatSize(3 * 1024 * 1024), "3.0 MiB");
  assert.deepEqual(admitted([{ state: "admitted" }, { state: "offered" }, { state: "removed" }, {}]).length, 2);
});
