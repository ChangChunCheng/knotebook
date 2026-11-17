/**
 * 點筆記區的空白處時，把「整個 block 被選取」（NodeSelection，圖片／程式碼／mermaid 外面那圈框）改成游標。
 *
 * 為什麼需要：文章欄的內距與欄外的空地都在編輯器（`.bn-editor`）之外。在那裡按下去，瀏覽器只是讓編輯器失焦，
 * ProseMirror 的 selection 原封不動，所以 NodeSelection 與它的外框一直留著，只有點進別的文字才會換掉。
 * 編輯器根節點與它的容器上的空白（最後一個 block 之下、撐滿欄高的那一段）同樣經這裡：那裡的點擊也不會換掉 NodeSelection。
 *
 * 只處理 NodeSelection：文字游標與文字選取維持原樣。落點：
 *   - 點在編輯器範圍內的位置 → 點擊位置之後最近的文字位置（之後沒有就往前找）；
 *   - 在編輯器下緣之下 → 最後一個可放游標的位置；在上緣之上 → 第一個。
 */

/** 只取用得到的欄位——PM 的 EditorState／Selection 型別在 apps/web 值層級拿不到（見 `pm-plugin.ts`）。 */
interface SelectionLike {
  node?: unknown;
  constructor: SelectionClassLike;
}
interface SelectionClassLike {
  /** `textOnly` 為 true 時只回文字游標（不會退回 NodeSelection）；找不到回 null。 */
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

/**
 * 目前是 NodeSelection 就換成游標並回傳 true；其餘不動、回傳 false。
 * `focus` 為 true 時順手讓編輯器取得焦點（可編輯的筆記）；唯讀的筆記只換 selection、不取焦點。
 */
export function clearNodeSelectionAt(view: BlankClickView, point: { x: number; y: number }, focus: boolean): boolean {
  const { selection, doc } = view.state;
  if (selection.node === undefined) return false;
  const SelectionClass = selection.constructor;
  // 一律只找文字游標：`Selection.near`／`atEnd` 碰到圖片這類 atom 區塊會再給一個 NodeSelection，外框就消不掉。
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
