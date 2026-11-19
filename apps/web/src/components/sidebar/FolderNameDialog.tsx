import "@/i18n/folder-strings";
import { useCallback, useRef, useState, type FormEvent, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { FOLDER_NAME_MAX, type FolderDto, type FolderSpaceDto } from "@knotebook/shared";
import { FOLDERS_QUERY_KEY, folderErrorMessage, useCreateFolder, useRenameFolder } from "@/api/folders";
import type { StackRenameHooks } from "@/components/NoteList";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { setCollapsed } from "./collapse";
import { expandFolderChain, indexFolders } from "./folder-index";

/** Same set as `CONTROL_CHAR_RE` in `apps/server/src/folders/names.ts`. Matched by code point (a regex with control characters trips `no-control-regex`); lone surrogates and NFC are checked by the server. */
function hasControlChar(value: string): boolean {
  for (const ch of value) {
    const c = ch.codePointAt(0) ?? 0;
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) {
      return true;
    }
  }
  return false;
}

export type FolderCreateParent = { folderId: string } | { space: FolderSpaceDto };

type FolderNameDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Focus target on close (a controlled Dialog has no trigger, so Radix won't restore it); if unmounted, Radix's default applies. */
  returnFocusRef?: RefObject<HTMLElement | null>;
} & ({ mode: "create"; parent: FolderCreateParent } | { mode: "rename"; folder: FolderDto; stack?: StackRenameHooks });

/** Import only through the FolderLazy chain and tests. With `stack` (rename after a stacked folder was created): select the default name on open; `stack.onClosed` fires exactly once on close (submitted name on success, original name on cancel/Esc). */
export function FolderNameDialog(props: FolderNameDialogProps) {
  const { t } = useTranslation();
  const { open, onOpenChange, returnFocusRef } = props;
  const stack = props.mode === "rename" ? props.stack : undefined;
  const queryClient = useQueryClient();
  const createFolder = useCreateFolder();
  const renameFolder = useRenameFolder();
  const [name, setName] = useState(props.mode === "rename" ? props.folder.name : "");
  const [error, setError] = useState<string | null>(null);
  const [selectOnOpen] = useState(stack !== undefined);
  // Stable callback ref: select once on mount (after autoFocus), not on later renders.
  const selectAllOnOpen = useCallback(
    (el: HTMLInputElement | null) => {
      if (el !== null && selectOnOpen) el.select();
    },
    [selectOnOpen],
  );
  const closedReportedRef = useRef(false);
  /** Rename PATCH in flight: closing (Esc etc.) doesn't report; handleSubmit reports by outcome, with the final name. */
  const renamingRef = useRef(false);
  /** Close was requested (Esc/cancel): a rename that then fails reports the original name. */
  const closeRequestedRef = useRef(false);

  function reportClosed(finalName: string): void {
    if (stack === undefined || closedReportedRef.current) return;
    closedReportedRef.current = true;
    stack.onClosed(finalName);
  }

  function handleOpenChange(next: boolean): void {
    if (!next) closeRequestedRef.current = true;
    if (!next && props.mode === "rename" && !renamingRef.current) reportClosed(props.folder.name);
    onOpenChange(next);
  }

  const trimmed = name.trim();
  // Same order as the server: trim → control characters → length in code points (at most FOLDER_NAME_MAX).
  const invalid = hasControlChar(trimmed)
    ? t("folderDialogs.nameControlChars")
    : [...trimmed].length > FOLDER_NAME_MAX
      ? t("folderDialogs.nameTooLong", { max: FOLDER_NAME_MAX })
      : null;
  const pending = createFolder.isPending || renameFolder.isPending;
  const message = invalid ?? error;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (trimmed.length === 0 || invalid !== null || pending) return;
    setError(null);
    // Stacked rename keeping the default name (the common Enter): skip the PATCH, just close and report.
    if (props.mode === "rename" && stack !== undefined && trimmed === props.folder.name) {
      reportClosed(trimmed);
      onOpenChange(false);
      return;
    }
    try {
      if (props.mode === "rename") {
        renamingRef.current = true;
        try {
          await renameFolder.mutateAsync({ id: props.folder.id, name: trimmed });
        } finally {
          renamingRef.current = false;
        }
        reportClosed(trimmed);
      } else {
        const { parent } = props;
        await createFolder.mutateAsync("folderId" in parent ? { name: trimmed, parentId: parent.folderId } : { name: trimmed, space: parent.space });
        if ("folderId" in parent) {
          expandFolderChain(indexFolders(queryClient.getQueryData<FolderDto[]>(FOLDERS_QUERY_KEY) ?? []), parent.folderId);
        } else if (parent.space.kind === "group") {
          setCollapsed(`group:${parent.space.groupId}`, false);
        }
      }
      onOpenChange(false);
    } catch (err) {
      // Rename closed while in flight then failed: the name is unchanged, report the original (an open dialog shows the error instead).
      if (props.mode === "rename" && closeRequestedRef.current) reportClosed(props.folder.name);
      setError(folderErrorMessage(t, err));
    }
  }

  const title = props.mode === "create" ? t("sidebar.newFolder") : t("folderDialogs.renameTitle");

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        dismissOnOutside={false}
        // No description on purpose: an sr-only copy of the title would be read twice.
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          // Stacked: no trigger to return to; focus goes to the new folder row (resolved at close time).
          const stackTarget = stack?.focusTarget();
          const target = stackTarget?.isConnected ? stackTarget : returnFocusRef?.current;
          if (!target?.isConnected) return;
          event.preventDefault();
          target.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="folder-name-input" className="text-sm font-medium">
              {t("folderDialogs.nameLabel")}
            </label>
            <Input
              id="folder-name-input"
              ref={selectAllOnOpen}
              autoFocus
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
              aria-invalid={message !== null || undefined}
            />
          </div>
          {message !== null && (
            <p role="alert" className="text-sm text-destructive">
              {message}
            </p>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t("home.cancel")}
              </Button>
            </DialogClose>
            <Button type="submit" variant="brandDeep" disabled={trimmed.length === 0 || invalid !== null || pending}>
              {props.mode === "create" ? t("groups.dialog.create") : t("groups.dialog.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
