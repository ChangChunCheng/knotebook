import { useContext, useMemo, useState } from "react";
import type { NoteDto } from "@knotebook/shared";
import { useFolders } from "@/api/folders";
import { useGroups } from "@/api/groups";
import { PhoneListFabs } from "@/components/sidebar/PhoneListFabs";
import { indexFolders } from "@/components/sidebar/folder-index";
import { createTargetFor } from "@/lib/note-create-target";
import { PhoneBrowseContext } from "@/lib/phone-list";
import { isKeyboardOpen, useKeyboardInset } from "@/lib/visual-viewport";

/**
 * 手機筆記頁底部的兩顆毛玻璃浮動鈕（與清單畫面同一組 `PhoneListFabs`）：左下「Search」（開全螢幕搜尋層）、
 * 右下「New note」（建在這篇所在的空間與資料夾；這篇不能在那裡建就不顯示）。
 * 螢幕鍵盤開著（例如正在改標題）或搜尋層開著時整組不渲染；編輯中由 `NotePage` 不掛。內容的底部空白由 `NoteEditor` 的 `fabClearance` 給。
 */
export function NoteBrowseBar({ note }: { note: NoteDto }) {
  const browse = useContext(PhoneBrowseContext);
  const foldersQuery = useFolders();
  const groupsQuery = useGroups();
  const keyboardOpen = isKeyboardOpen(useKeyboardInset());
  const searchOpen = browse?.searchOpen === true;
  const [pending, setPending] = useState(false);
  const folderIndex = useMemo(() => indexFolders(foldersQuery.data ?? []), [foldersQuery.data]);
  const target = createTargetFor(note, { groups: groupsQuery.data ?? [], folders: folderIndex });
  if (keyboardOpen || searchOpen) return null;

  function handleCreate(): void {
    if (target === null || pending) return;
    setPending(true);
    void (browse?.createNote(target.groupId, target.folderId) ?? Promise.resolve()).finally(() => setPending(false));
  }

  return (
    <div data-testid="note-browse-bar" className="contents">
      <PhoneListFabs
        onSearch={() => browse?.openSearch()}
        showNewNote={target !== null}
        onCreateNote={handleCreate}
        newNotePending={pending}
      />
    </div>
  );
}
