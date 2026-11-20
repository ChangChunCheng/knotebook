import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { noteSchema } from "@/collab/schema";
import { registerEditor, setTourTransactionFilter } from "@/lib/tour-bridge";
import { createTourTransactionFilterExtension } from "./tour-transaction-filter";
import { isTourTransactionFilterOn, setEditorTransactionFilterFlag, TOUR_TRANSACTION_META } from "./tour-filter-flag";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple, repo convention
type AnyEditor = BlockNoteEditor<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ProseMirror node type isn't available at value level in apps/web
type Any = any;

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  vi.restoreAllMocks();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

function mountEditor(doc: Y.Doc, extensions = [createTourTransactionFilterExtension()]): AnyEditor {
  const editor = BlockNoteEditor.create(
    withCollaboration({
      schema: noteSchema,
      collaboration: {
        provider: { awareness: undefined },
        fragment: doc.getXmlFragment(YDOC_FRAGMENT),
        user: { id: "u1", name: "User 1", color: "hsl(0 65% 45%)" },
      },
      _tiptapOptions: { extensions },
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
  });
  return editor;
}

async function setup(text = "hello"): Promise<{ doc: Y.Doc; editor: AnyEditor }> {
  const doc = new Y.Doc();
  cleanups.push(() => doc.destroy());
  const editor = mountEditor(doc);
  await tick();
  editor.replaceBlocks(editor.document, [{ type: "paragraph", content: text }]);
  return { doc, editor };
}

function texts(editor: AnyEditor): string[] {
  return editor.document.map((b: { content?: unknown }) =>
    Array.isArray(b.content) ? b.content.map((n: { text?: string }) => n.text ?? "").join("") : "",
  );
}

function endOfFirstText(editor: AnyEditor): number {
  let end = -1;
  editor._tiptapEditor.state.doc.descendants((node: Any, pos: number) => {
    if (end !== -1) return false;
    if (node.isTextblock) {
      end = pos + 1 + node.content.size;
      return false;
    }
    return true;
  });
  return end;
}

function blockIds(editor: AnyEditor): unknown[] {
  const ids: unknown[] = [];
  editor._tiptapEditor.state.doc.descendants((node: Any) => {
    if (node.type.name === "blockContainer") ids.push(node.attrs.id);
    return true;
  });
  return ids;
}

/** Inserts a copy of the first block at the end of the outermost blockGroup with id null: BlockNote's UniqueID fills it in with an appended transaction. */
function appendBlockWithoutId(state: Any): Any {
  const group = state.doc.firstChild;
  const first = group.firstChild;
  const copy = first.type.create({ ...first.attrs, id: null }, first.content);
  return state.tr.insert(1 + group.content.size, copy);
}

function typeAtEnd(editor: AnyEditor, text: string, meta?: [string, unknown]): void {
  const view = editor._tiptapEditor.view;
  const tr = view.state.tr.insertText(text, endOfFirstText(editor));
  if (meta) tr.setMeta(meta[0], meta[1]);
  view.dispatch(tr);
}

describe("tour transaction filter (real editor with Y.Doc collab)", () => {
  it("switch off: ordinary insertText is written as usual, into the Y.Doc too", async () => {
    const { doc, editor } = await setup();
    expect(isTourTransactionFilterOn(editor._tiptapEditor)).toBe(false);
    const before = Y.encodeStateVector(doc);
    typeAtEnd(editor, " world");
    expect(texts(editor)).toEqual(["hello world"]);
    expect(Y.encodeStateVector(doc)).not.toEqual(before);
  });

  it("the switch is kept per editor instance: with another editor's on, this one still writes as usual", async () => {
    const { editor: a } = await setup();
    const { editor: b } = await setup();
    setEditorTransactionFilterFlag(b._tiptapEditor, true);
    typeAtEnd(a, "a");
    typeAtEnd(b, "b");
    expect(texts(a)).toEqual(["helloa"]);
    expect(texts(b)).toEqual(["hello"]);
  });

  it("on: ordinary insertText and transactions with the composition meta are blocked, document and Y.Doc unchanged", async () => {
    const { doc, editor } = await setup();
    setEditorTransactionFilterFlag(editor._tiptapEditor, true);
    const before = Y.encodeStateVector(doc);
    typeAtEnd(editor, "x");
    typeAtEnd(editor, "測", ["composition", 1]);
    expect(texts(editor)).toEqual(["hello"]);
    expect(Y.encodeStateVector(doc)).toEqual(before);
  });

  it("on: selection-only transactions pass", async () => {
    const { editor } = await setup();
    const end = endOfFirstText(editor);
    editor._tiptapEditor.commands.setTextSelection(end);
    setEditorTransactionFilterFlag(editor._tiptapEditor, true);
    editor._tiptapEditor.commands.setTextSelection(end - 2);
    expect(editor._tiptapEditor.state.selection.from).toBe(end - 2);
    expect(texts(editor)).toEqual(["hello"]);
  });

  it("on: document-changing transactions with the tour meta pass", async () => {
    const { editor } = await setup();
    setEditorTransactionFilterFlag(editor._tiptapEditor, true);
    typeAtEnd(editor, "!", [TOUR_TRANSACTION_META, true]);
    expect(texts(editor)).toEqual(["hello!"]);
  });

  it("on: an update from another Y.Doc applied (y-sync$) -> the content appears as usual", async () => {
    const { doc: d1, editor: a } = await setup();
    const d2 = new Y.Doc();
    cleanups.push(() => d2.destroy());
    Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1));
    const b = mountEditor(d2, []);
    await tick();
    expect(texts(b)).toEqual(["hello"]);

    setEditorTransactionFilterFlag(a._tiptapEditor, true);
    typeAtEnd(b, " from B");
    expect(texts(b)).toEqual(["hello from B"]);
    Y.applyUpdate(d1, Y.encodeStateAsUpdate(d2, Y.encodeStateVector(d1)));
    await tick();
    expect(texts(a)).toEqual(["hello from B"]);
    // Control: typing in this same editor is still blocked, so the update above passed because of y-sync$.
    typeAtEnd(a, "x");
    expect(texts(a)).toEqual(["hello from B"]);
  });

  it("on: inserting a block without an id with the tour meta -> the appended transaction that fills in the id passes too; an insert without the meta is still blocked", async () => {
    const { editor } = await setup();
    const tiptap = editor._tiptapEditor;
    setEditorTransactionFilterFlag(tiptap, true);
    tiptap.view.dispatch(appendBlockWithoutId(tiptap.state));
    expect(blockIds(editor)).toHaveLength(1);
    tiptap.view.dispatch(appendBlockWithoutId(tiptap.state).setMeta(TOUR_TRANSACTION_META, true));
    const ids = blockIds(editor);
    expect(ids).toHaveLength(2);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
  });

  it("on: a remote block without an id applied -> the local side fills in the id (the appended transaction passes along with the remote sync)", async () => {
    const { doc: d1, editor: a } = await setup();
    const d2 = new Y.Doc();
    cleanups.push(() => d2.destroy());
    Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1));
    setEditorTransactionFilterFlag(a._tiptapEditor, true);

    const group = d2.getXmlFragment(YDOC_FRAGMENT).get(0) as Y.XmlElement;
    const block = new Y.XmlElement("blockContainer");
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText("remote")]);
    block.insert(0, [paragraph]);
    group.insert(group.length, [block]);
    Y.applyUpdate(d1, Y.encodeStateAsUpdate(d2, Y.encodeStateVector(d1)));
    await tick();

    expect(texts(a)).toEqual(["hello", "remote"]);
    const ids = blockIds(a);
    expect(ids).toHaveLength(2);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
  });

  it("toggled several times: the number and identity of state.plugins are unchanged and registerPlugin/unregisterPlugin aren't called", async () => {
    const { editor } = await setup();
    const tiptap = editor._tiptapEditor;
    const register = vi.spyOn(tiptap, "registerPlugin");
    const unregister = vi.spyOn(tiptap, "unregisterPlugin");
    const before = [...tiptap.state.plugins];
    for (const on of [true, false, true, false, true]) {
      setEditorTransactionFilterFlag(tiptap, on);
      typeAtEnd(editor, "x");
    }
    setEditorTransactionFilterFlag(tiptap, false);
    const after = tiptap.state.plugins;
    expect(after).toHaveLength(before.length);
    after.forEach((plugin: unknown, i: number) => expect(plugin).toBe(before[i]));
    expect(register).not.toHaveBeenCalled();
    expect(unregister).not.toHaveBeenCalled();
    // On, off, on, off, on with one typing each: only the two typed while off land, so the switch still works after several toggles.
    expect(texts(editor)).toEqual(["helloxx"]);
  });
});

describe("tour transaction filter: switch via the registry", () => {
  it("setTourTransactionFilter with an id different from the registered one -> no effect; the same id -> takes effect", async () => {
    const { editor } = await setup();
    const unregister = registerEditor("note-1", editor);
    cleanups.push(unregister);
    expect(setTourTransactionFilter("other", true)).toBe(false);
    typeAtEnd(editor, "a");
    expect(texts(editor)).toEqual(["helloa"]);

    expect(setTourTransactionFilter("note-1", true)).toBe(true);
    typeAtEnd(editor, "b");
    expect(texts(editor)).toEqual(["helloa"]);
    expect(setTourTransactionFilter("note-1", false)).toBe(true);
    typeAtEnd(editor, "c");
    expect(texts(editor)).toEqual(["helloac"]);
  });

  it("after unregistering the switch is off and typing is written as usual", async () => {
    const { editor } = await setup();
    const unregister = registerEditor("note-1", editor);
    setTourTransactionFilter("note-1", true);
    typeAtEnd(editor, "a");
    expect(texts(editor)).toEqual(["hello"]);
    unregister();
    expect(isTourTransactionFilterOn(editor._tiptapEditor)).toBe(false);
    typeAtEnd(editor, "b");
    expect(texts(editor)).toEqual(["hellob"]);
  });

  it("unregistering after the editor has unmounted: no throw, the switch is off", async () => {
    const { editor } = await setup();
    const unregister = registerEditor("note-1", editor);
    setTourTransactionFilter("note-1", true);
    editor.unmount();
    expect(() => unregister()).not.toThrow();
    expect(isTourTransactionFilterOn(editor._tiptapEditor)).toBe(false);
  });
});
