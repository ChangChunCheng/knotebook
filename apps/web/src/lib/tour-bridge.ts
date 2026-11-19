import type { BlockNoteEditor } from "@blocknote/core";
import type { SidebarTab } from "@/lib/sidebar-tab";
// Import only the flag module: the plugin itself (`collab/tour-transaction-filter.ts`) would pull tiptap and ProseMirror into the main bundle.
import { setEditorTransactionFilterFlag } from "@/collab/tour-filter-flag";

/**
 * The tour overlay lives at App level, but `AppShell` is swapped on navigation, so the sidebar controls and the editor
 * register here on mount. Last registered wins; unregistering removes only your own entry (compared by object), so a
 * late-unmounting old shell does not clear the new one's registration. Main bundle: keep it to registration state.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote editor generic triple; repo convention (same as EditorRef in components/wikilink/menu.ts)
export type TourEditor = BlockNoteEditor<any, any, any>;

export interface ShellControls {
  /** On a narrow window this also opens the drawer by default (phones: back to the list); `reveal: false` only switches the tab. */
  showTab: (tab: SidebarTab, options?: { reveal?: boolean }) => void;
  endSelectionIfActive: () => boolean;
  closeDrawer: () => void;
  getTab: () => SidebarTab;
}

let shellControls: ShellControls | null = null;

export function registerShellControls(controls: ShellControls): () => void {
  shellControls = controls;
  return () => {
    if (shellControls === controls) shellControls = null;
  };
}

export function getShellControls(): ShellControls | null {
  return shellControls;
}

export type EditorListener = (noteId: string, editor: TourEditor) => void;

interface EditorEntry {
  noteId: string;
  editor: TourEditor;
}

let editorEntry: EditorEntry | null = null;
const editableListeners = new Set<EditorListener>();
const notifiedEditable = new WeakSet<TourEditor>();

/**
 * Unregistering always switches this editor's transaction filter off, even if the registry changed hands: afterwards the
 * tour can no longer reach it. Sets the flag directly without dispatching, since the editor may already be unmounted.
 */
export function registerEditor(noteId: string, editor: TourEditor): () => void {
  const entry: EditorEntry = { noteId, editor };
  editorEntry = entry;
  return () => {
    setEditorTransactionFilterFlag(editor._tiptapEditor, false);
    if (editorEntry === entry) editorEntry = null;
  };
}

/** Matched by noteId: the tour may only touch the note it created. */
export function getTourNoteEditor(noteId: string): TourEditor | null {
  return editorEntry !== null && editorEntry.noteId === noteId ? editorEntry.editor : null;
}

export function setTourTransactionFilter(noteId: string, on: boolean): boolean {
  const editor = getTourNoteEditor(noteId);
  if (editor === null) return false;
  setEditorTransactionFilterFlag(editor._tiptapEditor, on);
  return true;
}

/**
 * At registration the document is usually not synced, so real content is visible only once editable. Not retroactive:
 * callers check `editor.isEditable` first.
 */
export function onEditorEditable(fn: EditorListener): () => void {
  editableListeners.add(fn);
  return () => {
    editableListeners.delete(fn);
  };
}

/** Subscribers are caught individually: this runs in a NoteEditor effect, and a throw would replace the page with the error card. */
export function notifyEditorEditable(noteId: string, editor: TourEditor): void {
  if (notifiedEditable.has(editor)) return;
  notifiedEditable.add(editor);
  for (const fn of [...editableListeners]) {
    try {
      fn(noteId, editor);
    } catch (err) {
      console.error(err);
    }
  }
}
