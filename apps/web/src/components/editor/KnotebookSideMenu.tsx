import { createContext, useContext, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { SideMenuExtension } from "@blocknote/core/extensions";
import {
  BlockColorsItem,
  DragHandleMenu,
  SideMenu,
  TableColumnHeaderItem,
  TableRowHeaderItem,
  useBlockNoteEditor,
  useComponentsContext,
  useDictionary,
  useExtensionState,
  type SideMenuProps,
} from "@blocknote/react";
import { removeBlocksKeepColumns } from "@/collab/columns/keep-columns";
import { blockIdsForMenuDelete } from "@/collab/columns/selection-delete";
import { absoluteUrl, blockLinkUrl, copyBlockLink } from "@/lib/copy-block-link";

/** #269 §10.3(a)：這篇筆記的 canonical 路徑（`canonicalNotePath(note)`）——NoteEditorView 提供；沒有（null）就不顯示複製項。 */
export const NotePathContext = createContext<string | null>(null);

function CopyBlockLinkItem() {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor();
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });
  const notePath = useContext(NotePathContext);
  const { t } = useTranslation();
  if (!block || notePath === null) return null;
  return (
    <Components.Generic.Menu.Item className="bn-menu-item" onClick={() => void copyBlockLink(blockLinkUrl(absoluteUrl(notePath), block.id), t)}>
      {t("note.blockLink.copy")}
    </Components.Generic.Menu.Item>
  );
}

/** 「刪除」項：刪哪些 block 見 `collab/columns/selection-delete.ts`，刪除走 D25 helper（不收欄）。 */
function KeepColumnsDeleteItem({ children }: { children: ReactNode }) {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor();
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });
  if (block === undefined) return null;
  return (
    <Components.Generic.Menu.Item
      className="bn-menu-item"
      onClick={() => removeBlocksKeepColumns(editor, blockIdsForMenuDelete(editor, block.id))}
    >
      {children}
    </Components.Generic.Menu.Item>
  );
}

/** 預設的四項（@blocknote/react 的 DragHandleMenu 預設 children，逐項照列；刪除項換成不收欄的版本）＋複製段落連結。 */
export function KnotebookDragHandleMenu() {
  const dict = useDictionary();
  return (
    <DragHandleMenu>
      <KeepColumnsDeleteItem>{dict.drag_handle.delete_menuitem}</KeepColumnsDeleteItem>
      <BlockColorsItem>{dict.drag_handle.colors_menuitem}</BlockColorsItem>
      <TableRowHeaderItem>{dict.drag_handle.header_row_menuitem}</TableRowHeaderItem>
      <TableColumnHeaderItem>{dict.drag_handle.header_column_menuitem}</TableColumnHeaderItem>
      <CopyBlockLinkItem />
    </DragHandleMenu>
  );
}

/** 模組層常數元件（身分穩定）：SideMenuController 以元件身分決定要不要重掛。 */
export function KnotebookSideMenu(props: SideMenuProps) {
  return <SideMenu {...props} dragHandleMenu={KnotebookDragHandleMenu} />;
}
