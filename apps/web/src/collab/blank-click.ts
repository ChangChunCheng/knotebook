/**
 * A press on blank space outside `.bn-editor` only blurs the editor and leaves a NodeSelection frame (image / code / mermaid)
 * in place; clicks there come through here to turn it into a caret.
 */

interface SelectionLike {
  node?: unknown;
  constructor: SelectionClassLike;
}
interface SelectionClassLike {
  findFrom($pos: unknown, dir: number, textOnly?: boolean): unknown;
}
export interface BlankClickView {
  state: {
    doc: { content: { size: number }; resolve(pos: number): unknown };
    selection: SelectionLike;
    tr: { setSelection(selection: unknown): unknown };
  };
  dom: HTMLElement;
  posAtCoords(coords: { left: number; top: number }): { pos: number } | null | undefined;
  dispatch(tr: unknown): void;
  focus(): void;
}

export function clearNodeSelectionAt(view: BlankClickView, point: { x: number; y: number }, focus: boolean): boolean {
  const { selection, doc } = view.state;
  if (selection.node === undefined) return false;
  const SelectionClass = selection.constructor;
  // Text carets only: `Selection.near` / `atEnd` can return another NodeSelection next to atom blocks such as images.
  const textFrom = (pos: number, dir: number) => SelectionClass.findFrom(doc.resolve(pos), dir, true);
  const rect = view.dom.getBoundingClientRect();
  let next: unknown;
  if (point.y > rect.bottom) {
    next = textFrom(doc.content.size, -1);
  } else if (point.y < rect.top) {
    next = textFrom(0, 1);
  } else {
    const left = Math.min(Math.max(point.x, rect.left + 1), rect.right - 1);
    const hit = view.posAtCoords({ left, top: point.y });
    next = hit ? (textFrom(hit.pos, 1) ?? textFrom(hit.pos, -1)) : textFrom(doc.content.size, -1);
  }
  if (!next) return false;
  view.dispatch(view.state.tr.setSelection(next));
  if (focus) view.focus();
  return true;
}
