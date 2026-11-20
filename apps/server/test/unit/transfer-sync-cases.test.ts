import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { topLevelSnapshot } from "../../src/notes/editing/fingerprint.js";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { matchesBase } from "../../src/transfer/decide.js";
import { exportNoteForTransfer } from "../../src/transfer/export-note.js";
import { bodyLines, normalizeBody } from "../../src/transfer/normalize.js";
import { allBlockIds } from "./fixtures/block-ids.js";
import { applyInMemory, docWith, forkOf, makeBaseInMemory, planInMemory, topOf, withEditor } from "./fixtures/transfer-sync.js";

/**
 * bulk transfer sync cases + overflow and resend scenarios.
 * In-memory fixture: base -> a "human" edits the current state -> the agent edits the file -> planning + one mount applying + `Y.applyUpdate` merge. Each case asserts
 * "the whole-note export after write-back", "the base ids kept (as indexes into the base's top level)" and "the decision marker".
 * Cases whose title says "known limitation" pin a known limitation as it is: if it is improved later, change these cases.
 */

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();

type Ed = Parameters<Parameters<typeof withEditor>[2]>[0];
const P = (t: string, extra: object = {}) => ({ type: "paragraph", content: t, ...extra });
const E = () => ({ type: "paragraph" });
const B = (t: string, extra: object = {}) => ({ type: "bulletListItem", content: t, ...extra });
const N = (t: string, extra: object = {}) => ({ type: "numberedListItem", content: t, ...extra });
const T = (t: string) => ({ type: "toggleListItem", content: t });
const H = (t: string) => ({ type: "heading", content: t, props: { level: 2 } });
const CODE = (t: string) => ({ type: "codeBlock", props: { language: "text" }, content: t });
const red = { props: { backgroundColor: "red" } };
const many = (n: number, f: (i: number) => unknown) => Array.from({ length: n }, (_, i) => f(i));
const trimR = (s: string) => s.replace(/[ \t]+$/, "");
const linesTrim = (s: string) => bodyLines(normalizeBody(s)).map(trimR).join("\n");

interface Outcome {
  error: string | null;
  final: string | null;
  eqAgent: boolean;
  kept: number[];
  marks: string[];
  top: Array<{ id: string; text: string; type: string }>;
  baseIds: string[];
  uniqueIds: boolean;
}

async function run(blocks: unknown[], edit: (body: string) => string, human: ((ed: Ed) => void) | null = null, opts: { maxD?: number } = {}): Promise<Outcome> {
  const doc = await docWith(rt, blocks);
  const b = await makeBaseInMemory(rt, doc);
  if (b.base.segments === null) throw new Error("base not_mergeable");
  const live = forkOf(doc);
  if (human) await withEditor(rt, live, human);
  const agent = edit(b.body);
  // same as `syncFileInQueue`: the current state and the base segment table differ block by block -> 409 `note_changed` for the whole note, no planning, no applying.
  if (!matchesBase(b.base.segments, topLevelSnapshot(live.getXmlFragment(YDOC_FRAGMENT)))) return { error: "note_changed", final: null, eqAgent: false, kept: [], marks: [], top: topOf(live), baseIds: b.ids, uniqueIds: true };
  const planned = await planInMemory(rt, b, agent, forkOf(live), opts);
  if (!planned.ok) return { error: planned.code, final: null, eqAgent: false, kept: [], marks: [], top: topOf(live), baseIds: b.ids, uniqueIds: true };
  const r = await applyInMemory(rt, b, agent, live, opts);
  const final = (await exportNoteForTransfer(rt, live, new Map())).body;
  const top = topOf(live);
  const after = new Set(top.map(x => x.id));
  const ids = allBlockIds(live);
  return {
    uniqueIds: new Set(ids).size === ids.length,
    error: null,
    final,
    eqAgent: linesTrim(final) === linesTrim(agent),
    kept: b.ids.map((id, i) => (after.has(id) ? i : -1)).filter(i => i >= 0),
    marks: r.plan.decisions.map(d => `${d.kind}:${d.mark}`),
    top,
    baseIds: b.ids,
  };
}
const NB = [N("a"), N("b"), N("c"), N("d")];
const N12 = many(12, i => N(`n${i + 1}`, i === 8 ? { children: [B("child")] } : {}));
/** Insert `1. new` at the top, renumber the rest; with `reindent`, two-digit items get one more space of indentation on child lines. */
const renum = (reindent: boolean) => (w: string) => {
  const o: string[] = ["1. new"];
  let cur = 0;
  for (const l of bodyLines(w)) {
    const m = /^(\d+)\. (.*)$/.exec(l);
    if (m) {
      cur = Number(m[1]) + 1;
      o.push(`${cur}. ${m[2]}`);
    } else o.push(reindent && cur >= 10 && /^ {3}\S/.test(l) ? ` ${l}` : l);
  }
  return o.join("\n");
};
const PS = many(6, i => P(`p${i}`));
const all = (n: number) => many(n, i => i) as number[];

describe("numbered", () => {
  it("inserting an item in the middle and renumbering -> only an insertion region, other ids unchanged, result = agent file", async () => {
    const o = await run(NB, () => "1. a\n2. new\n3. b\n4. c\n5. d");
    expect(o).toMatchObject({ eqAgent: true, kept: [0, 1, 2, 3], marks: ["insert:applied"] });
  });
  it("deleting a middle item and renumbering -> only a deletion region, other ids unchanged, result = agent file", async () => {
    const o = await run(NB, () => "1. a\n2. c\n3. d");
    expect(o).toMatchObject({ eqAgent: true, kept: [0, 2, 3], marks: ["delete:applied"] });
  });
  it("lazy numbering with every item `1.` -> zero regions, the result is still 1-4", async () => {
    const o = await run(NB, w => w.replace(/^\d+\./gm, "1."));
    expect(o).toMatchObject({ kept: [0, 1, 2, 3], marks: [] });
    expect(linesTrim(o.final!)).toBe("1. a\n2. b\n3. c\n4. d");
  });
  it("(better than expected) 12 items with children under item 9, one inserted at the top and renumbered, child lines re-indented -> item 9's region is judged same, ids all unchanged, result = agent file", async () => {
    const o = await run(N12, renum(true));
    expect(o.kept).toEqual(all(12));
    expect(o.marks).toContain("insert:applied");
    expect(o.marks.filter(m => m !== "insert:applied").every(m => m.endsWith(":same"))).toBe(true);
    expect(o.marks.some(m => m.endsWith(":same"))).toBe(true);
    expect(o.eqAgent).toBe(true);
  });
  it("same, child lines not re-indented -> only an insertion region, ids all unchanged; the result is the canonical export form (!= agent file)", async () => {
    const o = await run(N12, renum(false));
    expect(o).toMatchObject({ kept: all(12), marks: ["insert:applied"], eqAgent: false });
  });
  it("a start-5 list where `5. a` is changed to `1. a` -> zero regions, nothing written (known-limitations)", async () => {
    const o = await run([N("a", { props: { start: 5 } }), N("b")], w => w.replace("5. a", "1. a"));
    expect(o).toMatchObject({ kept: [0, 1], marks: [] });
  });
  it("a numbered item changed to content that still starts with a number -> only that item changes, its id is kept", async () => {
    const o = await run(NB, w => w.replace("3. c", "3. 2024 年"));
    expect(o).toMatchObject({ eqAgent: true, kept: [0, 1, 2, 3], marks: ["rewrite:applied"] });
  });
  it("a numbered item changed to a paragraph -> that item changes; numbering restarts from `1.` after the next item", async () => {
    const o = await run(NB, w => w.replace("3. c", "c 變段落"));
    expect(o).toMatchObject({ kept: [0, 1, 3], marks: ["rewrite:applied"] });
    expect(linesTrim(o.final!)).toBe("1. a\n2. b\n\nc 變段落\n\n1. d");
  });
  it("`2. y` -> `3. y` inside code counts as a change, the code block keeps its id, result = agent file", async () => {
    const o = await run([CODE("1. x\n2. y"), P("after")], w => w.replace("2. y", "3. y"));
    expect(o).toMatchObject({ eqAgent: true, kept: [0, 1], marks: ["rewrite:applied"] });
  });
});

describe("blank lines and empty paragraphs", () => {
  it("A, empty paragraph, B: removing the extra blank lines -> the empty paragraph is deleted", async () => {
    const o = await run([P("A"), E(), P("B")], w => w.replace(/\n{3,}/g, "\n\n"));
    expect(o).toMatchObject({ kept: [0, 2], marks: ["delete:applied"] });
  });
  it("A, two empty paragraphs, B: removing the extra blank lines -> both empty paragraphs are deleted", async () => {
    const o = await run([P("A"), E(), E(), P("B")], w => w.replace(/\n{3,}/g, "\n\n"));
    expect(o.kept).toEqual([0, 3]);
    expect(o.top.map(x => x.text)).toEqual(["A", "B"]);
  });
  it("inserting only blank lines -> zero regions (an empty paragraph cannot be added by inserting blank lines)", async () => {
    const o = await run([P("A"), P("B")], w => w.replace("A\n\nB", "A\n\n\n\nB"));
    expect(o).toMatchObject({ kept: [0, 1], marks: [] });
  });
  it("trailing empty paragraph + adding a paragraph at the end -> the new paragraph goes before the empty paragraph, result = agent file", async () => {
    const o = await run([P("A"), E()], w => `${w.replace(/\n*$/, "")}\n\nnew`);
    expect(o).toMatchObject({ eqAgent: true, kept: [0, 1] });
    expect(o.top.map(x => x.text)).toEqual(["A", "new", ""]);
  });
  it("leading empty paragraph + adding a paragraph at the very top -> the new paragraph goes after the leading empty paragraph (0-line segments stay first)", async () => {
    const o = await run([E(), P("A")], w => `new\n\n${w}`);
    expect(o.kept).toEqual([0, 1]);
    expect(o.top.map(x => x.text)).toEqual(["", "new", "A"]);
  });
  it("CRLF + BOM + trailing whitespace -> zero regions", async () => {
    const o = await run([P("A"), P("B")], w => `\ufeff${w.replace(/\n/g, "  \r\n")}`);
    expect(o).toMatchObject({ kept: [0, 1], marks: [] });
  });
});

describe("child blocks", () => {
  it("adding a child under a bullet -> the parent is rewritten as one region and keeps its id, result = agent file", async () => {
    const o = await run([B("a"), B("b")], w => w.replace("* a\n", "* a\n  * child\n"));
    expect(o).toMatchObject({ eqAgent: true, kept: [0, 1], marks: ["rewrite:applied"] });
  });
  it("moving item 2 under item 1 -> one rewrite region, result = agent file", async () => {
    const o = await run([B("a"), B("b"), B("c")], w => w.replace("* b", "  * b"));
    expect(o).toMatchObject({ eqAgent: true, kept: [2] });
  });
  it("pulling a child out to top level -> one rewrite region, result = agent file", async () => {
    const o = await run([B("a", { children: [B("x")] }), B("b")], w => w.replace("  * x", "* x"));
    expect(o).toMatchObject({ eqAgent: true, kept: [1] });
  });
  it("(known limitation) changing a bullet that has paragraph children -> the child paragraph is flattened to top level, nesting disappears", async () => {
    const o = await run([B("a", { children: [P("child")] }), P("after")], w => w.replace("* a", "* a2"));
    expect(o.kept).toEqual([1]);
    expect(o.top.map(x => `${x.type}:${x.text}`)).toEqual(["bulletListItem:a2", "paragraph:child", "paragraph:after"]);
  });
  it("changing one item of a coloured list -> one region for the whole run, all ids kept (equal text pairs, the edited item pairs between them), result = agent file", async () => {
    const o = await run([B("a", red), B("b"), B("c"), P("after")], w => w.replace("<p>b</p>", "<p>b2</p>"));
    expect(o).toMatchObject({ eqAgent: true, kept: [0, 1, 2, 3], marks: ["rewrite:applied"] });
  });
  it("(known limitation) changing a toggle's content -> it becomes a bullet", async () => {
    const o = await run([T("t1"), T("t2")], w => w.replace("* t1", "* t1x"));
    expect(o.kept).toEqual([1]);
    expect(o.top[0]).toMatchObject({ type: "bulletListItem", text: "t1x" });
  });
});

describe("a note changed since download gets a 409", () => {
  // The in-memory version only checks the structural criterion (`matchesBase`); the whole-note export criterion and the whole-note fingerprint at merge time are in `transfer-write-reread.test.ts` (integration).
  it("a human changes paragraph 5, the agent changes paragraph 2 -> note_changed, the current state untouched", async () => {
    const o = await run(PS, w => w.replace("p1", "p1-agent"), ed => ed.updateBlock(ed.document[4]!.id, { content: "p4-human" }));
    expect(o.error).toBe("note_changed");
    expect(o.top.map(x => x.text)).toEqual(["p0", "p1", "p2", "p3", "p4-human", "p5"]);
  });
  it("a human inserts a paragraph before paragraph 2 -> note_changed", async () => {
    const o = await run(PS, w => w.replace("p1", "p1-agent"), ed => ed.insertBlocks([P("human-new")], ed.document[1]!.id, "before"));
    expect(o.error).toBe("note_changed");
  });
  it("the human also deleted the paragraph the agent deleted -> note_changed (no longer judged same)", async () => {
    const o = await run(PS, w => w.replace("p2\n\n", ""), ed => ed.removeBlocks([ed.document[2]!.id]));
    expect(o.error).toBe("note_changed");
  });
  it("a human replaces a paragraph with a new block of identical content (id changed) -> note_changed (same export, different structure)", async () => {
    const o = await run(PS, w => w.replace("p3", "p3-agent"), ed => {
      const d = ed.document;
      ed.insertBlocks([P("p1")], d[1]!.id, "before");
      ed.removeBlocks([d[1]!.id]);
    });
    expect(o.error).toBe("note_changed");
  });
});

describe("others", () => {
  it("(known limitation) repeated lines: the one deleted is the first", async () => {
    const o = await run([P("dup"), P("x"), P("dup")], w => w.replace("dup\n\nx\n\n", "x\n\n"));
    expect(o.kept).toEqual([1, 2]);
    expect(o.top.map(x => x.text)).toEqual(["x", "dup"]);
  });
  it("rewriting the whole text -> one region, no base id kept, result = agent file", async () => {
    const o = await run(PS, () => "totally\n\nnew");
    expect(o).toMatchObject({ kept: [], eqAgent: true, marks: ["rewrite:applied"] });
  });
  it("a region containing an empty paragraph: change A and delete the empty paragraph -> one region, result = agent file", async () => {
    const o = await run([P("A"), E(), P("B")], w => w.replace(/A\n+B/, "A2\n\nB"));
    expect(o).toMatchObject({ kept: [2], eqAgent: true, marks: ["rewrite:applied"] });
  });
  it("a line added under a heading without a blank line -> inserted, heading id unchanged", async () => {
    const o = await run([H("H"), P("p")], w => w.replace("## H\n", "## H\nnew\n"));
    expect(o).toMatchObject({ kept: [0, 1], marks: ["insert:applied"] });
  });
  it("a line added under a paragraph without a blank line -> merged into that paragraph (it is rewritten, the id is kept)", async () => {
    const o = await run([P("A"), P("B")], w => w.replace("A\n", "A\nmore\n"));
    expect(o).toMatchObject({ kept: [0, 1], marks: ["rewrite:applied"] });
  });
  // Current rule: an insertion region left with only closed comments is not a region, and a rewrite region left with only closed comments is treated as a deletion region.
  it("a newly inserted `<!-- todo -->` forms a paragraph of its own -> not a region (same as inserting only blank lines): zero regions, ids unchanged", async () => {
    const o = await run([P("A"), P("B")], w => w.replace("A\n\nB", "A\n\n<!-- todo -->\n\nB"));
    expect(o).toMatchObject({ error: null, kept: [0, 1], marks: [] });
  });
  it("changing a paragraph into only an HTML comment -> the rewrite region is treated as a deletion region: that paragraph is deleted", async () => {
    const o = await run([P("A"), P("B")], w => w.replace("A\n\nB", "<!-- A -->\n\nB"));
    expect(o).toMatchObject({ error: null, kept: [1], marks: ["delete:applied"] });
    expect(o.top.map(x => x.text)).toEqual(["B"]);
  });
});

describe("overflow and repeated segments", () => {
  const PARAS = (n: number, f: (i: number) => string = i => `Para ${i}`) => many(n, i => P(f(i)));
  it("(known-limitations: repeated segments) two adjacent identical blocks, only one left in the file -> the first is kept; the counter-example is the repeated-lines case above (the second is kept while a segment in between remains)", async () => {
    const o = await run([P("x"), P("dup"), P("dup"), P("y")], w => w.replace("dup\n\ndup", "dup"));
    expect(o.kept).toEqual([0, 1, 3]);
    expect(o.top.map(x => x.text)).toEqual(["x", "dup", "y"]);
  });
  it("on overflow, three `***` dividers between completely changed paragraphs -> no unique line to anchor on, the dividers are rewritten too but keep their ids (equal blocks pair)", async () => {
    const blocks = [...PARAS(12, i => `A${i}`), { type: "divider" }, { type: "divider" }, { type: "divider" }, ...PARAS(12, i => `B${i}`)];
    const o = await run(blocks, w => w.replace(/\n+$/, "").split("\n\n").map(p => (p === "***" ? p : `${p}x`)).join("\n\n"), null, { maxD: 10 });
    expect(o.kept.filter(i => i >= 12 && i <= 14)).toEqual([12, 13, 14]);
    expect(o.top.filter(x => x.type === "divider")).toHaveLength(3);
  });
  it("(contrast) the same three repeated segments, but with unchanged unique lines around -> matched, ids unchanged (matching can only fail when the surrounding paragraphs are all changed too)", async () => {
    const blocks = [...PARAS(12, i => `A${i}`), P("anchor-before"), P("dup"), P("dup"), P("dup"), P("anchor-after"), ...PARAS(12, i => `B${i}`)];
    const o = await run(blocks, w => w.replace(/\n+$/, "").split("\n\n").map(p => (/^[AB]\d/.test(p) ? `${p}x` : p)).join("\n\n"), null, { maxD: 10 });
    expect(o.kept).toEqual([12, 13, 14, 15, 16]);
  });
});

describe("block ids kept in rewrite regions (#551)", () => {
  it("one paragraph changed between unchanged ones -> its id is kept, result = agent file", async () => {
    const o = await run([P("a"), P("b"), P("c")], w => w.replace(/^b$/m, "b changed"));
    expect(o).toMatchObject({ eqAgent: true, kept: [0, 1, 2], marks: ["rewrite:applied"], uniqueIds: true });
  });
  it("one paragraph split into two -> both halves get new ids", async () => {
    const o = await run([P("a"), P("bc"), P("d")], w => w.replace(/^bc$/m, "b\n\nc"));
    expect(o).toMatchObject({ eqAgent: true, kept: [0, 2], uniqueIds: true });
  });
  it("a paragraph turned into a bullet -> new id", async () => {
    const o = await run([P("a"), P("b"), P("c")], w => w.replace(/^b$/m, "* b"));
    expect(o).toMatchObject({ eqAgent: true, kept: [0, 2], uniqueIds: true });
  });
  it("two separate regions (b and d changed, c unchanged between) -> both keep their ids", async () => {
    const o = await run([P("a"), P("b"), P("c"), P("d"), P("e")], w => w.replace(/^b$/m, "b2").replace(/^d$/m, "d2"));
    expect(o).toMatchObject({ eqAgent: true, kept: [0, 1, 2, 3, 4], marks: ["rewrite:applied", "rewrite:applied"], uniqueIds: true });
  });
  it("two adjacent paragraphs both changed are one region -> neither keeps its id (a gap pairs only when exactly one old and one new block remain)", async () => {
    const o = await run([P("a"), P("b"), P("c"), P("d")], w => w.replace(/^b$/m, "b2").replace(/^c$/m, "c2"));
    expect(o).toMatchObject({ eqAgent: true, kept: [0, 3], uniqueIds: true });
  });
});

void Y;
