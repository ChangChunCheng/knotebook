/**
 * Multiple paragraphs under a quote, heading or summary: BlockNote 0.52 merges them itself (`mergeParagraphs`, `innerHTML +=` in a loop), which
 * grows quadratically (2,000 paragraphs in one quote take tens of seconds). `premergeInto` merges them once, with the same rule, before handing over.
 *
 * Equivalence: per case, the blocks from `tryParseHTMLToBlocks` (random ids removed) must be identical for merged and unmerged HTML. Coverage is the shapes below:
 * the 70 shapes of `REVIEW_CASES` (copied as-is; the 5 with a paragraph inside a paragraph instead verify whole-write rejection) plus this file's own shapes. Not a proof for arbitrary HTML.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { checkNoteMarkdownSyntax } from "@knotebook/shared";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession } from "../../src/notes/editing/session.js";
import { MAX_HTML_DEPTH, parseMarkdownForNote, premergeParagraphs } from "../../src/notes/editing/markdown.js";
import { expectLinear } from "../perf-helpers.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();
const ORIGIN = "http://localhost";
const ID = "11111111-1111-4111-8111-111111111111";
const cands = [{ id: ID, title: "A", slug: "a", groupId: null, ownerHandle: "alice" }];

const stripIds = (x: unknown): unknown =>
  Array.isArray(x) ? x.map(stripIds) : x !== null && typeof x === "object" ? Object.fromEntries(Object.entries(x).filter(([k]) => k !== "id").map(([k, v]) => [k, stripIds(v)])) : x;
async function withEditor<T>(fn: (ed: EditorSession["editor"]) => T): Promise<T> {
  const s = await EditorSession.open(rt, new Y.Doc());
  try {
    return fn(s.editor);
  } finally {
    s.close();
  }
}
/** HTML that passed the syntax check (the original string if it didn't). */
const htmlOf = (md: string) => {
  const s = checkNoteMarkdownSyntax(md, "top");
  return s.ok ? s.html : md;
};
const blocksOf = (ed: EditorSession["editor"], html: string): string => {
  try {
    return JSON.stringify(stripIds(ed.tryParseHTMLToBlocks(html)));
  } catch (e) {
    return "THROW " + (e as Error).message;
  }
};

const REVIEW_CASES: Record<string, string> = {
  c01_md_two: "> a\n>\n> b",
  c02_ws_edges: "<blockquote><p>a </p><p> b</p></blockquote>",
  c03_newline_in_p: "<blockquote><p>a\nb</p>\n<p>c</p>\n</blockquote>",
  c04_md_loose_list: "> a\n>\n> - x\n>\n> - y\n>\n> b",
  c05_lift_nested: "<blockquote><ul><li><p>a</p><ul><li><p>b</p></li></ul><p>c</p></li></ul></blockquote>",
  c06_lift_text_after: "<blockquote><ul><li><p>a</p><ul><li>b</li></ul>tail<p>c</p></li></ul><p>d</p></blockquote>",
  c07_bq_table_cell: "<blockquote><table><tr><td><p>a</p><p>b</p></td></tr></table><p>c</p></blockquote>",
  c08_cell_bq: "<table><tr><td><blockquote><p>a</p><p>b</p></blockquote></td></tr></table>",
  c09_h2: "<h2><p>a</p><p>b</p></h2>",
  c10_h5h6: "<h5><p>a</p><p>b</p></h5><h6><p>c</p><p>d</p></h6>",
  c11_h1_empty_first: "<h1><p></p><p>b</p><p>c</p></h1>",
  c12_details_summary: "<details><summary><p>a</p><p>b</p></summary><p>c</p></details>",
  c13_toggle_heading_p: "<details><summary><h2>H</h2><p>x</p><p>y</p></summary><p>c</p></details>",
  c14_summary_not_first: "<details><p>x</p><summary><p>a</p><p>b</p></summary></details>",
  c15_nested_details: "<details><summary>s</summary><details><summary><p>a</p><p>b</p></summary><p>c</p></details></details>",
  c16_details_in_bq: "<blockquote><p>q</p><details><summary><p>a</p><p>b</p></summary><p>c</p></details></blockquote>",
  c17_bq_in_summary: "<details><summary><blockquote><p>a</p><p>b</p></blockquote><p>z</p></summary><p>c</p></details>",
  c18_loose_summary: "<summary><p>a</p><p>b</p></summary>",
  c19_loose_summary_bq: "<summary><blockquote><p>a</p><p>b</p></blockquote></summary>",
  c20_second_summary: "<details><summary>s</summary><p>x</p><summary><p>a</p><p>b</p></summary></details>",
  c21_li_details: "<ul><li><details><summary><p>a</p><p>b</p></summary><p>c</p></details></li></ul>",
  c22_figcaption: '<figure><img src="/api/uploads/x"><figcaption><blockquote><p>a</p>\n<p>b</p></blockquote></figcaption></figure>',
  c23_figcaption_h: '<figure><img src="/api/uploads/x"><figcaption><h3><p>a</p> <p>b</p></h3>tail</figcaption></figure>',
  c24_button_nested_first: "<blockquote><p>a<button><p>b</p></button></p><p>c</p></blockquote>",
  c25_button_nested_later: "<blockquote><p>a</p><p>c<button><p>d</p></button></p></blockquote>",
  c26_marquee: "<blockquote><p>a<marquee><p>b</p></marquee></p><p>c</p></blockquote>",
  c27_foreignobject: "<blockquote><p>a<svg><foreignObject><p>b</p></foreignObject></svg></p><p>c</p></blockquote>",
  c28_mtext: "<blockquote><p>a<math><mtext><p>b</p></mtext></math></p><p>c</p></blockquote>",
  c29_pre_leading_nl: "<pre>\n\nlead</pre>\n\n> a\n>\n> b",
  c30_textarea: "<p><textarea>\n\nx</textarea></p>\n\n> a\n>\n> b",
  c31_listing: "<listing>\n\nx</listing>\n\n> a\n>\n> b",
  c32_attrs: '<blockquote data-text-color="red"><p style="text-align:center" class="c" data-x="1">a</p><p style="color:red" data-text-color="blue">b</p></blockquote>',
  c33_columns: '<div data-kb-columns style="display:flex;gap:16px">\n<div data-kb-column style="flex:1">\n\n> a\n>\n> b\n\n</div>\n<div data-kb-column style="flex:1">\n\nX\n\n</div>\n</div>',
  c34_bq_li_bq: "> - x\n>\n>   > a\n>   >\n>   > b\n>\n> - y",
  c35_h_in_bq: "<blockquote><h2><p>a</p><p>b</p></h2><p>c</p></blockquote>",
  c36_notion: "<!-- notionvc: 123 -->\n\n<blockquote><p>a\nb</p><p>c\nd</p></blockquote>",
  c37_ws_only_p: "<blockquote><p> </p><p>&nbsp;</p><p>x</p></blockquote>",
  c38_br_trailing: "<blockquote><p>a<br></p><p>b<br><br></p><p>c</p></blockquote>",
  c39_hr_between: "<blockquote><p>a</p><hr><p>b</p></blockquote>",
  c40_img_between: "<blockquote><p>a</p><img src=\"/api/uploads/x\"><p>b</p></blockquote>",
  c41_text_between: "<blockquote><p>a</p>mid<p>b</p></blockquote>",
  c42_pre_nocode_bq: "<pre><blockquote><p>a</p><p>b</p></blockquote></pre>",
  c43_pre_in_bq: "<blockquote><p>a</p><pre><p>b</p><p>c</p></pre></blockquote>",
  c44_anchor_wrap: '<blockquote><a href="http://x.com"><p>a</p><p>b</p></a></blockquote>',
  c45_mxss1: "> a\n>\n> b\n\n<svg><p><style><img src=x></style></p></svg>",
  c46_mxss2: "> a\n>\n> b\n\n<math><mtext><table><mglyph><svg><mtext><p>x</p></mtext></svg></mglyph></table></mtext></math>",
  c47_form_nest: "> a\n>\n> b\n\n<form><div></form><p>x</p>",
  c48_mermaid: "> a\n>\n> b\n\n```mermaid\ngraph TD; A-->B\n```\n\n```\n\n  indented\n```",
  c49_codefence_in_bq: "> a\n>\n> ```\n> <p>x</p>\n> ```\n>\n> b",
  c50_bq_with_checklist: "> - [ ] a\n>\n>   b\n>\n> - [x] c",
  c51_details_open_attr: '<details open><summary style="color:red"><p>a</p><p>b</p></summary></details>',
  c52_h_in_li_first: "<ul><li><h2><p>a</p><p>b</p></h2><p>c</p></li></ul>",
  c53_ol_in_bq_start: "<blockquote><ol start=\"3\"><li><p>a</p></li><li><p>b</p></li></ol></blockquote>",
  c54_details_no_summary_bq: "<details><blockquote><p>a</p><p>b</p></blockquote></details>",
  c55_summary_in_h: "<h2><details><summary><p>a</p><p>b</p></summary></details></h2>",
  c56_summary_nested_in_summary: "<details><summary><details><summary><p>a</p><p>b</p></summary></details><p>c</p></summary></details>",
  c57_entities: "<blockquote><p>&lt;b&gt; &amp;amp; &quot;</p><p>&#x1F600; &nbsp;x</p></blockquote>",
  c58_wikilink: "> [[A]]\n>\n> [x](/notes/11111111-1111-4111-8111-111111111111)",
  c59_figure_bq_no_img: "<figure><figcaption>cap</figcaption><blockquote><p>a</p><p>b</p></blockquote></figure>",
  c60_video_bq: '<video src="/api/uploads/v.mp4"><blockquote><p>a</p><p>b</p></blockquote></video>',
};
Object.assign(REVIEW_CASES, {
  f1_bq_multiline: "<blockquote>\n<p>a</p>\n<p>b</p>\n</blockquote>",
  f2_bq_multiline_inline_after: "<blockquote>\n<p>a</p>\n<p>b</p>\n<em>x</em>\n</blockquote>",
  f3_h2_multiline: "<h2>\n<p>a</p>\n<p>b</p>\n</h2>",
  f4_summary_multiline: "<details>\n<summary>\n<p>a</p>\n<p>b</p>\n</summary>\n\nchild\n\n</details>",
  f5_bq_indented: "<blockquote>\n  <p>first</p>\n  <p>second</p>\n  <p>third</p>\n</blockquote>",
  g1_pre_code_bq: "<pre><code><blockquote><p>a</p>\n<p>b</p></blockquote></code></pre>",
  g2_pre_bq_ws: "<pre><blockquote>\n<p>a</p>\n<p>b</p>\n</blockquote></pre>",
  g3_dct_internal: '<div class="bn-block-content" data-content-type="quote"><blockquote class="bn-inline-content"><p>a</p><p>b</p></blockquote></div>',
  g4_dct_span_plus_bq: '<p><span data-content-type="zzz">y</span></p><blockquote><p>a</p><p>b</p></blockquote>',
  g5_loose_summary_ws: "<summary>\n<blockquote>\n<p>a</p>\n<p>b</p>\n</blockquote>\n</summary>",
});

/** A paragraph inside a paragraph: `parseMarkdownForNote` rejects the whole write (`nested_paragraph`), so no equivalence comparison. */
const NESTED_P = new Set(["c24_button_nested_first", "c25_button_nested_later", "c26_marquee", "c27_foreignobject", "c28_mtext"]);

/** This file's shapes: [name, markdown, whether merging should change the HTML]. */
const CASES: Array<[string, string, boolean]> = [
  ["two paragraphs", "> a\n>\n> b", true],
  ["inline formatting", "> **bold** x _i_ ~~s~~ `c`\n>\n> [link](http://example.com) and **b _bi_**", true],
  ["colored text and colored quote", '> <span style="color:red">red</span> x\n>\n> <span style="background-color:yellow">bg</span>\n\n<blockquote data-text-color="red"><p>a</p><p><strong>b</strong></p></blockquote>', true],
  ["empty paragraph (HTML)", "<blockquote><p>a</p><p></p><p>b</p><p></p></blockquote>", true],
  ["line break inside a paragraph", "> a\\\n> b\n>\n> c  \n> d", true],
  ["nested quote", "> a\n>\n> > b\n> >\n> > c\n>\n> d", true],
  ["loose list inside a quote", "> a\n>\n> - x\n>\n> - y\n>\n> b", true],
  ["heading and code inside a quote", "> # H\n>\n> p\n>\n> ```\n> code\n> ```\n>\n> q", true],
  ["multiple paragraphs under a heading (HTML)", '<h2><p>a</p><p><b>b</b> <a href="http://example.com">l</a></p></h2>', true],
  ["quote inside a list item", "- item\n\n  > a\n  >\n  > b\n\n- next", true],
  ["quote inside details", "<details><summary>s</summary>\n\n> a\n>\n> b\n\n</details>", true],
  ["multiple paragraphs in summary", "<details><summary><p>a</p><p><strong>b</strong></p></summary>\n\nchild\n\n</details>", true],
  ["summary nested in details", "<details><summary><p>a</p><p>b</p></summary><details><summary><p>c</p><p>d</p></summary><p>e</p></details></details>", true],
  ["a second summary is not that line (not merged)", "<details><summary>s</summary><p>x</p><summary><p>a</p><p>b</p></summary></details>", false],
  ["quote inside a table cell", "<table><tr><td><blockquote><p>a</p><p>b</p></blockquote></td><td>x</td></tr></table>", true],
  ["quote inside a column", '<div data-kb-columns style="display:flex;gap:16px">\n<div data-kb-column style="flex:1">\n\n> a\n>\n> b\n\n</div>\n<div data-kb-column style="flex:1">\n\nX\n\n</div>\n</div>', true],
  ["quote inside pre (merged anyway)", "<pre><blockquote><p>a</p><p>b</p></blockquote></pre>", true],
  ["other content unaffected by re-serialization", "```\n\ncode & <x> \"q\"\n```\n\n<pre>\nlead</pre>\n\n> a&nbsp;&amp;\n>\n> &lt;b&gt; <!-- c -->\n\n| h | i |\n|---|---|\n| 1 | 2 |\n\n![alt](/api/uploads/x)\n\n```mermaid\ngraph TD; A-->B\n```", true],
  ["image and links inside a quote", `> a\n>\n> ![alt](/api/uploads/x)\n>\n> [[A]] and [x](/notes/${ID})`, true],
  ["single paragraph (nothing to merge)", "> only one", false],
  // #398: `<plaintext>` makes re-parsing after serialization non-equivalent, so nothing is premerged when it is present.
  ["<plaintext> after a quote (not premerged)", "> a\n>\n> b\n\n<plaintext>z", false],
  ["<plaintext> inside the second paragraph of a quote (not premerged)", "<blockquote><p>a</p><p>b<plaintext>z</p></blockquote>", false],
  ["<plaintext> after a heading (not premerged)", "<h2><p>a</p><p>b</p></h2>\n\ntext\n\n<plaintext>z <b>y</b>", false],
  ["whitespace in multi-line HTML", "<blockquote>\n<p>a</p>\n<p>b</p>\n</blockquote>", true],
  ["multi-line HTML paragraphs followed by an inline element", "<blockquote>\n<p>a</p>\n<p>b</p>\n<em>x</em>\n</blockquote>", true],
  ["quote inside figcaption (left alone)", '<figure><img src="/api/uploads/x"><figcaption><blockquote><p>a</p>\n<p>b</p></blockquote></figcaption></figure>', false],
  ["quote with a child carrying data-content-type (merged anyway)", '<blockquote><p><span data-content-type="zzz">y</span></p><p>b</p></blockquote>', true],
  ["quote under a summary that is not inside details (merged)", "<summary><blockquote><p>a</p><p>b</p></blockquote></summary>", true],
];

describe("premergeInto: merged and unmerged give identical blocks (70 shapes)", () => {
  for (const [name, md] of Object.entries(REVIEW_CASES)) {
    if (NESTED_P.has(name)) continue;
    it(name, async () => {
      const html = htmlOf(md);
      const merged = premergeParagraphs(html);
      const [a, b] = await withEditor(ed => [blocksOf(ed, html), blocksOf(ed, merged)]);
      expect(b).toBe(a);
    });
  }
  it("the 5 shapes with a paragraph inside a paragraph -> parseMarkdownForNote rejects the whole write with nested_paragraph", async () => {
    for (const name of NESTED_P) {
      const r = await withEditor(ed => parseMarkdownForNote(ed, REVIEW_CASES[name]!, cands, ORIGIN));
      expect(r, name).toEqual({ error: "unsupported_block", detail: "nested_paragraph" });
    }
  });
});

describe("premergeInto: merged and unmerged give identical blocks (this file's shapes)", () => {
  for (const [name, md, shouldChange] of CASES) {
    it(name, async () => {
      const html = htmlOf(md);
      const merged = premergeParagraphs(html);
      if (shouldChange) expect(merged, "前提：真的有要併的").not.toBe(html);
      else expect(merged).toBe(html);
      const [a, b] = await withEditor(ed => [blocksOf(ed, html), blocksOf(ed, merged)]);
      expect(b).toBe(a);
    });
  }

  it("large quote with mixed formatting (200 paragraphs, alternating bold/link/colored text/empty paragraph/line break)", async () => {
    const kinds = [
      (k: number) => `<p><strong>b${k}</strong> t</p>`,
      (k: number) => `<p><a href="http://example.com/${k}">l${k}</a></p>`,
      (k: number) => `<p><span style="color:red">c${k}</span></p>`,
      () => "<p></p>",
      (k: number) => `<p>x${k}<br>y${k}</p>`,
    ];
    const html = "<blockquote>\n" + Array.from({ length: 200 }, (_, k) => kinds[k % kinds.length]!(k)).join("\n") + "\n</blockquote>";
    const merged = premergeParagraphs(html);
    expect(merged).not.toBe(html);
    const [a, b] = await withEditor(ed => [blocksOf(ed, html), blocksOf(ed, merged)]);
    expect(b).toBe(a);
  }, 60_000);
});

const ps = (n: number, pre = "q") => Array.from({ length: n }, (_, k) => `<p>${pre}${k}</p>`).join("");
const mdq = (n: number) => Array.from({ length: n }, (_, k) => `> q${k}\n>`).join("\n");
/**
 * Shapes that were quadratic and took tens of seconds before the fix. After the fix, compare 1/8 of the paragraph count with the full count on the scale and
 * require a ratio < 24 (linear is about 8-16, quadratic about 64) rather than absolute milliseconds (`expectLinear`); a full run under 250 ms passes outright, and there is also an absolute cap (`maxMs`, 30 s by default in perf-helpers.ts).
 */
const SLOW: Array<[string, (n: number) => string, number, "ok" | "nested_paragraph"]> = [
  ["2 000 blockquote paragraphs (Markdown)", n => mdq(n), 2000, "ok"],
  ["2 000 paragraphs under <h2>", n => "<h2>" + ps(n, "h") + "</h2>", 2000, "ok"],
  ["2 000 paragraphs under <details><summary>", n => "<details><summary>" + ps(n, "s") + "</summary>\n\nchild\n\n</details>", 2000, "ok"],
  ["the string data-content-type appears somewhere in the text", n => "This note talks about data-content-type attributes.\n\n" + mdq(n), 2000, "ok"],
  ["wrapped in <pre>", n => "<pre><blockquote>" + ps(n) + "</blockquote></pre>", 2000, "ok"],
  ["wrapped in <pre><code>", n => "<pre><code><blockquote>" + ps(n) + "</blockquote></code></pre>", 2000, "ok"],
  ["<summary> outside details", n => "<summary><blockquote>" + ps(n) + "</blockquote></summary>", 2000, "ok"],
  ["blockquote with a child element carrying data-content-type", n => '<blockquote><p><span data-content-type="zzz">y</span></p>' + ps(n) + "</blockquote>", 2000, "ok"],
  ["1 000 paragraphs nested via <button> in a top-level <p>", n => "<p>a<button>" + ps(n) + "</button></p>", 1000, "nested_paragraph"],
  ["1 000 paragraphs nested via <math><mtext> in a top-level <p>", n => "<p>a<math><mtext>" + ps(n) + "</mtext></math></p>", 1000, "nested_paragraph"],
  ["2 000 paragraphs nested via <button> in a <p> inside a blockquote", n => "<blockquote><p>a<button>" + ps(n) + "</button></p><p>z</p></blockquote>", 2000, "nested_paragraph"],
];
describe("timing: shapes that were quadratic and took over 20 seconds before the fix are linear after it", () => {
  for (const [name, mdOf, size, want] of SLOW) {
    it(name, async () => {
      await expectLinear(
        name,
        n =>
          withEditor(ed => {
            const t = performance.now();
            const r = parseMarkdownForNote(ed, mdOf(n), cands, ORIGIN);
            const ms = performance.now() - t;
            if (want === "ok") expect(r).not.toHaveProperty("error");
            else expect(r).toEqual({ error: "unsupported_block", detail: want });
            return ms;
          }),
        size
      );
    }, 240_000);
  }
});

describe("nesting depth limit", () => {
  const bq = (d: number) => "<blockquote><p>a</p>".repeat(d) + "</blockquote>".repeat(d);
  it(`DOM depth of exactly ${MAX_HTML_DEPTH} is writable, ${MAX_HTML_DEPTH + 1} is rejected (each quote level counts 1, the <p> inside counts 1 more: d quote levels = depth d+1)`, async () => {
    expect(MAX_HTML_DEPTH).toBe(128);
    const ok = await withEditor(ed => parseMarkdownForNote(ed, bq(MAX_HTML_DEPTH - 1), cands, ORIGIN));
    expect(ok).not.toHaveProperty("error");
    const over = await withEditor(ed => parseMarkdownForNote(ed, bq(MAX_HTML_DEPTH), cands, ORIGIN));
    expect(over).toEqual({ error: "unsupported_block", detail: "too_deep" });
    const mdOk = await withEditor(ed => parseMarkdownForNote(ed, "> ".repeat(MAX_HTML_DEPTH - 1) + "a", cands, ORIGIN));
    expect(mdOk).not.toHaveProperty("error");
    const mdOver = await withEditor(ed => parseMarkdownForNote(ed, "> ".repeat(MAX_HTML_DEPTH) + "a", cands, ORIGIN));
    expect(mdOver).toEqual({ error: "unsupported_block", detail: "too_deep" });
  }, 60_000);

  it("normal deep content is unaffected: list nested 60 levels, list + details + table inside a column", async () => {
    const list60 = Array.from({ length: 60 }, (_, k) => "  ".repeat(k) + `- d${k}`).join("\n");
    const cols =
      '<div data-kb-columns style="display:flex;gap:16px">\n<div data-kb-column style="flex:1">\n\n' +
      Array.from({ length: 10 }, (_, k) => "  ".repeat(k) + `- d${k}`).join("\n") +
      '\n\n</div>\n<div data-kb-column style="flex:1">\n\n<details><summary>s</summary>\n\n<table><tr><td><p><strong><em><a href="x"><span style="color:red">x</span></a></em></strong></p></td></tr></table>\n\n</details>\n\n</div>\n</div>';
    for (const md of [list60, cols]) {
      const r = await withEditor(ed => parseMarkdownForNote(ed, md, cands, ORIGIN));
      expect(r).not.toHaveProperty("error");
    }
  }, 60_000);

  it("#398: `<T>` (generics) inside a code block does not count as nesting: a code block with 600 `<T>` still parses successfully (the old string estimate would say too_deep)", async () => {
    const md = "```ts\n" + "let x: Array<T> = f<T>();\n".repeat(300) + "```";
    const r = await withEditor(ed => parseMarkdownForNote(ed, md, cands, ORIGIN));
    expect(r).not.toHaveProperty("error");
    expect((r as { blocks: Array<{ type: string }> }).blocks.map(b => b.type)).toEqual(["codeBlock"]);
  }, 60_000);
  // Quotes thousands of levels deep (the shapes the old string estimate before the syntax check used to block) are now covered by the worker's time limit and stack limit: see `parse-pool-worker.test.ts`.
});
