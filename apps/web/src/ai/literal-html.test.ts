// #379：筆記裡打的字面 HTML（`<b>`、`<script>`…）走「讀出 → 改 → 送回站內 AI 套用」要原樣回來。
// 讀出端的 `<` 跳脫由 shared 負責，解析端靠 BlockNote parser 的 `\<` patch；這裡兩頭都釘住。
import { describe, expect, it } from "vitest";
import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { noteSchema } from "@/collab/schema";
import { aiMarkdownOf } from "./note-markdown";
import { prepareAiResult } from "./apply";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組（repo 慣例）
type AnyPartial = PartialBlock<any, any, any>;

const documentOf = (blocks: AnyPartial[]) => BlockNoteEditor.create({ schema: noteSchema, initialContent: blocks }).document;

// [使用者打的字 L, 讀出的 markdown E]；E 的反斜線要原樣保留，所以用 String.raw。
const CASES: [string, string][] = [
  ["<b>bold</b>", String.raw`\<b>bold\</b>`],
  ["a <b> c", String.raw`a \<b> c`],
  ["<img src=x>", String.raw`\<img src=x>`],
  ["<!-- c -->", String.raw`\<!-- c -->`],
  ["&lt;b&gt;", "&lt;b&gt;"],
  ["2 < 3 and 5 > 4", "2 < 3 and 5 > 4"],
  [String.raw`C:\<dir>`, String.raw`C:\\\<dir>`],
  ["<script>x</script>", String.raw`\<script>x\</script>`],
  ['<div data-kb-columns style="display:flex;gap:16px">', String.raw`\<div data-kb-columns style="display:flex;gap:16px">`],
];

describe("#379 站內 AI：字面 HTML 讀出、改字、套用", () => {
  it.each(CASES)("%s 讀成 markdown 後改一個字，套用回來仍是同一段字面文字", (L, E) => {
    const md = aiMarkdownOf(documentOf([{ type: "paragraph", content: `${L} EDITME` }]), () => undefined);
    expect(md).toBe(`${E} EDITME\n`);

    const editor = BlockNoteEditor.create({ schema: noteSchema });
    const prepared = prepareAiResult(editor, md.replace("EDITME", "EDITED"), { notes: [], placement: "top" });
    if (!("blocks" in prepared)) throw new Error(`預期可套用，實際 ${JSON.stringify(prepared)}`);
    expect(prepared.blocks[0]!.type).toBe("paragraph");
    expect(prepared.blocks[0]!.content).toEqual([{ type: "text", text: `${L} EDITED`, styles: {} }]);
  });

  // 網頁貼上 markdown 與站內 AI 用同一個 parser：確認 web 這邊真的吃到 patch（`\<` 是字面 `<`）。
  it("parser：`\\<b>x\\</b>` 解成一個段落、文字 <b>x</b>", () => {
    const editor = BlockNoteEditor.create({ schema: noteSchema });
    const blocks = editor.tryParseMarkdownToBlocks(String.raw`\<b>x\</b>`);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("paragraph");
    expect(blocks[0]!.content).toEqual([{ type: "text", text: "<b>x</b>", styles: {} }]);
  });
});
