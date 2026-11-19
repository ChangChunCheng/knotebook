import { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import type { VersionDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { fetchCurrent, useApplyVersion, versionsKey } from "@/api/versions";
import { toast } from "@/components/ui/toast";
import { useVersions } from "@/lib/versions-context";
import { versionLabel } from "./version-labels";

function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

/** `current` is refetched before applying (`staleTime: 0`) so the dirty check sees fresh data. Never auto-saves. */
export function useApplyFlow(noteId: string) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { openDialog, closeDialog, stopPreview, onApplied } = useVersions();
  const { mutateAsync } = useApplyVersion(noteId);
  // requestApply in-flight flag: a second click returns at once. `fetchQuery` coalesces concurrent refetches of the same key, but both calls would still reach applyNow with their results: without this flag it is two apply POSTs.
  const inFlight = useRef(false);

  const applyNow = useCallback(
    async (version: VersionDto, discardUnsaved: boolean) => {
      try {
        await mutateAsync({ version, discardUnsaved });
        closeDialog();
        stopPreview();
        // Invalidate the whole note query set (id key plus the path-resolution layer, NotePage's invalidateNoteQueries): `useApplyVersion.onSuccess` only invalidates `['note', id]`; the page layer covers the legacy/path keys.
        // After closing the dialog / leaving preview, and wrapped on its own: a failing notification must not turn a successful apply into an error toast.
        try {
          onApplied();
        } catch {
          // Invalidation only aligns header data sooner; on failure wait for the next refetch, the apply result is unaffected.
        }
        toast({ title: t("versions.toast.applied", { label: versionLabel(version) }) });
      } catch (err) {
        if (err instanceof ApiFail && err.status === 409 && err.code === "version_unsaved_changes") {
          openDialog({ kind: "apply", version });
          return;
        }
        closeDialog();
        if (err instanceof ApiFail && err.status === 409 && err.code === "version_mismatch") {
          void queryClient.invalidateQueries({ queryKey: versionsKey(noteId) });
          stopPreview();
        }
        toast({ title: errorMessage(t, err), variant: "destructive" });
      }
    },
    [mutateAsync, onApplied, closeDialog, stopPreview, openDialog, queryClient, noteId, t],
  );

  const requestApply = useCallback(
    async (version: VersionDto) => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        let dirty: boolean;
        try {
          dirty = (await fetchCurrent(queryClient, noteId)).dirty;
        } catch (err) {
          toast({ title: errorMessage(t, err), variant: "destructive" });
          return;
        }
        if (dirty) openDialog({ kind: "apply", version });
        else await applyNow(version, false);
      } finally {
        inFlight.current = false;
      }
    },
    [queryClient, noteId, openDialog, applyNow, t],
  );

  return { requestApply, applyNow };
}
