import { useEffect, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import type { BlockNoteEditor } from "@blocknote/core";
import { COLUMN_LIST_TYPE, COLUMN_TYPE } from "@knotebook/shared";
import { collabUndoManager } from "@/collab/undo";
import { COLUMN_GAP_PX, columnKindOf, columnMinWidth, type PMNodeLike } from "@/collab/columns/layout";
import { STACKED_ATTR } from "@/collab/columns/layout-extension";
import { findNodeById } from "@/collab/columns/position";
import { createWidthPreview, writeColumnWidths, type WidthPreview } from "@/collab/columns/width-preview";
import { changedIndices, dividerResize, ratiosFromPixels } from "@/collab/columns/widths";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple (repo convention)
type AnyEditor = BlockNoteEditor<any, any, any>;

/** Desktop hit area: 8px left of the gutter; the right side belongs to the 16px ⋮⋮ inside the column (`index.css`). */
const FINE_HIT_PX = 8;
const COARSE_HIT_PX = COLUMN_GAP_PX;
const COARSE_QUERY = "(pointer: coarse)";
const KEY_STEP = 0.05;

const ROW_SELECTOR = `[data-node-type="${COLUMN_LIST_TYPE}"]`;

interface DividerPlace {
  key: string;
  rowId: string;
  index: number;
  columnIds: readonly string[];
  top: number;
  left: number;
  width: number;
  height: number;
  now: number;
  min: number;
  max: number;
  touch: boolean;
}

interface RowMeasure {
  rowId: string;
  rowEl: HTMLElement;
  rowRect: DOMRect;
  columnEls: HTMLElement[];
  columnRects: DOMRect[];
  columnIds: string[];
  px: number[];
  mins: number[];
}

interface DragState {
  key: string;
  rowId: string;
  index: number;
  columnIds: readonly string[];
  pointerId: number;
  target: HTMLElement;
  startX: number;
  px: readonly number[];
  mins: readonly number[];
  /** Column widths at pointerdown; columns others changed mid-drag are not overwritten on release (`since` of `writeColumnWidths`). */
  base: readonly number[];
  /** null when neither adjacent column's pixel width changed (no move, or pinned at min width): nothing is written on release. */
  next: number[] | null;
  preview: WidthPreview;
  prevUserSelect: string;
  controller: AbortController;
}

/** Before mount tiptap's view is a proxy; reading `dom` throws. */
function viewDomOf(editor: AnyEditor): HTMLElement | null {
  try {
    return editor.domElement ?? null;
  } catch {
    return null;
  }
}

function columnElsOf(rowEl: Element): HTMLElement[] {
  return Array.from(rowEl.children).filter((el): el is HTMLElement => el.getAttribute("data-node-type") === COLUMN_TYPE);
}

function measureRow(editor: AnyEditor, rowEl: HTMLElement): RowMeasure | null {
  if (rowEl.hasAttribute(STACKED_ATTR)) return null;
  const rowId = rowEl.getAttribute("data-id");
  if (!rowId) return null;
  const columnEls = columnElsOf(rowEl);
  if (columnEls.length < 2) return null;
  const columnIds = columnEls.map((el) => el.getAttribute("data-id") ?? "");
  if (columnIds.some((id) => !id)) return null;
  const hit = findNodeById(editor.prosemirrorState.doc as never, rowId, COLUMN_LIST_TYPE);
  if (!hit || hit.node.childCount !== columnEls.length) return null;
  const mins: number[] = [];
  (hit.node as unknown as PMNodeLike).forEach((col) => mins.push(columnMinWidth(columnKindOf(col))));
  const columnRects = columnEls.map((el) => el.getBoundingClientRect());
  return {
    rowId,
    rowEl,
    rowRect: rowEl.getBoundingClientRect(),
    columnEls,
    columnRects,
    columnIds,
    px: columnRects.map((r) => r.width),
    mins,
  };
}

function rowElById(dom: HTMLElement, rowId: string): HTMLElement | null {
  const css = dom.ownerDocument.defaultView?.CSS ?? CSS;
  return dom.querySelector<HTMLElement>(`${ROW_SELECTOR}[data-id="${css.escape(rowId)}"]`);
}

function isCoarsePointer(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(COARSE_QUERY).matches;
}

function placesOf(row: RowMeasure, box: DOMRect, coarse: boolean): DividerPlace[] {
  const out: DividerPlace[] = [];
  for (let i = 0; i + 1 < row.px.length; i++) {
    const pL = row.px[i]!;
    const pR = row.px[i + 1]!;
    const total = pL + pR;
    const percent = (v: number) => (total > 0 ? Math.round((v / total) * 100) : 50);
    out.push({
      key: `${row.rowId}:${i}`,
      rowId: row.rowId,
      index: i,
      columnIds: row.columnIds,
      top: row.rowRect.top - box.top,
      left: row.columnRects[i]!.right - box.left,
      width: coarse ? COARSE_HIT_PX : FINE_HIT_PX,
      height: row.rowRect.height,
      now: percent(pL),
      min: total > 0 ? percent(row.mins[i]!) : 0,
      max: total > 0 ? percent(total - row.mins[i + 1]!) : 100,
      touch: coarse,
    });
  }
  return out;
}

const sameIds = (a: readonly string[] | null | undefined, b: readonly string[] | null | undefined) =>
  !!a && !!b && a.length === b.length && a.every((id, i) => id === b[i]);

function samePlace(a: DividerPlace, b: DividerPlace): boolean {
  return (
    a.key === b.key &&
    a.top === b.top &&
    a.left === b.left &&
    a.width === b.width &&
    a.height === b.height &&
    a.now === b.now &&
    a.min === b.min &&
    a.max === b.max &&
    a.touch === b.touch &&
    sameIds(a.columnIds, b.columnIds)
  );
}

const samePlaces = (a: readonly DividerPlace[], b: readonly DividerPlace[]) =>
  a.length === b.length && a.every((p, i) => samePlace(p, b[i]!));

function rowInDoc(editor: AnyEditor, rowId: string): { ids: string[]; widths: number[] } | null {
  const row = editor.getBlock(rowId) as { type?: string; children?: { id: string; props?: { width?: number } }[] } | undefined;
  if (!row || row.type !== COLUMN_LIST_TYPE || !row.children) return null;
  return { ids: row.children.map((c) => c.id), widths: row.children.map((c) => c.props?.width ?? 1) };
}

/**
 * Overlay on `container` (the editor column's `relative` wrapper); nothing is put inside ProseMirror's DOM. Mount only when editable. `container` scrolls with the content, so no scroll listener.
 * Re-measured on document changes, window resize, and via ResizeObserver on `container`, `view.dom` (content growing above a row pushes it down without resizing the row or its columns), and each row and its columns; also on pointerenter/pointerdown, to catch layout changes ResizeObserver misses. A pointerdown that finds the position changed only updates it and does not start a drag.
 * Keyboard writes are not their own undo step: one is cut on focus and on blur, rapid presses merge via the UndoManager window.
 */
export function ColumnDividers({ container, editor }: { container: HTMLElement | null; editor: AnyEditor }): JSX.Element | null {
  const { t } = useTranslation();
  const [places, setPlaces] = useState<DividerPlace[]>([]);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const placesRef = useRef<DividerPlace[]>(places);

  /** Columns other than the two beside the divider keep their current widths: pixels measured at pointerdown are stale if someone changed them mid-drag. */
  const stopDrag = (commit: boolean) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    drag.controller.abort();
    if (commit && drag.next && sameIds(rowInDoc(editor, drag.rowId)?.ids, drag.columnIds)) {
      writeColumnWidths(editor, drag.rowId, drag.next, { since: { base: drag.base, own: [drag.index, drag.index + 1] } });
    }
    drag.preview.clear();
    document.body.style.userSelect = drag.prevUserSelect;
    if (drag.target.hasPointerCapture?.(drag.pointerId)) drag.target.releasePointerCapture(drag.pointerId);
    setDraggingKey(null);
  };
  const stopDragRef = useRef(stopDrag);
  stopDragRef.current = stopDrag;

  const measureAll = (): DividerPlace[] => {
    const dom = viewDomOf(editor);
    let next: DividerPlace[] = [];
    if (container && dom && editor.isEditable) {
      const box = container.getBoundingClientRect();
      const coarse = isCoarsePointer();
      dom.querySelectorAll<HTMLElement>(ROW_SELECTOR).forEach((rowEl) => {
        const row = measureRow(editor, rowEl);
        if (row) next = next.concat(placesOf(row, box, coarse));
      });
    }
    const drag = dragRef.current;
    if (drag && !next.some((p) => p.key === drag.key && sameIds(p.columnIds, drag.columnIds))) stopDragRef.current(false);
    if (!samePlaces(placesRef.current, next)) {
      placesRef.current = next;
      setPlaces(next);
    }
    return placesRef.current;
  };
  const measureAllRef = useRef(measureAll);
  measureAllRef.current = measureAll;

  useEffect(() => {
    if (!container) return;
    let frame = 0;
    let disposed = false;
    const observed = new Set<Element>();
    const schedule = () => {
      if (frame || disposed) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!disposed) run();
      });
    };
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    // Observe only new targets / unobserve gone ones: starting over would make RO report every target again, looping forever.
    // Stacked rows are observed too: when one widens enough to unstack, its size change triggers the re-measure.
    const syncObserved = () => {
      if (!observer) return;
      const targets = new Set<Element>([container]);
      const dom = viewDomOf(editor);
      if (dom) {
        targets.add(dom);
        dom.querySelectorAll(ROW_SELECTOR).forEach((rowEl) => {
          targets.add(rowEl);
          for (const col of columnElsOf(rowEl)) targets.add(col);
        });
      }
      for (const el of observed) {
        if (!targets.has(el)) {
          observer.unobserve(el);
          observed.delete(el);
        }
      }
      for (const el of targets) {
        if (!observed.has(el)) {
          observer.observe(el);
          observed.add(el);
        }
      }
    };
    const run = () => {
      syncObserved();
      measureAllRef.current();
    };
    const offChange = editor.onChange(schedule);
    window.addEventListener("resize", schedule);
    run();
    return () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
      offChange?.();
      window.removeEventListener("resize", schedule);
      stopDragRef.current(false);
    };
  }, [container, editor]);

  const remeasureMoved = (place: DividerPlace): boolean => {
    const fresh = measureAllRef.current().find((p) => p.key === place.key);
    return !fresh || fresh.top !== place.top || fresh.left !== place.left || fresh.height !== place.height || fresh.width !== place.width;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>, place: DividerPlace) => {
    if (e.button !== 0 || dragRef.current || !container) return;
    if (remeasureMoved(place)) return;
    const dom = viewDomOf(editor);
    const rowEl = dom && rowElById(dom, place.rowId);
    const row = rowEl && measureRow(editor, rowEl);
    const inDoc = rowInDoc(editor, place.rowId);
    if (!row || !inDoc || !sameIds(row.columnIds, place.columnIds) || !sameIds(inDoc.ids, row.columnIds)) return;
    const target = e.currentTarget;
    target.setPointerCapture?.(e.pointerId);
    const controller = new AbortController();
    const drag: DragState = {
      key: place.key,
      rowId: place.rowId,
      index: place.index,
      columnIds: row.columnIds,
      pointerId: e.pointerId,
      target,
      startX: e.clientX,
      px: row.px,
      mins: row.mins,
      base: inDoc.widths,
      next: null,
      preview: createWidthPreview(document),
      prevUserSelect: document.body.style.userSelect,
      controller,
    };
    dragRef.current = drag;
    document.body.style.userSelect = "none";
    setDraggingKey(place.key);
    const listen = { signal: controller.signal };
    /** The release event is computed too: its position may never have been reported by a pointermove. */
    const apply = (ev: PointerEvent) => {
      const i = drag.index;
      const [left, right] = dividerResize(drag.px[i]!, drag.px[i + 1]!, drag.mins[i]!, drag.mins[i + 1]!, ev.clientX - drag.startX);
      const px = [...drag.px];
      px[i] = left;
      px[i + 1] = right;
      const grows = ratiosFromPixels(px, [i, i + 1]);
      drag.next = left === drag.px[i] ? null : grows;
      drag.preview.set({ columnIds: drag.columnIds, grows });
    };
    window.addEventListener("pointermove", (ev) => ev.pointerId === drag.pointerId && apply(ev), listen);
    window.addEventListener(
      "pointerup",
      (ev) => {
        if (ev.pointerId !== drag.pointerId) return;
        apply(ev);
        stopDragRef.current(true);
      },
      listen,
    );
    window.addEventListener("pointercancel", (ev) => ev.pointerId === drag.pointerId && stopDragRef.current(false), listen);
    window.addEventListener(
      "keydown",
      (ev) => {
        if (ev.key !== "Escape") return;
        ev.preventDefault();
        ev.stopPropagation();
        stopDragRef.current(false);
      },
      { ...listen, capture: true },
    );
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>, place: DividerPlace) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    if (dragRef.current) return;
    // Measure from the screen every keypress: the previous write already changed the widths.
    const dom = viewDomOf(editor);
    const rowEl = dom && rowElById(dom, place.rowId);
    const row = rowEl && measureRow(editor, rowEl);
    const inDoc = rowInDoc(editor, place.rowId);
    if (!row || !inDoc || !sameIds(row.columnIds, place.columnIds) || !sameIds(inDoc.ids, row.columnIds)) return;
    const i = place.index;
    const step = Math.max(0, row.rowRect.width - COLUMN_GAP_PX * (row.px.length - 1)) * KEY_STEP;
    const [left, right] = dividerResize(row.px[i]!, row.px[i + 1]!, row.mins[i]!, row.mins[i + 1]!, e.key === "ArrowLeft" ? -step : step);
    // Already at min width: skip when pixels are unchanged (otherwise a row whose doc widths don't match the screen is rewritten, adding an invisible undo step).
    if (left === row.px[i]) return;
    const px = [...row.px];
    px[i] = left;
    px[i + 1] = right;
    const next = ratiosFromPixels(px, [i, i + 1]);
    if (changedIndices(inDoc.widths, next).length === 0) return;
    // Pixels and doc value are read in the same keypress, so no remote update lands between; same `since` rule as on release.
    writeColumnWidths(editor, place.rowId, next, { undoStep: false, since: { base: inDoc.widths, own: [i, i + 1] } });
  };

  const cutUndoStep = () => collabUndoManager(editor)?.stopCapturing();

  if (!container || places.length === 0) return null;
  return (
    <div className="kb-column-dividers pointer-events-none absolute inset-0 z-[5]">
      {places.map((place) => (
        <div
          key={place.key}
          role="separator"
          aria-orientation="vertical"
          tabIndex={0}
          aria-label={t("note.columns.resize")}
          aria-valuenow={place.now}
          aria-valuemin={place.min}
          aria-valuemax={place.max}
          data-row-id={place.rowId}
          data-index={place.index}
          data-touch={place.touch ? "" : undefined}
          data-dragging={draggingKey === place.key ? "" : undefined}
          className="pointer-events-auto absolute cursor-col-resize touch-none"
          style={{ top: place.top, left: place.left, width: place.width, height: place.height }}
          onPointerEnter={() => void remeasureMoved(place)}
          onPointerDown={(e) => onPointerDown(e, place)}
          // Mouse down must not move focus to the divider: focus stays in the editor so Ctrl+Z right after a drag undoes it, and holding to drag doesn't select text.
          onMouseDown={(e) => e.preventDefault()}
          onKeyDown={(e) => onKeyDown(e, place)}
          onFocus={cutUndoStep}
          onBlur={cutUndoStep}
        />
      ))}
    </div>
  );
}
