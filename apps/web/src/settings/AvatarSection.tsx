import { lazy, Suspense, useEffect, useId, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { formatBytes, type AvatarCandidateDto, type AvatarRef } from "@knotebook/shared";
import { useIdentities } from "@/api/account";
import { AVATARS_QUERY_KEY, useAvatars, useDeleteAvatar, useRefreshOidcAvatar, useSelectAvatar } from "@/api/avatars";
import { useAuthConfig } from "@/api/authConfig";
import { ApiFail } from "@/api/client";
import { useSession } from "@/auth/useSession";
import { useFillPending, useQuotaFailed } from "@/avatars/filler-hooks";
import { fillKey, registerCropOpen } from "@/avatars/display-filler";
import { Avatar } from "@/components/Avatar";
import { ProviderIcon } from "@/components/ProviderIcon";
import { storageQuotaDescription } from "@/lib/storage-quota-text";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Check, EllipsisVertical, Pencil, Trash } from "@/components/ui/icons";
import { hoverReveal } from "@/components/ui/reveal";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { SettingsGroup } from "./SettingsLayout";
import type { AvatarCropSource } from "./AvatarCropDialog";
import "@/i18n/management-strings";

// The crop dialog and its dependencies download only when the user opens it; the decode/encode modules load later still, on save.
const AvatarCropDialog = lazy(() => import("./AvatarCropDialog").then(m => ({ default: m.AvatarCropDialog })));

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Shared by the radiogroup and the menu grid overlaid on it, so each menu lands in its cell's column and row. */
const CELL_GRID = "grid grid-cols-[repeat(auto-fill,minmax(5rem,1fr))] gap-y-2";

interface Cell {
  /** null = the "no avatar" cell. */
  candidate: AvatarCandidateDto | null;
}

function candidateLabel(t: Translate, language: string, candidate: AvatarCandidateDto): string {
  if (candidate.source === "oidc") {
    return candidate.providerName !== null
      ? t("settings.account.avatar.fromProvider", { provider: candidate.providerName })
      : t("settings.account.avatar.fromDisconnected");
  }
  // Includes time so same-day uploads are distinguishable (accessible name and delete confirmation use it).
  const date = new Date(candidate.createdAt).toLocaleString(language, { dateStyle: "medium", timeStyle: "medium" });
  return t("settings.account.avatar.uploaded", { date });
}

/** 404 means another tab just deleted it, so refetch the list instead of showing an error. */
function reportFailure(t: Translate, err: unknown, refetch: () => void): void {
  if (err instanceof ApiFail && err.status === 404) {
    refetch();
    return;
  }
  const code = err instanceof ApiFail && err.code === "server_busy" ? "server_busy" : "internal";
  toast({ title: t(`errors.${code}`), variant: "destructive" });
}

/** The caller handles 404 (refetch the list, no error). */
function reportRefreshFailure(t: Translate, err: unknown, provider: string): void {
  if (err instanceof ApiFail) {
    switch (err.code) {
      case "storage_quota_exceeded":
        toast({ title: t("errors.storage_quota_exceeded"), description: storageQuotaDescription(err, t), variant: "destructive" });
        return;
      case "server_busy":
      case "too_many_requests":
        toast({ title: t(`errors.${err.code}`), variant: "destructive" });
        return;
      case "avatar_fetch_failed":
        toast({ title: t("settings.account.avatar.refreshFailed", { provider }), variant: "destructive" });
        return;
    }
  }
  toast({ title: t("errors.internal"), variant: "destructive" });
}

function CandidateMenu({
  label,
  onRecrop,
  onDelete,
}: {
  label: string;
  onRecrop: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu phoneSheet open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t("settings.account.avatar.more", { candidate: label })}
          className={cn(
            "pointer-events-auto relative h-6 w-6 shrink-0 self-start justify-self-end",
            // Touch: stays 24px visually, hit area grows to 40x44.
            "pointer-coarse:before:absolute pointer-coarse:before:-inset-x-2 pointer-coarse:before:-inset-y-2.5 pointer-coarse:before:content-['']",
            hoverReveal("avatarcell"),
          )}
        >
          <EllipsisVertical aria-hidden="true" className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sheetTitle={label}>
        <DropdownMenuItem
          onSelect={event => {
            event.preventDefault();
            setOpen(false);
            onRecrop();
          }}
        >
          <Pencil aria-hidden="true" className="mr-2 h-4 w-4" />
          {t("settings.account.avatar.recrop")}
        </DropdownMenuItem>
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onSelect={event => {
            event.preventDefault();
            setOpen(false);
            onDelete();
          }}
        >
          <Trash aria-hidden="true" className="mr-2 h-4 w-4" />
          {t("settings.account.avatar.delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DeleteDialog({
  candidate,
  label,
  pending,
  onConfirm,
  onOpenChange,
}: {
  candidate: AvatarCandidateDto;
  label: string;
  pending: boolean;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("settings.account.avatar.deleteTitle")}</DialogTitle>
          <DialogDescription>
            {t("settings.account.avatar.deleteDescription", { size: formatBytes(candidate.originalSize + candidate.displaySize) })}
          </DialogDescription>
          <p className="text-sm font-medium">{label}</p>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {t("home.cancel")}
            </Button>
          </DialogClose>
          <Button type="button" variant="destructive" onClick={onConfirm} disabled={pending}>
            {t("settings.account.avatar.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * `role="radiogroup"` with roving tabindex: one cell in the Tab order (the checked one again once focus leaves the group),
 * arrows/Home/End move focus, click or Space picks (native button behavior). The overflow menus can't live inside `role="radio"` (its descendants are
 * presentational), so they sit in a second grid with the same template overlaid on the same cell; Tab visits the
 * radiogroup once, then each menu. Ring color is a CSS
 * variable (`Avatar`'s `ringColor`), not the `ring-brand` utility.
 */
export function AvatarSection() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { user } = useSession();
  const list = useAvatars();
  const maxUploadBytes = useAuthConfig().data?.maxUploadBytes;
  const select = useSelectAvatar();
  const remove = useDeleteAvatar();
  const refresh = useRefreshOidcAvatar();
  const identities = useIdentities();
  const quotaFailed = useQuotaFailed();
  const refreshButtons = useRef(new Map<string, HTMLButtonElement>());
  const [focusAfterRefresh, setFocusAfterRefresh] = useState<string | null>(null);
  const noSpaceId = useId();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const radios = useRef<(HTMLButtonElement | null)[]>([]);
  const uploadButton = useRef<HTMLButtonElement | null>(null);
  const [focusAfterDelete, setFocusAfterDelete] = useState<{ id: string; index: number } | null>(null);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const [cropSource, setCropSource] = useState<AvatarCropSource | null>(null);
  const [deleting, setDeleting] = useState<AvatarCandidateDto | null>(null);
  const [sizeError, setSizeError] = useState<string | null>(null);

  const displayName = user?.displayName ?? "";
  const candidates = list.data?.candidates ?? [];
  const cells: Cell[] = [{ candidate: null }, ...candidates.map(candidate => ({ candidate }))];
  const checkedIndex = Math.max(0, cells.findIndex(cell => cell.candidate?.current === true));
  const rovingIndex = Math.min(focusIndex ?? checkedIndex, cells.length - 1);
  const previewRef: AvatarRef | null = user?.avatar ? { id: user.avatar.id, v: user.avatar.v } : null;

  // Registered as soon as chosen, so the background fill skips this candidate and doesn't submit one already running. The
  // crop dialog is a lazy chunk, so waiting for it to load would miss that window.
  const croppingId = cropSource?.kind === "existing" ? cropSource.candidate.id : null;
  useEffect(() => {
    if (croppingId === null) return;
    return registerCropOpen(croppingId);
  }, [croppingId]);

  // Pending candidates also go to the background fill; each version is filled once.
  useFillPending(candidates.filter(c => c.pending).map(c => ({ id: c.id, v: c.avatar.v })));
  const noSpaceKeys = candidates.filter(c => c.pending && quotaFailed.has(fillKey({ id: c.id, v: c.avatar.v }))).map(c => c.id);

  // After a successful refresh the button disappears once the list stops listing it: focus the checked cell then.
  useEffect(() => {
    if (focusAfterRefresh === null || list.data === undefined) return;
    setFocusAfterRefresh(null);
    const stillThere = list.data.refreshable.some(r => r.identityId === focusAfterRefresh);
    (stillThere ? refreshButtons.current.get(focusAfterRefresh) : radios.current[checkedIndex])?.focus();
  }, [focusAfterRefresh, list.data, checkedIndex]);

  // The deleted candidate's menu button is gone from the DOM, so without this focus would fall to body.
  useEffect(() => {
    if (focusAfterDelete === null || list.data === undefined) return;
    if (list.data.candidates.some(c => c.id === focusAfterDelete.id)) return;
    const remaining = list.data.candidates.length;
    const target = remaining === 0 ? uploadButton.current : radios.current[Math.min(focusAfterDelete.index, remaining)];
    setFocusAfterDelete(null);
    if (remaining > 0) setFocusIndex(Math.min(focusAfterDelete.index, remaining));
    target?.focus();
  }, [focusAfterDelete, list.data]);

  function refetchList(): Promise<void> {
    return queryClient.invalidateQueries({ queryKey: AVATARS_QUERY_KEY });
  }

  function choose(cell: Cell, index: number): void {
    setFocusIndex(index);
    if (index === checkedIndex || select.isPending) return;
    select.mutate(cell.candidate === null ? null : cell.candidate.id, {
      onSuccess: () => toast({ title: t("settings.account.avatar.changed") }),
      onError: err => reportFailure(t, err, refetchList),
    });
  }

  function refreshFrom(identityId: string, provider: string): void {
    // aria-disabled, not disabled: Chromium drops focus to body when the focused button gets disabled.
    if (refresh.isPending) return;
    refresh.mutate(identityId, {
      onSuccess: () => {
        toast({ title: t("settings.account.avatar.changed") });
        setFocusAfterRefresh(identityId);
      },
      onError: err => {
        if (err instanceof ApiFail && err.status === 404) {
          // Identity was just unlinked: the button disappears after refetch and focus goes to the checked cell; no error toast.
          void refetchList().then(() => setFocusAfterRefresh(identityId));
          return;
        }
        reportRefreshFailure(t, err, provider);
      },
    });
  }

  function sourceIcon(candidate: AvatarCandidateDto) {
    if (candidate.source !== "oidc" || candidate.providerName === null) return undefined;
    return identities.data?.identities.flatMap(identity => identity.providers).find(p => p.displayName === candidate.providerName)?.icon ?? undefined;
  }

  function onRadioKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    const last = cells.length - 1;
    let next: number;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = Math.min(index + 1, last);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = Math.max(index - 1, 0);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    setFocusIndex(next);
    radios.current[next]?.focus();
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    // Clear so that choosing the same file again still fires change.
    event.target.value = "";
    if (file === undefined) return;
    if (maxUploadBytes !== undefined && file.size > maxUploadBytes) {
      setSizeError(t("settings.account.avatar.tooLarge", { size: formatBytes(maxUploadBytes) }));
      return;
    }
    setSizeError(null);
    setCropSource({ kind: "new", file });
  }

  function confirmDelete(candidate: AvatarCandidateDto): void {
    const index = cells.findIndex(cell => cell.candidate?.id === candidate.id);
    remove.mutate(candidate.id, {
      onSuccess: () => {
        setFocusAfterDelete({ id: candidate.id, index });
        toast({ title: candidate.current ? t("settings.account.avatar.deletedCurrent") : t("settings.account.avatar.deleted") });
      },
      onError: err => reportFailure(t, err, refetchList),
      onSettled: () => setDeleting(null),
    });
  }

  return (
    <SettingsGroup title={t("settings.account.avatar.title")} description={t("settings.account.avatar.description")}>
      <div className="flex items-center gap-4">
        <Avatar name={displayName} avatar={previewRef} size={64} offsetColor="var(--color-background)" />
        <Button ref={uploadButton} type="button" variant="outline" onClick={() => fileInput.current?.click()}>
          {t("settings.account.avatar.upload")}
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          data-testid="avatar-file-input"
          onChange={onFileChange}
        />
      </div>
      {sizeError !== null && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {sizeError}
        </p>
      )}

      {list.isPending && <p className="mt-4 text-sm text-muted-foreground">{t("settings.account.avatar.loading")}</p>}
      {list.isError && (
        <div className="mt-4 flex items-center gap-3">
          <p role="alert" className="text-sm text-destructive">
            {t("settings.account.avatar.loadFailed")}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => void list.refetch()}>
            {t("app.retry")}
          </Button>
        </div>
      )}
      {list.data !== undefined && (
        <>
          <div className="group/avatarcell mt-4 grid">
            <div role="radiogroup"
              aria-label={t("settings.account.avatar.listLabel")}
              className={cn(CELL_GRID, "col-start-1 row-start-1")}
              onBlur={event => {
                // Focus left the group (not moved within it): the Tab stop returns to the checked cell.
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusIndex(null);
              }}
            >
              {cells.map((cell, index) => {
                const checked = index === checkedIndex;
                const label = cell.candidate === null ? t("settings.account.avatar.none") : candidateLabel(t, i18n.language, cell.candidate);
                const icon = cell.candidate === null ? undefined : sourceIcon(cell.candidate);
                const noSpace = cell.candidate !== null && noSpaceKeys.includes(cell.candidate.id);
                return (
                  <button
                    key={cell.candidate?.id ?? "none"}
                    ref={node => {
                      radios.current[index] = node;
                    }}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    aria-label={label}
                    title={label}
                    aria-describedby={noSpace ? noSpaceId : undefined}
                    tabIndex={index === rovingIndex ? 0 : -1}
                    onClick={() => choose(cell, index)}
                    onKeyDown={event => onRadioKeyDown(event, index)}
                    className="relative flex h-14 w-14 items-center justify-center justify-self-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    <Avatar
                      name={displayName}
                      avatar={cell.candidate === null ? null : cell.candidate.avatar}
                      size={48}
                      ringColor={checked ? "var(--color-brand)" : undefined}
                      offsetColor="var(--color-background)"
                    />
                    {icon != null && (
                      <span
                        aria-hidden="true"
                        data-testid="avatar-source-icon"
                        className="absolute bottom-0 left-0 flex h-4 w-4 items-center justify-center rounded-full bg-background ring-1 ring-border"
                      >
                        <ProviderIcon icon={icon} className="h-3 w-3" />
                      </span>
                    )}
                    {checked && (
                      <span
                        aria-hidden="true"
                        className="absolute bottom-0 right-0 flex h-4 w-4 items-center justify-center rounded-full bg-brand text-brand-fg"
                      >
                        <Check className="h-3 w-3" />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <div className={cn(CELL_GRID, "pointer-events-none col-start-1 row-start-1")}>
              {cells.map(cell => {
                if (cell.candidate === null) return <span key="none" aria-hidden="true" />;
                const candidate = cell.candidate;
                return (
                  <CandidateMenu
                    key={candidate.id}
                    label={candidateLabel(t, i18n.language, candidate)}
                    onRecrop={() => setCropSource({ kind: "existing", candidate })}
                    onDelete={() => setDeleting(candidate)}
                  />
                );
              })}
            </div>
          </div>
          {candidates.length === 0 && <p className="mt-2 text-sm text-muted-foreground">{t("settings.account.avatar.empty")}</p>}
          {noSpaceKeys.length > 0 && (
            <p id={noSpaceId} className="mt-2 text-sm text-muted-foreground">
              {t("settings.account.avatar.noSpace")}
            </p>
          )}
          {list.data.refreshable.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {list.data.refreshable.map(r => (
                <Button
                  key={r.identityId}
                  ref={node => {
                    if (node === null) refreshButtons.current.delete(r.identityId);
                    else refreshButtons.current.set(r.identityId, node);
                  }}
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-disabled={refresh.isPending || undefined}
                  className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                  onClick={() => refreshFrom(r.identityId, r.providerName)}
                >
                  {t("settings.account.avatar.useProvider", { provider: r.providerName })}
                </Button>
              ))}
            </div>
          )}
        </>
      )}
      <p className="mt-4 text-sm text-muted-foreground">{t("settings.account.avatar.usage")}</p>

      {cropSource !== null && (
        <Suspense fallback={null}>
          <AvatarCropDialog
            open
            source={cropSource}
            onOpenChange={open => {
              if (!open) setCropSource(null);
            }}
            onSaved={() => undefined}
          />
        </Suspense>
      )}
      {deleting !== null && (
        <DeleteDialog
          candidate={deleting}
          label={candidateLabel(t, i18n.language, deleting)}
          pending={remove.isPending}
          onConfirm={() => confirmDelete(deleting)}
          onOpenChange={open => {
            if (!open) setDeleting(null);
          }}
        />
      )}
    </SettingsGroup>
  );
}
