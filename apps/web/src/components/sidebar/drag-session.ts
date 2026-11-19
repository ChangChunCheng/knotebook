import { useSyncExternalStore } from "react";
import { DRAG_HOVER_DELAY_MS, dropScopeKey, readDragTarget, type DragOverResult, type DragSource, type DropZone, type HoldAction } from "./drag-zone";

/** One timer (spring and stack-folder never share a row; both use `DRAG_HOVER_DELAY_MS`); leaving the tree is judged by a capture-phase document `dragover` against the container that started the drag. */

export interface StackPreviewState {
  anchorNoteId: string;
  parentFolderId: string | null;
  name: string;
  sourceTitle: string;
}

export interface DragView {
  active: boolean;
  scope: string | null;
  preview: StackPreviewState | null;
  /** Independent state: `endDrag` doesn't clear it. */
  creating: StackPreviewState | null;
}

let view: DragView = { active: false, scope: null, preview: null, creating: null };
let source: DragSource | null = null;
let container: HTMLElement | null = null;
/** Current row for the timer; reset to null when leaving the tree, so coming back to the same row restarts it. */
let currentRow: string | null = null;
let lastZone: DropZone | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): DragView {
  return view;
}

function commit(patch: Partial<DragView>): void {
  const next = { ...view, ...patch };
  if (next.active === view.active && next.scope === view.scope && next.preview === view.preview && next.creating === view.creating) return;
  view = next;
  for (const listener of [...listeners]) listener();
}

function clearTimer(): void {
  if (timer === null) return;
  clearTimeout(timer);
  timer = null;
}

function leaveTree(): void {
  clearTimer();
  currentRow = null;
  lastZone = null;
  commit({ scope: null, preview: null });
}

function onDocumentDragOver(event: DragEvent): void {
  if (container === null || readDragTarget(event.target, container).kind !== "outside") return;
  leaveTree();
}

function teardown(): void {
  document.removeEventListener("dragover", onDocumentDragOver, true);
  clearTimer();
  source = null;
  container = null;
  currentRow = lastZone = null;
  commit({ active: false, scope: null, preview: null });
}

export function useDragView(): DragView {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function getDragSource(): DragSource | null {
  return source;
}

export function beginDrag(next: DragSource, el: HTMLElement): void {
  teardown();
  source = next;
  container = el;
  document.addEventListener("dragover", onDocumentDragOver, true);
  commit({ active: true });
}

/** The timer restarts only when the row changes. The preview collapses when row is not "preview" or "note:<anchor>"; collapsing starts no timer and the result is still applied. */
export function applyDragOver(result: DragOverResult, onHold: (hold: HoldAction) => void): boolean {
  if (source === null) return false;
  lastZone = result.zone;
  let preview = view.preview;
  if (preview !== null && result.row !== "preview" && result.row !== `note:${preview.anchorNoteId}`) preview = null;
  if (result.row !== currentRow) {
    clearTimer();
    currentRow = result.row;
    const hold = result.hold;
    if (hold !== null) {
      timer = setTimeout(() => {
        timer = null;
        onHold(hold);
      }, DRAG_HOVER_DELAY_MS);
    }
  }
  commit({ scope: result.zone === null ? null : dropScopeKey(result.zone.scope), preview });
  return result.zone !== null;
}

export function setPreview(preview: StackPreviewState | null): void {
  commit({ preview });
}

export function takeDropZone(): DropZone | null {
  const zone = lastZone;
  teardown();
  return zone;
}

export function endDrag(): void {
  teardown();
}

export function setCreating(state: StackPreviewState | null): void {
  commit({ creating: state });
}

/** @internal tests only */
export function __resetDragSessionForTests(): void {
  teardown();
  commit({ creating: null });
}
