import { useLayoutEffect } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import type { UndoManager } from "yjs";

/**
 * Keeps undo/redo alive in collaborative mode (#97).
 *
 * The `yUndoPlugin` view's `destroy()` calls `undoManager.destroy()` (y-prosemirror 1.3.7), which
 * unsubscribes it from the Y.Doc (yjs 13.6.32), but a view remount reuses the same `EditorState`
 * and so the same destroyed manager: Ctrl+Z silently does nothing. The view remounts on every
 * `editable` flip (`@blocknote/react` 0.52.1 binds mount to a ref callback depending on it, and
 * `NotePage` flips it false→true on every note open) and on StrictMode's simulated remount.
 * Preventing the teardown is fragile (any new prop dependency breaks it); the sync plugin
 * re-attaches on every `view()` but the undo plugin only tears down, so the manager is re-armed on every mount (`keepCollabUndoAlive`).
 *
 * The manager is deliberately not rebuilt: `destroy()` keeps `undoStack`/`redoStack`, so
 * re-subscribing revives the history, whereas a rebuild drops it; and the old instance holds the
 * plugin's `stack-item-added` listener (cursor restore), so the later `destroy()` would tear down
 * the wrong object.
 */

interface YUndoPluginState {
  undoManager?: UndoManager;
}

/**
 * Reads the plugin from BlockNote's own `yUndo` extension instead of importing `yUndoPluginKey`:
 * a `PluginKey` identity check silently fails (`getState()` returns `undefined`) if pnpm gives
 * apps/web and `@blocknote/core` two y-prosemirror instances.
 */
export function collabUndoManager(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote editor's three generic parameters; repo convention uses any (as in components/NoteEditor.tsx, components/wikilink/menu.ts)
  editor: BlockNoteEditor<any, any, any>,
): UndoManager | undefined {
  const plugin = editor.getExtension("yUndo")?.prosemirrorPlugins?.[0];
  return (plugin?.getState(editor.prosemirrorState) as YUndoPluginState | undefined)?.undoManager;
}

// Idempotent (`trackedOrigins` and lib0 `Observable.on` are Sets), so the first mount needs no destroyed check.
export function armCollabUndoManager(manager: UndoManager): void {
  // Without it undo works but redo is dead: undo's origin is the manager itself, and an untracked origin makes the handler return early.
  manager.trackedOrigins.add(manager);
  manager.doc.on("afterTransaction", manager.afterTransactionHandler);
  // Symmetry with `destroy()`; `super.destroy()` clears subscriptions anyway, but this avoids a leak if the unmount order ever changes.
  manager.doc.on("destroy", manager.destroy);
}

// #100: undo to an empty document → PM normalization restores an empty paragraph → the sync
// plugin writes it back with `ySyncPluginKey` (the origin user edits share) on a later PM
// transaction (`binding.mux` holds it off during undo's own dispatch) → `afterTransactionHandler`
// takes it as a new edit: `clear(false, true)` wipes redoStack, and the normalization lands on
// undoStack (undoing it would normalize again, circular).
//
// Discriminator (all required): origin y-sync$ ∧ a non-empty change ∧ empty deleteSet ∧ result
// exactly the default empty document. Select-all-delete has the same shape but a non-empty deleteSet; typing
// the first character is a pure insert, but the result isn't the empty document. `undo.test.tsx` guards that it isn't too broad.

interface XmlNodeLike {
  nodeName?: string;
  length?: number;
  get?: (index: number) => unknown;
}

/** Duck-typed: `instanceof Y.XmlElement` is always false if pnpm gives two yjs instances. Only XmlElement has `nodeName`. */
function isXmlElement(node: unknown, nodeName: string, expectedLength: number): node is Required<XmlNodeLike> {
  const candidate = node as XmlNodeLike | null;
  return candidate?.nodeName === nodeName && candidate.length === expectedLength && typeof candidate.get === "function";
}

/**
 * nodeName is camelCase (`toString()` prints lowercase). Attrs are unchecked: the id is
 * regenerated on every normalization.
 */
function isDefaultEmptyFragment(fragment: { length: number; get: (index: number) => unknown }): boolean {
  if (fragment.length !== 1) return false;
  const group = fragment.get(0);
  if (!isXmlElement(group, "blockGroup", 1)) return false;
  const container = group.get(0);
  if (!isXmlElement(container, "blockContainer", 1)) return false;
  return isXmlElement(container.get(0), "paragraph", 0);
}

/** Not in `trackedOrigins`, so clearing the residue before redo does not enter history. */
const DENORMALIZE_ORIGIN = "knotebook:undo-denormalize";

/**
 * Wrapped once per manager (arm is called repeatedly). The value invalidates the residue record
 * and is called on every re-arm: a remote update arriving while the manager was unsubscribed
 * (#97) can contaminate the residue node in place, which the identity comparison can't detect.
 * Invalidating degrades to a parallel empty block (fail-safe); not invalidating can delete
 * remote content.
 */
const guardedManagers = new WeakMap<UndoManager, () => void>();

/**
 * Idempotent. Hooks the public `captureTransaction` option (yjs 13.6.32) and wraps `redo`, which
 * must first clear the refused normalization; otherwise the restored content sits next to it as
 * two parallel blockGroups (PM renders only the first, so redo looks like it did nothing).
 *
 * The residue is tracked by record, not by "fragment looks like the default empty document":
 * that structure can be a live baseline (a reopened note once undone to empty, or undo-to-empty
 * then typing then undo) and is then the parent of the redo item; deleting it makes yjs
 * `redoItem` return null (13.6.32 `structs/Item.js`), the redo stack pops with nothing
 * restored, and since the deletion uses an untracked origin even undo can't recover it: data
 * loss. So on a refused capture remember the inserted blockGroup node; any substantive change
 * invalidates it; before redo, clear only if the record still exists and the fragment is
 * exactly that node. A collaborator writing between undo-to-empty and redo: see
 * docs/known-limitations.md.
 */
export function guardEmptyDocNormalization(manager: UndoManager): void {
  const invalidate = guardedManagers.get(manager);
  if (invalidate) {
    invalidate();
    return;
  }
  // Duck-typed like `isXmlElement`.
  const fragment = manager.scope[0] as unknown as { length: number; get: (index: number) => unknown; delete: (index: number, length: number) => void };
  if (typeof fragment?.get !== "function" || typeof fragment.delete !== "function") return;

  let pendingResidue: unknown = null;
  guardedManagers.set(manager, () => { pendingResidue = null; });

  const capture = manager.captureTransaction;
  manager.captureTransaction = (transaction) => {
    // Compare the origin's `key` string: with two y-prosemirror instances a PluginKey identity check fails silently.
    const isSyncWriteback = (transaction.origin as { key?: string } | null)?.key === "y-sync$";
    // Each condition is load-bearing (pinned by tests); don't remove one because it looks inert.
    // The shape condition stops a user "clear note" write-back (the paragraph still has an empty
    // text node then); deleteSet stops synthetic delete-and-rebuild write-backs; origin stops
    // non-sync pure inserts (e.g. a future server seed). `changedParentTypes.size > 0`: yjs fires
    // afterTransaction for no-op transacts too, which would match whenever the fragment has the
    // empty shape and record a live baseline as residue (the data loss above).
    if (
      isSyncWriteback &&
      transaction.changedParentTypes.size > 0 &&
      transaction.deleteSet.clients.size === 0 &&
      isDefaultEmptyFragment(fragment)
    ) {
      pendingResidue = fragment.get(0);
      return false;
    }
    // Any other substantive change (user edit, remote update, undo/redo) may make the residue the
    // parent of a new edit, and clearing it would break the redo chain: invalidate.
    if (pendingResidue !== null && transaction.changedParentTypes.size > 0) {
      pendingResidue = null;
    }
    return capture(transaction);
  };

  const redo = manager.redo.bind(manager);
  manager.redo = () => {
    // The record is the load-bearing gate; the redoStack and identity gates are unreachable on
    // known paths and kept as defense in depth.
    if (pendingResidue !== null && manager.redoStack.length > 0 && fragment.length === 1 && fragment.get(0) === pendingResidue) {
      manager.doc.transact(() => { fragment.delete(0, 1); }, DENORMALIZE_ORIGIN);
    }
    pendingResidue = null;
    return redo();
  };
}

// Arm now and on every mount: under StrictMode the remount's onMount fires while our onMount subscription is torn down
// (the re-run effect's immediate arm catches it); an editable flip doesn't re-run the effect, so only onMount sees it.
export function keepCollabUndoAlive(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
  editor: BlockNoteEditor<any, any, any>,
): () => void {
  const arm = (): void => {
    const manager = collabUndoManager(editor);
    if (manager) {
      armCollabUndoManager(manager);
      guardEmptyDocNormalization(manager);
    }
  };
  arm();
  return editor.onMount(arm);
}

export function useCollabUndoLifeline(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
  editor: BlockNoteEditor<any, any, any>,
): void {
  // Layout effect so re-subscribing lands in the same commit as the ref attach.
  useLayoutEffect(() => keepCollabUndoAlive(editor), [editor]);
}
