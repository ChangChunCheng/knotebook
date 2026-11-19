/**
 * #386: a line break inside a paragraph, once written to a note, must not leave an extra space at the start of the next line; read -> write back unchanged must be stable;
 * whitespace that is genuinely at a line start (typed on the web, or left over from writes before the fix) must not be eaten by read -> write back either.
 * Verified directly at both ends, the write pipeline (`parseMarkdownForNote`) and the read side (`readNoteContentFromDoc`);
 * the end-to-end cases for each write path (REST / MCP / batch write-back / create) are in the integration test `test/softbreak-write-paths.test.ts`.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession } from "../../src/notes/editing/session.js";
import { parseMarkdownForNote } from "../../src/notes/editing/markdown.js";
import { readNoteContentFromDoc } from "../../src/notes/editing/read.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" }); rt.installGlobals();
const ORIGIN = "http://localhost";

type Inline = { type: string; text?: string; styles?: Record<string, unknown>; content?: Inline[] };
type Blk = { type: string; content?: unknown; children?: Blk[] };

async function parse(md: string): Promise<Blk[]> {
  const s = await EditorSession.open(rt, new Y.Doc());
  try {
    const r = parseMarkdownForNote(s.editor, md, [], ORIGIN);
    if ("error" in r) throw new Error(r.error);
    return r.blocks as Blk[];
  } finally {
    s.close();
  }
}
/** Normalised by a real editor. */
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
async function storedBlocks(doc: Y.Doc): Promise<unknown> {
  const s = await EditorSession.open(rt, doc);
  try {
    const strip = (bs: unknown[]): unknown[] => bs.map(b => { const { id: _id, children, ...rest } = b as { id: string; children: unknown[] }; return { ...rest, children: strip(children) }; });
    return strip(s.editor.document as unknown[]);
  } finally {
    s.close();
  }
}
async function readMd(doc: Y.Doc): Promise<string> {
  const r = await readNoteContentFromDoc(rt, doc);
  if (r === "section_not_found" || !("markdown" in r)) throw new Error("unexpected shape");
  return r.markdown;
}
const textOf = (content: unknown): string => (Array.isArray(content) ? (content as Inline[]).map(c => c.text ?? textOf(c.content)).join("") : "");
async function roundTrip(md: string): Promise<{ md1: string; md2: string; b1: unknown; b2: unknown }> {
  const d1 = await docWith(await parse(md));
  const md1 = await readMd(d1);
  const d2 = await docWith(await parse(md1));
  return { md1, md2: await readMd(d2), b1: await storedBlocks(d1), b2: await storedBlocks(d2) };
}

describe("#386 write: no extra space after a line break inside a paragraph", () => {
  // Three spellings: soft break, `\` break, two trailing spaces - BlockNote's markdown -> HTML emits `<br>\n` for all of them.
  it.each([
    ["soft break", "L1\nL2"],
    ["backslash break", "L1\\\nL2"],
    ["two trailing spaces", "L1  \nL2"],
    ["continuation line with leading indent (markdown strips it anyway)", "L1\\\n   L2"],
  ])("%s -> stored as L1 newline L2, read back as L1 backslash newline L2", async (_label, md) => {
    const [b] = await parse(md);
    expect(b!.type).toBe("paragraph");
    expect(textOf(b!.content)).toBe("L1\nL2");
    expect(await readMd(await docWith(await parse(md)))).toBe("L1\\\nL2\n");
  });

  it("verbatim case from the issue: line one ABC / line two DEF (Chinese, two kinds of line break)", async () => {
    for (const md of ["行一ABC\n行二DEF", "行一ABC\\\n行二DEF"]) {
      expect(await readMd(await docWith(await parse(md)))).toBe("行一ABC\\\n行二DEF\n");
    }
  });

  // BlockNote's parser does not recognise `\` breaks in list items and table cells (unrelated to #386); there only an inline `<br>` can write a line break - and reading writes that form too (see "round trip" below).
  it("two consecutive line breaks, quote, bold spanning a line break, <br> in list items and tables: none gets an extra space", async () => {
    expect(textOf((await parse("a\\\n\\\nb"))[0]!.content)).toBe("a\n\nb");
    expect(textOf((await parse("> L1\\\n> L2"))[0]!.content)).toBe("L1\nL2");
    expect(textOf((await parse("* L1<br>L2"))[0]!.content)).toBe("L1\nL2");
    const [bold] = await parse("**L1\\\nL2**");
    expect(bold!.content).toEqual([{ type: "text", text: "L1\nL2", styles: { bold: true } }]);
  });

  it("whitespace after an inline <br> written in the source is the source's own text and is kept", async () => {
    expect(textOf((await parse("L1<br> L2"))[0]!.content)).toBe("L1\n L2");
    expect(textOf((await parse("L1<br>  L2"))[0]!.content)).toBe("L1\n  L2");
    expect(textOf((await parse("L1<br>L2"))[0]!.content)).toBe("L1\nL2");
  });

  // A hand-written <pre> gives line breaks meaning: the `\n` after `<br>` is not removed (same number of line breaks as before the change).
  it("a line break after <br> inside a hand-written <pre> is kept", async () => {
    const [p] = await parse("<pre>a<br>\nb</pre>");
    expect(textOf(p!.content)).toBe("a\n\n\nb");
    const [c] = await parse("<pre><code>a<br>\nb</code></pre>");
    expect(c!.type).toBe("codeBlock");
    expect(textOf(c!.content)).toBe("a\n\n\nb");
    // the same paragraph outside the pre is still stripped
    expect(textOf((await parse("<pre>x</pre>\n\nL1\nL2"))[1]!.content)).toBe("L1\nL2");
  });

  // CRLF / CR are converted to LF at the entry, so `\r` no longer becomes trailing whitespace.
  it.each([
    ["CRLF soft break", "L1\r\nL2", ["L1\nL2"]],
    ["CRLF backslash break", "L1\\\r\nL2", ["L1\nL2"]],
    ["CRLF two trailing spaces", "L1  \r\nL2", ["L1\nL2"]],
    ["CRLF two paragraphs", "p\r\n\r\nq", ["p", "q"]],
    ["CR only", "p\r\rL1\rL2", ["p", "L1\nL2"]],
  ])("%s -> no extra whitespace in the text", async (_label, md, texts) => {
    expect((await parse(md)).map(b => textOf(b.content))).toEqual(texts);
  });

  it("backslashes, line breaks and literal <br> inside a code block are unaffected", async () => {
    const [b] = await parse("```\nL1\\\n L2\n```");
    expect(b!.type).toBe("codeBlock");
    expect(textOf(b!.content)).toBe("L1\\\n L2");
    const [c] = await parse("```\na<br>\nb\n```");
    expect(textOf(c!.content)).toBe("a<br>\nb");
  });
});

describe("#386 read -> write back unchanged is stable", () => {
  it.each(["L1\nL2", "L1\\\nL2", "> L1\\\n> L2", "**L1\\\nL2**", "a\\\n\\\nb"])("%j: both reads identical, blocks identical", async md => {
    const r = await roundTrip(md);
    expect(r.md2).toBe(r.md1);
    expect(r.b2).toEqual(r.b1);
  });

  // Line breaks in list items, table cells and headings are read out as inline `<br>` (a `\` break cannot be written back there: a list item splits into "`a\`" plus a new paragraph, a table row breaks).
  it.each([
    ["bullet list", { type: "bulletListItem", content: "a\nb" }, "* a<br>b\n"],
    ["numbered list", { type: "numberedListItem", content: "a\nb" }, "1. a<br>b\n"],
    ["check list", { type: "checkListItem", content: "a\nb" }, "* [ ] a<br>b\n"],
    ["heading", { type: "heading", props: { level: 2 }, content: "a\nb" }, "## a<br>b\n"],
  ])("line break in %s -> read out as <br>, written back to identical blocks", async (_label, block, expected) => {
    const doc = await docWith([block]);
    const md1 = await readMd(doc);
    expect(md1).toBe(expected);
    const d2 = await docWith(await parse(md1));
    expect(await storedBlocks(d2)).toEqual(await storedBlocks(doc));
    expect(await readMd(d2)).toBe(md1);
  });

  it("a line break in a table cell -> read out as <br>, the whole table round-trips identically", async () => {
    const r = await roundTrip("| h |\n| - |\n| a<br>b |");
    expect(r.md1).toContain("| a<br>b");
    expect(r.md2).toBe(r.md1);
    expect(r.b2).toEqual(r.b1);
  });

  it("a line break in a header cell (th) -> read out as <br>, the whole table round-trips identically", async () => {
    const r = await roundTrip("| h1<br>h2 |\n| - |\n| a |");
    expect(r.md1).toContain("| h1<br>h2");
    expect(r.md2).toBe(r.md1);
    expect(r.b2).toEqual(r.b1);
  });

  // Whitespace already at a line start (Shift+Enter then a space on the web; or the extra space written before #386 was fixed, already in the DB, no data fix):
  // the `\` break form cannot be written back (markdown strips the whitespace at the start of a continuation line), so reading rewrites it as an inline `<br>`: the whitespace stays on the same line and is kept on write back.
  it.each([
    ["one space (old content written before the fix)", "L1\n L2", "L1<br> L2\n"],
    ["two spaces", "L1\n  L2", "L1<br>  L2\n"],
    ["tab", "L1\n\tL2", "L1<br>\tL2\n"],
  ])("leading whitespace: %s -> read out with <br>, written-back blocks equal the original", async (_label, text, expected) => {
    const doc = await docWith([{ type: "paragraph", content: [{ type: "text", text, styles: {} }] }]);
    const md1 = await readMd(doc);
    expect(md1).toBe(expected);
    const d2 = await docWith(await parse(md1));
    expect(await storedBlocks(d2)).toEqual(await storedBlocks(doc));
    expect(await readMd(d2)).toBe(md1);
  });

  it("two line breaks in one paragraph, only one with leading whitespace after it: only that one is rewritten to <br>; leading whitespace inside list items is kept too", async () => {
    const blocks = [
      { type: "paragraph", content: [{ type: "text", text: "p1\n p2\np3", styles: {} }] },
      { type: "bulletListItem", content: [{ type: "text", text: "i1\n i2", styles: {} }] },
    ];
    const doc = await docWith(blocks);
    const md1 = await readMd(doc);
    expect(md1).toBe("p1<br> p2\\\np3\n\n* i1<br> i2\n");
    const d2 = await docWith(await parse(md1));
    expect(await storedBlocks(d2)).toEqual(await storedBlocks(doc));
    expect(await readMd(d2)).toBe(md1);
  });

  it("leading whitespace inside a coloured paragraph (read out as whole-paragraph HTML) also round-trips identically", async () => {
    const doc = await docWith([{ type: "paragraph", props: { backgroundColor: "yellow" }, content: [{ type: "text", text: "L1\n L2", styles: {} }] }]);
    const md1 = await readMd(doc);
    expect(md1).toContain("<br> L2");
    const d2 = await docWith(await parse(md1));
    expect(await storedBlocks(d2)).toEqual(await storedBlocks(doc));
    expect(await readMd(d2)).toBe(md1);
  });

  // The line-break placeholder must be a single character absent from the whole HTML (URLs included) - the old version used a repeated U+2E02 and only compared text, so it overlapped adjacent characters and was swapped into URLs.
  // U+E000 is now the first candidate character; U+2E02 was the old placeholder.
  it.each([
    ["placeholder candidate right before a line break (paragraph)", [{ type: "paragraph", content: [{ type: "text", text: "\n b", styles: {} }] }]],
    ["old placeholder right before a line break (paragraph)", [{ type: "paragraph", content: [{ type: "text", text: "⸂\n b⸂⸂", styles: {} }] }]],
    ["placeholder candidate right before a line break (list)", [{ type: "bulletListItem", content: [{ type: "text", text: "\nb", styles: {} }] }]],
    ["candidate character in the middle of the text", [{ type: "paragraph", content: [{ type: "text", text: "xy\n z", styles: {} }] }]],
  ])("%s -> read and write back to identical blocks", async (_label, blocks) => {
    const doc = await docWith(blocks);
    const md1 = await readMd(doc);
    const d2 = await docWith(await parse(md1));
    expect(await storedBlocks(d2)).toEqual(await storedBlocks(doc));
    expect(await readMd(d2)).toBe(md1);
  });

  it.each([
    ["link URL", "https://example.com/x\uE000\uE000\uE000\uE000y"],
    ["link URL (old placeholder)", "https://example.com/x⸂y"],
  ])("placeholder candidate character in %s, and the document has a line break to rewrite -> URL unchanged", async (_label, href) => {
    const doc = await docWith([
      { type: "bulletListItem", content: "a\nb" },
      { type: "paragraph", content: [{ type: "link", href, content: "L" }] },
    ]);
    const md1 = await readMd(doc);
    expect(md1).toContain("* a<br>b");
    expect(md1).not.toContain("x<br>y");
    const d2 = await docWith(await parse(md1));
    expect(await storedBlocks(d2)).toEqual(await storedBlocks(doc));
  });

  // Private-use characters in an image URL are percent-encoded on export anyway (unrelated to line breaks); this compares the image line verbatim between "the document has a line break to rewrite" and "it has none".
  it.each([
    ["placeholder candidate character", "https://example.com/p\uE000q.png"],
    ["old placeholder character", "https://example.com/p\u2E02q.png"],
  ])("%s in an image URL, and the document has a line break to rewrite -> the image line equals the one without the line break", async (_label, url) => {
    const image = { type: "image", props: { url } };
    const withBreak = await readMd(await docWith([{ type: "bulletListItem", content: "a\nb" }, image]));
    const without = await readMd(await docWith([{ type: "bulletListItem", content: "ab" }, image]));
    expect(withBreak).toContain("* a<br>b");
    const imgLine = (md: string) => md.split("\n").find(l => l.startsWith("!["))!;
    expect(imgLine(withBreak)).toBe(imgLine(without));
    expect(withBreak).not.toMatch(/%3Cbr%3E/i);
  });

  it("a line break without leading whitespace reads out unchanged (still a backslash break, no <br>)", async () => {
    const doc = await docWith([{ type: "paragraph", content: [{ type: "text", text: "L1\nL2", styles: {} }] }]);
    expect(await readMd(doc)).toBe("L1\\\nL2\n");
  });
});

// A style that starts with whitespace (`<strong> b</strong>`) is written by the converter as `** b**`, which turns literal on write back - the read side moves whitespace at the start and end of a style outside the marks.
// The text is unchanged (every character's style is unchanged except that one space), read -> write back -> read is identical, and blocks are stable after one write back.
describe("whitespace at the start/end of a style moves outside the emphasis marks", () => {
  /** Whitespace characters are compared without style: after moving out, that space carries none. */
  const glyphs = (blocks: unknown): string[] =>
    (blocks as Array<{ content: Inline[] }>).flatMap(b => (b.content ?? []).flatMap(c => [...(c.text ?? "")].map(ch => (/[ \t]/.test(ch) ? ch : `${ch}:${JSON.stringify(c.styles ?? {})}`))));
  it.each([
    ["bold, leading space", [{ type: "text", text: "a", styles: {} }, { type: "text", text: " b", styles: { bold: true } }], "a **b**\n"],
    ["italic, leading space", [{ type: "text", text: "a", styles: {} }, { type: "text", text: " b", styles: { italic: true } }], "a *b*\n"],
    ["strikethrough, leading space", [{ type: "text", text: "a", styles: {} }, { type: "text", text: " b", styles: { strike: true } }], "a ~~b~~\n"],
    ["bold italic, leading space", [{ type: "text", text: "a", styles: {} }, { type: "text", text: " b", styles: { bold: true, italic: true } }], "a ***b***\n"],
    ["bold, trailing space before text", [{ type: "text", text: "b ", styles: { bold: true } }, { type: "text", text: "c", styles: {} }], "**b** c\n"],
    // The converter moves trailing whitespace out of bold/italic itself, but not out of strikethrough (`~~b ~~`), which this handles
    ["strikethrough, trailing space before text", [{ type: "text", text: "b ", styles: { strike: true } }, { type: "text", text: "c", styles: {} }], "~~b~~ c\n"],
    ["bold with whitespace at both ends", [{ type: "text", text: "a", styles: {} }, { type: "text", text: "  b  ", styles: { bold: true } }, { type: "text", text: "c", styles: {} }], "a  **b**  c\n"],
    ["old content: bold spanning a line break, leading space on the next line", [{ type: "text", text: "a\n b", styles: { bold: true } }], "**a**<br> **b**\n"],
    ["italic with leading space after a line break", [{ type: "text", text: "L1\n", styles: {} }, { type: "text", text: " b", styles: { italic: true } }], "L1<br> *b*\n"],
  ])("%s", async (_label, content, expected) => {
    const doc = await docWith([{ type: "paragraph", content }]);
    const md1 = await readMd(doc);
    expect(md1).toBe(expected);
    const d2 = await docWith(await parse(md1));
    expect(await readMd(d2)).toBe(md1);
    expect(glyphs(await storedBlocks(d2))).toEqual(glyphs(await storedBlocks(doc)));
    const d3 = await docWith(await parse(await readMd(d2)));
    expect(await storedBlocks(d3)).toEqual(await storedBlocks(d2));
  });

  it("a style without edge whitespace reads out unchanged; leading whitespace inside inline code stays inside the code", async () => {
    const doc = await docWith([{ type: "paragraph", content: [{ type: "text", text: "a ", styles: {} }, { type: "text", text: "b", styles: { bold: true } }, { type: "text", text: " c", styles: { code: true } }] }]);
    expect(await readMd(doc)).toBe("a **b**` c`\n");
  });
});

// A real note reproduced three times through edit_note: bold right next to inline code in a quote, bold spanning a line break, one extra space after the line break.
describe("real case: bold + inline code + line break round trip inside a quote", () => {
  const B = { bold: true };
  const C = { code: true };
  const I = { italic: true };
  const TAIL = [
    { type: "text", text: "其他每一道預設都是硬的，需要過渡期才調軟 —— 而且 ", styles: {} },
    { type: "text", text: "soft_*", styles: C },
    { type: "text", text: " 一開就是所有分支一起軟化，", styles: {} },
    { type: "text", text: "包含發版 tag", styles: B },
    { type: "text", text: "。", styles: {} },
  ];
  /** The shape stored when an agent writes bold text containing inline code (code cannot also be bold, so bold breaks on both sides of the code), plus the extra space from before the fix. */
  const ORIGINAL = [
    { type: "text", text: "test 跟 lint 沒有 ", styles: B },
    { type: "text", text: "soft_", styles: C },
    { type: "text", text: " 開關，是刻意的。\n", styles: B },
    { type: "text", text: " ", styles: {} },
    ...TAIL,
  ];
  /** The shape of the above after one write back through the pre-fix read: italic swallowed the literal `**`, `\n` and the next code's backtick (what that note looks like now). */
  const CORRUPTED = [
    { type: "text", text: "test 跟 lint 沒有", styles: B },
    { type: "text", text: " ", styles: {} },
    { type: "text", text: "soft_", styles: C },
    { type: "text", text: "* 開關，是刻意的。**\n 其他每一道預設都是硬的，需要過渡期才調軟 —— 而且 `soft_", styles: I },
    { type: "text", text: "` 一開就是所有分支一起軟化，", styles: {} },
    { type: "text", text: "包含發版 tag", styles: B },
    { type: "text", text: "。", styles: {} },
  ];
  async function loop(content: unknown[]) {
    const d0 = await docWith([{ type: "quote", content }]);
    const md1 = await readMd(d0);
    const d1 = await docWith(await parse(md1));
    const md2 = await readMd(d1);
    const d2 = await docWith(await parse(md2));
    return { md1, md2, b0: await storedBlocks(d0), b1: await storedBlocks(d1), b2: await storedBlocks(d2) };
  }
  const glyphs = (blocks: unknown): string[] =>
    (blocks as Array<{ content: Inline[] }>).flatMap(b => (b.content ?? []).flatMap(c => [...(c.text ?? "")].map(ch => (/[ \t]/.test(ch) ? ch : `${ch}:${JSON.stringify(c.styles ?? {})}`))));

  it("original shape (bold on both sides of the code, bold spanning a line break, a space after the line break) -> no `** ` in the read-out; round trip stable, characters and styles unchanged", async () => {
    const r = await loop(ORIGINAL);
    expect(r.md1).toBe("> **test 跟 lint 沒有** `soft_` **開關，是刻意的。**<br> 其他每一道預設都是硬的，需要過渡期才調軟 —— 而且 `soft_*` 一開就是所有分支一起軟化，**包含發版 tag**。\n");
    expect(r.md2).toBe(r.md1);
    expect(glyphs(r.b1)).toEqual(glyphs(r.b0));
    expect(r.b2).toEqual(r.b1);
  });

  it("already-distorted shape (literal ** and backticks inside italic) -> literal characters are escaped; round trip stable, characters and styles unchanged", async () => {
    const r = await loop(CORRUPTED);
    expect(r.md1).toContain("\\*\\*");
    expect(r.md1).toContain("\\`soft\\_");
    expect(r.md2).toBe(r.md1);
    // the space after the line break is at the start of the italic: moved outside the italic (same characters; that space is no longer italic)
    expect(glyphs(r.b1)).toEqual(glyphs(r.b0));
    expect(r.b2).toEqual(r.b1);
  });

  it("the markdown as actually read is written back unchanged -> later read and write back no longer change (no extra * per round, no turning into a list)", async () => {
    const REAL_NOTE = "> **test 跟 lint 沒有** `soft_`** 開關，是刻意的。**\\\n>  其他每一道預設都是硬的，需要過渡期才調軟 —— 而且 `soft_*` 一開就是所有分支一起軟化，**包含發版 tag**。\n";
    const d1 = await docWith(await parse(REAL_NOTE));
    const md1 = await readMd(d1);
    const d2 = await docWith(await parse(md1));
    const md2 = await readMd(d2);
    expect(md2).toBe(md1);
    expect(await storedBlocks(d2)).toEqual(await storedBlocks(d1));
    expect((await storedBlocks(d2) as Blk[]).map(b => b.type)).toEqual(["quote"]);
  });
});

describe("escaping of markdown marker characters in text", () => {
  it.each([
    ["asterisk", "5 * 3 = 15，a*b*c"],
    ["backtick", "用 ` 包起來"],
    ["square brackets", "[x] 與 [連結](不是)"],
    ["underscore: not escaped inside a word, escaped at word edges", "snake_case 與 _前後_ 與 中_文"],
    ["tilde", "約 ~3 個、~~不是刪除線~~"],
    ["backslash", "C:\\Users 與 a\\*b 與結尾\\"],
  ])("%s -> blocks identical after round trip", async (_label, text) => {
    const doc = await docWith([{ type: "paragraph", content: [{ type: "text", text, styles: {} }] }]);
    const md1 = await readMd(doc);
    const d2 = await docWith(await parse(md1));
    expect(await storedBlocks(d2)).toEqual(await storedBlocks(doc));
    expect(await readMd(d2)).toBe(md1);
  });

  it("text without marker characters, an underscore inside a word and backslashes in paths read out unchanged", async () => {
    const doc = await docWith([{ type: "paragraph", content: [{ type: "text", text: "snake_case C:\\Users 一般文字", styles: {} }] }]);
    expect(await readMd(doc)).toBe("snake_case C:\\Users 一般文字\n");
  });

  it("characters inside inline code and code blocks are not escaped", async () => {
    const doc = await docWith([
      { type: "paragraph", content: [{ type: "text", text: "a*b_c", styles: { code: true } }] },
      { type: "codeBlock", content: "x * y [z]" },
    ]);
    expect(await readMd(doc)).toBe("`a*b_c`\n\n```text\nx * y [z]\n```\n");
  });
});
