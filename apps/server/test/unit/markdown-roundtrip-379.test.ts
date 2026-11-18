/**
 * #379：Markdown 裡的 `\<` 是字面 `<`。寫入端（parseMarkdownForNote）要把它解成純文字，
 * 不能變成真的 HTML 標籤；沒有跳脫的輸入行為不變。
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession } from "../../src/notes/editing/session.js";
import { parseMarkdownForNote } from "../../src/notes/editing/markdown.js";
import { readNoteContentFromDoc } from "../../src/notes/editing/read.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" }); rt.installGlobals();

type Inline = { type: string; text?: string; styles?: Record<string, unknown>; content?: Inline[]; href?: string };
type Blk = { type: string; content?: unknown; children?: Blk[]; props?: Record<string, unknown> };

async function parseRaw(md: string): Promise<unknown> {
  const s = await EditorSession.open(rt, new Y.Doc());
  try {
    return parseMarkdownForNote(s.editor, md, [], "http://localhost");
  } finally {
    s.close();
  }
}
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組
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
  const r = await readNoteContentFromDoc(rt, doc);
  if (r === "section_not_found" || !("markdown" in r)) throw new Error("unexpected shape");
  return r.markdown;
}
const T = (text: string, styles: Record<string, unknown> = {}) => ({ type: "text", text, styles });
const P = (...content: unknown[]) => ({ type: "paragraph", content });

/** 解析後再存進文件，取回實際儲存的區塊（與寫回後的樣子一致）。 */
async function parseStored(md: string): Promise<Blk[]> {
  return stored(await docWith(await parse(md)));
}
const inlineOf = (b: Blk): Inline[] => (Array.isArray(b.content) ? (b.content as Inline[]) : []);

describe("#379 寫入端：`\\<` 是字面 `<`", () => {
  const inlineCases: [string, string, unknown[]][] = [
    ["escaped tag pair", "\\<b>bold\\</b> x", [T("<b>bold</b> x")]],
    ["escaped less-than in prose", "2 \\< 3", [T("2 < 3")]],
    ["escaped backslash then a real tag", "\\\\<b>bold</b>", [T("\\"), T("bold", { bold: true })]],
    ["escaped backslash then escaped lt", "\\\\\\<b>", [T("\\<b>")]],
    ["inline code keeps the backslash", "`\\<b>`", [T("\\<b>", { code: true })]],
    ["escaped comment is text, not empty", "\\<!-- c -->", [T("<!-- c -->")]],
    ["escaped script", "\\<script>x\\</script>", [T("<script>x</script>")]],
    ["escaped img with event attribute", "\\<img src=x onerror=\"y\">", [T("<img src=x onerror=\"y\">")]],
    ["escaped columns div", "\\<div data-kb-columns style=\"display:flex;gap:16px\">", [T("<div data-kb-columns style=\"display:flex;gap:16px\">")]],
  ];
  for (const [name, md, expected] of inlineCases) {
    it(name, async () => {
      const blocks = await parseStored(md);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]!.type).toBe("paragraph");
      expect(blocks[0]!.content).toEqual(expected);
    });
  }

  it("fenced code keeps `\\<b>` as the code text", async () => {
    const blocks = await parseStored("```\n\\<b>\n```");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("codeBlock");
    expect(inlineOf(blocks[0]!).map(c => c.text).join("")).toBe("\\<b>");
  });

  it("table cell with `\\<b>` holds the text `<b>`", async () => {
    const blocks = await parseStored("| h | x |\n| --- | --- |\n| \\<b> | y |");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("table");
    const rows = (blocks[0]!.content as { rows: { cells: unknown[] }[] }).rows;
    const cellText = (cell: unknown): string => {
      const c = cell as { content?: Inline[] } | Inline[];
      const inl = Array.isArray(c) ? c : (c.content ?? []);
      return inl.map(i => i.text ?? "").join("");
    };
    expect(cellText(rows[1]!.cells[0])).toBe("<b>");
  });

  it("link text `\\<b>` is the text `<b>`", async () => {
    const blocks = await parseStored("[\\<b>](https://example.com)");
    expect(blocks).toHaveLength(1);
    const link = inlineOf(blocks[0]!).find(c => c.type === "link");
    expect(link).toBeDefined();
    expect(link!.href).toBe("https://example.com");
    expect((link!.content ?? []).map(c => c.text).join("")).toBe("<b>");
  });
});

describe("#379 寫入端：沒有跳脫的輸入行為不變", () => {
  it("`<b>x</b>` is still bold", async () => {
    const blocks = await parseStored("<b>x</b>");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.content).toEqual([T("x", { bold: true })]);
  });
  it("`<script>` is still rejected as a dropped element", async () => {
    expect(await parseRaw("<script>x</script>")).toEqual({ error: "unsupported_block", detail: "dropped_element" });
  });
  it("an event attribute is still rejected", async () => {
    expect(await parseRaw("<img src=x onerror=\"y\">")).toEqual({ error: "unsupported_block", detail: "event_attr" });
  });
  it("a bare columns div is still rejected", async () => {
    expect(await parseRaw("<div data-kb-columns style=\"display:flex;gap:16px\">")).toEqual({ error: "unsupported_columns" });
  });
});

// 留給讀出端的案例使用（讀出 → 寫回的共用輔助）。
export { P, readMd };
