import type { BlockNoteEditor } from "@blocknote/core";

/**
 * 選取（或游標）整個落在一條既有連結裡時，回傳那條連結（範圍、文字、網址）；否則 undefined。
 * link mark 的 `inclusive` 是 false，從選取起點本身查會拿到前一個節點的 mark（剛好選整條連結、或連結在段首時查不到），
 * 所以選取沒收合時從起點後一格查（BlockNote 的 `editLink` 也是這樣）；收合的游標查它自己所在位置，
 * 連結前後的游標才不會被誤判成在連結裡。選取超出連結尾端不算。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，走 repo 慣例用 any
export function linkAtSelection(editor: BlockNoteEditor<any, any, any> | null | undefined) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 取 PM 選取
  const sel = (editor as any)?._tiptapEditor?.state?.selection as { from: number; to: number; empty: boolean } | undefined;
  if (!editor || !sel) return undefined;
  const link = editor.getLinkMarkAtPos(sel.empty ? sel.from : sel.from + 1);
  return link && sel.from >= link.from && sel.to <= link.to ? link : undefined;
}
