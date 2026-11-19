/* eslint-disable @typescript-eslint/no-explicit-any -- tests reach into PM's view/selection directly (types unavailable in apps/web) */
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { noteSchema } from "@/collab/schema";
import { collabUndoManager } from "@/collab/undo";
import { IMG, P, blockPos, integrity, pressKey, row, shape, type AnyEditor, type PartialBlockLike } from "@/test/columns-fixtures";

// When y-prosemirror restores a selection from relative positions and the stored one is a NodeSelection whose node is no longer in place (deleted, or moved away by undo/redo), the original calls `NodeSelection.create` directly and throws `reading 'nodeSize'` when no node follows that position. The exception is thrown inside the Y observer: the Y.Doc has already changed but the editor hasn't updated, so the local and shared documents stay inconsistent (#428). `patches/y-prosemirror@1.3.7.patch` makes it use a nearby text selection instead.
//
// This file uses only an ordinary collab editor (no app options, no undo lifeline), so what it guards is that patch: it goes red when y-prosemirror is upgraded and the patch no longer applies.

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 50));
const CLEAN = { dupIds: 0, nullIds: 0, nestedRows: 0, valid: true };

function makeEditor(doc: Y.Doc, name: string): AnyEditor {
  const editor = BlockNoteEditor.create(
    withCollaboration({
      schema: noteSchema,
      collaboration: { provider: { awareness: undefined }, fragment: doc.getXmlFragment(YDOC_FRAGMENT), user: { id: name, name, color: "hsl(0 65% 45%)" } },
    } as any),
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
}

async function pair(initial: PartialBlockLike[]) {
  const d1 = new Y.Doc();
  const d2 = new Y.Doc();
  const alice = makeEditor(d1, "alice");
  await tick();
  alice.replaceBlocks(alice.document, initial);
  await tick();
  Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1));
  const bob = makeEditor(d2, "bob");
  await tick();
  const aliceToBob = () => Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1, Y.encodeStateVector(d2)));
  const bobToAlice = () => Y.applyUpdate(d1, Y.encodeStateAsUpdate(d2, Y.encodeStateVector(d1)));
  const viewMatchesYDoc = (editor: AnyEditor, doc: Y.Doc) => {
    const view = editor.prosemirrorView!;
    return yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment(YDOC_FRAGMENT), view.state.schema).eq(view.state.doc);
  };
  return { alice, bob, d1, d2, aliceToBob, bobToAlice, viewMatchesYDoc };
}

const selectionType = (editor: AnyEditor): string => editor.prosemirrorView!.state.selection.toJSON().type;

/** Builds a NodeSelection at `pos` via `fromJSON({ type: "node" })` (apps/web can't get prosemirror-state values). */
function selectNode(editor: AnyEditor, pos: number): void {
  const view = editor.prosemirrorView! as any;
  let base = view.state.selection.constructor;
  for (let p = Object.getPrototypeOf(base); p && p !== Function.prototype; p = Object.getPrototypeOf(base)) base = p;
  view.dispatch(view.state.tr.setSelection(base.fromJSON(view.state.doc, { type: "node", anchor: pos })));
  expect(selectionType(editor), "前提：NodeSelection").toBe("node");
}

const IMAGE_AT_END = () => [P("x", "x1"), IMG("i1")];
const IMAGE_AT_COLUMN_END = () => [P("x", "x1"), row([[P("a", "a1"), IMG("i1")], [P("b", "b1")]], "r")];
const BLOCK_AT_END = () => [P("x", "x1"), P("y", "i1")];

describe("a collaborator deletes the block you have selected (NodeSelection)", () => {
  it.each([
    ["image at document end", IMAGE_AT_END, 0, "paragraph:x"],
    ["image at document end (the image itself selected)", IMAGE_AT_END, 1, "paragraph:x"],
    ["image in the last block of column 1", IMAGE_AT_COLUMN_END, 0, "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b)]"],
    ["paragraph at document end (the whole block)", BLOCK_AT_END, 0, "paragraph:x"],
  ] as const)("%s: bob deletes it -> alice receives the update without an exception, the view equals the shared document, and typing afterwards stays consistent on both sides", async (_label, content, offset, without) => {
    const { alice, bob, d1, aliceToBob, bobToAlice, viewMatchesYDoc } = await pair(content());
    selectNode(alice, blockPos(alice, "i1") + offset);
    bob.removeBlocks(["i1"]);
    expect(shape(bob)).toBe(without);
    expect(() => bobToAlice()).not.toThrow();
    await tick();
    expect(shape(alice)).toBe(without);
    expect(viewMatchesYDoc(alice, d1)).toBe(true);
    expect(selectionType(alice)).toBe("text");
    expect(integrity(alice)).toEqual(CLEAN);
    alice.setTextCursorPosition("x1", "end");
    alice.prosemirrorView!.dispatch(alice.prosemirrorView!.state.tr.insertText("T"));
    aliceToBob();
    await tick();
    expect(shape(bob)).toBe(without.replace("paragraph:x", "paragraph:xT"));
    expect(shape(alice)).toBe(shape(bob));
  });

  it("the selected image is still there (the collaborator edited elsewhere) -> after the update it is still a NodeSelection of that image", async () => {
    const { alice, bob, d1, bobToAlice, viewMatchesYDoc } = await pair(IMAGE_AT_END());
    const at = blockPos(alice, "i1");
    selectNode(alice, at);
    bob.setTextCursorPosition("x1", "end");
    bob.prosemirrorView!.dispatch(bob.prosemirrorView!.state.tr.insertText("Q"));
    expect(() => bobToAlice()).not.toThrow();
    await tick();
    expect(shape(alice)).toBe("paragraph:xQ  image");
    expect(viewMatchesYDoc(alice, d1)).toBe(true);
    const sel = alice.prosemirrorView!.state.selection as any;
    expect(sel.toJSON().type).toBe("node");
    expect(sel.node.attrs.id).toBe("i1");
    expect(sel.from).toBe(at + 1);
  });
});

describe("a NodeSelection restored by undo and redo points to a block that has been moved away", () => {
  it.each([
    ["document end", IMAGE_AT_END, "paragraph:x"],
    ["last block of column 1", IMAGE_AT_COLUMN_END, "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b)]"],
  ] as const)("image at %s: select -> Backspace -> Ctrl+Z -> immediately Ctrl+Shift+Z -> no exception, redo takes effect, local and shared documents equal", async (_label, content, without) => {
    const { alice, bob, d2, bobToAlice, viewMatchesYDoc } = await pair(content());
    selectNode(bob, blockPos(bob, "i1"));
    expect(pressKey(bob, "Backspace")).toBe(true);
    expect(shape(bob)).toBe(without);
    expect(() => pressKey(bob, "z", { ctrlKey: true })).not.toThrow();
    expect(shape(bob)).toContain("image");
    // After undo the selection from before the deletion (a NodeSelection of the image) is kept, and redo restores with it after the image has been moved away again.
    expect(() => pressKey(bob, "z", { ctrlKey: true, shiftKey: true })).not.toThrow();
    expect(shape(bob)).toBe(without);
    expect(viewMatchesYDoc(bob, d2)).toBe(true);
    bobToAlice();
    await tick();
    expect(shape(alice)).toBe(without);
    expect(integrity(bob)).toEqual(CLEAN);
  });

  it("undo with the just-inserted image selected (NodeSelection) moves it away -> no exception, local and shared documents equal", async () => {
    const { alice, bob, d2, bobToAlice, viewMatchesYDoc } = await pair([P("x", "x1"), P("y", "y1")]);
    const manager = collabUndoManager(bob)!;
    manager.stopCapturing();
    bob.insertBlocks([IMG("i1")], "y1", "after");
    manager.stopCapturing();
    selectNode(bob, blockPos(bob, "i1"));
    expect(() => pressKey(bob, "z", { ctrlKey: true })).not.toThrow();
    expect(shape(bob)).toBe("paragraph:x  paragraph:y");
    expect(viewMatchesYDoc(bob, d2)).toBe(true);
    bobToAlice();
    await tick();
    expect(shape(alice)).toBe("paragraph:x  paragraph:y");
  });
});
