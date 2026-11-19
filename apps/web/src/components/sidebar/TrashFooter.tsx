import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { usePurgeTrash, useRestoreTrash, useTrash } from "@/api/trash";
import { SIDEBAR_SELECT_BUTTON } from "@/lib/sidebar-selection";
import { useSidebarTabActions, useSidebarTabState } from "@/lib/sidebar-tab";
import { selectedTrashIds } from "@/lib/trash-display";
import { useWidePointer } from "@/lib/wide-pointer";
import { Button } from "@/components/ui/button";
import { Trash } from "@/components/ui/icons";
import { RotateCcw } from "@/components/ui/icons-extra";
import { PurgeConfirmDialog, toastTrashFailure, toastTrashResult } from "@/components/sidebar/trash-dialogs";

/** Both live in one lazy component: separate lazies would suspend again on first entering select mode and flash a placeholder. */
export function TrashFooter() {
  const { selection } = useSidebarTabState();
  const wide = useWidePointer();
  if (!selection.active) return <TrashFooterNote />;
  return wide ? null : <TrashActionBar />;
}

/** Phone: the note follows the list as the document scrolls; the bottom-left Search FAB covers the screen bottom, so bottom padding is 56+16+8 plus the safe area to keep list and note above it. */
function TrashFooterNote() {
  const { t } = useTranslation();
  const trash = useTrash();
  if (!trash.isSuccess) return <div className="h-7 max-sm:h-[calc(6.375rem+env(safe-area-inset-bottom))]" />;
  const days = trash.data.retentionDays;
  return (
    <p data-testid="trash-footer" className="px-4 py-1.5 text-center text-[11px] text-muted-foreground max-sm:pb-[calc(5rem+env(safe-area-inset-bottom))]">
      {days !== null ? t("trash.footer", { count: days }) : t("trash.footerNever")}
    </p>
  );
}

/** Both callers mount it only while selecting: the `mountedRef` guard (a late response mustn't end a selection the user restarted) relies on that; `purgeDialog` is rendered by the caller and unmounts with it. */
export function useTrashSelectionActions(): {
  selectedIds: string[];
  disabled: boolean;
  busy: boolean;
  onRestore: (event: MouseEvent<HTMLButtonElement>) => void;
  onPurge: (event: MouseEvent<HTMLButtonElement>) => void;
  purgeDialog: ReactNode;
} {
  const { t } = useTranslation();
  const trash = useTrash();
  const restore = useRestoreTrash();
  const purge = usePurgeTrash();
  const { selection } = useSidebarTabState();
  const { updateSelection } = useSidebarTabActions();
  const [confirmOpen, setConfirmOpen] = useState(false);
  /** No double send on rapid clicks (as TrashPanel: `isPending` reaches `disabled` only a macrotask later). */
  const busyRef = useRef(false);
  /** Once selection ended (caller unmounted) don't touch selection or focus: a late response mustn't end a selection the user restarted. */
  const mountedRef = useRef(true);
  /** The dialog opener and its instance (the confirm button is in a portal, so the shell can't be found from it). */
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const shellRef = useRef<Element | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const selectedIds = selectedTrashIds(trash.data?.items ?? [], selection.keys);
  const busy = restore.isPending || purge.isPending;
  const disabled = selectedIds.length === 0 || busy;
  const end = () => updateSelection({ type: "end" });

  async function exclusive(run: () => Promise<void>): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      await run();
    } finally {
      busyRef.current = false;
    }
  }

  /**
   * The action button unmounts at once and "Select" appears only after `TrashPanel` re-renders, so `flushSync` commits within the same task before looking it up (rAF waits a frame, and a key in that frame would hit body).
   * Focus goes back to the initiating instance's "Select" only if it was in this instance or already on body; if the user moved elsewhere while waiting, don't grab it.
   */
  function finish(shell: Element | null): void {
    if (!mountedRef.current) return;
    flushSync(end);
    const active = document.activeElement;
    if (active === null || active === document.body || shell?.contains(active)) shell?.querySelector<HTMLButtonElement>(SIDEBAR_SELECT_BUTTON)?.focus();
  }

  function onRestore(event: MouseEvent<HTMLButtonElement>): void {
    const shell = event.currentTarget.closest("[data-sidebar-instance]");
    const ids = selectedIds;
    void exclusive(async () => {
      try {
        toastTrashResult("restore", await restore.mutateAsync(ids), t);
      } catch (err) {
        toastTrashFailure("restore", err, t);
        return;
      }
      finish(shell);
    });
  }

  function onPurge(event: MouseEvent<HTMLButtonElement>): void {
    openerRef.current = event.currentTarget;
    shellRef.current = event.currentTarget.closest("[data-sidebar-instance]");
    setConfirmOpen(true);
  }

  const purgeDialog = (
    <PurgeConfirmDialog
      count={selectedIds.length}
      open={confirmOpen}
      pending={purge.isPending}
      onConfirm={() => {
        const ids = selectedIds;
        // The list was refetched after opening and none of the selection remains: no empty request or "deleted 0" report, just close.
        if (ids.length === 0) {
          setConfirmOpen(false);
          return;
        }
        const shell = shellRef.current;
        void exclusive(async () => {
          let ok = false;
          try {
            toastTrashResult("purge", await purge.mutateAsync(ids), t);
            ok = true;
          } catch (err) {
            toastTrashFailure("purge", err, t);
          }
          // Closed on success and failure alike; cancelling mid-submit can't reopen on another target: the action button is disabled while pending.
          setConfirmOpen(false);
          if (ok) finish(shell);
        });
      }}
      onOpenChange={setConfirmOpen}
      // No DialogTrigger: Radix's focus target on close is empty and focus would fall to body. On cancel or failure the opener still exists and gets focus;
      // on success `finish` already focused "Select" and the opener is unmounted, so do nothing.
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        if (openerRef.current?.isConnected) openerRef.current.focus();
      }}
    />
  );

  return { selectedIds, disabled, busy, onRestore, onPurge, purgeDialog };
}

function TrashActionBar() {
  const { t } = useTranslation();
  const { disabled, onRestore, onPurge, purgeDialog } = useTrashSelectionActions();
  const { endSelectionIfActive } = useSidebarTabActions();

  /**
   * Esc for the static card's bottom (the action bar isn't under TrashPanel's root). In the drawer AppShell's `onEscapeKeyDown` (Radix, document capture) ends selection and hands focus;
   * a real browser commits after that and before React's onKeyDown, with the action bar already unmounted, so this never sees it.
   */
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "Escape") return;
    const shell = event.currentTarget.closest("[data-sidebar-instance]");
    let ended = false;
    flushSync(() => {
      ended = endSelectionIfActive();
    });
    if (ended) {
      event.preventDefault(); // Only ends selection; the search-highlight Esc listener yields on defaultPrevented
      shell?.querySelector<HTMLButtonElement>(SIDEBAR_SELECT_BUTTON)?.focus();
    }
  }

  return (
    <>
      {/* Phone scrolls the document: same frame as the other bottom bars, sticky at the window bottom clear of the Home indicator, so the list doesn't show through */}
      <div
        className="m-2 flex gap-1 max-sm:sticky max-sm:bottom-0 max-sm:z-20 max-sm:m-0 max-sm:border-t max-sm:border-border max-sm:bg-card max-sm:px-2 max-sm:pt-1.5 max-sm:pb-[calc(0.375rem+env(safe-area-inset-bottom))]"
        onKeyDown={handleKeyDown}
      >
        <Button type="button" variant="brand" className="min-w-0 flex-1 px-1.5" aria-label={t("trash.restore")} title={t("trash.restore")} disabled={disabled} onClick={onRestore}>
          <RotateCcw aria-hidden="true" className="h-4 w-4 shrink-0" />
        </Button>
        {/* Not outline: its hover fills brand-deep, which clashes with red text (hover as ROW_ICON_DANGER in row-actions.ts) */}
        <Button
          type="button"
          variant="ghost"
          className="min-w-0 flex-1 px-1.5 border border-input text-destructive hover:bg-destructive/10 hover:text-destructive"
          aria-label={t("trash.purge")}
          title={t("trash.purge")}
          disabled={disabled}
          onClick={onPurge}
        >
          <Trash aria-hidden="true" className="h-4 w-4 shrink-0" />
        </Button>
      </div>
      {/* Outside the bar's div: Esc inside the dialog only closes it and doesn't bubble through the React tree to the onKeyDown that ends selection */}
      {purgeDialog}
    </>
  );
}

/** Rendered by `TrashPanel` only while selecting (the `mountedRef` guard relies on it). Esc inside the confirm dialog bubbles through the React tree (portal) to TrashPanel's root, where `handleKeyDown` filters it out: closes the dialog without ending selection. */
export function TrashWideToolbar() {
  const { t } = useTranslation();
  const { disabled, busy, onRestore, onPurge, purgeDialog } = useTrashSelectionActions();
  return (
    <>
      <div className="flex shrink-0 items-center gap-0.5" data-select-action-bar="" aria-busy={busy}>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t("trash.restore")}
          title={t("trash.restore")}
          disabled={disabled}
          onClick={onRestore}
          className="h-6 w-6 shrink-0"
        >
          <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t("trash.purge")}
          title={t("trash.purge")}
          disabled={disabled}
          onClick={onPurge}
          className="h-6 w-6 shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash aria-hidden="true" className="h-3.5 w-3.5" />
        </Button>
      </div>
      {purgeDialog}
    </>
  );
}
