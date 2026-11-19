import { COLUMN_LIST_TYPE } from "@knotebook/shared";
import type { BlockNoteEditor } from "@blocknote/core";
import { changedIndices } from "./widths";
import { asUndoStep } from "./undo-step";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote's three generic parameters (repo convention)
type AnyEditor = BlockNoteEditor<any, any, any>;

export interface WidthPreview {
  set(row: { columnIds: readonly string[]; grows: readonly number[] }): void;
  clear(): void;
}

// Only a `<style>` element is edited: changing a column element's style directly makes no transaction, and PM later redraws it back to the document's value.
export function createWidthPreview(doc: Document): WidthPreview {
  let style: HTMLStyleElement | null = null;
  const css = doc.defaultView?.CSS ?? CSS;
  const esc = (id: string) => css.escape(id);
  return {
    set({ columnIds, grows }) {
      if (grows.length !== columnIds.length) return;
      if (!style) {
        style = doc.createElement("style");
        style.setAttribute("data-kb-col-preview", "");
        doc.head.appendChild(style);
      }
      style.textContent = columnIds
        .map(
          (id, i) =>
            `.bn-editor [data-node-type="column"][data-id="${esc(id)}"] { flex-grow: ${grows[i]} !important; }`,
        )
        .join("\n");
    },
    clear() {
      style?.remove();
      style = null;
    },
  };
}

interface ColumnLike {
  id: string;
  props?: { width?: number };
}

export interface WidthsSince {
  base: readonly number[];
  own: readonly number[];
}

/**
 * Returns false and writes nothing when the row is gone, the column count differs, or nothing changed (callers rely on this).
 * Keyboard repeats pass `undoStep: false` so repeated presses merge inside the UndoManager's merge window.
 * `since`: a peer may edit the row during the operation. For columns outside `own`, a current value that no longer equals `base` is kept (not written); one that still equals `base`
 * is written as in `next` (rows whose widths don't sum to the column count are normalised as a whole this way, matching the preview).
 */
export function writeColumnWidths(
  editor: AnyEditor,
  rowId: string,
  next: readonly number[],
  opts: { previewWidth?: { blockId: string; value: number }; undoStep?: boolean; since?: WidthsSince } = {},
): boolean {
  const row = editor.getBlock(rowId) as { type?: string; children?: ColumnLike[] } | undefined;
  const columns = row?.children;
  if (!row || row.type !== COLUMN_LIST_TYPE || !columns || columns.length !== next.length) return false;
  const current = columns.map((c) => c.props?.width ?? 1);
  const since = opts.since;
  const changed = changedIndices(current, next).filter(
    (i) => !since || since.own.includes(i) || since.base[i] === current[i],
  );
  if (changed.length === 0) return false;
  const write = () =>
    editor.transact(() => {
      for (const i of changed) editor.updateBlock(columns[i]!.id, { props: { width: next[i]! } });
      if (opts.previewWidth) editor.updateBlock(opts.previewWidth.blockId, { props: { previewWidth: opts.previewWidth.value } });
    });
  if (opts.undoStep === false) write();
  else asUndoStep(editor, write);
  return true;
}
