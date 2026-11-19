/**
 * - PM also calls `transformPasted` for in-site drags (`view.dragging.slice`), so "a dropped row at a non-top-level point → flatten" lives here; `handleDOMEvents.drop` only records the drop point. External drag-ins use the drop point too.
 * - Core's `transformPasted` runs before plugins: in a table cell blocks are already inline content plus line breaks, so rows aren't visible here.
 * - The slice is closed at top level because PM's `Slice.maxOpen` would split the row (first column merged into the caret paragraph, plus an extra empty column);
 *   cost: pasting at the start of a non-empty paragraph adds an empty paragraph.
 * - Single-column rows here come from copying inside a column (external single-column HTML is rejected by shared `columns.ts`), rebuilt by PM from `data-pm-slice`'s open context.
 * `Slice` / `Fragment` aren't available at value level in apps/web, so the constructor is taken from the slice passed in.
 */
import { Extension } from "@tiptap/core";
import { COLUMN_LIST_TYPE, COLUMN_TYPE, COLUMNS_MIN } from "@knotebook/shared";
import { createPmPlugin } from "../pm-plugin";
import { isTopLevelPosition, type ResolvedPosLike } from "./position";

interface NodeLike {
  type: { name: string };
  childCount: number;
  isLeaf: boolean;
  isText: boolean;
  content: FragmentLike;
  firstChild: NodeLike | null;
  lastChild: NodeLike | null;
  forEach(f: (node: NodeLike) => void): void;
  copy(content: FragmentLike): NodeLike;
}

interface FragmentLike {
  childCount: number;
  firstChild: NodeLike | null;
  lastChild: NodeLike | null;
  forEach(f: (node: NodeLike) => void): void;
  descendants(f: (node: NodeLike, pos: number, parent: NodeLike | null) => boolean | void): void;
}

export interface SliceLike {
  content: FragmentLike;
  openStart: number;
  openEnd: number;
}

export interface ViewLike {
  state: { doc: { resolve(pos: number): ResolvedPosLike }; selection: { from: number } };
  dragging: unknown;
  posAtCoords(coords: { left: number; top: number }): { pos: number; inside: number } | null;
}

type SliceCtor = new (content: FragmentLike, openStart: number, openEnd: number) => SliceLike;
const newSlice = (like: SliceLike, content: FragmentLike, openStart = 0, openEnd = 0) =>
  new (like.constructor as SliceCtor)(content, openStart, openEnd);
const fragmentFrom = (like: SliceLike, nodes: NodeLike[]) =>
  (like.content.constructor as unknown as { from(nodes: NodeLike[]): FragmentLike }).from(nodes);

let dropPoint: number | null = null;

// If `posAtCoords` throws, null is recorded: the exception must not escape and skip the media blocking after it.
export function recordDropPoint(view: ViewLike | null, event: Pick<DragEvent, "clientX" | "clientY">): void {
  if (!view) return;
  try {
    dropPoint = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? null;
  } catch {
    dropPoint = null;
  }
  queueMicrotask(() => {
    dropPoint = null;
  });
}

export function takeDropPoint(): number | null {
  const pos = dropPoint;
  dropPoint = null;
  return pos;
}

const isSingle = (node: NodeLike) => node.type.name === COLUMN_LIST_TYPE && node.childCount < COLUMNS_MIN;
// A lone column (Ctrl+click copy of a column, open is 0): PM would wrap it in a row padded with an empty column and paste it as a child of a paragraph (a nested row).
const isLoneColumn = (node: NodeLike, parent: NodeLike | null) => node.type.name === COLUMN_TYPE && parent?.type.name !== COLUMN_LIST_TYPE;

function unwrapFragment(like: SliceLike, fragment: FragmentLike, parent: NodeLike | null): FragmentLike {
  const out: NodeLike[] = [];
  fragment.forEach((node) => {
    if (isSingle(node)) node.forEach((col) => unwrapFragment(like, col.content, col).forEach((b) => out.push(b)));
    else if (isLoneColumn(node, parent)) unwrapFragment(like, node.content, node).forEach((b) => out.push(b));
    else out.push(node.isLeaf || node.isText ? node : node.copy(unwrapFragment(like, node.content, node)));
  });
  return fragmentFrom(like, out);
}

function adjustOpen(fragment: FragmentLike, open: number, first: boolean): number {
  let node = first ? fragment.firstChild : fragment.lastChild;
  let removed = 0;
  for (let d = 0; d < open && node; d++) {
    if (isSingle(node) && d + 1 < open) removed += 2;
    node = first ? node.firstChild : node.lastChild;
  }
  return open - removed;
}

export function unwrapSingleColumnLists(slice: SliceLike): SliceLike {
  let has = false;
  slice.content.descendants((node, _pos, parent) => {
    if (isSingle(node) || isLoneColumn(node, parent)) has = true;
  });
  if (!has) return slice;
  return newSlice(
    slice,
    unwrapFragment(slice, slice.content, null),
    adjustOpen(slice.content, slice.openStart, true),
    adjustOpen(slice.content, slice.openEnd, false),
  );
}

export function sliceHasRow(slice: SliceLike): boolean {
  let has = false;
  slice.content.descendants((node) => {
    if (node.type.name === COLUMN_LIST_TYPE && node.childCount >= COLUMNS_MIN) has = true;
  });
  return has;
}

export function closeTopLevel(slice: SliceLike): SliceLike {
  let fragment = slice.content;
  if (fragment.childCount === 1 && fragment.firstChild!.type.name === "blockGroup") fragment = fragment.firstChild!.content;
  return newSlice(slice, fragment);
}

function flatten(fragment: FragmentLike, out: NodeLike[]): NodeLike[] {
  fragment.forEach((node) => {
    if (node.type.name === COLUMN_LIST_TYPE) node.forEach((col) => col.forEach((b) => out.push(b)));
    else if (node.type.name === "blockGroup") flatten(node.content, out);
    else out.push(node);
  });
  return out;
}

export function flattenRows(slice: SliceLike): SliceLike {
  return newSlice(slice, fragmentFrom(slice, flatten(slice.content, [])));
}

export function columnsTransformPasted(slice: SliceLike, view: ViewLike): SliceLike {
  slice = unwrapSingleColumnLists(slice);
  if (!sliceHasRow(slice)) return slice;
  const drop = takeDropPoint();
  const { doc } = view.state;
  if (view.dragging) {
    return drop !== null && !isTopLevelPosition(doc.resolve(drop)) ? flattenRows(slice) : slice;
  }
  return isTopLevelPosition(doc.resolve(drop ?? view.state.selection.from)) ? closeTopLevel(slice) : flattenRows(slice);
}

export function createColumnsPasteExtension(): Extension {
  return Extension.create({
    name: "knotebookColumnsPaste",
    addProseMirrorPlugins() {
      return [createPmPlugin({ props: { transformPasted: columnsTransformPasted } }) as never];
    },
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- handlers type `view` differently (`unknown` / EditorView); this only passes it through
export function withColumnsDropPoint<T extends { drop: (view: any, e: DragEvent) => boolean }>(events: T): T {
  return {
    ...events,
    drop: (view: ViewLike | null, event: DragEvent) => {
      recordDropPoint(view, event);
      return events.drop(view, event);
    },
  };
}
