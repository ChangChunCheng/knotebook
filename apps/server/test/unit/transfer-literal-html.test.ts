/**
 * #379：批次讀寫（檔案）路徑上，筆記文字裡的字面 HTML 標籤讀出時加反斜線、寫回時還原成字面文字。
 * agent 只改 EDITME 一個字：寫回後整篇匯出要等於 agent 的檔、字面 `<` 原樣留著、沒動的段落保留 id。
 * 另有兩案：修正之前下載的副本（`<` 沒有反斜線）寫回時，沒碰的那一段不會被改成真的 HTML；改到的那一段照檔裡的寫法當成 HTML。
 */
import { describe, expect, it } from "vitest";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { exportNoteForTransfer } from "../../src/transfer/export-note.js";
import { bodyLines, normalizeBody } from "../../src/transfer/normalize.js";
import { applyInMemory, docWith, forkOf, makeBaseInMemory, topOf, withEditor } from "./fixtures/transfer-sync.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();

const T = (text: string, styles: Record<string, unknown> = {}) => ({ type: "text", text, styles });
const P = (text: string) => ({ type: "paragraph", content: [T(text)] });
const trimR = (s: string) => s.replace(/[ \t]+$/, "");
const linesTrim = (s: string) => bodyLines(normalizeBody(s)).map(trimR).join("\n");

/** 頂層每顆的完整文字（`topOf` 的文字會把 `<…>` 當標籤濾掉，這裡要比的正好是 `<…>`）。 */
async function fullTexts(doc: Parameters<typeof withEditor>[1]): Promise<string[]> {
  type Blk = { content?: unknown; children?: Blk[] };
  type Inl = { text?: string; content?: Inl[] };
  const inl = (c: unknown): string => {
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return (c as Inl[]).map(i => i.text ?? inl(i.content)).join("");
    if (c && typeof c === "object" && "rows" in c) {
      const rows = (c as { rows: { cells: unknown[] }[] }).rows;
      return rows.map(r => r.cells.map(cell => inl((cell as { content?: unknown })?.content ?? cell)).join("|")).join("\n");
    }
    return "";
  };
  const walk = (b: Blk): string => [inl(b.content), ...(b.children ?? []).map(walk)].join("");
  return withEditor(rt, doc, ed => (ed.document as unknown as Blk[]).map(walk));
}

const S = ["<b>bold</b>", "a <b> c", "<img src=x>", "<!-- c -->", "&lt;b&gt;", "2 < 3 and 5 > 4", "C:\\<dir>", "<DIV>x</DIV>", "<span style=\"color:red\">r</span>"];

const variants: [string, (L: string) => unknown[]][] = [
  ["paragraph", L => [P(`${L} EDITME`), P("other")]],
  ["table cell", L => [
    { type: "table", content: { type: "tableContent", headerRows: 1, rows: [{ cells: ["h1", "h2"] }, { cells: [[T(`${L} EDITME`)], "c"] }] } },
    P("other"),
  ]],
  ["column", L => [
    { type: "columnList", children: [
      { type: "column", props: { width: 1 }, children: [P(`${L} EDITME`)] },
      { type: "column", props: { width: 1 }, children: [P("keep")] },
    ] },
    P("other"),
  ]],
];

describe("#379 批次寫回：字面 `<` 讀出加反斜線、改一個字寫回後原樣", () => {
  for (const [ctx, make] of variants) {
    describe(ctx, () => {
      for (const L of S) {
        it(L, async () => {
          const doc = await docWith(rt, make(L));
          const b = await makeBaseInMemory(rt, doc);
          expect(b.base.segments).not.toBeNull();
          const agent = b.body.replace("EDITME", "EDITED");
          expect(agent).not.toBe(b.body);
          const live = forkOf(doc);
          await applyInMemory(rt, b, agent, live);

          const final = (await exportNoteForTransfer(rt, live, new Map())).body;
          expect(bodyLines(normalizeBody(final))).toEqual(bodyLines(normalizeBody(agent)));

          const texts = await fullTexts(live);
          if (ctx === "paragraph") expect(texts[0]).toBe(`${L} EDITED`);
          else expect(texts[0]).toContain(`${L} EDITED`);
          expect(texts[0]).not.toContain("EDITME");

          const top = topOf(live);
          expect(top).toHaveLength(2);
          expect(top[1]!.id).toBe(b.ids[1]);
          expect(texts[1]).toBe("other");
        });
      }
    });
  }

  it("匯出的檔裡 `\\<b>` 帶著反斜線", async () => {
    const doc = await docWith(rt, [P("<b>bold</b> EDITME"), P("other")]);
    const b = await makeBaseInMemory(rt, doc);
    expect(b.body).toContain("\\<b>bold\\</b> EDITME");
  });
});

describe("#379 修正之前下載的副本（`<` 沒有反斜線）", () => {
  it("沒碰的 `<b>bold</b> keep` 段落保留 id 與原文，只有 EDITME 那段改成 EDITED", async () => {
    const doc = await docWith(rt, [P("<b>bold</b> keep"), P("other EDITME")]);
    const b = await makeBaseInMemory(rt, doc, new Map(), "T", line => line.replaceAll("\\<", "<"));
    expect(b.body).toContain("<b>bold</b> keep");
    expect(b.body).not.toContain("\\<");
    const agent = b.body.replace("EDITME", "EDITED");
    const live = forkOf(doc);
    await applyInMemory(rt, b, agent, live);

    const top = topOf(live);
    expect(top).toHaveLength(2);
    expect(top[0]!.id).toBe(b.ids[0]);
    const texts = await fullTexts(live);
    expect(texts).toEqual(["<b>bold</b> keep", "other EDITED"]);
    // 第一段仍是純文字，不是粗體：整篇匯出再讀一次，反斜線版照舊。
    expect(linesTrim((await exportNoteForTransfer(rt, live, new Map())).body)).toBe("\\<b>bold\\</b> keep\n\nother EDITED");
  });

  it("改到的那段 `<b>bold</b> keep` → `<b>bold</b> kept`：沒有反斜線的 `<b>` 當成 HTML，變成真的粗體", async () => {
    const doc = await docWith(rt, [P("<b>bold</b> keep"), P("other")]);
    const b = await makeBaseInMemory(rt, doc, new Map(), "T", line => line.replaceAll("\\<", "<"));
    expect(b.body).toContain("<b>bold</b> keep");
    const agent = b.body.replace("keep", "kept");
    expect(agent).not.toBe(b.body);
    const live = forkOf(doc);
    await applyInMemory(rt, b, agent, live);

    const top = topOf(live);
    expect(top).toHaveLength(2);
    expect(top[1]!.id).toBe(b.ids[1]);
    const texts = await fullTexts(live);
    expect(texts).toEqual(["bold kept", "other"]);
    const first = await withEditor(rt, live, ed => (ed.document[0] as unknown as { content: unknown }).content);
    expect(first).toEqual([T("bold", { bold: true }), T(" kept")]);
    expect(linesTrim((await exportNoteForTransfer(rt, live, new Map())).body)).toBe("**bold** kept\n\nother");
  });
});
