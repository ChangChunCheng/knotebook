import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router";
import {
  NOTE_WIDTHS,
  normalizeSlug,
  publicAliasPath,
  validateSlug,
  type NoteDto,
  type NoteWidth,
  type ShareDto,
  type ShareRole,
} from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useDeleteShare, usePutShare, useShares } from "@/api/shares";
import { useSession } from "@/auth/useSession";
import {
  useClearPublicSlug,
  useCreatePublicLink,
  useDeletePublicLink,
  usePublicLink,
  useSetPublicSlug,
  useSetPublicWidth,
} from "@/api/public-link";
import { Avatar } from "@/components/Avatar";
import { Button } from "@/components/ui/button";
import { HEADER_ICON_HIT } from "@/components/ui/hit-area";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { toNoteWidth } from "@/components/note-width";
import { Share, Trash, Users } from "@/components/ui/icons";
import { Globe, Lock } from "@/components/ui/icons-extra";
import { Select, type SelectOption } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { ManualCopyField } from "@/components/ManualCopyField";
import { UserEmailCombobox } from "@/components/UserEmailCombobox";
import { tourTarget } from "@/lib/tour-targets";

function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) {
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

function roleOptions(t: (key: string) => string): SelectOption[] {
  return [
    { value: "viewer", label: t("roles.viewer") },
    { value: "editor", label: t("roles.editor") },
  ];
}

/** Local copy: `components/` must not depend on `settings/`, and the density here is tighter. */
function ShareGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2 py-4 first:pt-0 last:pb-0">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function ShareRow({ noteId, share }: { noteId: string; share: ShareDto }) {
  const { t } = useTranslation();
  const putShare = usePutShare(noteId);
  const deleteShare = useDeleteShare(noteId);
  const myUserId = useSession().user?.id;
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const trashRef = useRef<HTMLButtonElement>(null);

  async function handleRoleChange(role: ShareRole): Promise<void> {
    try {
      await putShare.mutateAsync({ email: share.email, role });
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  async function handleRemove(): Promise<void> {
    try {
      await deleteShare.mutateAsync(share.userId);
    } catch (err) {
      setConfirmingRemove(false);
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-2">
      <Avatar name={share.displayName} avatar={share.avatar ?? null} size={28} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{share.displayName}</p>
        <p className="truncate text-xs text-muted-foreground">{share.email}</p>
      </div>
      <Select
        variant="inline"
        aria-label={t("share.roleLabel", { email: share.email })}
        value={share.role}
        disabled={putShare.isPending}
        onValueChange={(value) => void handleRoleChange(value as ShareRole)}
        options={roleOptions(t)}
        className="w-fit shrink-0"
      />
      <Button
        ref={trashRef}
        type="button"
        variant="ghost"
        size="icon"
        aria-label={t("share.remove", { email: share.email })}
        disabled={deleteShare.isPending}
        onClick={() => setConfirmingRemove(true)}
      >
        <Trash className="h-4 w-4" />
      </Button>
      {confirmingRemove && (
        <div role="alert" className="w-full space-y-2 rounded-md border border-destructive/40 p-2">
          <p className="text-sm break-words">
            {t(share.userId === myUserId ? "share.removeSelfConfirm" : "share.removeConfirm", { email: share.email })}
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="destructive" size="sm" disabled={deleteShare.isPending} onClick={() => void handleRemove()}>
              {t("share.removeConfirmButton")}
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={deleteShare.isPending} onClick={() => {
                setConfirmingRemove(false);
                trashRef.current?.focus(); // the confirm row unmounts, focus mustn't fall to body
              }}>
              {t("home.cancel")}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

function SharesSection({ noteId, title }: { noteId: string; title: string }) {
  const { t } = useTranslation();
  const sharesQuery = useShares(noteId);
  const putShare = usePutShare(noteId);

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<ShareRole>("viewer");
  const [addError, setAddError] = useState<string | null>(null);

  async function handleAdd(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setAddError(null);
    const trimmed = email.trim();
    if (trimmed.length === 0) return;
    try {
      await putShare.mutateAsync({ email: trimmed, role });
      setEmail("");
      setRole("viewer");
    } catch (err) {
      setAddError(errorMessage(t, err));
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{title}</p>

      {sharesQuery.isPending ? (
        <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
      ) : sharesQuery.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(t, sharesQuery.error)}
        </p>
      ) : sharesQuery.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("share.noShares")}</p>
      ) : (
        <ul className="space-y-2">
          {sharesQuery.data.map((share) => (
            <ShareRow key={share.userId} noteId={noteId} share={share} />
          ))}
        </ul>
      )}

      <form onSubmit={(event) => void handleAdd(event)} className="flex items-center gap-2">
        <UserEmailCombobox
          label={t("share.emailPlaceholder")}
          value={email}
          onChange={setEmail}
          excludeUserIds={sharesQuery.data?.map((share) => share.userId)}
          className="min-w-0 flex-1"
        />
        <Select
          variant="field"
          aria-label={t("share.newRoleLabel")}
          value={role}
          onValueChange={(value) => setRole(value as ShareRole)}
          options={roleOptions(t)}
          className="w-fit shrink-0"
        />
        <Button type="submit" variant="outline" disabled={putShare.isPending}>
          {t("share.add")}
        </Button>
      </form>
      {addError && (
        <p role="alert" className="text-sm text-destructive">
          {addError}
        </p>
      )}
    </div>
  );
}

type AccessLevel = "private" | "members" | "public";

function deriveAccess(token: string | null, shares: ShareDto[]): AccessLevel {
  return token ? "public" : shares.length > 0 ? "members" : "private";
}

/**
 * The radio is a sticky latch: derived once when both queries (shares + public-link) have fetched after mount (#170); until then loading and no radio selected (a literal derive-on-open would show an already public note as private). The choice then lives until the dialog closes (closing unmounts), with no recompute on data change (it would bounce "public -> specific members (zero members)" and "remove last member" back to private).
 * Explicit recompute points: failed mutation recovery (otherwise the screen says revoked while the link is alive), cancel of the private confirm flow, and abort of that flow (partial failure).
 * Member list and add form render in all three states. If members are cleared while the confirm flow is pending, the effect finishes the pending link revoke (otherwise the action evaporates).
 * Private confirm flow deletes public-link first, then shares sequentially: if it aborts the worst case is leftover members, not an open link.
 * Personal notes only (#175): group notes use `GroupNoteShareSection`.
 */
function AccessSection({ note }: { note: NoteDto }) {
  const noteId = note.id;
  const { t } = useTranslation();
  const sharesQuery = useShares(noteId);
  const linkQuery = usePublicLink(noteId);
  const createLink = useCreatePublicLink(noteId);
  const deleteLink = useDeletePublicLink(noteId);
  const deleteShare = useDeleteShare(noteId);

  const [selection, setSelection] = useState<AccessLevel | null>(null); // null = not latched yet
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const latched = selection !== null;
  const token = linkQuery.data?.token ?? null;
  const shares = sharesQuery.data ?? [];
  const queriesFailed = linkQuery.isError || sharesQuery.isError;

  // Latch only on data fetched after mount (#170): the cache can predate an ownership change (move writes shares as [], deleting a group converts its notes to personal). Mount always refetches (default staleTime 0, see main.tsx). Known residuals: a failed refetch counts as fetched; a request already in flight at mount is reused; a post-mount `setQueryData` also latches.
  useEffect(() => {
    if (selection === null && linkQuery.isFetchedAfterMount && sharesQuery.isFetchedAfterMount
        && linkQuery.data !== undefined && sharesQuery.data !== undefined) {
      setSelection(deriveAccess(linkQuery.data.token, sharesQuery.data));
    }
  }, [selection, linkQuery.isFetchedAfterMount, sharesQuery.isFetchedAfterMount, linkQuery.data, sharesQuery.data]);

  async function recoverFromError(err: unknown): Promise<void> {
    toast({ title: errorMessage(t, err), variant: "destructive" });
    const [freshShares, freshLink] = await Promise.all([sharesQuery.refetch(), linkQuery.refetch()]);
    setSelection(deriveAccess(freshLink.data?.token ?? null, freshShares.data ?? []));
  }

  async function revokeLink(): Promise<void> {
    try {
      await deleteLink.mutateAsync();
    } catch (err) {
      await recoverFromError(err);
    }
  }

  /** Returns whether the token swap succeeded: on failure it already toasted and recovered, so the caller only aborts. */
  async function mintLink(): Promise<boolean> {
    try {
      await createLink.mutateAsync();
      return true;
    } catch (err) {
      await recoverFromError(err);
      return false;
    }
  }

  // sharesQuery.data check: during a refetch the fallback [] is not "cleared"
  useEffect(() => {
    if (!confirming || sharesQuery.data === undefined || sharesQuery.data.length > 0) return;
    setConfirming(false);
    if (token) void revokeLink();
    // revokeLink/token are deliberately not in deps: this effect should fire only once on the edge "confirming + list became empty", and token flipping to null (revoke done) must not run it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirming, sharesQuery.data]);

  function pick(next: AccessLevel): void {
    if (!latched || busy) return;
    setConfirming(false);
    if (next === "public") {
      setSelection("public");
      // PUT regenerates (not idempotent): only the Regenerate button may do that.
      if (!token) void mintLink();
      return;
    }
    if (next === "members") {
      setSelection("members");
      if (token) void revokeLink();
      return;
    }
    setSelection("private");
    if (shares.length > 0) {
      setConfirming(true); // has members: act only after the inline confirmation
    } else if (token) {
      void revokeLink();
    }
  }

  async function confirmPrivate(): Promise<void> {
    setBusy(true);
    try {
      // Revoke the link before clearing members: an abort then leaves members, not an open link.
      if (token) await deleteLink.mutateAsync();
      for (const share of shares) {
        await deleteShare.mutateAsync(share.userId);
      }
      setConfirming(false);
    } catch (err) {
      await recoverFromError(err);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  const options: Array<{ value: AccessLevel; label: string; desc: string }> = [
    { value: "private", label: t("share.access.private"), desc: t("share.access.privateDesc") },
    { value: "members", label: t("share.access.members"), desc: t("share.access.membersDesc") },
    { value: "public", label: t("share.access.public"), desc: t("share.access.publicDesc") },
  ];

  return (
    <ShareGroup title={t("share.access.title")}>

      {queriesFailed && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(t, linkQuery.error ?? sharesQuery.error)}
        </p>
      )}

      <div role="radiogroup" aria-label={t("share.access.title")} aria-busy={!latched} className="space-y-1">
        {options.map((option) => (
          <label
            key={option.value}
            className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent/60"
          >
            <input
              type="radio"
              name="share-access"
              className="mt-1"
              checked={selection === option.value}
              disabled={!latched || busy}
              onChange={() => pick(option.value)}
            />
            <span className="flex flex-col">
              <span className="text-sm">{option.label}</span>
              <span className="text-xs text-muted-foreground">{option.desc}</span>
            </span>
          </label>
        ))}
      </div>

      {!latched && !queriesFailed && <p className="text-sm text-muted-foreground">{t("app.loading")}</p>}

      {confirming && shares.length > 0 && (
        <div role="alert" className="space-y-2 rounded-md border border-destructive/40 p-2">
          <p className="text-sm">
            {token
              ? t("share.access.confirmHintWithLink", { count: shares.length })
              : t("share.access.confirmHint", { count: shares.length })}
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="destructive" size="sm" disabled={busy} onClick={() => void confirmPrivate()}>
              {t("share.access.confirmPrivate", { count: shares.length })}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                // Without this the radio stays on "private" while the link is still alive.
                setConfirming(false);
                setSelection(deriveAccess(token, shares));
              }}
            >
              {t("share.access.confirmCancel")}
            </Button>
          </div>
        </div>
      )}

      {/* Context panel: each level shows only what it needs. The private state has no invite form (pick "Specific members" first), which `e2e/tests/03-share-revoke.spec.ts` accounts for. */}
      {latched && selection === "members" && (
        <div className="rounded-md bg-muted/40 p-3">
          <SharesSection noteId={note.id} title={t("share.membersPanelTitle")} />
        </div>
      )}

      {selection === "public" && token && (
        <PublicLinkPanel
          noteId={note.id}
          ownerHandle={note.ownerHandle}
          token={token}
          slug={linkQuery.data?.slug ?? null}
          width={linkQuery.data?.width ?? "standard"}
          allowAlias
          onRegenerateToken={mintLink}
          regenerateTokenPending={createLink.isPending}
        />
      )}
    </ShareGroup>
  );
}

/** No radio, so no latch (#170/#171 sticky misreports do not apply). Roles come from `note.permissions`: after a move this DTO is the server response and a create-but-not-edit role ends up a viewer. `useShares` is never issued; `usePublicLink` only when `managePublicLink`. */
function GroupNoteShareSection({ note, onClose }: { note: NoteDto; onClose: () => void }) {
  const { t } = useTranslation();
  const location = useLocation();
  const canLink = note.permissions.managePublicLink;
  const linkQuery = usePublicLink(canLink ? note.id : "");
  const createLink = useCreatePublicLink(note.id);
  const deleteLink = useDeletePublicLink(note.id);
  const token = linkQuery.data?.token ?? null;

  async function toggle(next: boolean): Promise<void> {
    try {
      if (next) await createLink.mutateAsync();
      else await deleteLink.mutateAsync();
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  async function regenerate(): Promise<boolean> {
    try {
      await createLink.mutateAsync();
      return true;
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
      return false;
    }
  }

  return (
    <ShareGroup title={t("share.access.title")}>
      <p className="text-sm">
        {t("share.groupNote.access", { name: note.group?.name ?? "" })}{" "}
        {typeof note.groupId === "string" && (
          <Link
            to={`/groups/${encodeURIComponent(note.groupId)}`}
            state={{ backgroundLocation: location }}
            onClick={onClose}
            className="text-brand underline-offset-4 hover:underline"
          >
            {t("share.group.manageLink")}
          </Link>
        )}
      </p>
      {canLink && (
        <>
          {linkQuery.isError && (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(t, linkQuery.error)}
            </p>
          )}
          <div className="flex items-center gap-2">
            <Switch
              id="share-group-public-toggle"
              checked={token !== null}
              disabled={linkQuery.data === undefined || createLink.isPending || deleteLink.isPending}
              onCheckedChange={(next) => void toggle(next)}
            />
            <label htmlFor="share-group-public-toggle" className="text-sm font-medium">
              {t("share.access.public")}
            </label>
          </div>
          <p className="text-xs text-muted-foreground">{t("share.access.publicDesc")}</p>
          {token && (
            <PublicLinkPanel
              noteId={note.id}
              ownerHandle={null}
              token={token}
              slug={null}
              width={linkQuery.data?.width ?? "standard"}
              allowAlias={false}
              onRegenerateToken={regenerate}
              regenerateTokenPending={createLink.isPending}
            />
          )}
        </>
      )}
    </ShareGroup>
  );
}

const RANDOM_SLUG_ATTEMPTS = 5;

/** Both the full URL and the displayed prefix use this constant (see the `publicAliasPath` JSDoc: no hand-spelled `"/p/"`). */
const ANONYMOUS_LINK_PREFIX = "/p/";

/** Not a security boundary: the security boundary is the server 256-bit token; this only avoids memorable names. `validateSlug` still runs after generation (no assumption the construction passes); retry then give up with null. */
function generateRandomSlugCandidate(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function generateValidatedRandomSlug(): string | null {
  for (let attempt = 0; attempt < RANDOM_SLUG_ATTEMPTS; attempt++) {
    const candidate = generateRandomSlugCandidate();
    if (validateSlug(candidate) === null) return candidate;
  }
  return null;
}

/** `anonymous` is derived from `slug` (null = ON), not separate state: a failed mutation leaves `slug` unchanged so the toggle recovers by itself. Regenerate in OFF swaps token then slug, aborting on failure: the OFF URL has no token but the token is still the only security boundary, so slug-only would leave a leaked token unrotatable. Always `mutateAsync` + catch -> `setError` (a bare `mutate` failing silently would misreport the link state). Ids `#share-public-slug-prefix`/`-hint` and the "Custom public link" / "Save custom URL" names are read by e2e 11-public-share.spec.ts. Known limitation: `value` does not follow slug changes from another tab. */
function PublicLinkPanel({
  noteId,
  ownerHandle,
  token,
  slug,
  width,
  allowAlias,
  onRegenerateToken,
  regenerateTokenPending,
}: {
  noteId: string;
  ownerHandle: string | null;
  token: string;
  slug: string | null;
  width: NoteWidth;
  allowAlias: boolean;
  onRegenerateToken: () => Promise<boolean>;
  regenerateTokenPending: boolean;
}) {
  const { t } = useTranslation();
  const setSlug = useSetPublicSlug(noteId);
  const clearSlug = useClearPublicSlug(noteId);
  const setWidth = useSetPublicWidth(noteId);
  const [pendingWidth, setPendingWidth] = useState<NoteWidth | null>(null);

  const anonymous = !allowAlias || slug === null;
  const [value, setValue] = useState(slug ?? "");
  const [error, setError] = useState<string | null>(null);

  const trimmed = value.trim();
  const normalized = trimmed.length > 0 ? normalizeSlug(trimmed) : "";
  const localReason = trimmed.length > 0 ? validateSlug(normalized) : null;
  const localError = localReason ? t(`share.slugError.${localReason}`) : null;
  const dirty = trimmed !== (slug ?? "");
  const busy = setSlug.isPending || clearSlug.isPending || setWidth.isPending || regenerateTokenPending;

  const linkUrl = anonymous
    ? `${window.location.origin}${ANONYMOUS_LINK_PREFIX}${token}`
    : `${window.location.origin}${publicAliasPath({ handle: ownerHandle ?? "", slug: slug ?? "" })}`;

  async function applyRandomSlug(): Promise<void> {
    const candidate = generateValidatedRandomSlug();
    if (candidate === null) {
      setError(t("share.publicSlug.randomSlugFailed"));
      return;
    }
    try {
      const updated = await setSlug.mutateAsync(candidate);
      setValue(updated.slug ?? candidate);
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  async function handleToggle(): Promise<void> {
    if (busy) return;
    setError(null);
    if (anonymous) {
      await applyRandomSlug();
      return;
    }
    try {
      await clearSlug.mutateAsync();
      setValue("");
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  async function handleRegenerate(): Promise<void> {
    if (busy) return;
    setError(null);
    if (anonymous) {
      await onRegenerateToken();
      return;
    }
    // Token first; on failure `mintLink` already presented the error, so abort and never swap a slug with the old token.
    const tokenRegenerated = await onRegenerateToken();
    if (!tokenRegenerated) return;
    await applyRandomSlug();
  }

  async function handleWidth(next: NoteWidth): Promise<void> {
    if (busy) return;
    setError(null);
    setPendingWidth(next);
    try {
      await setWidth.mutateAsync(next);
    } catch (err) {
      setError(errorMessage(t, err));
    } finally {
      setPendingWidth(null);
    }
  }

  async function handleSave(): Promise<void> {
    if (localError || trimmed.length === 0 || !dirty || busy) return;
    setError(null);
    try {
      const updated = await setSlug.mutateAsync(normalized);
      setValue(updated.slug ?? "");
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  return (
    <div role="group" aria-label={t("share.publicPanelTitle")} className="space-y-2 rounded-md bg-muted/40 p-3">
      <p className="text-sm font-medium">{t("share.publicPanelTitle")}</p>

      {allowAlias && (
        <>
          <div className="flex items-center gap-2">
            <Switch
              id="share-anonymous-toggle"
              checked={anonymous}
              disabled={busy}
              onCheckedChange={() => void handleToggle()}
            />
            <label htmlFor="share-anonymous-toggle" className="text-sm font-medium">
              {t("share.anonymous.label")}
            </label>
          </div>
          <p className="text-xs text-muted-foreground">{t("share.anonymous.desc")}</p>
        </>
      )}

      {/* anonymous input is read-only but still an input (selectable, no layout jump on toggle) */}
      <div className="flex items-center gap-2">
        {/* prefix comes from `publicAliasPath` (same source as the copied URL) */}
        <span id="share-public-slug-prefix" className="shrink-0 text-xs text-muted-foreground">
          {anonymous ? ANONYMOUS_LINK_PREFIX : publicAliasPath({ handle: ownerHandle ?? "", slug: "" })}
        </span>
        <Input
          id="share-public-slug"
          readOnly={anonymous}
          aria-label={anonymous ? t("share.access.publicUrlLabel") : t("share.publicSlug.label")}
          aria-describedby="share-public-slug-prefix share-public-slug-hint"
          value={anonymous ? token : value}
          disabled={!anonymous && busy}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
          className="min-w-0 flex-1 text-xs"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <PublicCopyButton url={linkUrl} />
        {/* `outline`, not `ghost`: it is a primary action, ghost has no border */}
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void handleRegenerate()}>
          {t("share.access.regenerate")}
        </Button>
        {!anonymous && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={t("share.publicSlug.saveLabel")}
            onClick={() => void handleSave()}
            disabled={!dirty || trimmed.length === 0 || localError !== null || busy}
          >
            {t("share.publicSlug.save")}
          </Button>
        )}
      </div>

      <div className="flex items-center gap-2">
        <label htmlFor="share-public-width" className="text-sm font-medium">
          {t("share.publicWidth.label")}
        </label>
        <Select
          id="share-public-width"
          variant="field"
          className="w-fit shrink-0"
          value={pendingWidth ?? width}
          disabled={busy}
          onValueChange={(value) => void handleWidth(toNoteWidth(value))}
          options={NOTE_WIDTHS.map((w) => ({ value: w, label: t(`note.width.${w}`) }))}
        />
      </div>

      {!anonymous && (
        <p id="share-public-slug-hint" className="text-xs text-muted-foreground">
          {t("share.publicSlug.hint")}
        </p>
      )}

      {localError && (
        <p role="alert" className="text-sm text-destructive">
          {localError}
        </p>
      )}
      {!localError && error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function PublicCopyButton({ url, label }: { url: string; label?: string }) {
  const { t } = useTranslation();
  const [manualUrl, setManualUrl] = useState<string | null>(null);

  async function handleCopy(): Promise<void> {
    if (await copyText(url)) {
      setManualUrl(null);
      toast({ title: t("share.linkCopied") });
      return;
    }
    setManualUrl(url);
  }

  return (
    <div className="flex flex-col gap-2">
      {/* not `secondary`: it nearly matches the panel background in light and equals `--accent` (ghost hover) in dark, so it looks like a hover highlight */}
      <Button type="button" variant="outline" size="sm" onClick={() => void handleCopy()}>
        {label ?? t("share.copyPublicLink")}
      </Button>
      {manualUrl !== null && <ManualCopyField value={manualUrl} />}
    </div>
  );
}

export interface ShareDialogProps {
  note: NoteDto;
}

/** Trigger queries (`useShares`/`usePublicLink`) fire on load so the icon can reflect state; the panel still mounts only when open and shares the same react-query cache. */
export function ShareDialog({ note }: ShareDialogProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // `typeof`, not `!== null`: an old object without `groupId` must not be a group note (same as `canonicalNotePath`).
  const isGroupNote = typeof note.groupId === "string";
  const canOpen = isGroupNote ? note.permissions.read : note.permissions.manageShares;

  // Hooks must be unconditional (rules-of-hooks): pass an empty noteId so the built-in `enabled` guard prevents fetching when the panel cannot open. Group notes never query shares; public-link only when the role can manage it (else 403). `AccessSection` latch is untouched: it tracks sticky UI state, this icon follows current data.
  const sharesQuery = useShares(canOpen && !isGroupNote ? note.id : "");
  const linkQuery = usePublicLink(canOpen && (!isGroupNote || note.permissions.managePublicLink) ? note.id : "");

  if (!canOpen) return null;

  const triggerAccess: AccessLevel | "group" | null = isGroupNote
    ? !note.permissions.managePublicLink
      ? "group"
      : linkQuery.data === undefined
        ? null
        : linkQuery.data.token
          ? "public"
          : "group"
    : sharesQuery.data === undefined || linkQuery.data === undefined
      ? null
      : deriveAccess(linkQuery.data.token, sharesQuery.data);
  const TriggerIcon =
    triggerAccess === "private" ? Lock : triggerAccess === "public" ? Globe : triggerAccess === "group" ? Users : Share;
  const triggerTitle =
    triggerAccess === "private"
      ? t("share.state.private")
      : triggerAccess === "members"
        ? t("share.state.members")
        : triggerAccess === "public"
          ? t("share.state.public")
          : triggerAccess === "group"
            ? t("share.state.group", { name: note.group?.name })
            : undefined;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {/* text-brand on the Button className (not the icon) so twMerge can drop the ghost hover text colour. State goes in `title`, not aria-label: it must stay a fixed "Share" (e2e, tests). */}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t("share.button")}
          {...tourTarget("share")}
          title={triggerTitle}
          className={cn("shrink-0 text-brand hover:text-brand", HEADER_ICON_HIT)}
        >
          <TriggerIcon className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      {/* 448px does not fit email + role + add in one row */}
      <DialogContent dismissOnOutside={false} className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("share.title")}</DialogTitle>
          {/* group notes open for readers who can manage nothing: use the group-specific text */}
          <DialogDescription>{isGroupNote ? t("share.groupNote.description") : t("share.description")}</DialogDescription>
        </DialogHeader>
        {/* key={note.id}: a different note must not inherit AccessSection's latched selection (#170); a personal/group swap remounts (different component types) */}
        {open &&
          (isGroupNote ? (
            <GroupNoteShareSection note={note} onClose={() => setOpen(false)} />
          ) : (
            <Fragment key={note.id}>
              <AccessSection note={note} />
            </Fragment>
          ))}
      </DialogContent>
    </Dialog>
  );
}
