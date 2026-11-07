import assert from "node:assert/strict";
import { test } from "node:test";
import { SearchIndex, isIndexableText, normalize, parseQuery } from "../src/index.js";

const mark = (h: { snippet: string; ranges: [number, number][] }) => h.ranges.map(([a, b]) => h.snippet.slice(a, b));

function files() {
  const ix = new SearchIndex();
  ix.upsert({ id: "1", kind: "file", version: 1, name: "report.pdf" });
  ix.upsert({ id: "2", kind: "file", version: 2, name: "Quarterly Report 2026.xlsx" });
  ix.upsert({ id: "3", kind: "file", version: 3, name: "misreported.txt" });
  ix.upsert({ id: "4", kind: "file", version: 4, name: "Résumé Café.md" });
  ix.upsert({ id: "5", kind: "file", version: 5, name: "report" });
  ix.upsert({ id: "6", kind: "note", version: 6, title: "report", text: "not a file" });
  return ix;
}

test("file names: exact, then prefix (name or token), then substring, newest first", () => {
  const hits = files().searchNames("Report");
  assert.deepEqual(hits.map((h) => [h.id, h.rank]), [["5", "exact"], ["1", "exact"], ["2", "prefix"], ["3", "substring"]]);
  assert.deepEqual(hits.map((h) => h.name.slice(h.ranges[0][0], h.ranges[0][1])), ["report", "report", "Report", "report"]);
  assert.deepEqual(files().searchNames("quar").map((h) => h.id), ["2"]);
  assert.deepEqual(files().searchNames("   "), []);
});

test("file names ignore case and diacritics, highlighting the original characters", () => {
  const [h] = files().searchNames("cafe");
  assert.equal(h.id, "4");
  assert.equal(h.rank, "prefix");
  assert.equal(h.name.slice(...h.ranges[0]), "Café");
  assert.equal(files().searchNames("RÉSUMÉ")[0].id, "4");
  assert.equal(normalize("Ångström ﬁle"), "angstrom file");
});

function texts() {
  const ix = new SearchIndex();
  ix.upsert({ id: "c1", kind: "chat", version: 1, text: "Shall we meet at the café on Friday?" });
  ix.upsert({ id: "c2", kind: "chat", version: 2, text: "Friday works. The meeting notes are in the doc." });
  ix.upsert({ id: "n1", kind: "note", version: 3, title: "Meeting plan", text: "Agenda:\n\n1. budget review\n2. friday   launch" });
  ix.upsert({ id: "f1", kind: "file", version: 4, name: "todo.md", text: "- review the budget before friday" });
  return ix;
}

test("full text: terms are ANDed and match word prefixes; ranked by hits, then newest", () => {
  const ix = texts();
  assert.deepEqual(new Set(ix.searchText("friday").map((h) => h.id)), new Set(["c1", "c2", "n1", "f1"]));
  assert.deepEqual(ix.searchText("friday budget").map((h) => h.id).sort(), ["f1", "n1"]);
  assert.deepEqual(ix.searchText("meet").map((h) => h.id)[0], "n1", "a title hit outranks a body hit");
  assert.deepEqual(ix.searchText("friday zebra"), []);
  assert.deepEqual(ix.searchText(""), []);
});

test("full text: quoted phrases must appear in order", () => {
  const ix = texts();
  assert.deepEqual(ix.searchText('"budget review"').map((h) => h.id), ["n1"]);
  assert.deepEqual(ix.searchText('"review the budget"').map((h) => h.id), ["f1"]);
  assert.deepEqual(ix.searchText('"review budget"'), []);
  assert.deepEqual(ix.searchText('"friday launch" agenda').map((h) => h.id), ["n1"]);
  assert.deepEqual(parseQuery('a "b c" d'), { terms: ["a", "d"], phrases: [["b", "c"]] });
});

test("full text: diacritics fold both ways; snippets carry highlight ranges", () => {
  const ix = texts();
  const [h] = ix.searchText("cafe");
  assert.equal(h.id, "c1");
  assert.deepEqual(mark(h), ["café"]);
  ix.upsert({ id: "c3", kind: "chat", version: 9, text: "plain cafe here" });
  assert.deepEqual(ix.searchText("café").map((x) => x.id).sort(), ["c1", "c3"]);
  const [p] = ix.searchText('"friday launch"');
  assert.deepEqual(mark(p), ["friday launch"], "whitespace in the snippet is collapsed and ranges follow");
  const long = "word ".repeat(100) + "needle " + "tail ".repeat(100);
  ix.upsert({ id: "big", kind: "note", version: 10, title: "x", text: long });
  const [b] = ix.searchText("needle");
  assert.ok(b.snippet.startsWith("…") && b.snippet.endsWith("…"));
  assert.ok(b.snippet.length < 200);
  assert.deepEqual(mark(b), ["needle"]);
});

test("retracted items are removed; upsert replaces", () => {
  const ix = texts();
  ix.remove("c1");
  assert.ok(!ix.searchText("cafe").length);
  ix.upsert({ id: "c2", kind: "chat", version: 5, text: "edited" });
  assert.ok(!ix.searchText("meeting notes").some((h) => h.id === "c2"));
  assert.equal(ix.searchText("edited")[0].id, "c2");
  const fx = files();
  fx.remove("4");
  assert.deepEqual(fx.searchNames("cafe"), []);
});

test("which text files are indexed", () => {
  assert.ok(isIndexableText("a.md", "application/octet-stream", 10));
  assert.ok(isIndexableText("a", "text/plain", 10));
  assert.ok(isIndexableText("d.csv", "", 10));
  assert.ok(!isIndexableText("a.png", "image/png", 10));
  assert.ok(!isIndexableText("big.txt", "text/plain", 2 * 1024 * 1024));
});
