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

/** 讀出 → 改一個字 → 寫回 → 再讀出：markdown 與儲存的 block 都要照原樣（只差改掉的那個字）。回傳第一次讀出的 markdown。 */
async function editLoop(blocks: unknown[], opts: { skipStored?: boolean } = {}): Promise<string> {
  const d0 = await docWith(blocks);
  const md1 = await readMd(d0);
  expect(md1.split("EDITME").length - 1).toBe(1);
  const md1e = md1.replace("EDITME", "EDITED");
  const d1 = await docWith(await parse(md1e));
  expect(await readMd(d1)).toBe(md1e);
  if (!opts.skipStored) {
    expect(JSON.stringify(await stored(d1))).toBe(JSON.stringify(await stored(d0)).replace("EDITME", "EDITED"));
  }
  return md1;
}

describe("#379 讀出端：可能開啟標記的 `<` 加反斜線", () => {
  const rows: [string, string][] = [
    ["<b>bold</b>", "\\<b>bold\\</b>"],
    ["a <b> c", "a \\<b> c"],
    ["<div>x</div>", "\\<div>x\\</div>"],
    ["<DIV>x</DIV>", "\\<DIV>x\\</DIV>"],
    ["<kbd>k</kbd>", "\\<kbd>k\\</kbd>"],
    ["<mark>m</mark>", "\\<mark>m\\</mark>"],
    ["<span style=\"color:red\">t</span>", "\\<span style=\"color:red\">t\\</span>"],
    ["<img src=x>", "\\<img src=x>"],
    ["<h1>H</h1>", "\\<h1>H\\</h1>"],
    ["<br>", "\\<br>"],
    ["</p>", "\\</p>"],
    ["<!-- c -->", "\\<!-- c -->"],
    ["<?x ?>", "\\<?x ?>"],
    ["<!DOCTYPE html>", "\\<!DOCTYPE html>"],
    ["<![CDATA[x]]>", "\\<!\\[CDATA\\[x\\]\\]>"],
    ["<script>x</script>", "\\<script>x\\</script>"],
    ["<img src=x onerror=\"y\">", "\\<img src=x onerror=\"y\">"],
    ["<div data-kb-columns style=\"display:flex;gap:16px\">", "\\<div data-kb-columns style=\"display:flex;gap:16px\">"],
    ["<figure><img src=\"/a.png\" width=\"100\"></figure>", "\\<figure>\\<img src=\"/a.png\" width=\"100\">\\</figure>"],
    ["<details><summary>s</summary></details>", "\\<details>\\<summary>s\\</summary>\\</details>"],
    ["x<y and z>w", "x\\<y and z>w"],
    ["&lt;b&gt;", "&lt;b&gt;"],
    ["2 < 3 and 5 > 4", "2 < 3 and 5 > 4"],
    ["C:\\<dir>", "C:\\\\\\<dir>"],
  ];
  for (const [L, E] of rows) {
    it(`paragraph ${L}`, async () => {
      const md1 = await editLoop([P(T(`${L} EDITME`))]);
      expect(md1).toBe(`${E} EDITME\n`);
    });
  }

  const S = ["<b>bold</b>", "a <b> c", "<img src=x>", "<!-- c -->", "&lt;b&gt;", "2 < 3 and 5 > 4", "C:\\<dir>"];
  const contexts: [string, (L: string) => unknown[], ((md1: string, L: string) => void)?][] = [
    ["heading", L => [{ type: "heading", props: { level: 2 }, content: [T(`${L} EDITME`)] }]],
    ["bullet item", L => [{ type: "bulletListItem", content: [T(`${L} EDITME`)] }]],
    ["numbered item", L => [{ type: "numberedListItem", content: [T(`${L} EDITME`)] }]],
    ["quote", L => [{ type: "quote", content: [T(`${L} EDITME`)] }]],
    ["table body cell", L => [{ type: "table", content: { type: "tableContent", headerRows: 1, rows: [{ cells: ["h1", "h2"] }, { cells: [[T(`${L} EDITME`)], "c"] }] } }]],
    ["column", L => [{ type: "columnList", children: [
      { type: "column", props: { width: 1 }, children: [P(T(`${L} EDITME`))] },
      { type: "column", props: { width: 1 }, children: [P(T("other"))] },
    ] }]],
    ["inline color", L => [P(T("x "), T(L, { textColor: "red" }), T(" EDITME"))], md1 => expect(md1).toContain("<span style=\"color:red\">")],
    ["colored block", L => [{ type: "paragraph", props: { backgroundColor: "yellow" }, content: [T(`${L} EDITME`)] }]],
    ["bold run", L => [P(T(L, { bold: true }), T(" EDITME"))]],
    ["external link text", L => [P({ type: "link", href: "https://example.com", content: [T(L)] }, T(" EDITME"))]],
    ["after a line break", L => [P(T(`EDITME\n${L}`))]],
    ["inline code", L => [P(T(L, { code: true }), T(" EDITME"))], (md1, L) => expect(md1).toContain(`\`${L}\``)],
    ["code block", L => [{ type: "codeBlock", props: { language: "text" }, content: [T(`${L}\nEDITME`)] }], (md1, L) => expect(md1).toContain(`\n${L}\nEDITME`)],
  ];
  for (const [ctx, make, extra] of contexts) {
    describe(ctx, () => {
      for (const L of S) {
        it(L, async () => {
          const md1 = await editLoop(make(L));
          extra?.(md1, L);
        });
      }
    });
  }

  it("note link text", async () => {
    const href = "/notes/11111111-1111-4111-8111-111111111111";
    const md1 = await editLoop([P({ type: "link", href, content: [T("<b>x</b>")] }, T(" EDITME"))], { skipStored: true });
    expect(md1).toContain(`[\\<b>x\\</b>](${href})`);
  });

  it("underline run that ends the text", async () => {
    // 底線不存在於 markdown，寫回後樣式本來就沒有；這裡只驗文字與再讀出一致。
    const md1 = await editLoop([P(T("a<"), T("b> EDITME", { underline: true }))], { skipStored: true });
    expect(md1).toBe("a\\<b> EDITME\n");
  });
});
