// The inert markdown renderer: tree structure, safe links, raw HTML as text, images as links, and the React output
// (rendered to a string with react-dom/server, so escaping is checked on the real element tree).
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseBlocks, parseInline, renderMarkdown, renderPlain, safeHref, type Block } from "../src/render.ts";

const html = (src: string) => renderToStaticMarkup(renderMarkdown(src) as any);

test("blocks: headings, paragraphs, lists, quotes, code, rules", () => {
  const b = parseBlocks("# Title\n\nSome *text*\nwraps.\n\n- one\n- two\n\n3. three\n4. four\n\n> quoted **bold**\n\n```ts\nconst x = 1;\n```\n\n---\n\n    indented code");
  assert.deepEqual(b.map((x) => x.t), ["heading", "para", "list", "list", "quote", "code", "hr", "code"]);
  assert.deepEqual(b[0], { t: "heading", level: 1, c: [{ t: "text", v: "Title" }] });
  assert.deepEqual(b[1], { t: "para", c: [{ t: "text", v: "Some " }, { t: "em", c: [{ t: "text", v: "text" }] }, { t: "text", v: " wraps." }] });
  const ul = b[2] as Extract<Block, { t: "list" }>;
  assert.equal(ul.ordered, false);
  assert.equal(ul.items.length, 2);
  const ol = b[3] as Extract<Block, { t: "list" }>;
  assert.equal(ol.ordered, true);
  assert.equal(ol.start, 3);
  assert.deepEqual((b[4] as Extract<Block, { t: "quote" }>).c[0], { t: "para", c: [{ t: "text", v: "quoted " }, { t: "strong", c: [{ t: "text", v: "bold" }] }] });
  assert.deepEqual(b[5], { t: "code", lang: "ts", v: "const x = 1;" });
  assert.deepEqual(b[7], { t: "code", v: "indented code" });
});

test("nested lists and multi-paragraph items", () => {
  const b = parseBlocks("- outer\n  - inner a\n  - inner b\n- second");
  const l = b[0] as Extract<Block, { t: "list" }>;
  assert.equal(l.items.length, 2);
  assert.deepEqual(l.items[0].map((x) => x.t), ["para", "list"]);
  assert.equal(html("- a\n  - b"), "<div class=\"md\"><ul><li><p>a</p><ul><li>b</li></ul></li></ul></div>");
});

test("inline: emphasis, strong, code, escapes, snake_case stays text", () => {
  assert.deepEqual(parseInline("a **b** _c_ `d*e*` \\*f\\* snake_case_name"), [
    { t: "text", v: "a " }, { t: "strong", c: [{ t: "text", v: "b" }] }, { t: "text", v: " " }, { t: "em", c: [{ t: "text", v: "c" }] },
    { t: "text", v: " " }, { t: "code", v: "d*e*" }, { t: "text", v: " *f* snake_case_name" },
  ]);
  assert.deepEqual(parseInline("2 * 3 * 4"), [{ t: "text", v: "2 * 3 * 4" }]);
});

test("React output structure", () => {
  assert.equal(html("# T\n\nhi *there*"), "<div class=\"md\"><h3 class=\"md-h\" data-level=\"1\">T</h3><p>hi <em>there</em></p></div>");
  assert.equal(html("```\n<b>x</b>\n```"), "<div class=\"md\"><pre class=\"md-pre\"><code>&lt;b&gt;x&lt;/b&gt;</code></pre></div>");
  assert.equal(html("> q"), "<div class=\"md\"><blockquote><p>q</p></blockquote></div>");
  assert.equal(renderToStaticMarkup(renderPlain("**not** <i>md</i>") as any), "<div class=\"plain\">**not** &lt;i&gt;md&lt;/i&gt;</div>");
});

test("raw HTML and <script> stay inert text", () => {
  const out = html("<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<a href=\"javascript:alert(1)\">x</a>");
  assert.ok(!out.includes("<script"), out);
  assert.ok(!out.includes("<img"), out);
  assert.ok(!/<a /.test(out), out);
  assert.ok(out.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), out);
  assert.ok(out.includes("&lt;img src=x onerror=alert(1)&gt;"), out);
});

test("links: only http(s) and mailto become links, with their URL shown and rel=noopener noreferrer", () => {
  assert.equal(safeHref("https://example.org/a b"), "https://example.org/a%20b");
  assert.equal(safeHref("mailto:team@example.org"), "mailto:team@example.org");
  for (const bad of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "java\tscript:alert(1)", " javascript:alert(1)", "data:text/html,<b>x</b>", "vbscript:x", "/relative", "file:///etc/passwd", ""]) {
    assert.equal(safeHref(bad), undefined, bad);
  }
  const ok = html("see [the spec](https://example.org/spec \"title\")");
  assert.equal(ok, "<div class=\"md\"><p>see <a href=\"https://example.org/spec\" rel=\"noopener noreferrer\" target=\"_blank\">the spec</a><span class=\"md-url\"> (https://example.org/spec)</span></p></div>");
  const auto = html("<https://example.org/x>");
  assert.ok(auto.includes("<a href=\"https://example.org/x\" rel=\"noopener noreferrer\""), auto);
  assert.ok(!auto.includes("md-url"), "an autolink already shows its URL");
  const bad = html("[click](javascript:alert(1)) [x](data:text/html,hi)");
  assert.ok(!/<a /.test(bad), bad);
  assert.ok(bad.includes("[click](javascript:alert(1))"), "the unsafe link stays visible as text");
});

test("markdown images become links and are never fetched", () => {
  const out = html("![a pixel](https://example.org/pixel.png)");
  assert.ok(!out.includes("<img"), out);
  assert.ok(out.includes("<a href=\"https://example.org/pixel.png\" rel=\"noopener noreferrer\" target=\"_blank\" class=\"md-image-link\">Image: a pixel</a>"), out);
  assert.ok(out.includes("not loaded"), out);
  const bad = html("![x](javascript:alert(1))");
  assert.ok(!out.includes("<img") && !/<a /.test(bad), bad);
  assert.deepEqual(parseInline("![alt](https://example.org/i.png)"), [{ t: "image", alt: "alt", href: "https://example.org/i.png" }]);
});

test("hostile nesting is capped, not a stack overflow", () => {
  const deep = ">".repeat(5000) + " deep";
  assert.doesNotThrow(() => html(deep));
  const stars = "*".repeat(20000) + "x";
  assert.doesNotThrow(() => html(stars));
  const brackets = "[".repeat(3000) + "x" + "]".repeat(3000) + "(https://example.org)";
  assert.doesNotThrow(() => html(brackets));
});
