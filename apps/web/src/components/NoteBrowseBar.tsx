import { useContext, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { NoteDto } from "@knotebook/shared";
import { useFolders } from "@/api/folders";
import { useGroups } from "@/api/groups";
import { PhoneListFabs } from "@/components/sidebar/PhoneListFabs";
import { indexFolders } from "@/components/sidebar/folder-index";
import { createTargetFor } from "@/lib/note-create-target";
import { PhoneBrowseContext } from "@/lib/phone-list";
import { isKeyboardOpen, useKeyboardInset } from "@/lib/visual-viewport";

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

  const bar = (
    <div data-testid="note-browse-bar" className="contents">
      <PhoneListFabs
        onSearch={() => browse?.openSearch()}
        showNewNote={target !== null}
        onCreateNote={handleCreate}
        newNotePending={pending}
      />
    </div>
  );
  // Mounted in a slot outside the main area: the main area slides when a note opens and the fixed buttons must not move with it.
  const slot = browse?.fabSlot ?? null;
  return slot === null ? bar : createPortal(bar, slot);
}
