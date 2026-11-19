import { describe, expect, it } from "vitest";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { normalizeBody } from "../../src/transfer/normalize.js";
import { BOUNDARY_ADJ_MAX_CHARS, fenceParseStats, stripClosedComments, trailingOpenFenceLine, type Region } from "../../src/transfer/regions.js";
import { TRANSFER_SHAPES } from "./fixtures/transfer-shapes.js";
import { docWith, makeBaseInMemory, realBoundaryCheck, regionsOf, type InMemoryBase } from "./fixtures/transfer-sync.js";
import { expectLinear } from "../perf-helpers.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();
const check = realBoundaryCheck(rt);

const P = (t: string) => ({ type: "paragraph", content: t });
const EMPTY = { type: "paragraph" };
const BL = (t: string, extra: Record<string, unknown> = {}) => ({ type: "bulletListItem", content: t, ...extra });
const NL = (t: string, props: Record<string, unknown> = {}) => ({ type: "numberedListItem", content: t, props });
const base = async (blocks: unknown[]) => makeBaseInMemory(rt, await docWith(rt, blocks));
const exportOf = async (block: unknown) => normalizeBody((await base([block])).body);
/** A file downloaded before #386: a text line that is just ``` is not escaped (the base is computed from that file). */
const legacyFenceBase = async () => makeBaseInMemory(rt, await docWith(rt, [P("A"), P("```"), P("B")]), new Map(), "T", l => (l === "\\`\\`\\`" ? "```" : l));
const summary = (b: InMemoryBase, regions: Region[]) => regions.map(r => ({ kind: r.kind, idx: r.baseIds.map(id => b.ids.indexOf(id)), text: r.text }));
const ok = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => {
  if (!r.ok) throw new Error(`not ok: ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
};

describe("boundary table (real parser; true = not merged)", () => {
  const TEXT = "文字";
  const blocks: Record<string, unknown> = {
    paragraph: P("Para"),
    quote: { type: "quote", content: "q" },
    // The canonical form of image is the markdown form (no caption, no width -> `![](...)`); one with a caption or width is exported as `<figure>` HTML, with two more cases listed separately (not merged)
    image: { type: "image", props: { url: "/api/uploads/u1" } },
    figure: { type: "image", props: { url: "/api/uploads/u1", caption: "cap" } },
    heading: { type: "heading", content: "H", props: { level: 2 } },
    code: { type: "codeBlock", props: { language: "js" }, content: "x = 1" },
    mermaid: { type: "mermaid", props: { code: "graph TD; a-->b" } },
    table: { type: "table", content: { type: "tableContent", rows: [{ cells: ["a", "b"] }, { cells: ["1", "2"] }] } },
    divider: { type: "divider" },
    columns: { type: "columnList", children: [{ type: "column", props: { width: 1 }, children: [P("c1")] }, { type: "column", props: { width: 1 }, children: [P("c2")] }] },
    bullet: BL("item"),
  };
  const rows: Array<[string, string, string, "before" | "after", boolean]> = [
    ["paragraph + text -> merge", "paragraph", TEXT, "after", false],
    ["quote + text -> merge (lazy)", "quote", TEXT, "after", false],
    ["image + text -> merge", "image", TEXT, "after", false],
    ["heading + text -> no merge", "heading", TEXT, "after", true],
    ["code + text -> no merge", "code", TEXT, "after", true],
    ["mermaid + text -> no merge", "mermaid", TEXT, "after", true],
    ["table + text -> no merge", "table", TEXT, "after", true],
    ["table + new row -> merge", "table", "| 3 | 4 |", "after", false],
    ["divider + text -> no merge", "divider", TEXT, "after", true],
    ["columns + text -> no merge", "columns", TEXT, "after", true],
    ["list item + unindented text -> no merge", "bullet", TEXT, "after", true],
    ["list item + indented text -> merge (child block)", "bullet", "  more", "after", false],
    ["paragraph + any numbered list line (A, newline, 2. x) -> no merge", "paragraph", "2. x", "after", true],
    ["text + paragraph -> merge", "paragraph", TEXT, "before", false],
    ["text + > q -> no merge", "quote", TEXT, "before", true],
    ["text + image -> merge", "image", TEXT, "before", false],
    ["text + # H -> no merge", "heading", TEXT, "before", true],
    ["text + fence -> no merge", "code", TEXT, "before", true],
    ["text + mermaid fence -> no merge", "mermaid", TEXT, "before", true],
    ["text + table -> no merge", "table", TEXT, "before", true],
    ["text + divider (***) -> no merge", "divider", TEXT, "before", true],
    ["text + columns -> no merge", "columns", TEXT, "before", true],
    ["text + list item -> no merge", "bullet", TEXT, "before", true],
    ["(outside the table) `<figure>` image + text -> no merge", "figure", TEXT, "after", true],
    ["(outside the table) text + `<figure>` image -> no merge", "figure", TEXT, "before", true],
  ];
  it.each(rows)("%s", async (_n, kind, adj, side, want) => {
    const k = await exportOf(blocks[kind]);
    expect(await check(k, adj, side)).toBe(want);
  });
  it("numbered: a changed `1. a2` + an unchanged `2. b` -> no merge; `1. new` + an unchanged `2. b` -> no merge (start is ignored)", async () => {
    expect(await check("2. b", "1. a2", "before")).toBe(true);
    expect(await check("2. b", "1. new", "before")).toBe(true);
    expect(await check("1. a", "2. b2", "after")).toBe(true);
  });
  it("parse failure -> false (an unterminated `<!--` swallows k)", async () => {
    expect(await check("B", "<!--", "before")).toBe(false);
  });
});

describe("the three triggering shapes and the non-triggering case", () => {
  it("inserting right up against A: a line added after A without a blank line -> A is merged, 1 check", async () => {
    const b = await base([P("A"), P("B")]);
    const r = ok(await regionsOf(rt, b, "A\nX\n\nB"));
    expect(summary(b, r.regions)).toEqual([{ kind: "rewrite", idx: [0], text: "A\nX" }]);
    expect(r.boundaryChecks).toBe(1);
  });
  it("deleting the separator line between two paragraphs -> each paragraph is checked once, both merged", async () => {
    const b = await base([P("A"), P("B")]);
    const r = ok(await regionsOf(rt, b, "A\nB"));
    expect(summary(b, r.regions)).toEqual([{ kind: "rewrite", idx: [0, 1], text: "A\nB" }]);
    expect(r.boundaryChecks).toBe(2);
  });
  it("deleting the middle item of a 0-line-separated list -> the items before and after are each checked once, neither merged, one deletion region", async () => {
    const b = await base([BL("a"), BL("b"), BL("c")]);
    const r = ok(await regionsOf(rt, b, "* a\n* c"));
    expect(summary(b, r.regions)).toEqual([{ kind: "delete", idx: [1], text: "" }]);
    expect(r.boundaryChecks).toBe(2);
  });
  it("a list where only the last item changed -> only 1 check (the adjacent line is the pairing of the base's adjacent line -> no check)", async () => {
    const b = await base([BL("a"), BL("b"), BL("c")]);
    const r = ok(await regionsOf(rt, b, "* a\n* b\n* c2"));
    expect(summary(b, r.regions)).toEqual([{ kind: "rewrite", idx: [2], text: "* c2" }]);
    expect(r.boundaryChecks).toBe(1);
  });
  it("the adjacent line is blank -> not triggered", async () => {
    const b = await base([P("A"), P("B")]);
    const r = ok(await regionsOf(rt, b, "A\n\nX\n\nB"));
    expect(summary(b, r.regions)).toEqual([{ kind: "insert", idx: [], text: "X" }]);
    expect(r.boundaryChecks).toBe(0);
  });
});

describe("no iteration", () => {
  it("three paragraphs, a line pasted after the first only -> only the first is merged", async () => {
    const b = await base([P("a"), P("b"), P("c")]);
    const r = ok(await regionsOf(rt, b, "a\nX\n\nb\n\nc"));
    expect(summary(b, r.regions)).toEqual([{ kind: "rewrite", idx: [0], text: "a\nX" }]);
    expect(r.boundaryChecks).toBe(1);
  });
});

describe("the trigger condition is defined by the text and runs only one round (pins current behaviour)", () => {
  it("0-line-separated list: an indented line pasted after a -> a is merged; b is triggered too (the adjacent line is not the base's adjacent pairing), but judged independently, with no chain reaction from a's merge", async () => {
    const b = await base([BL("a"), BL("b"), BL("c")]);
    const r = ok(await regionsOf(rt, b, "* a\n  more\n* b\n* c"));
    expect(summary(b, r.regions)).toEqual([{ kind: "rewrite", idx: [0], text: "* a\n  more" }]);
    expect(r.boundaryChecks).toBe(2); // a's lower edge and b's upper edge; c's upper edge is the pairing of the base's adjacent line (* b), so it does not trigger
  });
});

describe("unclosed code fence", () => {
  it("an unclosed ``` line added above a 0-line-separated list -> the whole file is unclosed_fence (not just the adjacent item merged into a region)", async () => {
    const b = await base([P("Z"), BL("a"), BL("b"), BL("c")]);
    expect(b.lines).toEqual(["Z", "", "* a", "* b", "* c"]);
    expect(await regionsOf(rt, b, "Z\n\n```\n* a\n* b\n* c")).toMatchObject({ ok: false, code: "unclosed_fence" });
  });
  it("closed fence, longer closing fence, ~~~ as usual; opened with ``` and closed with ~~~ is not closed; ``` inside a comment does not count", async () => {
    const b = await base([P("A"), P("B")]);
    expect((await regionsOf(rt, b, "A\n\n```\ncode\n```\n\nB")).ok).toBe(true);
    expect((await regionsOf(rt, b, "A\n\n```\ncode\n`````\n\nB")).ok).toBe(true);
    expect((await regionsOf(rt, b, "A\n\n~~~\ncode\n~~~\n\nB")).ok).toBe(true);
    expect(await regionsOf(rt, b, "A\n\n```\ncode\n~~~\n\nB")).toMatchObject({ ok: false, code: "unclosed_fence" });
    expect((await regionsOf(rt, b, "A\n\n<!-- ``` -->\n\nB")).ok).toBe(true);
  });
  // Since #386 the exporter escapes backticks in text (a text paragraph of ``` reads out escaped and is no longer a fence); this case is for files downloaded before: the base line is an unescaped ```.
  it("since #386: a text paragraph that is just ``` -> read out escaped, not an unclosed fence", async () => {
    const b = await base([P("A"), P("```"), P("B")]);
    expect(b.lines).toEqual(["A", "", "\\`\\`\\`", "", "B"]);
    expect(trailingOpenFenceLine(b.lines)).toBeNull();
  });
  it("base has a text paragraph that is just ``` (the exporter before #386 did not escape) -> resending the original file is ok (zero regions), changing only B is ok (the opening line falls in an unchanged segment)", async () => {
    const b = await legacyFenceBase();
    expect(b.lines).toEqual(["A", "", "```", "", "B"]);
    expect(trailingOpenFenceLine(b.lines)).toBe(2); // premise: the parser really treats it as code extending to the end of the file
    expect(ok(await regionsOf(rt, b, normalizeBody(b.body))).regions).toEqual([]);
    expect(summary(b, ok(await regionsOf(rt, b, "A\n\n```\n\nB2")).regions)).toEqual([{ kind: "rewrite", idx: [2], text: "B2" }]);
  });
  // After the pre-filter, the previous case does not parse at all; this case lets "a changed line that looks like a fence" pass the pre-filter while the unclosed opening is still in an unchanged segment (~~~x inside ``` code
  // does not close) -> reaches the check "is the opening line in an unchanged segment".
  it("a changed line that looks like a fence but does not change the unclosed state (B -> ~~~x) -> parsed, allowed (the opening is still in an unchanged segment)", async () => {
    const b = await legacyFenceBase();
    fenceParseStats.calls = 0;
    expect(summary(b, ok(await regionsOf(rt, b, "A\n\n```\n\n~~~x")).regions)).toEqual([{ kind: "rewrite", idx: [2], text: "~~~x" }]);
    expect(fenceParseStats.calls).toBe(1);
  });
  it("variant of the pre-#386 case: A, blank, ```, X, blank, B (X directly under the ``` paragraph without a blank line -> that paragraph is merged into the region) -> unclosed_fence", async () => {
    const b = await legacyFenceBase();
    expect(await regionsOf(rt, b, "A\n\n```\nX\n\nB")).toMatchObject({ ok: false, code: "unclosed_fence" });
  });
  it("exact pre-filter: an ordinary write-back (no changed line looks like a fence) does not call the parser; resending the pre-#386 original (``` in an unchanged segment) does not either; the parser is called only when a changed line contains ```", async () => {
    const b = await base([P("A"), P("B")]);
    fenceParseStats.calls = 0;
    expect(ok(await regionsOf(rt, b, "A\n\nB2")).regions).toHaveLength(1);
    expect(fenceParseStats.calls).toBe(0);
    const e6 = await legacyFenceBase();
    expect(ok(await regionsOf(rt, e6, "A\n\n```\n\nB2")).regions).toHaveLength(1);
    expect(fenceParseStats.calls).toBe(0);
    expect(ok(await regionsOf(rt, b, "A\n\n```js\nx\n```\n\nB")).regions).toHaveLength(1);
    expect(fenceParseStats.calls).toBe(1);
  });
  it("the agent adds an unclosed ``` line -> rejected", async () => {
    const b = await base([P("A"), P("B")]);
    expect(await regionsOf(rt, b, "A\n\n```\n\nB")).toMatchObject({ ok: false, code: "unclosed_fence" });
  });
  it("a valid fence inside a list item or <div> -> allowed (the parser decides; it does not swallow to the end of the file)", async () => {
    const b = await base([P("A")]);
    expect((await regionsOf(rt, b, "A\n\n- ```js\n  code\n  ```")).ok).toBe(true);
    expect((await regionsOf(rt, b, "A\n\n1. ```\n   x\n   ```")).ok).toBe(true);
    expect((await regionsOf(rt, b, "A\n\n- [ ] ```\n  x\n  ```")).ok).toBe(true);
    expect((await regionsOf(rt, b, "A\n\n<div>\n```\nx\n</div>")).ok).toBe(true);
  });
  it("forms the parser swallows to the end of the file, such as ```x``` and ``` a`b, added by the agent -> rejected", async () => {
    const b = await base([P("A"), P("B")]);
    expect(await regionsOf(rt, b, "A\n\n```x```\n\nB")).toMatchObject({ ok: false, code: "unclosed_fence" });
    expect(await regionsOf(rt, b, "A\n\n``` a`b\n\nB")).toMatchObject({ ok: false, code: "unclosed_fence" });
  });
  it("a fence inside an HTML comment (comment open, fence line, comment close) -> allowed", async () => {
    const b = await base([P("A"), P("B")]);
    expect((await regionsOf(rt, b, "A\n\n<!--\n```\n-->\n\nB")).ok).toBe(true);
  });
});

describe("take the number of blocks from parse(k) (not the number of ids)", () => {
  it("a 1-id segment with flattened children (a bullet with a paragraph child) + text pasted in front -> not merged", async () => {
    const b = await base([P("Z"), BL("a", { children: [P("child")] }), P("Y")]);
    const seg = b.base.segments![1]!;
    expect(seg.ids).toHaveLength(1); // premise: a 1-id segment whose per-block export is 3 lines (parses into 2 blocks)
    expect(seg.count).toBe(3);
    const r = ok(await regionsOf(rt, b, "Z\n\nX\n* a\n\nchild\n\nY"));
    expect(summary(b, r.regions)).toEqual([{ kind: "insert", idx: [], text: "X" }]);
    expect(r.boundaryChecks).toBe(1);
  });
});

describe("an empty-paragraph segment is not boundary-checked", () => {
  it("A, empty paragraph, B: inserting X right next to the empty paragraph without a blank line -> one insertion region, no check, no 400", async () => {
    const b = await base([P("A"), EMPTY, P("B")]);
    expect(b.lines).toEqual(["A", "", "", "", "B"]); // premise: the empty paragraph in the middle takes one blank line
    const r = ok(await regionsOf(rt, b, "A\n\nX\n\n\nB"));
    expect(summary(b, r.regions)).toEqual([{ kind: "insert", idx: [], text: "X" }]);
    expect(r.boundaryChecks).toBe(0);
  });
  it("an empty heading or empty check item is not a blank line (counter-example)", async () => {
    expect(await exportOf({ type: "heading", content: "", props: { level: 1 } })).not.toBe("");
    expect(await exportOf({ type: "checkListItem", content: "", props: { checked: false } })).not.toBe("");
  });
});

describe("HTML comments", () => {
  it("`<!-- TODO -->` inserted after a blank line -> zero regions", async () => {
    const b = await base([P("A"), P("B")]);
    expect(ok(await regionsOf(rt, b, "A\n\n<!-- TODO -->\n\nB")).regions).toEqual([]);
  });
  it("changing a paragraph into `<!-- B -->` -> one deletion region", async () => {
    const b = await base([P("A"), P("B")]);
    expect(summary(b, ok(await regionsOf(rt, b, "A\n\n<!-- B -->")).regions)).toEqual([{ kind: "delete", idx: [1], text: "" }]);
  });
  it("a file left with only comments -> empty_content; a blank file -> empty_content", async () => {
    const b = await base([P("A")]);
    expect(await regionsOf(rt, b, "<!-- x -->\n\n<!-- y -->")).toMatchObject({ ok: false, code: "empty_content" });
    expect(await regionsOf(rt, b, "  \n\n")).toMatchObject({ ok: false, code: "empty_content" });
  });
  it("inline `a <!-- c --> b` -> a rewrite region (text verbatim, left to parse)", async () => {
    const b = await base([P("A"), P("B")]);
    expect(summary(b, ok(await regionsOf(rt, b, "A\n\nB <!-- c --> b")).regions)).toEqual([{ kind: "rewrite", idx: [1], text: "B <!-- c --> b" }]);
  });
  it("an unterminated `<!--` pasted above an unchanged segment -> that segment is merged (the write side decides the 400)", async () => {
    const b = await base([P("A"), P("B")]);
    expect(summary(b, ok(await regionsOf(rt, b, "A\n\n<!--\nB")).regions)).toEqual([{ kind: "rewrite", idx: [1], text: "<!--\nB" }]);
  });
  it("stripClosedComments", () => {
    expect(stripClosedComments("a<!--x-->b<!--y")).toBe("ab<!--y");
    expect(stripClosedComments("<!-- a\nb -->c")).toBe("c");
  });
});

describe("the three region kinds and their text", () => {
  const B3 = [P("a"), P("b"), P("c")];
  it.each([
    ["change one paragraph", "a\n\nB\n\nc", [{ kind: "rewrite", idx: [1], text: "B" }]],
    ["two adjacent paragraphs", "A\n\nB\n\nc", [{ kind: "rewrite", idx: [0, 1], text: "A\n\nB" }]],
    ["insert between paragraphs", "a\n\nb\n\nX\n\nc", [{ kind: "insert", idx: [], text: "X" }]],
    ["delete a paragraph", "a\n\nc", [{ kind: "delete", idx: [1], text: "" }]],
    ["rewrite the whole text (one region)", "x\n\ny", [{ kind: "rewrite", idx: [0, 1, 2], text: "x\n\ny" }]],
    ["only blank lines inserted (zero regions)", "a\n\n\n\nb\n\n\nc", []],
  ])("%s", async (_n, agentBody, want) => {
    const b = await base(B3);
    expect(summary(b, ok(await regionsOf(rt, b, agentBody as string)).regions)).toEqual(want);
  });
  it("positive case: a, b, a with the first a deleted -> the common suffix is stripped, the removed one is A1 (id correct)", async () => {
    const b = await base([P("a"), P("b"), P("a")]);
    expect(b.lines).toEqual(["a", "", "b", "", "a"]);
    expect(summary(b, ok(await regionsOf(rt, b, "b\n\na")).regions)).toEqual([{ kind: "delete", idx: [0], text: "" }]);
  });
  it("ambiguous shape: a, x, a keeping only a -> the prefix is stripped: A1 stays, X and A2 are removed (if the agent meant to delete the first a: same content, different id)", async () => {
    const b = await base([P("a"), P("x"), P("a")]);
    expect(summary(b, ok(await regionsOf(rt, b, "a")).regions)).toEqual([{ kind: "delete", idx: [1, 2], text: "" }]);
  });
});

describe("numbered", () => {
  it("inserting an item in the middle and renumbering -> only one insertion region", async () => {
    const b = await base([NL("a"), NL("b"), NL("c")]);
    expect(b.lines).toEqual(["1. a", "2. b", "3. c"]);
    expect(summary(b, ok(await regionsOf(rt, b, "1. a\n2. new\n3. b\n4. c")).regions)).toEqual([{ kind: "insert", idx: [], text: "2. new" }]);
  });
  it("`1.` -> `2.` inside a code block counts as a change", async () => {
    const b = await base([{ type: "codeBlock", props: { language: "" }, content: "1. x" }]);
    const body = normalizeBody(b.body);
    expect(ok(await regionsOf(rt, b, body.replace("1. x", "2. x"))).regions.map(r => r.kind)).toEqual(["rewrite"]);
  });
  it("changing the start number in either direction -> zero regions", async () => {
    const b5 = await base([NL("a", { start: 5 }), NL("b")]);
    expect(b5.lines).toEqual(["5. a", "6. b"]);
    expect(ok(await regionsOf(rt, b5, "1. a\n2. b")).regions).toEqual([]);
    const b1 = await base([NL("a"), NL("b")]);
    expect(ok(await regionsOf(rt, b1, "5. a\n6. b")).regions).toEqual([]);
  });
});

describe("overflow", () => {
  const blocks = [P("X0"), P("S"), P("S"), P("X1"), ...Array.from({ length: 6 }, (_, i) => P(`U${i}`))];
  const agentBody = ["Y0", "S", "S", "Y1", ...Array.from({ length: 6 }, (_, i) => `U${i}`)].join("\n\n");
  it("no overflow: only the changed paragraphs become regions (two regions)", async () => {
    const b = await base(blocks);
    const r = ok(await regionsOf(rt, b, agentBody));
    expect(r.diff.overflow).toBe(false);
    expect(summary(b, r.regions)).toEqual([
      { kind: "rewrite", idx: [0], text: "Y0" },
      { kind: "rewrite", idx: [3], text: "Y1" },
    ]);
  });
  it("overflow with a degraded sub-section: only the paragraphs inside the degraded sub-section merge into a rewrite region (including the unchanged S, S made of repeated lines)", async () => {
    const b = await base(blocks);
    const r = ok(await regionsOf(rt, b, agentBody, { maxD: 2 }));
    expect(r.diff.overflow).toBe(true);
    expect(r.diff.degradedLines).toBe(7);
    expect(summary(b, r.regions)).toEqual([{ kind: "rewrite", idx: [0, 1, 2, 3], text: "Y0\n\nS\n\nS\n\nY1" }]);
  });
  it("overflow with anchors: anchored paragraphs are still judged unchanged", async () => {
    const many = Array.from({ length: 30 }, (_, i) => P(`L${i}`));
    const b = await base(many);
    const body = Array.from({ length: 30 }, (_, i) => (i === 3 || i === 20 ? `L${i} changed` : `L${i}`)).join("\n\n");
    const r = ok(await regionsOf(rt, b, body, { maxD: 2 }));
    expect(r.diff.overflow).toBe(true);
    expect(r.diff.anchored).toBeGreaterThan(0);
    expect(summary(b, r.regions)).toEqual([
      { kind: "rewrite", idx: [3], text: "L3 changed" },
      { kind: "rewrite", idx: [20], text: "L20 changed" },
    ]);
  });
});

describe("types that export only blank lines", () => {
  it("129 shapes: per-segment export is [] or all blank lines, and all block types are paragraph", async () => {
    let seen = 0;
    for (const shape of TRANSFER_SHAPES) {
      const b = await base(shape.blocks);
      for (const s of b.base.segments ?? []) {
        const lines = b.lines.slice(s.start, s.start + s.count);
        if (!lines.every(l => l.trimEnd() === "")) continue;
        seen++;
        for (const id of s.ids) expect(b.types[b.ids.indexOf(id)], `${shape.name}`).toBe("paragraph");
      }
    }
    expect(seen).toBeGreaterThan(0);
  }, 120_000);
});

describe("#398: limit on boundary checks, linear comment stripping", () => {
  it("an adjoining string over 4 096 characters (BOUNDARY_ADJ_MAX_CHARS) -> not parsed, the segment counts as changed; exactly 4 096 -> parsed as usual", async () => {
    expect(BOUNDARY_ADJ_MAX_CHARS).toBe(4 * 1024);
    const b = await base([P("A"), P("B")]);
    const calls: string[] = [];
    const spy = async (k: string, adj: string, side: "before" | "after") => {
      calls.push(adj);
      return check(k, adj, side);
    };
    const long = "y".repeat(4 * 1024 + 1);
    const r1 = ok(await regionsOf(rt, b, `A\n\n${long}\nB`, { check: spy }));
    expect(calls).toHaveLength(0);
    expect(summary(b, r1.regions)).toEqual([{ kind: "rewrite", idx: [1], text: `${long}\nB` }]);
    const fit = "y".repeat(4 * 1024);
    await regionsOf(rt, b, `A\n\n${fit}\nB`, { check: spy });
    expect(calls).toEqual([fit]);
  });
  it("stripClosedComments gives the same result as the original regex (including unterminated, overlapping, adjacent), and 65 000 `<!--` repetitions run in linear time", async () => {
    const ref = (s: string) => s.replace(/<!--[\s\S]*?-->/g, "");
    for (const s of ["", "a", "<!---->", "<!-->x-->y", "a<!--b-->c<!--d", "<!--<!--x-->-->", "x<!--a-->-->y<!--", "<!--a--><!--b-->c", "<!-- a --\n> b -->c"]) {
      expect(stripClosedComments(s), JSON.stringify(s)).toBe(ref(s));
    }
    await expectLinear("stripClosedComments", n => {
      const t = performance.now();
      expect(stripClosedComments("<!--".repeat(n))).toBe("<!--".repeat(n));
      return performance.now() - t;
    }, 64_000);
  });
});
