import { useLayoutEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { VersionDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useDeleteVersion, useRenameVersion, useSaveVersion } from "@/api/versions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { useVersions } from "@/lib/versions-context";
import { useApplyFlow } from "./use-apply-flow";
import { versionLabel } from "./version-labels";

// Max 120 characters (the server decides finally); import `VERSION_NAME_MAX` from shared, don't duplicate the constant.
import { VERSION_NAME_MAX } from "@knotebook/shared";

function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

type CloseAutoFocus = (event: Event) => void;

function SaveDialog({ noteId, then, onCloseAutoFocus }: { noteId: string; then?: VersionDto; onCloseAutoFocus: CloseAutoFocus }) {
  const { t } = useTranslation();
  const { closeDialog } = useVersions();
  const save = useSaveVersion(noteId);
  const { applyNow } = useApplyFlow(noteId);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  // In-flight flag for the whole submit: with `then`, after the save succeeds `save.isPending` is already false but the apply is still running; no submit meanwhile (it would save twice and send apply twice). The ref blocks re-entry, state disables the button.
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const row = await save.mutateAsync(name);
      toast({ title: row.upgraded ? t("versions.toast.upgraded", { label: versionLabel(row) }) : t("versions.toast.saved", { label: versionLabel(row) }) });
      if (then) await applyNow(then, false);
      else closeDialog();
    } catch (err) {
      setError(errorMessage(t, err));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && closeDialog()}>
      {/* Form dialogs use dismissOnOutside={false}: a stray click outside must not discard the typed name; Esc/cancel still close */}
      <DialogContent dismissOnOutside={false} onCloseAutoFocus={onCloseAutoFocus}>
        <form onSubmit={(e) => void submit(e)}>
          <DialogHeader>
            <DialogTitle>{t("versions.dialog.saveTitle")}</DialogTitle>
            {/* Don't announce which version number will be created */}
            <DialogDescription>{t("versions.dialog.saveDescription")}</DialogDescription>
          </DialogHeader>
          <label className="mt-4 block text-sm" htmlFor="version-save-name">
            {t("versions.dialog.nameLabel")}
          </label>
          <Input id="version-save-name" value={name} maxLength={VERSION_NAME_MAX} onChange={(e) => setName(e.target.value)} className="mt-1" />
          {error !== null && (
            <p role="alert" className="mt-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={closeDialog}>
              {t("versions.dialog.cancel")}
            </Button>
            <Button type="submit" variant="brandDeep" disabled={busy || save.isPending}>
              {t("versions.dialog.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ApplyDialog({ noteId, version, onCloseAutoFocus }: { noteId: string; version: VersionDto; onCloseAutoFocus: CloseAutoFocus }) {
  const { t } = useTranslation();
  const { closeDialog, openSave } = useVersions();
  const { applyNow } = useApplyFlow(noteId);
  const [busy, setBusy] = useState(false);

  async function discard() {
    setBusy(true);
    try {
      await applyNow(version, true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && closeDialog()}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{t("versions.dialog.applyTitle", { label: versionLabel(version) })}</DialogTitle>
          <DialogDescription>{t("versions.dialog.applyDescription", { label: versionLabel(version) })}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="mt-4">
          <Button type="button" variant="outline" disabled={busy} onClick={closeDialog}>
            {t("versions.dialog.cancel")}
          </Button>
          <Button type="button" variant="destructive" disabled={busy} onClick={() => void discard()}>
            {t("versions.dialog.applyDiscard")}
          </Button>
          <Button type="button" variant="brandDeep" disabled={busy} onClick={() => openSave(version)}>
            {t("versions.dialog.applySaveFirst")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RenameDialog({ noteId, version, onCloseAutoFocus }: { noteId: string; version: VersionDto; onCloseAutoFocus: CloseAutoFocus }) {
  const { t } = useTranslation();
  const { closeDialog } = useVersions();
  const rename = useRenameVersion(noteId);
  const [name, setName] = useState(version.name ?? "");
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    try {
      await rename.mutateAsync({ seq: version.seq, name });
      toast({ title: t("versions.toast.renamed") });
      closeDialog();
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && closeDialog()}>
      <DialogContent dismissOnOutside={false} onCloseAutoFocus={onCloseAutoFocus}>
        <form onSubmit={(e) => void submit(e)}>
          <DialogHeader>
            <DialogTitle>{t("versions.dialog.renameTitle", { label: versionLabel(version) })}</DialogTitle>
            {version.kind === "auto" && <DialogDescription>{t("versions.dialog.renameAutoHint")}</DialogDescription>}
          </DialogHeader>
          <label className="mt-4 block text-sm" htmlFor="version-rename-name">
            {t("versions.dialog.nameLabel")}
          </label>
          <Input id="version-rename-name" value={name} maxLength={VERSION_NAME_MAX} onChange={(e) => setName(e.target.value)} className="mt-1" />
          {error !== null && (
            <p role="alert" className="mt-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={closeDialog}>
              {t("versions.dialog.cancel")}
            </Button>
            <Button type="submit" variant="brandDeep" disabled={rename.isPending}>
              {t("versions.dialog.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({ noteId, version, onCloseAutoFocus }: { noteId: string; version: VersionDto; onCloseAutoFocus: CloseAutoFocus }) {
  const { t } = useTranslation();
  const { closeDialog, preview, stopPreview } = useVersions();
  const del = useDeleteVersion(noteId);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    try {
      await del.mutateAsync(version.seq);
      toast({ title: t("versions.toast.deleted", { label: versionLabel(version) }) });
      if (preview?.seq === version.seq) stopPreview();
      closeDialog();
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && closeDialog()}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{t("versions.dialog.deleteTitle", { label: versionLabel(version) })}</DialogTitle>
          <DialogDescription>{t("versions.dialog.deleteDescription")}</DialogDescription>
        </DialogHeader>
        {error !== null && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter className="mt-4">
          <Button type="button" variant="outline" onClick={closeDialog}>
            {t("versions.dialog.cancel")}
          </Button>
          <Button type="button" variant="destructive" disabled={del.isPending} onClick={() => void submit()}>
            {t("versions.dialog.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Focus restore: the four dialogs are controlled with no `DialogTrigger`, so Radix on close only does `triggerRef.current?.focus()` (null) and focus falls to body (after Ctrl+S the caret leaves the editor). So `document.activeElement` is recorded at the "no dialog → dialog" moment (the editor's contenteditable after Ctrl+S) and restored when the whole dialog flow ends (including the three-way → save swap), as in `GroupNameDialog`/`LinkDialog`.
 * If that element is gone (opened from the header ⋮: the menu item was recorded) it falls back to `returnFocusRef` (the ⋮ trigger, as VersionsSheet); with neither, nothing. `document.body` counts as not recorded.
 * Swapping dialogs (apply → save, apply hitting 409 → apply) also fires onCloseAutoFocus from the old dialog's unmount (`@radix-ui/react-focus-scope` sends it in a setTimeout) while another dialog is open: don't restore then.
 * `openRef` does two things: reset on unmount (NotePage mounts conditionally and unmounts on close; without the reset all restores would be blocked); and block restore during a swap (jsdom tests don't cover this guard; it is kept so focus doesn't jump to the editor and get pulled back, which in a real browser may scroll).
 */
export function VersionsDialogs({ returnFocusRef }: { returnFocusRef?: RefObject<HTMLElement | null> } = {}) {
  const { noteId, dialog } = useVersions();
  const isOpen = noteId !== null && dialog !== null;
  const [session, setSession] = useState<{ open: boolean; returnTo: HTMLElement | null }>({ open: false, returnTo: null });
  if (session.open !== isOpen) {
    // body doesn't count as a restorable element: treated as not recorded, so close falls back to the ⋮ path.
    const active = document.activeElement;
    setSession({ open: isOpen, returnTo: isOpen && active instanceof HTMLElement && active !== document.body ? active : null });
  }
  const openRef = useRef(isOpen);
  useLayoutEffect(() => {
    openRef.current = isOpen;
  });
  // NotePage mounts this only when dialog !== null (close = unmount, never an isOpen=false render): reset openRef on unmount,
  // or the swap guard above would block the onCloseAutoFocus FocusScope sends after unmount and focus would fall to body.
  useLayoutEffect(
    () => () => {
      openRef.current = false;
    },
    [],
  );
  const returnTo = session.returnTo;
  const onCloseAutoFocus = (event: Event) => {
    if (openRef.current) return;
    const target = returnTo?.isConnected ? returnTo : returnFocusRef?.current;
    if (!target?.isConnected) return;
    event.preventDefault();
    target.focus();
  };
  if (!noteId || !dialog) return null;
  switch (dialog.kind) {
    case "save":
      return <SaveDialog key={`save-${dialog.then?.id ?? ""}`} noteId={noteId} then={dialog.then} onCloseAutoFocus={onCloseAutoFocus} />;
    case "apply":
      return <ApplyDialog key={`apply-${dialog.version.id}`} noteId={noteId} version={dialog.version} onCloseAutoFocus={onCloseAutoFocus} />;
    case "rename":
      return <RenameDialog key={`rename-${dialog.version.id}`} noteId={noteId} version={dialog.version} onCloseAutoFocus={onCloseAutoFocus} />;
    case "delete":
      return <DeleteDialog key={`delete-${dialog.version.id}`} noteId={noteId} version={dialog.version} onCloseAutoFocus={onCloseAutoFocus} />;
  }
}
