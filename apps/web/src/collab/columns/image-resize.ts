/**
 * Replaces the native resize handle (core ignores columns: its limit is the editor width) for images in columns, by capturing `mousedown` / `touchstart` on the editor DOM and stopping propagation.
 * - Up to `Ck` (content box of the block holding the image) only the image changes; beyond it the other columns yield in proportion to their spare room above their minimum width, and the handle stops when it's used up.
 *   Column widths change only in the preview stylesheet until release.
 * - Not in a column or read-only: not intercepted, native handle as usual. Shrinking the image never shrinks columns.
 * - Stacked row: a column's width is the row's width, so the limit is the row width and columns don't move.
 * - Release: no movement → no write; otherwise `previewWidth` and the changed widths in one transaction, as their own undo step.
 * - Esc, `touchcancel`, unmount, the row's column ids changing mid-drag, or the image disappearing cancel without writing and restore
 *   the pre-press image width. Read-only at release writes nothing.
 */
import { COLUMN_LIST_TYPE, COLUMN_TYPE } from "@knotebook/shared";
import type { BlockNoteEditor } from "@blocknote/core";
import { columnKindOf, columnMinWidth, type PMNodeLike } from "./layout";
import { findNodeById } from "./position";
import { asUndoStep } from "./undo-step";
import { createWidthPreview, writeColumnWidths } from "./width-preview";
import { expandColumnPixels, ratiosFromPixels } from "./widths";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote's three generic parameters (repo convention)
type AnyEditor = BlockNoteEditor<any, any, any>;

// Same lower bound as the native handle.
const MIN_WIDTH_PX = 64;
// Largest `previewWidth` that can be written to the document and back through markdown without being rejected.
const MAX_WIDTH_PX = 4000;
// Not imported from `layout-extension.ts` because that file imports this one (a cycle).
const STACKED_SELECTOR = "[data-stacked]";

const clientXOf = (event: MouseEvent | TouchEvent): number =>
  "touches" in event ? (event.touches[0] ?? event.changedTouches[0])?.clientX ?? 0 : event.clientX;

interface RowAtStart {
  rowId: string;
  columnIds: string[];
  px: number[];
  mins: number[];
  k: number;
}

function measureRow(editor: AnyEditor, rowEl: HTMLElement, column: HTMLElement): RowAtStart | null {
  const rowId = rowEl.getAttribute("data-id");
  if (!rowId) return null;
  const columnEls = Array.from(rowEl.children).filter((el): el is HTMLElement => el.getAttribute("data-node-type") === COLUMN_TYPE);
  const columnIds = columnEls.map((el) => el.getAttribute("data-id") ?? "");
  const k = columnEls.indexOf(column);
  if (k < 0 || columnIds.some((id) => !id)) return null;
  const hit = findNodeById(editor.prosemirrorState.doc as never, rowId, COLUMN_LIST_TYPE);
  if (!hit || hit.node.childCount !== columnEls.length) return null;
  const mins: number[] = [];
  (hit.node as unknown as PMNodeLike).forEach((col) => mins.push(columnMinWidth(columnKindOf(col))));
  return { rowId, columnIds, px: columnEls.map((el) => el.getBoundingClientRect().width), mins, k };
}

function columnIdsInDoc(editor: AnyEditor, rowId: string): string[] | null {
  const row = editor.getBlock(rowId) as { type?: string; children?: { id: string }[] } | undefined;
  if (!row || row.type !== COLUMN_LIST_TYPE || !row.children) return null;
  return row.children.map((c) => c.id);
}

const sameIds = (a: readonly string[] | null, b: readonly string[]) => !!a && a.length === b.length && a.every((id, i) => id === b[i]);

export function attachColumnImageResize(editor: AnyEditor, dom: HTMLElement, signal: AbortSignal): void {
  const onDown = (event: MouseEvent | TouchEvent) => {
    const handle = event.target instanceof Element ? event.target.closest<HTMLElement>(".bn-resize-handle") : null;
    if (!handle || !editor.isEditable) return;
    const column = handle.closest<HTMLElement>(`[data-node-type="${COLUMN_TYPE}"]`);
    const wrapper = handle.closest<HTMLElement>(".bn-file-block-content-wrapper");
    const content = wrapper?.closest<HTMLElement>(".bn-block-content");
    const id = wrapper?.closest(".bn-block-outer")?.getAttribute("data-id");
    const rowEl = column?.parentElement?.closest<HTMLElement>(`[data-node-type="${COLUMN_LIST_TYPE}"]`);
    const row = column && rowEl ? measureRow(editor, rowEl, column) : null;
    if (!column || !wrapper || !content || !id || !rowEl || !row) return;
    event.stopPropagation();
    event.preventDefault();

    const block = editor.getBlock(id) as { props?: { textAlignment?: string } } | undefined;
    // ×2 when centred and reversed for the left handle, as in the native handle.
    const factor = block?.props?.textAlignment === "center" ? 2 : 1;
    const fromLeft = handle.style.left !== "";
    const startX = clientXOf(event);
    const initial = wrapper.getBoundingClientRect().width;
    const styleWidthBefore = wrapper.style.width;
    const stacked = rowEl.closest(STACKED_SELECTOR) !== null;
    // Stacked: a column's width is the row's width; 0 = not laid out yet: no limit, same as native.
    const stackedMax = rowEl.clientWidth || Number.MAX_VALUE;
    const ck = content.clientWidth;
    const preview = createWidthPreview(dom.ownerDocument);
    let width = initial;
    let next: number[] | null = null;
    let moved = false;

    const apply = (clientX: number) => {
      const delta = clientX - startX;
      if (delta !== 0) moved = true;
      let w = Math.min(Math.max(initial + (fromLeft ? -delta : delta) * factor, MIN_WIDTH_PX), MAX_WIDTH_PX);
      next = null;
      if (stacked) w = Math.min(w, stackedMax);
      else if (w > ck) {
        const need = w - ck;
        const grown = expandColumnPixels(row.px, row.mins, row.k, need);
        if (grown.granted < need) w = ck + grown.granted;
        if (grown.granted > 0) next = ratiosFromPixels(grown.px);
      }
      width = w;
      wrapper.style.width = `${w}px`;
      if (next) preview.set({ columnIds: row.columnIds, grows: next });
      else preview.clear();
    };

    const drag = new AbortController();
    const finish = (commit: boolean) => {
      if (drag.signal.aborted) return;
      drag.abort();
      offChange?.();
      if (commit && moved && editor.isEditable) {
        const value = Math.round(width);
        // No widened column, or ratios equal to the document's: `writeColumnWidths` writes nothing, so write only `previewWidth` (still its own undo step).
        if (!(next && writeColumnWidths(editor, row.rowId, next, { previewWidth: { blockId: id, value } }))) {
          asUndoStep(editor, () => editor.updateBlock(id, { props: { previewWidth: value } }));
        }
      } else {
        // Nothing written: `apply` already set the inline width to the measured display width; restore it, otherwise the image stays squeezed.
        wrapper.style.width = styleWidthBefore;
      }
      preview.clear();
    };

    // The document changed mid-drag (e.g. a column deleted remotely): the measured column widths are stale.
    const offChange = editor.onChange(() => {
      if (!sameIds(columnIdsInDoc(editor, row.rowId), row.columnIds) || !editor.getBlock(id)) finish(false);
    }) as (() => void) | undefined;
    signal.addEventListener("abort", () => finish(false), { once: true, signal: drag.signal });
    const listen = { signal: drag.signal };
    const onMove = (e: MouseEvent | TouchEvent) => apply(clientXOf(e));
    // A move event hasn't necessarily reported the release position, so recompute from it first.
    const onUp = (e: MouseEvent | TouchEvent) => {
      apply(clientXOf(e));
      finish(true);
    };
    window.addEventListener("mousemove", onMove, listen);
    window.addEventListener("touchmove", onMove, listen);
    window.addEventListener("mouseup", onUp, listen);
    window.addEventListener("touchend", onUp, listen);
    window.addEventListener("touchcancel", () => finish(false), listen);
    window.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      },
      { ...listen, capture: true },
    );
  };
  dom.addEventListener("mousedown", onDown, { capture: true, signal });
  dom.addEventListener("touchstart", onDown, { capture: true, signal });
}
