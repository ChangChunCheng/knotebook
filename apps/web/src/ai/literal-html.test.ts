// #379: literal HTML typed in a note (`<b>`, `<script>`...) must come back verbatim through read -> edit -> send back to in-site AI apply. The `<` escaping on the read side is done by shared; the parse side relies on the BlockNote parser's `\<` patch; both ends are pinned here.
import { describe, expect, it } from "vitest";
import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { noteSchema } from "@/collab/schema";
import { aiMarkdownOf } from "./note-markdown";
import { prepareAiResult } from "./apply";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple, repo convention
type AnyPartial = PartialBlock<any, any, any>;

const documentOf = (blocks: AnyPartial[]) => BlockNoteEditor.create({ schema: noteSchema, initialContent: blocks }).document;

// [text L the user typed, markdown E as read out]; E's backslashes must be kept verbatim, hence String.raw.
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

describe("#379 in-site AI: literal HTML read out, edited, applied", () => {
  it.each(CASES)("%s read as markdown, edit one word, applying restores the same literal text", (L, E) => {
    const md = aiMarkdownOf(documentOf([{ type: "paragraph", content: `${L} EDITME` }]), () => undefined);
    expect(md).toBe(`${E} EDITME\n`);

    const editor = BlockNoteEditor.create({ schema: noteSchema });
    const prepared = prepareAiResult(editor, md.replace("EDITME", "EDITED"), { notes: [], placement: "top" });
    if (!("blocks" in prepared)) throw new Error(`預期可套用，實際 ${JSON.stringify(prepared)}`);
    expect(prepared.blocks).toHaveLength(1);
    expect(prepared.blocks[0]!.type).toBe("paragraph");
    expect(prepared.blocks[0]!.content).toEqual([{ type: "text", text: `${L} EDITED`, styles: {} }]);
  });

  // Web paste-markdown and in-site AI share one parser: confirms web really gets the patch (`\<` is a literal `<`).
  it("parser: `\\<b>x\\</b>` parses to one paragraph with text <b>x</b>", () => {
    const editor = BlockNoteEditor.create({ schema: noteSchema });
    const blocks = editor.tryParseMarkdownToBlocks(String.raw`\<b>x\</b>`);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("paragraph");
    expect(blocks[0]!.content).toEqual([{ type: "text", text: "<b>x</b>", styles: {} }]);
  });
});
