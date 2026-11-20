import { StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { noteSchema } from "@/collab/schema";
import { collabUndoManager } from "@/collab/undo";
import { NoteEditorView } from "@/components/NoteEditor";

/**
 * Regression guard for issue #97: Ctrl+Z / Ctrl+Shift+Z did nothing in collaborative mode.
 *
 * Cause (details in the header of `@/collab/undo`): the `<BlockNoteView>` mount ref callback listed
 * `editable` in its `useCallback` deps, so every `editable` flip made React detach the old ref
 * (`editor.unmount()`) and attach a new one (`editor.mount()`). y-prosemirror's undo plugin calls
 * `undoManager.destroy()` (unsubscribes from the Y.Doc) when the view is destroyed, but the plugin
 * state keeps the same dead manager, so `undoStack` stays 0 and `editor.undo()` silently does nothing.
 *
 * Mounting and then typing does not reproduce this: the view must actually be torn down once. Each
 * test takes a real remount path:
 * 1. `editable` false -> true (`NotePage`'s `roleCanEdit && synced`, once per opened note)
 * 2. React `StrictMode` (mount -> unmount -> mount on every dev mount)
 *
 * Uses the real `<NoteEditorView>`, not a bare `<BlockNoteView>`, because the lifeline is wired there.
 */

const editors: BlockNoteEditor<never, never, never>[] = [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote editor generic triple; any per repo convention (same as NoteEditor.tsx/NoteEditorView.test.tsx)
type AnyEditor = BlockNoteEditor<any, any, any>;

function collabEditor(): { doc: Y.Doc; editor: AnyEditor } {
  const doc = new Y.Doc();
  const editor = BlockNoteEditor.create(
    withCollaboration({
      schema: noteSchema,
      collaboration: {
        // awareness undefined = no y-cursor (not needed here, and jsdom lacks the APIs).
        provider: { awareness: undefined },
        fragment: doc.getXmlFragment(YDOC_FRAGMENT),
        user: { id: "u1", name: "User 1", color: "hsl(0 65% 45%)" },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- withCollaboration's option type requires the full schema generic triple
    } as any),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
  ) as any as AnyEditor;
  editors.push(editor as never);
  return { doc, editor };
}

async function getItems() {
  return [];
}

function firstBlockText(editor: AnyEditor): string {
  const content = editor.document[0]?.content;
  if (!Array.isArray(content)) return "";
  return content.map((node: { text?: string }) => node.text ?? "").join("");
}

function type(editor: AnyEditor, text: string): void {
  act(() => {
    editor.updateBlock(editor.document[0]!, { content: text });
  });
}

/**
 * Whether the note's Y.Doc has this UndoManager's `afterTransaction` handler: necessary and sufficient
 * for the manager being alive, since `UndoManager.destroy()` removes exactly this subscription and
 * without it `undoStack` never grows.
 */
function isSubscribed(doc: Y.Doc, manager: Y.UndoManager): boolean {
  const observers = (doc as unknown as { _observers: Map<string, Set<unknown>> })._observers;
  return observers.get("afterTransaction")?.has(manager.afterTransactionHandler) === true;
}

afterEach(() => {
  for (const editor of editors.splice(0)) {
    // Unmount every mounted editor so jsdom's document does not accumulate portals.
    try {
      (editor as unknown as AnyEditor).unmount();
    } catch {
      // Unmounting an editor that never mounted warns; harmless.
    }
  }
});

describe("collaborative undo/redo lifeline (issue #97)", () => {
  it("undo still reverts typed text after editable flips false -> true (synced completes)", () => {
    const { editor } = collabEditor();
    const { rerender } = render(
      <NoteEditorView editor={editor} editable={false} theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />,
    );
    rerender(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />);

    type(editor, "hello world");
    expect(firstBlockText(editor)).toBe("hello world");

    act(() => {
      editor.undo();
    });

    expect(firstBlockText(editor)).toBe("");
  });

  it("redo also works after the editable flip (Ctrl+Shift+Z / Ctrl+Y use the same UndoManager)", () => {
    const { editor } = collabEditor();
    const { rerender } = render(
      <NoteEditorView editor={editor} editable={false} theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />,
    );
    rerender(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />);

    type(editor, "hello world");
    act(() => {
      editor.undo();
    });
    expect(firstBlockText(editor)).toBe("");

    act(() => {
      editor.redo();
    });

    expect(firstBlockText(editor)).toBe("hello world");
  });

  it("undo still works after a simulated StrictMode remount (happens on every dev mount)", () => {
    const { editor } = collabEditor();
    render(
      <StrictMode>
        <NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />
      </StrictMode>,
    );

    type(editor, "hello world");
    act(() => {
      editor.undo();
    });

    expect(firstBlockText(editor)).toBe("");
  });

  it("invariant: the UndoManager stays subscribed to its Y.Doc after a view remount", () => {
    const { doc, editor } = collabEditor();
    const { rerender } = render(
      <NoteEditorView editor={editor} editable={false} theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />,
    );
    const manager = collabUndoManager(editor);
    // Pin that the manager can be found first: if BlockNote changes the shape of the `yUndo` extension
    // this fails, instead of the lifeline silently degrading to a no-op and the other assertions passing vacuously.
    expect(manager).toBeDefined();
    expect(isSubscribed(doc, manager!)).toBe(true);

    rerender(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />);

    expect(isSubscribed(doc, manager!)).toBe(true);
    // And it is the same manager, not a silently rebuilt one (rebuilding loses the pre-remount history).
    expect(collabUndoManager(editor)).toBe(manager);
  });

  it("remount keeps history: typing before and after the remount, two Ctrl+Z steps undo them one at a time (UndoManager is not rebuilt empty)", () => {
    const { editor } = collabEditor();
    const { rerender } = render(
      <NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />,
    );
    type(editor, "before");
    // The default `captureTimeout` of 500ms merges adjacent changes into one item; stop capturing so the two
    // inputs are separate stack items and the two undos below test two history steps.
    collabUndoManager(editor)!.stopCapturing();

    rerender(<NoteEditorView editor={editor} editable={false} theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />);
    rerender(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />);

    type(editor, "before / after");
    act(() => {
      editor.undo();
    });
    // First undo reverts the edit made after the remount; that item exists only if the lifeline reattached the manager.
    expect(firstBlockText(editor)).toBe("before");

    act(() => {
      editor.undo();
    });
    // Second undo reverts the edit made before the remount; a fix that rebuilds the manager would lose this item.
    expect(firstBlockText(editor)).toBe("");
  });

  it("switching notes does not leak: a new Y.Doc/editor has its own empty undo history, and undo does not touch another note's content", () => {
    const { editor: first } = collabEditor();
    const { unmount } = render(
      <NoteEditorView editor={first} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />,
    );
    type(first, "note one");
    unmount();

    // `useCollab` opens a new Y.Doc/provider on note switch, so `useCreateBlockNote([doc, provider])`
    // builds a fresh editor; reproduce that shape.
    const { editor: second } = collabEditor();
    render(<NoteEditorView editor={second} editable theme="light" noteId="note-2" getItems={getItems} getSlashItems={getItems} />);

    expect(collabUndoManager(second)).not.toBe(collabUndoManager(first));
    expect(collabUndoManager(second)!.undoStack).toHaveLength(0);

    act(() => {
      second.undo();
    });

    expect(firstBlockText(second)).toBe("");
    expect(firstBlockText(first)).toBe("note one");
  });
});

/**
 * Issue #100: redo breaks after undoing to an empty document.
 *
 * Mechanism (fully reproduced in jsdom): undo empties the fragment -> BlockNote/PM normalization
 * restores an empty paragraph -> on the next arbitrary PM transaction the y-prosemirror sync plugin's
 * `view.update` writes the normalization back to the Y.Doc with `ySyncPluginKey` as origin (the origin
 * shared with user edits) -> `UndoManager` treats it as a new edit -> `clear(false, true)` wipes the
 * redoStack. Waiting longer always loses; pressing fast sometimes wins: that is the race.
 *
 * `guardEmptyDocNormalization` discriminates on three conditions together: origin = y-sync$ AND empty
 * deleteSet AND result is exactly the default empty document. No real user edit satisfies all three
 * (deleting everything has a deleteSet; typing the first character yields a non-empty result). The
 * "user clears it themselves" test guards against the discriminator becoming too broad.
 */
describe("redo after undoing to an empty document (issue #100)", () => {
  /** Simulates any PM transaction ~12ms after undo: an empty tr triggers the sync plugin's view.update write-back. */
  function triggerNormalizationWriteback(editor: AnyEditor): void {
    act(() => {
      const view = editor._tiptapEditor.view;
      view.dispatch(view.state.tr);
    });
  }

  it("type -> undo to empty -> (after the normalization write-back) redo restores the text and the document structure stays single", () => {
    const { doc, editor } = collabEditor();
    render(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />);
    const manager = collabUndoManager(editor)!;

    type(editor, "hello");
    act(() => { manager.undo(); });
    expect(doc.getXmlFragment(YDOC_FRAGMENT).length, "undo 後 fragment 應為空（本 bug 的前提）").toBe(0);

    triggerNormalizationWriteback(editor);
    expect(manager.redoStack.length, "正規化回寫不得清掉 redoStack（#100 的核心）").toBe(1);

    act(() => { manager.redo(); });
    expect(firstBlockText(editor)).toBe("hello");
    // Leftover guard: the empty blockGroup that normalization inserted before redo must be cleared; otherwise the
    // fragment has two parallel blockGroups (invalid structure), PM renders only the first, and redo looks like it did nothing.
    const xml = doc.getXmlFragment(YDOC_FRAGMENT).toString();
    expect((xml.match(/<blockgroup/g) ?? []).length).toBe(1);
  });

  it("history works back and forth: redo, undo, redo all succeed, and clearing the leftover does not enter history", () => {
    const { doc, editor } = collabEditor();
    render(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />);
    const manager = collabUndoManager(editor)!;

    type(editor, "hello");
    act(() => { manager.undo(); });
    triggerNormalizationWriteback(editor);
    act(() => { manager.redo(); });
    expect(firstBlockText(editor)).toBe("hello");
    // Clearing the leftover (non-tracked origin) must not become a history item: undoStack should hold only the "hello" item now.
    expect(manager.undoStack.length).toBe(1);

    act(() => { manager.undo(); });
    expect(doc.getXmlFragment(YDOC_FRAGMENT).length, "再 undo 應回到空").toBe(0);
    triggerNormalizationWriteback(editor);
    act(() => { manager.redo(); });
    expect(firstBlockText(editor), "第二輪 redo 也要通").toBe("hello");
  });

  it("discriminator is not too broad: a user clearing the content themselves (empty-document shape, but with a deletion) is still undoable", () => {
    const { editor } = collabEditor();
    render(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />);
    const manager = collabUndoManager(editor)!;

    type(editor, "hello");
    // Separate items: without stopCapturing, typing and clearing fall in one captureTimeout (500ms) and merge, so one
    // undo would go back to before the typing and "undo restores the cleared content" would not be tested.
    act(() => { manager.stopCapturing(); });
    // The user clears: also written back via y-sync$ and the result is again an empty paragraph, but the deleteSet is
    // non-empty. It must be captured, otherwise deleting all content would be irreversible. (`content: []` is the
    // real clear; `""` is a no-op for updateBlock.)
    act(() => { editor.updateBlock(editor.document[0]!, { content: [] }); });
    expect(firstBlockText(editor)).toBe("");

    act(() => { manager.undo(); });
    expect(firstBlockText(editor), "undo 要能復原被清掉的內容").toBe("hello");
  });

  it("after an editable flip (view remount, lifeline re-armed) the guard still works and is not stacked twice", () => {
    const { doc, editor } = collabEditor();
    const { rerender } = render(
      <NoteEditorView editor={editor} editable={false} theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />,
    );
    rerender(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />);
    const manager = collabUndoManager(editor)!;

    type(editor, "hello");
    act(() => { manager.undo(); });
    triggerNormalizationWriteback(editor);
    act(() => { manager.redo(); });
    expect(firstBlockText(editor)).toBe("hello");
    expect((doc.getXmlFragment(YDOC_FRAGMENT).toString().match(/<blockgroup/g) ?? []).length).toBe(1);
  });
});

/**
 * Regression boundary for the issue #100 fix: the leftover must not be identified by "looks like the default
 * empty document", because that structure can be the live parent of a redo item (yjs `redoItem` returns null
 * for a deleted parent that is not in the redo set, so the whole redo stack pops without restoring anything).
 * Only the normalization this session just refused to capture, and that no edit has touched since, may be cleared.
 */
describe("leftover identification does not delete a live baseline (#100)", () => {
  function triggerWriteback(editor: AnyEditor): void {
    act(() => { const view = editor._tiptapEditor.view; view.dispatch(view.state.tr); });
  }

  it("same session: undo to empty -> leftover lands -> type again -> undo -> redo restores the new text (the leftover is now the parent of the new edit and must stay)", () => {
    const { editor } = collabEditor();
    render(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />);
    const manager = collabUndoManager(editor)!;

    type(editor, "hello");
    act(() => { manager.undo(); });
    triggerWriteback(editor);
    act(() => { manager.stopCapturing(); });
    type(editor, "world");
    act(() => { manager.undo(); });
    triggerWriteback(editor);

    act(() => { manager.redo(); });
    expect(firstBlockText(editor), "redo 應復原 world；殘渣被誤刪的話 redo 整疊失效、文件停在全空").toBe("world");
  });

  it("reopening a note that was undone to empty: leftover persisted as baseline -> type -> undo -> redo restores (the new session refused nothing, so no node may be cleared)", () => {
    const first = collabEditor();
    render(<NoteEditorView editor={first.editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />);
    const firstManager = collabUndoManager(first.editor)!;
    type(first.editor, "hello");
    act(() => { firstManager.undo(); });
    act(() => { const view = first.editor._tiptapEditor.view; view.dispatch(view.state.tr); });
    expect(first.doc.getXmlFragment(YDOC_FRAGMENT).length, "殘渣應已落地").toBe(1);

    const second = collabEditor();
    Y.applyUpdate(second.doc, Y.encodeStateAsUpdate(first.doc));
    render(<NoteEditorView editor={second.editor} editable theme="light" noteId="note-2" getItems={getItems} getSlashItems={getItems} />);
    const manager = collabUndoManager(second.editor)!;

    type(second.editor, "world");
    act(() => { manager.undo(); });
    act(() => { const view = second.editor._tiptapEditor.view; view.dispatch(view.state.tr); });
    act(() => { manager.redo(); });
    expect(firstBlockText(second.editor), "redo 應復原 world；baseline 被誤刪＝資料遺失且不可 undo 救回").toBe("world");
  });
});

/**
 * Each leg of the discriminator pinned on its own. Natural flows cannot reach the origin and deleteSet legs
 * (other conditions stop user scenarios first), so these use synthetic transactions: the discriminator
 * compares origin only through the `key === "y-sync$"` string, so a fake object works as origin.
 */
describe("each leg of the discriminator is guarded separately (#100)", () => {
  function triggerWriteback(editor: AnyEditor): void {
    act(() => { const view = editor._tiptapEditor.view; view.dispatch(view.state.tr); });
  }
  function defaultEmptyGroup(): Y.XmlElement {
    const group = new Y.XmlElement("blockGroup");
    const container = new Y.XmlElement("blockContainer");
    const paragraph = new Y.XmlElement("paragraph");
    container.insert(0, [paragraph]);
    group.insert(0, [container]);
    return group;
  }

  it("origin leg: a plain insert of the empty-document shape from a non-sync origin must be captured (e.g. a future server seed)", () => {
    const { doc, editor } = collabEditor();
    render(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />);
    const manager = collabUndoManager(editor)!;
    // Make the UndoManager track the synthetic origin, isolating the case where only the origin leg discriminates.
    const seedOrigin = { key: "not-sync" };
    manager.trackedOrigins.add(seedOrigin);

    // Insert the default empty-document shape into an empty fragment; the only difference from a normalization write-back is the origin.
    act(() => { doc.transact(() => { doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [defaultEmptyGroup()]); }, seedOrigin); });
    expect(manager.undoStack.length, "origin 不是 y-sync$ 就不得被判成正規化，必須進歷史").toBe(1);
  });

  it("deleteSet leg: a synthetic sync-origin write-back that deletes and rebuilds the empty-document shape must be captured", () => {
    const { doc, editor } = collabEditor();
    render(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />);
    const manager = collabUndoManager(editor)!;

    type(editor, "hello");
    act(() => { manager.stopCapturing(); });
    const before = manager.undoStack.length;
    // Fake y-sync$ origin: the discriminator only compares the key string. It must be in trackedOrigins first (the real
    // ySyncPluginKey already is), otherwise the handler returns early at the origin check and the discriminator is never
    // reached. This write deletes and inserts and yields the empty-document shape; the deleteSet leg is what stops it.
    const fakeSyncOrigin = { key: "y-sync$" };
    manager.trackedOrigins.add(fakeSyncOrigin);
    act(() => {
      doc.transact(() => {
        const fragment = doc.getXmlFragment(YDOC_FRAGMENT);
        fragment.delete(0, fragment.length);
        fragment.insert(0, [defaultEmptyGroup()]);
      }, fakeSyncOrigin);
    });
    expect(manager.undoStack.length, "有刪除的回寫不是正規化，必須進歷史（否則這種清空不可 undo）").toBe(before + 1);
  });

  it("WeakSet idempotence: installing the guard repeatedly (the lifeline calls it on every remount) does not add another wrapper layer", () => {
    const { editor } = collabEditor();
    const { rerender } = render(
      <NoteEditorView editor={editor} editable={false} theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />,
    );
    const manager = collabUndoManager(editor)!;
    const captureRef = manager.captureTransaction;
    const redoRef = manager.redo;
    rerender(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />);
    expect(manager.captureTransaction, "重複裝不得換掉（再包一層）captureTransaction").toBe(captureRef);
    expect(manager.redo, "重複裝不得換掉（再包一層）redo").toBe(redoRef);
  });

  // What this pins is the invalidation branch (the leftover record is dropped once the cleanup and redo transactions
  // flow through captureTransaction), not the trailing null of the redo wrapper, which is defense in depth.
  it("leftover record is single-use: after one redo, the same node is not deleted by a second redo", () => {
    const { doc, editor } = collabEditor();
    render(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />);
    const manager = collabUndoManager(editor)!;

    type(editor, "hello");
    act(() => { manager.undo(); });
    triggerWriteback(editor);
    act(() => { manager.redo(); });
    expect(firstBlockText(editor)).toBe("hello");
    act(() => { manager.redo(); });
    expect(firstBlockText(editor)).toBe("hello");
    expect(doc.getXmlFragment(YDOC_FRAGMENT).toString()).toContain("hello");
  });
});

/**
 * Dead-window hardening: the invalidation invariant "captureTransaction sees every transaction" relies on the
 * manager being subscribed to afterTransaction, and the #97 cause is exactly that subscription being torn down
 * on view remount. If a remote update touches the leftover node in place while the subscription is dead, the
 * identity comparison cannot catch it (the node is not replaced), and after re-arm a redo would delete the
 * remote content together with the leftover (non-tracked origin, undo cannot recover it, and it is broadcast).
 * Hardening: every re-arm invalidates the leftover record (a re-arm may follow a dead window); the degraded
 * outcome is the documented parallel empty block, which fails safe.
 */
describe("re-arm after a dead window invalidates the leftover record (issue #100)", () => {
  it("remote write into the leftover paragraph while the subscription is dead -> re-arm -> redo does not delete the remote content", () => {
    const { doc, editor } = collabEditor();
    const { rerender } = render(
      <NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />,
    );
    const manager = collabUndoManager(editor)!;

    type(editor, "hello");
    act(() => { manager.undo(); });
    act(() => { const view = editor._tiptapEditor.view; view.dispatch(view.state.tr); });
    // Simulate the dead window: the subscription is gone (the #97 view-remount period).
    doc.off("afterTransaction", manager.afterTransactionHandler);
    act(() => {
      doc.transact(() => {
        const paragraph = (doc.getXmlFragment(YDOC_FRAGMENT).get(0) as Y.XmlElement).get(0) as Y.XmlElement;
        (paragraph.get(0) as Y.XmlElement).insert(0, [new Y.XmlText("REMOTE")]);
      }, "remote-provider");
    });
    rerender(<NoteEditorView editor={editor} editable={false} theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />);
    rerender(<NoteEditorView editor={editor} editable theme="light" noteId="note-1" getItems={getItems} getSlashItems={getItems} />);

    act(() => { manager.redo(); });
    expect(
      doc.getXmlFragment(YDOC_FRAGMENT).toString(),
      "遠端內容不得被清殘渣連坐刪掉（非 tracked origin、undo 救不回）",
    ).toContain("REMOTE");
  });
});
