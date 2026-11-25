/**
 * #379: on the batch read/write (file) path, literal HTML tags in note text get a backslash on read and are restored to literal text on write-back.
 * The agent changes only the one word EDITME: after write-back the whole-note export must equal the agent's file, the literal `<` stays as is, and untouched paragraphs keep their ids.
 * Two more cases: in a copy downloaded before the fix (`<` without a backslash), the untouched paragraph must not turn into real HTML on write-back; the paragraph that was changed is treated as HTML as written in the file.
 */
import { DEFAULT_KNOWLEDGE_FIELD_VIEW } from "@knotebook/shared";
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

/** The full text of every top-level block (the text of `topOf` filters `<...>` out as tags; here `<...>` is exactly what is compared). */
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

describe("#379 batch write-back: literal `<` gets a backslash on read, and write-back after changing one word leaves it as is", () => {
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

          const final = (await exportNoteForTransfer(rt, live, new Map(), { fields: DEFAULT_KNOWLEDGE_FIELD_VIEW })).body;
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

  it("the exported file has a backslash before `<b>`", async () => {
    const doc = await docWith(rt, [P("<b>bold</b> EDITME"), P("other")]);
    const b = await makeBaseInMemory(rt, doc);
    expect(b.body).toContain("\\<b>bold\\</b> EDITME");
  });
});

describe("#379 copy downloaded before the fix (`<` without a backslash)", () => {
  it("an untouched `<b>bold</b> keep` paragraph keeps its id and text; only the EDITME paragraph becomes EDITED", async () => {
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
    // the first paragraph is still plain text, not bold: exporting the whole note and reading it again keeps the backslash form as before.
    expect(linesTrim((await exportNoteForTransfer(rt, live, new Map(), { fields: DEFAULT_KNOWLEDGE_FIELD_VIEW })).body)).toBe("\\<b>bold\\</b> keep\n\nother EDITED");
  });

  it("the changed paragraph `<b>bold</b> keep` -> `<b>bold</b> kept`: a `<b>` without a backslash is treated as HTML and becomes real bold", async () => {
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
    expect(linesTrim((await exportNoteForTransfer(rt, live, new Map(), { fields: DEFAULT_KNOWLEDGE_FIELD_VIEW })).body)).toBe("**bold** kept\n\nother");
  });
});
