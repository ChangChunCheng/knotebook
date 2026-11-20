/* eslint-disable @typescript-eslint/no-explicit-any -- tests reach into PM's view/selection directly (types unavailable in apps/web) */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { noteSchema } from "@/collab/schema";
import { collabUndoManager, keepCollabUndoAlive } from "@/collab/undo";
import type { EditorRef } from "@/components/wikilink/menu";
import { IMG, P, blockPos, cursorOf, integrity, pressKey, row, shape, startBlockDrag, type AnyEditor, type PartialBlockLike } from "@/test/columns-fixtures";

// Undo and focus after a drag-drop of the drag handle (#428, #429, #430). The dragging editor (bob) is mounted with `buildNoteEditorOptions`'s full options (the `handleDrop` chain and the drag-source recorder are present); the other (alice) is an ordinary collab editor used to inspect the shared document. Each has its own Y.Doc, synced through `Y.applyUpdate`.
const toastMock = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/toast", () => ({ toast: toastMock }));
const { buildNoteEditorOptions } = await import("@/components/NoteEditor");

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  vi.restoreAllMocks();
  toastMock.mockReset();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 50));
const CLEAN = { dupIds: 0, nullIds: 0, nestedRows: 0, valid: true };

type Box = readonly [left: number, top: number, right: number, bottom: number];
const ORIGINAL_RECT = Element.prototype.getBoundingClientRect;

/**
 * jsdom rects are all 0: the drop-target editor's root `.bn-block-group` returns a box enclosing all test coordinates (core SideMenu uses it to find the nearest editor), the other editor is placed far away; other elements are looked up by `<data-node-type>:<data-id>`.
 */
function mockRects(target: AnyEditor, boxes: Record<string, Box> = {}): void {
  const dom = target.prosemirrorView!.dom;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    let box: Box | undefined;
    if (this.classList.contains("bn-block-group") && this.parentElement?.classList.contains("bn-editor")) {
      box = this.parentElement === dom ? [0, 0, 1000, 1000] : [5000, 0, 6000, 1000];
    } else if (dom.contains(this)) {
      box = boxes[`${this.getAttribute("data-node-type")}:${this.getAttribute("data-id")}`];
    }
    return box ? new DOMRect(box[0], box[1], box[2] - box[0], box[3] - box[1]) : ORIGINAL_RECT.call(this);
  });
}

function rowBoxes(id: string, n: number): Record<string, Box> {
  const width = (600 - 24 * (n - 1)) / n;
  const out: Record<string, Box> = { [`columnList:${id}`]: [0, 100, 600, 300] };
  for (let i = 0; i < n; i++) out[`column:${id}c${i}`] = [i * (width + 24), 100, i * (width + 24) + width, 300];
  return out;
}

function makeEditor(doc: Y.Doc, name: string, full: boolean): AnyEditor {
  const editorRef: EditorRef = { current: null };
  const editor = BlockNoteEditor.create(
    full
      ? buildNoteEditorOptions({
          doc,
          provider: { awareness: null } as never,
          user: { id: name, name },
          language: "en",
          translate: (k) => k,
          editorRef,
          noteId: "n",
          siteLinks: { current: null },
        })
      : withCollaboration({
          schema: noteSchema,
          collaboration: { provider: { awareness: undefined }, fragment: doc.getXmlFragment(YDOC_FRAGMENT), user: { id: name, name, color: "hsl(0 65% 45%)" } },
        } as any),
  ) as any as AnyEditor;
  editorRef.current = editor;
  const el = document.createElement("div");
  document.body.appendChild(el);
  editor.mount(el);
  // Same as NoteEditor's `useCollabUndoLifeline`: attach the undo lifeline after mount.
  const disarm = full ? keepCollabUndoAlive(editor) : () => {};
  cleanups.push(() => {
    disarm();
    editor.unmount();
    el.remove();
    doc.destroy();
  });
  return editor;
}

/** alice (ordinary collab) writes the initial content and syncs it to bob (full options); the initial content isn't in bob's undo stack. */
async function pair(initial: PartialBlockLike[]) {
  const d1 = new Y.Doc();
  const d2 = new Y.Doc();
  const alice = makeEditor(d1, "alice", false);
  await tick();
  alice.replaceBlocks(alice.document, initial);
  await tick();
  Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1));
  const bob = makeEditor(d2, "bob", true);
  await tick();
  const sync = async () => {
    const u1 = Y.encodeStateAsUpdate(d1, Y.encodeStateVector(d2));
    const u2 = Y.encodeStateAsUpdate(d2, Y.encodeStateVector(d1));
    Y.applyUpdate(d2, u1);
    Y.applyUpdate(d1, u2);
    await tick();
  };
  // One way: sends only bob's updates to alice (runs no Y transaction on bob's side).
  const bobToAlice = () => Y.applyUpdate(d1, Y.encodeStateAsUpdate(d2, Y.encodeStateVector(d1)));
  // One way: sends only alice's updates to bob.
  const aliceToBob = () => Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1, Y.encodeStateVector(d2)));
  return { alice, bob, sync, bobToAlice, aliceToBob };
}

/** End of the text of `id`'s first textblock (the drop point is in its lower half: PM's `dropPoint` inserts after this block). */
const textEnd = (editor: AnyEditor, id: string): number => {
  const pos = blockPos(editor, id);
  return pos + 2 + editor.prosemirrorView!.state.doc.nodeAt(pos)!.firstChild!.content.size;
};

function dispatchDrop(editor: AnyEditor, dataTransfer: unknown, pos: number, at: readonly [number, number], extra: { ctrlKey?: boolean } = {}): DragEvent {
  const view = editor.prosemirrorView! as any;
  view.posAtCoords = () => ({ pos, inside: -1 });
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  Object.defineProperty(event, "clientX", { value: at[0] });
  Object.defineProperty(event, "clientY", { value: at[1] });
  Object.defineProperty(event, "ctrlKey", { value: !!extra.ctrlKey });
  Object.defineProperty(event, "altKey", { value: false });
  view.dom.dispatchEvent(event);
  return event as DragEvent;
}

/**
 * A dragend the browser sends on the drag handle: the handle's own handler calls core `blockDragEnd` (which blurs the editor), then it bubbles to document. The handle stand-in is mounted inside the editor container (same as `startBlockDrag`).
 */
function dragEndFromHandle(editor: AnyEditor): void {
  const handle = document.createElement("div");
  editor.domElement!.parentElement!.appendChild(handle);
  handle.addEventListener("dragend", () => (editor.getExtension("sideMenu") as unknown as { blockDragEnd(): void }).blockDragEnd());
  handle.dispatchEvent(new Event("dragend", { bubbles: true }));
  handle.remove();
}

async function blockDrop(
  editor: AnyEditor,
  g: { drag: string; range?: readonly [string, string]; target: string; at?: readonly [number, number]; boxes?: Record<string, Box>; ctrlKey?: boolean },
  beforeDrop?: () => Promise<void>,
): Promise<DragEvent> {
  mockRects(editor, g.boxes);
  const { dataTransfer } = startBlockDrag(editor, g.drag, { range: g.range });
  await beforeDrop?.();
  const event = dispatchDrop(editor, dataTransfer, textEnd(editor, g.target), g.at ?? [300, 150], { ctrlKey: g.ctrlKey });
  dragEndFromHandle(editor);
  return event;
}

const ids = (editor: AnyEditor): string[] => editor.document.map((b) => b.id);
const selectionType = (editor: AnyEditor): string => editor.prosemirrorView!.state.selection.toJSON().type;

/** Page error stand-in: an exception thrown by y-prosemirror inside a Y observer surfaces from `undo()`. */
function undoOnce(editor: AnyEditor): void {
  expect(pressKey(editor, "z", { ctrlKey: true }), "Ctrl+Z 有 handler 接手").toBe(true);
}

const XROWZ = () => [P("x", "x1"), row([[P("a", "a1")], [P("b", "b1")]], "r"), P("z", "z1")];

describe("#428 Ctrl+Z right after dropping a horizontal-line drag into an existing column", () => {
  it.each([
    ["z dropped below a (into column 1)", "a1", "paragraph:x  ROW[COL(paragraph:a,paragraph:z) | COL(paragraph:b)]"],
    ["z dropped below b (into column 2)", "b1", "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b,paragraph:z)]"],
  ] as const)("%s: after the drop the selection isn't a NodeSelection; one Ctrl+Z restores, no exception, local and shared documents equal, ids unchanged", async (_label, target, moved) => {
    const { alice, bob, sync } = await pair(XROWZ());
    const before = shape(bob);
    const beforeIds = ids(bob);
    await blockDrop(bob, { drag: "z1", target, at: [target === "a1" ? 150 : 450, 150], boxes: rowBoxes("r", 2) });
    expect(shape(bob)).toBe(moved);
    expect.soft(selectionType(bob), "放下後的選取").toBe("text");
    expect.soft(cursorOf(bob)).toBe("z@0");
    await sync();
    expect(shape(alice)).toBe(moved);

    expect(() => undoOnce(bob)).not.toThrow();
    expect(shape(bob)).toBe(before);
    expect(ids(bob)).toEqual(beforeIds);
    await sync();
    expect(shape(alice)).toBe(before);
    expect(integrity(bob)).toEqual(CLEAN);

    // Redo: when undoing, y-prosemirror keeps the selection from before the drop, and redo restores with it.
    expect(() => pressKey(bob, "z", { ctrlKey: true, shiftKey: true })).not.toThrow();
    expect(shape(bob)).toBe(moved);
    await sync();
    expect(shape(alice)).toBe(moved);
  });

  it("z into column 1 -> Ctrl+Z then immediately Ctrl+Shift+Z (no Y transaction in between) -> no exception, back to the post-drop state, both sides equal", async () => {
    // After undo y-prosemirror keeps this step's "before the drop" selection, and the next non-local Y transaction (here, the redo) restores with it; any Y transaction in between (e.g. a sync) would consume it, so this case doesn't sync between the two presses.
    const { alice, bob, sync } = await pair(XROWZ());
    await blockDrop(bob, { drag: "z1", target: "a1", at: [150, 150], boxes: rowBoxes("r", 2) });
    const moved = shape(bob);
    undoOnce(bob);
    expect(shape(bob)).toBe("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b)]  paragraph:z");
    expect(() => pressKey(bob, "z", { ctrlKey: true, shiftKey: true })).not.toThrow();
    expect(shape(bob)).toBe(moved);
    await sync();
    expect(shape(alice)).toBe(moved);
  });

  it("top-level reorder (x y z, drag x below z) -> one Ctrl+Z restores, ids unchanged, one undo step added", async () => {
    const { bob } = await pair([P("x", "x1"), P("y", "y1"), P("z", "z1")]);
    const manager = collabUndoManager(bob)!;
    const stack = manager.undoStack.length;
    await blockDrop(bob, { drag: "x1", target: "z1" });
    expect(shape(bob)).toBe("paragraph:y  paragraph:z  paragraph:x");
    expect(ids(bob)).toEqual(["y1", "z1", "x1"]);
    expect.soft(selectionType(bob)).toBe("text");
    expect(manager.undoStack.length).toBe(stack + 1);
    expect(() => undoOnce(bob)).not.toThrow();
    expect(shape(bob)).toBe("paragraph:x  paragraph:y  paragraph:z");
    expect(ids(bob)).toEqual(["x1", "y1", "z1"]);
  });

  it("typing right before a reorder and right after (both within 500 ms) -> the reorder is its own step: Ctrl+Z undoes the later typing, the reorder, then the earlier typing in turn", async () => {
    const { bob } = await pair([P("x", "x1"), P("y", "y1"), P("z", "z1")]);
    const view = bob.prosemirrorView!;
    bob.setTextCursorPosition("y1", "end");
    view.dispatch(view.state.tr.insertText("Q"));
    await blockDrop(bob, { drag: "x1", target: "z1" });
    expect(shape(bob)).toBe("paragraph:yQ  paragraph:z  paragraph:x");
    view.dispatch(view.state.tr.insertText("R"));
    expect(shape(bob)).toBe("paragraph:yQ  paragraph:z  paragraph:Rx");
    undoOnce(bob);
    expect(shape(bob)).toBe("paragraph:yQ  paragraph:z  paragraph:x");
    undoOnce(bob);
    expect(shape(bob)).toBe("paragraph:x  paragraph:yQ  paragraph:z");
    undoOnce(bob);
    expect(shape(bob)).toBe("paragraph:x  paragraph:y  paragraph:z");
  });

  it("multi-select drag (a b dragged below c) -> after the drop a text selection spanning two blocks (a second drag still moves two blocks), one Ctrl+Z restores", async () => {
    const { bob } = await pair([P("a", "a1"), P("b", "b1"), P("c", "c1"), P("d", "d1")]);
    await blockDrop(bob, { drag: "a1", range: ["a1", "b1"], target: "c1" });
    expect(shape(bob)).toBe("paragraph:c  paragraph:a  paragraph:b  paragraph:d");
    const sel = bob.prosemirrorView!.state.selection;
    expect(sel.toJSON().type).toBe("text");
    expect(sel.$from.parent.textContent).toBe("a");
    expect(sel.$to.parent.textContent).toBe("b");
    expect(() => undoOnce(bob)).not.toThrow();
    expect(shape(bob)).toBe("paragraph:a  paragraph:b  paragraph:c  paragraph:d");
    expect(ids(bob)).toEqual(["a1", "b1", "c1", "d1"]);
  });

  it.each([
    ["horizontal-line reorder (x dragged below z)", { drag: "x1", target: "z1" }, "paragraph:y  paragraph:z  paragraph:x"],
    ["vertical-line column creation (x dragged to z's right edge)", { drag: "x1", target: "z1", at: [590, 165] as const, boxes: { "blockOuter:z1": [0, 150, 600, 180] as Box } }, "paragraph:y  ROW[COL(paragraph:z) | COL(paragraph:x)]  paragraph"],
  ] as const)("%s: undo then redo - after redo the selection is a caret, not a whole-block selection of the y now in x's old place", async (_label, g, moved) => {
    const { bob } = await pair([P("x", "x1"), P("y", "y1"), P("z", "z1")]);
    await blockDrop(bob, g);
    expect(shape(bob)).toBe(moved);
    undoOnce(bob);
    expect(shape(bob)).toBe("paragraph:x  paragraph:y  paragraph:z");
    pressKey(bob, "z", { ctrlKey: true, shiftKey: true });
    expect(shape(bob)).toBe(moved);
    expect(selectionType(bob)).toBe("text");
  });
});

describe("#429 collaborator types during a multi-select drag", () => {
  it("a b dragged below c, alice types in d during the drag (bob's multi-selection degrades to a text selection) -> a b moved as whole blocks, no empty paragraph, both sides equal", async () => {
    const { alice, bob, sync } = await pair([P("a", "a1"), P("b", "b1"), P("c", "c1"), P("d", "d1")]);
    await blockDrop(bob, { drag: "a1", range: ["a1", "b1"], target: "c1" }, async () => {
      expect(selectionType(bob), "前提：dragstart 後是多選").not.toBe("text");
      alice.setTextCursorPosition("d1", "end");
      alice.prosemirrorView!.dispatch(alice.prosemirrorView!.state.tr.insertText("Q"));
      await sync();
      expect(shape(bob)).toContain("paragraph:dQ");
      expect(selectionType(bob), "前提：遠端更新之後多選退化成文字選取").toBe("text");
    });
    expect(shape(bob)).toBe("paragraph:c  paragraph:a  paragraph:b  paragraph:dQ");
    expect(ids(bob)).toEqual(["c1", "a1", "b1", "d1"]);
    expect(integrity(bob)).toEqual(CLEAN);
    await sync();
    expect(shape(alice)).toBe(shape(bob));
    expect(ids(alice)).toEqual(ids(bob));

    expect(() => undoOnce(bob)).not.toThrow();
    expect(shape(bob)).toBe("paragraph:a  paragraph:b  paragraph:c  paragraph:dQ");
    expect(ids(bob)).toEqual(["a1", "b1", "c1", "d1"]);
    await sync();
    expect(shape(alice)).toBe(shape(bob));
  });
});

/** Builds a NodeSelection at `pos` via `fromJSON({ type: "node" })` (apps/web can't get prosemirror-state values). */
function selectNode(editor: AnyEditor, pos: number): void {
  const view = editor.prosemirrorView! as any;
  let base = view.state.selection.constructor;
  for (let p = Object.getPrototypeOf(base); p && p !== Function.prototype; p = Object.getPrototypeOf(base)) base = p;
  view.dispatch(view.state.tr.setSelection(base.fromJSON(view.state.doc, { type: "node", anchor: pos })));
  expect(selectionType(editor), "前提：NodeSelection").toBe("node");
}

describe("#428 selection at undo time is a NodeSelection", () => {
  it("undo stack empty: Ctrl+Z leaves the selection alone, the image stays a NodeSelection", async () => {
    const { bob } = await pair([P("x", "x1"), IMG("i1")]);
    expect(collabUndoManager(bob)!.undoStack.length, "前提：沒有東西可撤").toBe(0);
    selectNode(bob, blockPos(bob, "i1"));
    pressKey(bob, "z", { ctrlKey: true });
    expect(selectionType(bob)).toBe("node");
    expect(shape(bob)).toBe("paragraph:x  image");
  });

  it.each([
    ["x copied below z (document end)", XROWZ, { drag: "x1", target: "z1" }, "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b)]  paragraph:z  paragraph:x"],
    ["z copied below a (end of column 1)", XROWZ, { drag: "z1", target: "a1", at: [150, 150] as const, boxes: rowBoxes("r", 2) }, "paragraph:x  ROW[COL(paragraph:a,paragraph:z) | COL(paragraph:b)]  paragraph:z"],
  ] as const)("Ctrl copy-drag: %s -> focus in the editor, Ctrl+Z without clicking -> one step, no exception, local and shared documents equal", async (_label, content, g, copied) => {
    const { alice, bob, sync } = await pair(content());
    const before = shape(bob);
    const manager = collabUndoManager(bob)!;
    await blockDrop(bob, { ...g, ctrlKey: true });
    expect(shape(bob)).toBe(copied);
    expect(document.activeElement, "焦點在編輯器").toBe(bob.prosemirrorView!.dom);
    const stack = manager.undoStack.length;
    expect(() => undoOnce(bob)).not.toThrow();
    expect(manager.undoStack.length).toBe(stack - 1);
    expect(shape(bob)).toBe(before);
    await sync();
    expect(shape(alice)).toBe(before);
    expect(integrity(bob)).toEqual(CLEAN);
  });

  it.each([
    ["the image's block", 0],
    ["the image itself", 1],
  ] as const)("select %s (NodeSelection), undo removes the just-inserted image -> no exception, local and shared documents equal", async (_label, offset) => {
    const { alice, bob, sync } = await pair([P("x", "x1"), P("y", "y1")]);
    const manager = collabUndoManager(bob)!;
    manager.stopCapturing();
    bob.insertBlocks([IMG("i1")], "y1", "after");
    manager.stopCapturing();
    await sync();
    expect(shape(alice)).toBe("paragraph:x  paragraph:y  image");
    selectNode(bob, blockPos(bob, "i1") + offset);
    expect(() => undoOnce(bob)).not.toThrow();
    expect(shape(bob)).toBe("paragraph:x  paragraph:y");
    await sync();
    expect(shape(alice)).toBe("paragraph:x  paragraph:y");
  });

  it.each([
    ["Ctrl+Shift+Z", { ctrlKey: true, shiftKey: true }, "z"],
    ["Ctrl+Y", { ctrlKey: true }, "y"],
  ] as const)("when redo (%s) runs with a NodeSelection and removes that block -> no exception", async (_label, mods, key) => {
    const { alice, bob, sync } = await pair([P("x", "x1"), P("y", "y1")]);
    const manager = collabUndoManager(bob)!;
    manager.stopCapturing();
    bob.removeBlocks(["y1"]);
    manager.stopCapturing();
    expect(shape(bob)).toBe("paragraph:x");
    undoOnce(bob);
    expect(shape(bob)).toBe("paragraph:x  paragraph:y");
    await sync();
    selectNode(bob, blockPos(bob, "y1"));
    expect(() => pressKey(bob, key, mods)).not.toThrow();
    expect(shape(bob)).toBe("paragraph:x");
    await sync();
    expect(shape(alice)).toBe("paragraph:x");
  });
});

describe("#428 the pre-operation selection recorded in an undo step is a NodeSelection (the next Y transaction after undo restores with it)", () => {
  const IMAGE_AT_END = () => [P("x", "x1"), IMG("i1")];
  const IMAGE_AT_COLUMN_END = () => [P("x", "x1"), row([[P("a", "a1"), IMG("i1")], [P("b", "b1")]], "r")];
  const without = (content: "end" | "column") =>
    content === "end" ? "paragraph:x" : "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b)]";

  function deleteSelectedImageThenUndo(bob: AnyEditor, where: "end" | "column"): void {
    selectNode(bob, blockPos(bob, "i1"));
    expect(pressKey(bob, "Backspace"), "Backspace 有 handler 接手").toBe(true);
    expect(shape(bob), "前提：圖片刪掉了").toBe(without(where));
    undoOnce(bob);
    expect(shape(bob), "前提：撤銷後圖片回來").toContain("image");
  }

  it.each([
    ["document end", IMAGE_AT_END, "end"],
    ["last block of column 1", IMAGE_AT_COLUMN_END, "column"],
  ] as const)("image at %s: select -> Backspace -> Ctrl+Z -> immediately Ctrl+Shift+Z -> no exception, redo takes effect, local and shared documents equal", async (_label, content, where) => {
    const { alice, bob, sync } = await pair(content());
    // After alice writes the content her selection rests on the last inserted image; this case only looks at bob's undo, so put alice's caret in text first.
    alice.setTextCursorPosition("x1", "end");
    deleteSelectedImageThenUndo(bob, where);
    expect(() => pressKey(bob, "z", { ctrlKey: true, shiftKey: true })).not.toThrow();
    expect(shape(bob)).toBe(without(where));
    await sync();
    expect(shape(alice)).toBe(shape(bob));
    expect(integrity(bob)).toEqual(CLEAN);
  });

  it.each([
    ["document end", IMAGE_AT_END, "end"],
    ["last block of column 1", IMAGE_AT_COLUMN_END, "column"],
  ] as const)("image at %s: select -> Backspace -> Ctrl+Z, then a remote update arrives in which a collaborator deleted that image (no other Y transaction on bob's side in between) -> no exception, both sides equal; typing and undo work as usual afterwards", async (_label, content, where) => {
    const { alice, bob, sync, bobToAlice, aliceToBob } = await pair(content());
    alice.setTextCursorPosition("x1", "end");
    deleteSelectedImageThenUndo(bob, where);
    expect(() => bobToAlice()).not.toThrow();
    await tick();
    expect(shape(alice), "前提：alice 看到圖片回來").toContain("image");
    alice.removeBlocks(["i1"]);
    expect(() => aliceToBob()).not.toThrow();
    await tick();
    expect(shape(bob)).toBe(without(where));
    await sync();
    expect(shape(alice)).toBe(shape(bob));
    const manager = collabUndoManager(bob)!;
    manager.stopCapturing();
    bob.setTextCursorPosition("x1", "end");
    bob.prosemirrorView!.dispatch(bob.prosemirrorView!.state.tr.insertText("Q"));
    expect(shape(bob)).toContain("paragraph:xQ");
    expect(() => undoOnce(bob)).not.toThrow();
    expect(shape(bob)).toBe(without(where));
    await sync();
    expect(shape(alice)).toBe(shape(bob));
    expect(integrity(bob)).toEqual(CLEAN);
  });
});

describe("collaborator types in the dragged block mid-drag (docs/known-limitations.md)", () => {
  async function dragWhileAliceTypesInZ(content: PartialBlockLike[], g: Parameters<typeof blockDrop>[1]) {
    const p = await pair(content);
    await blockDrop(p.bob, g, async () => {
      p.alice.setTextCursorPosition("z1", "end");
      p.alice.prosemirrorView!.dispatch(p.alice.prosemirrorView!.state.tr.insertText("Q"));
      await p.sync();
      expect(shape(p.bob), "前提：bob 收到 alice 打的字").toContain("paragraph:zQ");
    });
    await p.sync();
    expect(shape(p.alice)).toBe(shape(p.bob));
    return p;
  }

  it("dropped above or below another block (horizontal line): the content from when the drag started lands, alice's typing is lost", async () => {
    const { bob } = await dragWhileAliceTypesInZ([P("x", "x1"), P("y", "y1"), P("z", "z1")], { drag: "z1", target: "x1" });
    expect(shape(bob)).toBe("paragraph:x  paragraph:z  paragraph:y");
  });

  it("dropped beside another block (vertical line creates a row): the content at drop time lands, alice's typing is kept", async () => {
    const { bob } = await dragWhileAliceTypesInZ([P("x", "x1"), P("y", "y1"), P("z", "z1")], {
      drag: "z1",
      target: "x1",
      at: [590, 115],
      boxes: { "blockOuter:x1": [0, 100, 600, 130] },
    });
    expect(shape(bob)).toBe("ROW[COL(paragraph:x) | COL(paragraph:zQ)]  paragraph:y");
  });

  it("dropped into an empty column: the content at drop time lands, alice's typing is kept", async () => {
    const { bob } = await dragWhileAliceTypesInZ([row([[P("a", "a1")], [{ id: "e1", type: "paragraph", content: [] } as PartialBlockLike]], "r"), P("z", "z1")], {
      drag: "z1",
      target: "e1",
      at: [450, 200],
      boxes: rowBoxes("r", 2),
    });
    expect(shape(bob)).toBe("ROW[COL(paragraph:a) | COL(paragraph:zQ)]");
  });
});

describe("#430 focus stays in the editor after a drag-handle drop", () => {
  it.each([
    ["horizontal-line reorder", { drag: "x1", target: "z1" }, "paragraph:y  paragraph:z  paragraph:x"],
    ["vertical-line column creation", { drag: "z1", target: "x1", at: [590, 115] as const, boxes: { "blockOuter:x1": [0, 100, 600, 130] as Box } }, "ROW[COL(paragraph:x) | COL(paragraph:z)]  paragraph:y"],
  ] as const)("%s: after the drag handle's dragend blurs the editor, focus returns to the editor with the caret at the start of the dragged block; a plain Ctrl+Z restores", async (_label, g, moved) => {
    const { bob } = await pair([P("x", "x1"), P("y", "y1"), P("z", "z1")]);
    await blockDrop(bob, g);
    expect(shape(bob)).toBe(moved);
    expect(document.activeElement).toBe(bob.prosemirrorView!.dom);
    expect(selectionType(bob)).toBe("text");
    expect(cursorOf(bob)).toBe(`${g.drag[0]}@0`);
    undoOnce(bob);
    expect(shape(bob)).toBe("paragraph:x  paragraph:y  paragraph:z");
  });

  it("drag handle dragged out without dropping into the editor -> dragend doesn't steal focus", async () => {
    const { bob } = await pair([P("x", "x1"), P("y", "y1"), P("z", "z1")]);
    const input = document.createElement("input");
    document.body.appendChild(input);
    cleanups.push(() => input.remove());
    mockRects(bob);
    startBlockDrag(bob, "x1");
    input.focus();
    dragEndFromHandle(bob);
    expect(document.activeElement).toBe(input);
    expect(shape(bob)).toBe("paragraph:x  paragraph:y  paragraph:z");
  });

  it("after a previous drag-handle drop, a dragend unrelated to the handle (e.g. a sidebar link) doesn't steal focus", async () => {
    const { bob } = await pair([P("x", "x1"), P("y", "y1"), P("z", "z1")]);
    await blockDrop(bob, { drag: "x1", target: "z1" });
    const input = document.createElement("input");
    document.body.appendChild(input);
    cleanups.push(() => input.remove());
    input.focus();
    input.dispatchEvent(new Event("dragend", { bubbles: true }));
    expect(document.activeElement).toBe(input);
  });

  it("Ctrl copy-drag (PM's default drop) works as before: copies, the original stays", async () => {
    const { bob } = await pair([P("x", "x1"), P("y", "y1"), P("z", "z1")]);
    await blockDrop(bob, { drag: "x1", target: "z1", ctrlKey: true });
    expect(shape(bob)).toBe("paragraph:x  paragraph:y  paragraph:z  paragraph:x");
  });
});
