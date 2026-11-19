import "@/i18n/folder-strings";
import type { RefObject } from "react";
import type { FolderDialogRequest } from "@/components/NoteList";
import { FolderDeleteDialog } from "./FolderDeleteDialog";
import { FolderNameDialog } from "./FolderNameDialog";

/** Reference only via `FolderLazy`. */
export function FolderDialogs({
  request,
  returnFocusRef,
  onClose,
}: {
  request: FolderDialogRequest;
  returnFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const onOpenChange = (open: boolean) => {
    if (!open) onClose();
  };
  if (request.kind === "create") {
    return <FolderNameDialog mode="create" parent={request.parent} open onOpenChange={onOpenChange} returnFocusRef={returnFocusRef} />;
  }
  if (request.kind === "rename") {
    return (
      <FolderNameDialog mode="rename" folder={request.folder} stack={request.stack} open onOpenChange={onOpenChange} returnFocusRef={returnFocusRef} />
    );
  }
  return <FolderDeleteDialog folder={request.folder} open onOpenChange={onOpenChange} returnFocusRef={returnFocusRef} />;
}
