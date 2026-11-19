/**
 * X is recorded at dragstart, never read from the current selection (a remote update mid-drag makes y-prosemirror restore a multi-selection to a text selection).
 * - Only editable, non-`preventDefault`ed dragstarts from inside this editor are recorded: a cancelled one never gets a dragend, and its stale X would
 *   make the next external drag-in look like a ⋮⋮ drag.
 * - Not cleared in a capture `drop`: capture runs before `handleDrop` on `view.dom`, and a microtask there runs between listeners. The caller clears it via `clearDraggedBlocks`.
 * - #430: core's ⋮⋮ dragend handler blurs the editor, so Ctrl+Z stops reaching it. `endBlockDrop` marks "dropped here" and the later bubbling
 *   `document` dragend moves focus back. If the ⋮⋮ is replaced during the drop (side menu re-targets), dragend never arrives and nothing blurs.
 */
import type { BlockNoteEditor } from "@blocknote/core";
import type { EditorView } from "prosemirror-view";
import { draggedFromSelection, type DraggedBlocks } from "./drag-geometry";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote's three generic parameters (repo convention)
type AnyEditor = BlockNoteEditor<any, any, any>;

const recorded = new WeakMap<EditorView, DraggedBlocks | null>();
const droppedHere = new WeakSet<EditorView>();

// The source test uses `editor.domElement.parentElement` (`bn-container` under React), same as core `isWithinEditor`; `dom` is the mount element.
export function attachDragSourceRecorder(editor: AnyEditor, dom: HTMLElement, signal: AbortSignal): void {
  // Bubble phase: core's ⋮⋮ and SideMenu dragstart handlers have already set the selection to the dragged blocks.
  document.addEventListener(
    "dragstart",
    (event) => {
      const view = editor.prosemirrorView as EditorView | undefined;
      if (!view) return;
      const inside = !!editor.domElement?.parentElement?.contains(event.target as Node);
      droppedHere.delete(view);
      recorded.set(view, editor.isEditable && inside && !event.defaultPrevented ? draggedFromSelection(view.state.selection) : null);
    },
    { signal },
  );
  document.addEventListener(
    "dragend",
    () => {
      const view = editor.prosemirrorView as EditorView | undefined;
      if (view) clearDraggedBlocks(view);
    },
    { capture: true, signal },
  );
  document.addEventListener(
    "dragend",
    (event) => {
      if ((event as { synthetic?: boolean }).synthetic) return;
      const view = editor.prosemirrorView as EditorView | undefined;
      if (!view || !droppedHere.has(view)) return;
      droppedHere.delete(view);
      if (editor.isEditable && view.dom.isConnected) view.focus();
    },
    { signal },
  );
}

export function endBlockDrop(view: EditorView): void {
  if (recorded.get(view)) droppedHere.add(view);
  clearDraggedBlocks(view);
}

export function draggedBlocksOf(view: EditorView): DraggedBlocks | null {
  return recorded.get(view) ?? null;
}

export function clearDraggedBlocks(view: EditorView): void {
  recorded.delete(view);
}
