import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { noteSchema } from "@/collab/schema";
import { IMG, P, integrity, mountEditor, row, shape, type AnyEditor, type PartialBlockLike } from "@/test/columns-fixtures";
import { removeBlocksKeepColumns, replaceBlocksKeepColumns } from "./keep-columns";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function mount(content: PartialBlockLike[]): AnyEditor {
  const m = mountEditor(content);
  cleanups.push(m.destroy);
  return m.editor;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

async function collabPair(initial: PartialBlockLike[]) {
  const d1 = new Y.Doc();
  const d2 = new Y.Doc();
  const make = (doc: Y.Doc, n: number): AnyEditor => {
    const editor = BlockNoteEditor.create(
      withCollaboration({
        schema: noteSchema,
        collaboration: {
          provider: { awareness: undefined },
          fragment: doc.getXmlFragment(YDOC_FRAGMENT),
          user: { id: `u${n}`, name: `User ${n}`, color: "hsl(0 65% 45%)" },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- withCollaboration's option type requires the full schema triple
      } as any),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
    ) as any as AnyEditor;
    const el = document.createElement("div");
    document.body.appendChild(el);
    editor.mount(el);
    cleanups.push(() => {
      editor.unmount();
      el.remove();
      doc.destroy();
    });
    return editor;
  };
  const a = make(d1, 1);
  await tick();
  a.replaceBlocks(a.document, initial);
  await tick();
  Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1));
  const b = make(d2, 2);
  await tick();
  const sync = () => {
    const u1 = Y.encodeStateAsUpdate(d1, Y.encodeStateVector(d2));
    const u2 = Y.encodeStateAsUpdate(d2, Y.encodeStateVector(d1));
    Y.applyUpdate(d2, u1);
    Y.applyUpdate(d1, u2);
  };
  return { a, b, sync };
}

const allText = (editor: AnyEditor) => {
  let s = "";
  editor.prosemirrorView!.state.doc.descendants((n) => {
    if (n.isText) s += n.text;
  });
  return s;
};

describe("removeBlocksKeepColumns / replaceBlocksKeepColumns", () => {
  it("removing the only image in a column -> row and both columns remain, that column gets an empty paragraph; core's removeBlocks flattens (pinned fact)", () => {
    const content = () => [P("x", "x"), row([[P("a", "a")], [IMG("img")]], "r"), P("z", "z")];
    const editor = mount(content());
    const removed = removeBlocksKeepColumns(editor, ["img"]);
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph)]  paragraph:z");
    expect(removed.map((b) => b.id)).toEqual(["img"]);
    expect(integrity(editor).valid).toBe(true);

    const core = mount(content());
    core.removeBlocks(["img"]);
    expect(shape(core)).toBe("paragraph:x  paragraph:a  paragraph:z");
  });

  it("three columns, removing the only block of the middle one -> still three columns, middle empty", () => {
    const editor = mount([row([[P("a", "a")], [P("b", "b")], [P("c", "c")]], "r")]);
    removeBlocksKeepColumns(editor, ["b"]);
    expect(shape(editor)).toBe("ROW[COL(paragraph:a) | COL(paragraph) | COL(paragraph:c)]");
  });

  it("replacing the only block in a column -> new block in the original column; returns insertedBlocks/removedBlocks", () => {
    const editor = mount([row([[P("a", "a")], [P("b", "b")]], "r")]);
    const out = replaceBlocksKeepColumns(editor, ["b"], [P("n", "n")]);
    expect(shape(editor)).toBe("ROW[COL(paragraph:a) | COL(paragraph:n)]");
    expect((out.insertedBlocks[0]!.content as { text: string }[])[0]!.text).toBe("n");
    expect(out.removedBlocks[0]!.id).toBe("b");
  });

  it("collab: B deletes the image in another column of the same row while A types in column 1 -> after merge both sides have A's text, the row still has two columns", async () => {
    const { a, b, sync } = await collabPair([P("x", "x"), row([[P("text", "t")], [IMG("img")]], "r"), P("z", "z")]);
    a.setTextCursorPosition("t", "end");
    const view = a.prosemirrorView!;
    view.dispatch(view.state.tr.insertText("XYZ"));
    removeBlocksKeepColumns(b, ["img"]);
    await tick();
    sync();
    await tick();
    const expected = "paragraph:x  ROW[COL(paragraph:textXYZ) | COL(paragraph)]  paragraph:z";
    expect(shape(a)).toBe(expected);
    expect(shape(b)).toBe(expected);
    expect(allText(a)).toContain("XYZ");
    expect(allText(b)).toContain("XYZ");
  });
});
