// Client-side search for both tiers (no host search exists). The index lives in memory only and is never persisted,
// so decrypted sealed content is never written anywhere.
//  - File names: normalised (lowercase, NFKD without diacritics); exact, then prefix (whole name or a token), then
//    substring, newest first within a rank.
//  - Full text: an inverted index over chat text, note title and body, and text files. Terms are ANDed and match a
//    word or a word's prefix; "quoted phrases" must appear as consecutive words. Hits carry a snippet with ranges.

export type SearchKind = "chat" | "note" | "file";

export interface SearchItem {
  /** The item's id (the session uses the envelope id). Upserting the same id replaces it. */
  id: string;
  kind: SearchKind;
  /** The host version, for newest-first ordering. */
  version: number;
  /** A file's name (file-name mode). */
  name?: string;
  /** A note's title (full-text mode). */
  title?: string;
  /** Chat text, a note body, or a text file's decoded content (full-text mode). */
  text?: string;
}

/** [start, end) offsets into the string shown. */
export type Range = [number, number];

export interface NameHit {
  id: string;
  name: string;
  version: number;
  rank: "exact" | "prefix" | "substring";
  ranges: Range[];
}

export interface TextHit {
  id: string;
  kind: SearchKind;
  version: number;
  field: "title" | "text" | "name";
  snippet: string;
  /** Highlight ranges within `snippet`. */
  ranges: Range[];
  score: number;
}

/** Text files indexed in full-text mode: text/*, .md, .json, .csv, at most 1 MiB. */
export const TEXT_INDEX_CAP = 1024 * 1024;
export function isIndexableText(name: string, mediaType: string, size: number): boolean {
  if (size > TEXT_INDEX_CAP) return false;
  return mediaType.startsWith("text/") || mediaType === "application/json" || /\.(md|markdown|txt|json|csv)$/i.test(name);
}

/** Lowercase, NFKD, combining marks removed. */
export const normalize = (s: string): string => normalizeWithMap(s).norm;

/** Normalised text plus, per normalised char, the [start, end) of the original code point it came from. */
export function normalizeWithMap(s: string): { norm: string; from: number[]; to: number[] } {
  let norm = "";
  const from: number[] = [], to: number[] = [];
  let i = 0;
  for (const cp of s) {
    const n = cp.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
    for (let k = 0; k < n.length; k++) { from.push(i); to.push(i + cp.length); }
    norm += n;
    i += cp.length;
  }
  return { norm, from, to };
}

interface Token { t: string; start: number; end: number }

const WORD = /[\p{L}\p{N}]+/gu;
function tokenize(norm: string): Token[] {
  return [...norm.matchAll(WORD)].map((m) => ({ t: m[0], start: m.index!, end: m.index! + m[0].length }));
}

interface Field { raw: string; norm: string; from: number[]; to: number[]; tokens: Token[] }
const field = (raw: string): Field => {
  const m = normalizeWithMap(raw);
  return { raw, ...m, tokens: tokenize(m.norm) };
};

interface Doc { item: SearchItem; name?: Field; title?: Field; text?: Field }

/** Parse a query into ANDed terms and quoted phrases (each phrase a list of words). */
export function parseQuery(q: string): { terms: string[]; phrases: string[][] } {
  const phrases: string[][] = [];
  const rest = q.replace(/"([^"]*)"/g, (_, p: string) => {
    const words = tokenize(normalize(p)).map((t) => t.t);
    if (words.length) phrases.push(words);
    return " ";
  });
  return { terms: tokenize(normalize(rest)).map((t) => t.t), phrases };
}

export class SearchIndex {
  private docs = new Map<string, Doc>();
  /** word -> ids */
  private words = new Map<string, Set<string>>();

  get size(): number {
    return this.docs.size;
  }

  upsert(item: SearchItem): void {
    this.remove(item.id);
    const d: Doc = { item };
    if (item.name) d.name = field(item.name);
    if (item.title) d.title = field(item.title);
    if (item.text) d.text = field(item.text);
    this.docs.set(item.id, d);
    for (const f of [d.title, d.text, d.name]) for (const tok of f?.tokens ?? []) {
      let s = this.words.get(tok.t);
      if (!s) this.words.set(tok.t, (s = new Set()));
      s.add(item.id);
    }
  }

  remove(id: string): void {
    const d = this.docs.get(id);
    if (!d) return;
    this.docs.delete(id);
    for (const f of [d.title, d.text, d.name]) for (const tok of f?.tokens ?? []) {
      const s = this.words.get(tok.t);
      s?.delete(id);
      if (s?.size === 0) this.words.delete(tok.t);
    }
  }

  clear(): void {
    this.docs.clear();
    this.words.clear();
  }

  /** Mode 1: file names. */
  searchNames(query: string, limit = 50): NameHit[] {
    const q = normalize(query).trim();
    if (!q) return [];
    const order = { exact: 0, prefix: 1, substring: 2 } as const;
    const hits: NameHit[] = [];
    for (const d of this.docs.values()) {
      if (d.item.kind !== "file" || !d.name) continue;
      const n = d.name;
      const stem = n.norm.replace(/\.[^.]*$/, "");
      let rank: NameHit["rank"] | undefined;
      let at = -1;
      if (n.norm === q || stem === q) { rank = "exact"; at = 0; }
      else if (n.norm.startsWith(q)) { rank = "prefix"; at = 0; }
      else {
        const tok = n.tokens.find((t) => n.norm.startsWith(q, t.start));
        if (tok) { rank = "prefix"; at = tok.start; }
        else if ((at = n.norm.indexOf(q)) >= 0) rank = "substring";
      }
      if (!rank) continue;
      hits.push({ id: d.item.id, name: n.raw, version: d.item.version, rank, ranges: [mapRange(n, at, at + q.length)] });
    }
    return hits.sort((a, b) => order[a.rank] - order[b.rank] || b.version - a.version).slice(0, limit);
  }

  /** Mode 2: full text. */
  searchText(query: string, limit = 50): TextHit[] {
    const { terms, phrases } = parseQuery(query);
    if (!terms.length && !phrases.length) return [];
    // Candidates: ids containing every term (as a word or prefix) and every phrase word.
    let cand: Set<string> | undefined;
    for (const t of [...terms, ...phrases.flat()]) {
      const ids = new Set<string>();
      for (const [w, s] of this.words) if (w.startsWith(t)) for (const id of s) ids.add(id);
      cand = cand ? new Set([...cand].filter((id) => ids.has(id))) : ids;
      if (!cand.size) return [];
    }
    const hits: TextHit[] = [];
    for (const id of cand ?? []) {
      const d = this.docs.get(id)!;
      const fields = ([["title", d.title], ["text", d.text], ["name", d.name]] as const).filter((x) => x[1]);
      const matchesIn = (f: Field) => matchRanges(f, terms, phrases);
      // Every phrase must occur within one field.
      if (!phrases.every((p) => fields.some(([, f]) => matchRanges(f!, [], [p]).length > 0))) continue;
      let best: { name: "title" | "text" | "name"; f: Field; r: Range[] } | undefined;
      let score = 0;
      for (const [name, f] of fields) {
        const r = matchesIn(f!);
        score += r.length * (name === "title" || name === "name" ? 2 : 1);
        if (r.length && !best) best = { name, f: f!, r };
      }
      if (!best) continue;
      hits.push({ id, kind: d.item.kind, version: d.item.version, field: best.name, score, ...snippet(best.f, best.r) });
    }
    return hits.sort((a, b) => b.score - a.score || b.version - a.version).slice(0, limit);
  }
}

/** Normalised [start, end) to original-string offsets. */
function mapRange(f: Field, start: number, end: number): Range {
  return [f.from[start] ?? f.raw.length, f.to[end - 1] ?? f.raw.length];
}

/** Original-string ranges of every term (word prefix) and phrase (consecutive words) in a field, merged. */
function matchRanges(f: Field, terms: string[], phrases: string[][]): Range[] {
  const out: Range[] = [];
  for (const tok of f.tokens) for (const t of terms) if (tok.t.startsWith(t)) out.push(mapRange(f, tok.start, tok.start + t.length));
  for (const p of phrases) {
    for (let i = 0; i + p.length <= f.tokens.length; i++) {
      if (p.every((w, k) => (k === p.length - 1 ? f.tokens[i + k].t.startsWith(w) : f.tokens[i + k].t === w))) {
        out.push(mapRange(f, f.tokens[i].start, f.tokens[i + p.length - 1].start + p[p.length - 1].length));
      }
    }
  }
  out.sort((a, b) => a[0] - b[0]);
  const merged: Range[] = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged;
}

/** A window of about 120 chars around the first hit, ranges shifted into it. */
function snippet(f: Field, ranges: Range[], radius = 50): { snippet: string; ranges: Range[] } {
  const start = Math.max(0, ranges[0][0] - radius);
  const end = Math.min(f.raw.length, ranges[0][1] + radius * 1.5);
  const pre = start > 0 ? "…" : "";
  const text = pre + f.raw.slice(start, end).replace(/\s+/g, " ") + (end < f.raw.length ? "…" : "");
  // Whitespace collapsing can shift offsets; recompute against the collapsed text by slicing each piece.
  const out: Range[] = [];
  for (const [a, b] of ranges) {
    if (a < start || b > end) continue;
    const s = pre.length + f.raw.slice(start, a).replace(/\s+/g, " ").length;
    out.push([s, s + f.raw.slice(a, b).replace(/\s+/g, " ").length]);
  }
  return { snippet: text, ranges: out };
}
