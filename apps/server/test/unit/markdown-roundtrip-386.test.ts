/**
 * #386: the remaining holes of the read -> write-back round trip: text of collapsed lists/headings, edge whitespace of colored bold/italic,
 * block markers after a line break and at the start of a block, boundaries of the escaping rules, and table column widths. The write/read path is shared with `softbreak-386.test.ts`.
 */
import { DEFAULT_KNOWLEDGE_FIELD_VIEW } from "@knotebook/shared";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession } from "../../src/notes/editing/session.js";
import { parseMarkdownForNote } from "../../src/notes/editing/markdown.js";
import { readNoteContentFromDoc } from "../../src/notes/editing/read.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" }); rt.installGlobals();

type Inline = { type: string; text?: string; styles?: Record<string, unknown>; content?: Inline[] };
type Blk = { type: string; content?: unknown; children?: Blk[]; props?: Record<string, unknown> };

async function parse(md: string): Promise<Blk[]> {
  const s = await EditorSession.open(rt, new Y.Doc());
  try {
    const r = parseMarkdownForNote(s.editor, md, [], "http://localhost");
    if ("error" in r) throw new Error(r.error);
    return r.blocks as Blk[];
  } finally {
    s.close();
  }
}
async function docWith(blocks: unknown[]): Promise<Y.Doc> {
  const doc = new Y.Doc();
  const s = await EditorSession.open(rt, doc);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple
    s.editor.replaceBlocks(s.editor.document, blocks as any);
  } finally {
    s.close();
  }
  return doc;
}
async function stored(doc: Y.Doc): Promise<Blk[]> {
  const s = await EditorSession.open(rt, doc);
  try {
    const strip = (bs: unknown[]): Blk[] => bs.map(b => { const { id: _id, children, ...rest } = b as { id: string; children: unknown[] }; return { ...rest, children: strip(children) } as Blk; });
    return strip(s.editor.document as unknown[]);
  } finally {
    s.close();
  }
}
async function readMd(doc: Y.Doc): Promise<string> {
  const r = await readNoteContentFromDoc(rt, doc, undefined, new Map(), undefined, DEFAULT_KNOWLEDGE_FIELD_VIEW);
  if (r === "section_not_found" || !("markdown" in r)) throw new Error("unexpected shape");
  return r.markdown;
}
/** The inline content of each block: character by character with its styles (styles of whitespace aren't compared: whitespace moved outside a style no longer carries it). */
const glyphs = (blocks: Blk[]): string[][] =>
  blocks.map(b => (Array.isArray(b.content) ? (b.content as Inline[]) : []).flatMap(c => [...(c.text ?? "")].map(ch => (/[ \t]/.test(ch) ? ch : `${ch}:${JSON.stringify(c.styles ?? {})}`))));
/** read -> write back -> read -> write back. */
async function loop(blocks: unknown[]) {
  const d0 = await docWith(blocks);
  const md1 = await readMd(d0);
  const d1 = await docWith(await parse(md1));
  const md2 = await readMd(d1);
  const d2 = await docWith(await parse(md2));
  return { md1, md2, b0: await stored(d0), b1: await stored(d1), b2: await stored(d2) };
}
const T = (text: string, styles: Record<string, unknown> = {}) => ({ type: "text", text, styles });
const P = (...content: unknown[]) => ({ type: "paragraph", content });

describe("text of collapsed lists and collapsed headings is escaped too", () => {
  it("collapsed list item `**x** and `c`` -> stays literal after write-back (not bold, not code)", async () => {
    const r = await loop([{ type: "toggleListItem", content: [T("**x** and `c`")] }]);
    expect(r.md2).toBe(r.md1);
    expect(glyphs(r.b1)).toEqual(glyphs(r.b0));
  });
  it("collapsed heading `**x**` -> stays literal after write-back", async () => {
    const r = await loop([{ type: "heading", props: { level: 2, isToggleable: true }, content: [T("**x**")] }]);
    expect(r.md2).toBe(r.md1);
    expect(glyphs(r.b1)).toEqual(glyphs(r.b0));
  });
});

describe("edge whitespace of colored bold/italic also moves outside the markers", () => {
  it.each([
    ["red bold with leading whitespace", [P(T("x"), T(" a", { bold: true, textColor: "red" }))]],
    ["background italic with whitespace on both ends", [P(T("x"), T(" a ", { italic: true, backgroundColor: "yellow" }), T("y"))]],
    ["red bold with leading whitespace after a line break", [P(T("L1\n"), T(" b", { bold: true, textColor: "red" }))]],
  ])("%s -> the read-out has no `** a**`/`* a*`, the round trip keeps characters and styles", async (_l, blocks) => {
    const r = await loop(blocks);
    expect(r.md1).not.toMatch(/\*\* |\* a/);
    expect(r.md2).toBe(r.md1);
    expect(glyphs(r.b1)).toEqual(glyphs(r.b0));
    expect(r.b2).toEqual(r.b1);
  });
});

describe("a line after a line break that starts with a block marker -> written as <br>, doesn't split the paragraph", () => {
  it.each([
    ["- b"], ["+ b"], ["1. b"], ["2) b"], ["# b"], ["> b"], ["---"], ["==="], ["| x |"], [":-|-"], ["(注意)"],
  ])("paragraph a, line break, %s", async next => {
    const r = await loop([P(T(`a\n${next}`))]);
    expect(r.md1).toContain("a<br>");
    expect(r.b1).toEqual(r.b0);
    expect(r.md2).toBe(r.md1);
  });
  it.each([["- b"], ["# b"], ["> b"]])("quote a, line break, %s", async next => {
    const r = await loop([{ type: "quote", content: [T(`a\n${next}`)] }]);
    expect(r.b1).toEqual(r.b0);
    expect(r.md2).toBe(r.md1);
  });
  it("paragraph a, line break, <div>x</div>: the < of a literal tag is escaped, and the line break and text are written back as they were (#379)", async () => {
    const r = await loop([P(T("a\n<div>x</div>"))]);
    expect(r.md1).toContain("a<br>\\<div>x\\</div>");
    expect(r.b1).toEqual(r.b0);
    expect(r.md2).toBe(r.md1);
  });
  it("a line break followed by ordinary text (not starting with punctuation) stays a backslash line break", async () => {
    const doc = await docWith([P(T("a\nb 2024 年"))]);
    expect(await readMd(doc)).toBe("a\\\nb 2024 年\n");
  });
});

describe("escaping marker characters at the start of a block", () => {
  it.each([
    ["# x", "\\# x\n"],
    ["###### x", "\\###### x\n"],
    ["> x", "\\> x\n"],
    [">x", "\\>x\n"],
    ["- x", "\\- x\n"],
    ["+ x", "\\+ x\n"],
    ["1. x", "1\\. x\n"],
    ["12) x", "12\\) x\n"],
    ["---", "\\---\n"],
    ["- - -", "\\- - -\n"],
  ])("paragraph starting with %j -> read as %j, written back as the same text", async (text, expected) => {
    const r = await loop([P(T(text))]);
    expect(r.md1).toBe(expected);
    expect(r.b1).toEqual(r.b0);
  });
  it.each([["-1 度"], ["#tag"], ["1.5 倍"], ["+1"], ["2024. 年"]])("%j that the parser doesn't recognize is not escaped", async text => {
    const r = await loop([P(T(text))]);
    if (text === "2024. 年") {
      // digits + `.` + space is a numbered list: it must be escaped
      expect(r.md1).toBe("2024\\. 年\n");
    } else {
      expect(r.md1).toBe(`${text}\n`);
    }
    expect(r.b1).toEqual(r.b0);
  });
  it("a paragraph whose first text is followed by bold starting with a space (`-` + bold ` x`) is escaped too", async () => {
    const r = await loop([P(T("-"), T(" x", { bold: true }))]);
    expect(r.md1).toBe("\\- **x**\n");
    expect(glyphs(r.b1)).toEqual(glyphs(r.b0));
  });
  it.each([["x #"], ["x ##"], ["a # b #"]])("a trailing # of heading %j is not stripped", async text => {
    const r = await loop([{ type: "heading", props: { level: 2 }, content: [T(text)] }]);
    expect(r.b1).toEqual(r.b0);
    expect(r.md2).toBe(r.md1);
  });
  it.each([["> x"], ["- x"], ["# x"], ["1. x"]])("leading %j of quote text is not stripped and doesn't become nested", async text => {
    const r = await loop([{ type: "quote", content: [T(text)] }]);
    expect(r.b1).toEqual(r.b0);
    expect(r.md2).toBe(r.md1);
  });
  it("a leading # in list items and headings is not escaped (it's only inline text there)", async () => {
    const doc = await docWith([{ type: "bulletListItem", content: [T("# x")] }, { type: "heading", props: { level: 3 }, content: [T("- x")] }]);
    expect(await readMd(doc)).toBe("* # x\n\n### - x\n");
  });
});

/** Inline text (leading whitespace removed: leading whitespace of a paragraph is dropped on write-back anyway, see known-limitations). */
const lead = (bs: Blk[]): string => (Array.isArray(bs[0]?.content) ? (bs[0]!.content as Inline[]).map(c => c.text ?? "").join("") : "").replace(/^\s+/, "");

describe("block markers after leading whitespace are escaped too", () => {
  it.each([[" # x"], ["  - x"], [" ---"], ["   1. x"], [" # x"], ["\t+ x"], [" > x"]])("paragraph %j -> still one paragraph after write-back, same characters (except the leading whitespace)", async text => {
    const r = await loop([P(T("lead")), P(T(text))]);
    expect(r.b1.map(b => b.type)).toEqual(["paragraph", "paragraph"]);
    expect(lead(r.b1.slice(1))).toBe(text.replace(/^\s+/, ""));
    // leading whitespace is dropped on the first write-back (known-limitations), and stable afterwards
    expect(r.b2).toEqual(r.b1);
  });
  it.each([[" # x"], ["  - x"], [" ---"], ["   1. x"]])("first paragraph (leading whitespace of the whole document gets stripped) %j -> still a paragraph after write-back", async text => {
    const r = await loop([P(T(text))]);
    expect(r.b1.map(b => b.type)).toEqual(["paragraph"]);
    expect(lead(r.b1)).toBe(text.replace(/^\s+/, ""));
  });
  it("quote text ' - x' -> still a quote after write-back, not a nested list", async () => {
    const r = await loop([{ type: "quote", content: [T(" - x")] }]);
    expect(r.b1.map(b => b.type)).toEqual(["quote"]);
    expect(lead(r.b1)).toBe("- x");
  });
});

describe("child paragraphs under a list item get the block-start escaping too", () => {
  it.each([["- c"], ["# c"], ["> c"], ["1. c"]])("child paragraph %j of collapsed list item t -> text unchanged after write-back", async text => {
    const r = await loop([{ type: "toggleListItem", content: [T("t")], children: [P(T(text))] }]);
    const kids = r.b1[0]!.children ?? [];
    expect(kids.map(b => b.type)).toEqual(["paragraph"]);
    expect(lead(kids)).toBe(text);
  });
  it("child paragraph '- c' under a bullet list -> not a nested list", async () => {
    const r = await loop([{ type: "bulletListItem", content: [T("t")], children: [P(T("- c"))] }]);
    const all = [...r.b1, ...r.b1.flatMap(b => b.children ?? [])];
    expect(all.filter(b => b.type === "bulletListItem")).toHaveLength(1);
    expect(all.some(b => b.type === "paragraph" && lead([b]) === "- c")).toBe(true);
  });
  it("a leading - in the item's own text is not escaped (it's only inline text)", async () => {
    expect(await readMd(await docWith([{ type: "toggleListItem", content: [T("- t")] }]))).toBe("* - t\n");
  });
});

describe("line breaks at the start/end of a paragraph", () => {
  it.each([
    ["at the start", "\nx", "<br>x"],
    ["at the end", "a\n", "a<br>"],
    ["only a line break", "\n", "<br>"],
    ["both ends", "\na\n", "<br>a<br>"],
    ["two at the end", "a\n\n", "a\\\n<br>"],
  ])("%s %j -> read as %j, written back the same", async (_l, text, expected) => {
    const r = await loop([P(T(text)), P(T("z"))]);
    expect(r.md1).toBe(`${expected}\n\nz\n`);
    expect(r.b1).toEqual(r.b0);
    expect(r.md2).toBe(r.md1);
  });
  it("a document whose only content is a paragraph with just a line break -> write-back is not empty_content", async () => {
    const r = await loop([P(T("\n"))]);
    expect(r.md1).toBe("<br>\n");
    expect(r.b1).toEqual(r.b0);
  });
});

describe("boundaries of the escaping rules", () => {
  it.each([
    ["two backslashes", [P(T("a\\\\b"))]],
    ["backslash at the end followed by bold", [P(T("a\\"), T("b", { bold: true }))]],
    ["tilde at the end followed by strikethrough", [P(T("a~"), T("b", { strike: true }))]],
  ])("%s -> the round-trip blocks are equal", async (_l, blocks) => {
    const r = await loop(blocks);
    expect(r.b1).toEqual(r.b0);
    expect(r.md2).toBe(r.md1);
  });
  it("table cell with an escaped pipe -> round trip is the same", async () => {
    const table = { type: "table", content: { type: "tableContent", rows: [{ cells: ["h"] }, { cells: ["a\\|b"] }] } };
    const r = await loop([table]);
    expect(r.b1).toEqual(r.b0);
    expect(r.md2).toBe(r.md1);
  });
  it("a single ~ in prose reads out unchanged (a single ~ is not escaped)", async () => {
    expect(await readMd(await docWith([P(T("約 ~3 個"))]))).toBe("約 ~3 個\n");
  });
});

describe("the in-word test for `_` matches the parser's (word characters: alphanumerics and `_`)", () => {
  it("a__b, snake_case, x_1 read out unchanged and round-trip the same", async () => {
    const r = await loop([P(T("a__b snake_case x_1"))]);
    expect(r.md1).toBe("a__b snake_case x_1\n");
    expect(r.b1).toEqual(r.b0);
  });
});

describe("the row of a cell containing <br> is as wide as the other rows", () => {
  it("every table row has the same length", async () => {
    const table = { type: "table", content: { type: "tableContent", rows: [{ cells: ["head", "h2"] }, { cells: ["a\nb", "x"] }, { cells: ["c", "y"] }] } };
    const md = await readMd(await docWith([table]));
    const lines = md.trimEnd().split("\n");
    expect(md).toContain("a<br>b");
    expect(new Set(lines.map(l => l.length)).size).toBe(1);
  });
});
