// An inert markdown renderer: source text -> a small block/inline tree -> React elements. Record bodies are untrusted, so:
//  - nothing is ever handed to innerHTML or dangerouslySetInnerHTML; every character of the source ends up as a React text
//    node or an attribute React escapes. Raw HTML (`<script>`, `<img onerror>`) stays visible text;
//  - links are links only for http:, https: and mailto: (judged on the parsed URL, so `java\tscript:` is refused too),
//    shown with their URL next to the label, opened with rel="noopener noreferrer";
//  - markdown images are never fetched: a page must not load third-party URLs the room's authors chose. They become links;
//  - nesting is capped, so a hostile body cannot blow the stack.
// Supported: ATX headings, emphasis and strong, inline code, fenced and indented code blocks, ordered and unordered lists,
// block quotes, thematic breaks, links, `<https://…>` autolinks and backslash escapes. Anything else is text.
import { createElement as h, Fragment, type ReactNode } from "react";

export type Inline =
  | { t: "text"; v: string }
  | { t: "em" | "strong"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "image"; alt: string; href: string }
  | { t: "br" };

export type Block =
  | { t: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; c: Inline[] }
  | { t: "para"; c: Inline[] }
  | { t: "code"; lang?: string; v: string }
  | { t: "list"; ordered: boolean; start?: number; items: Block[][] }
  | { t: "quote"; c: Block[] }
  | { t: "hr" };

const MAX_DEPTH = 8;

/** The href to use, or undefined when the URL must not become a link. */
export function safeHref(raw: string): string | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  let u: URL;
  try { u = new URL(s); } catch { return undefined; } // relative URLs have no base here: not links
  if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "mailto:") return undefined;
  return u.href;
}

// --- blocks -------------------------------------------------------------------------------------------------------------

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const ITEM = /^( {0,3})([-*+]|(\d{1,9})[.)])([ \t]+(.*))?$/;
const blank = (l: string) => /^\s*$/.test(l);

function startsBlock(l: string): boolean {
  return FENCE.test(l) || HEADING.test(l) || HR.test(l) || QUOTE.test(l) || ITEM.test(l);
}

export function parseBlocks(src: string, depth = 0): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) { i++; continue; }
    if (depth >= MAX_DEPTH) { out.push({ t: "para", c: [{ t: "text", v: lines.slice(i).join("\n") }] }); break; }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`).test(lines[i])) body.push(lines[i++]);
      i++; // the closing fence (or the end)
      out.push({ t: "code", v: body.join("\n"), ...(fence[2] ? { lang: fence[2] } : {}) });
      continue;
    }
    const hd = HEADING.exec(line);
    if (hd) { out.push({ t: "heading", level: hd[1].length as 1, c: parseInline(hd[2] ?? "", depth) }); i++; continue; }
    if (HR.test(line)) { out.push({ t: "hr" }); i++; continue; }
    if (/^ {4,}/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && (/^ {4,}/.test(lines[i]) || (blank(lines[i]) && i + 1 < lines.length && /^ {4,}/.test(lines[i + 1])))) body.push(lines[i++].slice(4));
      out.push({ t: "code", v: body.join("\n") });
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && !blank(lines[i])) {
        const q = QUOTE.exec(lines[i]);
        if (q) body.push(q[1]);
        else if (!startsBlock(lines[i])) body.push(lines[i]); // lazy continuation
        else break;
        i++;
      }
      out.push({ t: "quote", c: parseBlocks(body.join("\n"), depth + 1) });
      continue;
    }
    const first = ITEM.exec(line);
    if (first) {
      const ordered = first[3] !== undefined;
      const indent = first[1].length;
      const items: string[][] = [];
      while (i < lines.length) {
        const m = ITEM.exec(lines[i]);
        if (!m || m[1].length !== indent || (m[3] !== undefined) !== ordered) break;
        const width = m[1].length + m[2].length + 1;
        const item = [m[5] ?? ""];
        i++;
        while (i < lines.length) {
          const l = lines[i];
          if (blank(l)) {
            // A blank line continues the item only when the next line is indented under it.
            if (i + 1 < lines.length && lines[i + 1].startsWith(" ".repeat(Math.min(width, 2))) && !blank(lines[i + 1])) { item.push(""); i++; continue; }
            break;
          }
          const ind = /^ */.exec(l)![0].length;
          if (ind >= 2 && ind > indent) { item.push(l.slice(Math.min(ind, width))); i++; continue; }
          if (!startsBlock(l) && item[item.length - 1] !== "") { item.push(l); i++; continue; } // lazy continuation
          break;
        }
        items.push(item);
        while (i < lines.length && blank(lines[i]) && i + 1 < lines.length && ITEM.exec(lines[i + 1])?.[1].length === indent) i++;
      }
      const start = ordered ? Number(first[3]) : undefined;
      out.push({ t: "list", ordered, ...(ordered && start !== 1 ? { start } : {}), items: items.map((it) => parseBlocks(it.join("\n"), depth + 1)) });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && !blank(lines[i]) && (para.length === 0 || !startsBlock(lines[i]))) para.push(lines[i++].trim());
    out.push({ t: "para", c: parseInline(para.join("\n"), depth) });
  }
  return out;
}

// --- inlines ------------------------------------------------------------------------------------------------------------

const PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

/** The index of the `]` closing the `[` at `open`, honouring nesting and escapes. */
function closeBracket(s: string, open: number): number {
  let d = 0;
  for (let k = open; k < s.length; k++) {
    if (s[k] === "\\") { k++; continue; }
    if (s[k] === "[") d++;
    else if (s[k] === "]" && --d === 0) return k;
  }
  return -1;
}

/** `(url "title")` right after a `]`: the url and the index after `)`. */
function linkTarget(s: string, at: number): { url: string; end: number } | undefined {
  if (s[at] !== "(") return undefined;
  const m = /^\(\s*(<[^<>\n]*>|[^\s()<>]*(?:\([^\s()<>]*\)[^\s()<>]*)*)(?:\s+("[^"]*"|'[^']*'))?\s*\)/.exec(s.slice(at));
  if (!m) return undefined;
  const url = m[1].startsWith("<") ? m[1].slice(1, -1) : m[1];
  return { url, end: at + m[0].length };
}

export function parseInline(s: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = () => { if (buf) { out.push({ t: "text", v: buf }); buf = ""; } };
  const push = (n: Inline) => { flush(); out.push(n); };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length && PUNCT.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
    if (c === "\\" && s[i + 1] === "\n") { push({ t: "br" }); i += 2; continue; }
    if (c === "\n") { buf += " "; i++; continue; }
    if (c === "`") {
      const run = /^`+/.exec(s.slice(i))![0];
      const close = s.indexOf(run, i + run.length);
      if (close > 0 && s[close + run.length] !== "`") {
        let v = s.slice(i + run.length, close).replace(/\n/g, " ");
        if (/^ .*[^ ].* $/.test(v)) v = v.slice(1, -1);
        push({ t: "code", v });
        i = close + run.length;
        continue;
      }
      buf += run; i += run.length; continue;
    }
    if (c === "<") {
      const m = /^<((?:https?|mailto):[^\s<>]+)>/i.exec(s.slice(i));
      const href = m ? safeHref(m[1]) : undefined;
      if (m && href) { push({ t: "link", href, c: [{ t: "text", v: m[1] }] }); i += m[0].length; continue; }
      buf += c; i++; continue; // raw HTML stays text
    }
    if ((c === "!" && s[i + 1] === "[") || c === "[") {
      const open = c === "!" ? i + 1 : i;
      const close = closeBracket(s, open);
      const target = close > 0 ? linkTarget(s, close + 1) : undefined;
      if (target) {
        const label = s.slice(open + 1, close);
        const href = safeHref(target.url);
        if (c === "!") {
          // Never fetched: a link to the image when its URL is safe, else its alt text and URL as text.
          if (href) push({ t: "image", alt: label, href });
          else buf += s.slice(i, target.end);
        } else if (href && depth < MAX_DEPTH) {
          push({ t: "link", href, c: parseInline(label, depth + 1).filter((n) => n.t !== "link") });
        } else {
          buf += s.slice(i, target.end); // an unsafe link stays visible text, scheme and all
        }
        i = target.end;
        continue;
      }
      buf += c; i++; continue;
    }
    if ((c === "*" || c === "_") && depth < MAX_DEPTH) {
      const run = s[i + 1] === c ? c + c : c;
      const prev = s[i - 1] ?? " ";
      const next = s[i + run.length] ?? " ";
      // `_` does not open inside a word (snake_case stays text); nothing opens before whitespace.
      const canOpen = !/\s/.test(next) && !(c === "_" && /[\p{L}\p{N}]/u.test(prev));
      if (canOpen) {
        let k = i + run.length;
        let found = -1;
        while ((k = s.indexOf(run, k)) !== -1) {
          const before = s[k - 1];
          const after = s[k + run.length] ?? " ";
          const okClose = !/\s/.test(before) && k > i + run.length && !(c === "_" && /[\p{L}\p{N}]/u.test(after)) && s[k - 1] !== "\\";
          if (okClose && (run.length === 2 || s[k + 1] !== c || s[k + 2] === c)) { found = k; break; }
          k += run.length;
        }
        if (found > 0) {
          push({ t: run.length === 2 ? "strong" : "em", c: parseInline(s.slice(i + run.length, found), depth + 1) });
          i = found + run.length;
          continue;
        }
      }
      buf += run; i += run.length; continue;
    }
    buf += c; i++;
  }
  flush();
  return out;
}

// --- React --------------------------------------------------------------------------------------------------------------

function textOf(ns: Inline[]): string {
  return ns.map((n) => (n.t === "text" || n.t === "code" ? n.v : n.t === "em" || n.t === "strong" || n.t === "link" ? textOf(n.c) : n.t === "image" ? n.alt : "")).join("");
}

const LINK = { rel: "noopener noreferrer", target: "_blank" } as const;

function inlineEl(n: Inline, key: number): ReactNode {
  switch (n.t) {
    case "text": return n.v;
    case "br": return h("br", { key });
    case "code": return h("code", { key }, n.v);
    case "em": return h("em", { key }, n.c.map(inlineEl));
    case "strong": return h("strong", { key }, n.c.map(inlineEl));
    case "link": {
      const label = textOf(n.c);
      // The URL is always visible, so a label cannot disguise where the link goes.
      const shown = label === n.href || `${label}/` === n.href || `mailto:${label}` === n.href;
      return h(Fragment, { key }, h("a", { href: n.href, ...LINK }, n.c.map(inlineEl)), shown ? null : h("span", { className: "md-url" }, ` (${n.href})`));
    }
    case "image":
      return h(Fragment, { key }, h("a", { href: n.href, ...LINK, className: "md-image-link" }, `Image: ${n.alt || "untitled"}`), h("span", { className: "md-url" }, ` (${n.href}, not loaded)`));
  }
}

function blockEl(b: Block, key: number): ReactNode {
  switch (b.t) {
    case "heading": return h(`h${Math.min(6, b.level + 2)}`, { key, className: "md-h", "data-level": b.level }, b.c.map(inlineEl));
    case "para": return h("p", { key }, b.c.map(inlineEl));
    case "code": return h("pre", { key, className: "md-pre" }, h("code", b.lang ? { "data-lang": b.lang } : {}, b.v));
    case "hr": return h("hr", { key });
    case "quote": return h("blockquote", { key }, b.c.map(blockEl));
    case "list":
      return h(b.ordered ? "ol" : "ul", { key, ...(b.start !== undefined ? { start: b.start } : {}) },
        b.items.map((it, k) => h("li", { key: k }, tight(it))));
  }
}

/** A list item holding a single paragraph renders without the <p>. */
function tight(blocks: Block[]): ReactNode {
  if (blocks.length === 1 && blocks[0].t === "para") return blocks[0].c.map(inlineEl);
  return blocks.map(blockEl);
}

/** Markdown source -> React elements (inert). Headings are shifted down two levels so a body never outranks the page. */
export function renderMarkdown(src: string): ReactNode {
  return h("div", { className: "md" }, parseBlocks(src).map(blockEl));
}

/** Plain text -> one element; line breaks kept by CSS (white-space: pre-wrap). */
export function renderPlain(text: string): ReactNode {
  return h("div", { className: "plain" }, text);
}
