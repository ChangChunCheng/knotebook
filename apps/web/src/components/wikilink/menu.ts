import { trackPosition, type BlockNoteEditor } from "@blocknote/core";
import type { DefaultReactSuggestionItem } from "@blocknote/react";
import type { NoteDto } from "@knotebook/shared";
import { insertWikilink } from "./spec.js";

/**
 * Late-bound: `buildNoteEditorOptions` in `NoteEditor.tsx` is pure and runs before `useCreateBlockNote` creates the
 * editor; the `[[` input handler and these item handlers run only on user interaction, so they read it from this ref
 * at event time instead of closing over it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- concrete types need `noteSchema`, but wikilink/* can't import `@/collab/schema` back (see spec.tsx); repo convention is any
export type EditorRef = { current: BlockNoteEditor<any, any, any> | null };

export type ToastFn = (item: { title: string }) => void;

export interface BuildWikilinkMenuItemsDeps {
  /** The SuggestionMenu query, without the `[[`. */
  query: string;
  /** The existing `GET /api/notes` query cache (the sidebar's), so no extra API call. */
  notes: NoteDto[];
  /** The caller's `mutateAsync` already invalidates `["notes"]` in `onSuccess`; don't invalidate again here. */
  createNote: (title: string) => Promise<NoteDto>;
  editorRef: EditorRef;
  /** The caller interpolates `query` itself: `(key) => t(key, { query })`. */
  translate: (key: string) => string;
  toast: ToastFn;
}

/**
 * `@blocknote/react`'s `onItemClickCloseMenu` calls `closeMenu()`, then `clearQuery()`, then the item's `onItemClick`,
 * so by then `[[`+query is already deleted with the caret at that spot, and existing-note items insert at the current
 * selection. "Create and link" awaits `createNote` while the user may keep typing, so the insert
 * point is pinned with `trackPosition` first and mapped afterwards; on failure the plain `[[query]]` text is
 * restored plus a toast so the typed query isn't lost.
 */
export function buildWikilinkMenuItems(deps: BuildWikilinkMenuItemsDeps): DefaultReactSuggestionItem[] {
  const { query, notes, createNote, editorRef, translate, toast } = deps;
  const lowerQuery = query.toLowerCase();

  const items: DefaultReactSuggestionItem[] = notes
    .filter((note) => note.title.toLowerCase().includes(lowerQuery))
    .map((note) => ({
      title: note.title,
      onItemClick: () => {
        const editor = editorRef.current;
        if (!editor) {
          return;
        }
        insertWikilink(editor, { targetNoteId: note.id, snapshotTitle: note.title });
      },
    }));

  if (query.length > 0) {
    items.push({
      title: translate("note.wikilink.createAndLink"),
      onItemClick: () => {
        const editor = editorRef.current;
        if (!editor) {
          return;
        }

        const insertionPos = editor.transact((tr) => tr.selection.from);
        const getInsertionPos = trackPosition(editor, insertionPos);

        void createNote(query).then(
          (note) => {
            const current = editorRef.current;
            if (!current) {
              return;
            }
            current._tiptapEditor.chain().focus().setTextSelection(getInsertionPos()).run();
            insertWikilink(current, { targetNoteId: note.id, snapshotTitle: note.title });
          },
          () => {
            const current = editorRef.current;
            if (!current) {
              return;
            }
            current._tiptapEditor.chain().focus().setTextSelection(getInsertionPos()).run();
            current.insertInlineContent([`[[${query}]]`]);
            toast({ title: translate("note.wikilink.createFailed") });
          },
        );
      },
    });
  }

  return items;
}
