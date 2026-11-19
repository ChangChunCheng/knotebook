import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AGENT_LABEL_RE, deriveAgentLabel, OAUTH_APP_IDLE_DAYS, type ApiTokenDto, type TokenScope } from "@knotebook/shared";
import {
  useApiTokens,
  useCreateApiToken,
  useRevokeApiToken,
  useUpdateApiToken,
  type CreateApiTokenInput,
  type UpdateApiTokenPatch,
} from "@/api/apiTokens";
import { ApiFail } from "@/api/client";
import { Pill } from "@/components/management/Pill";
import { SettingsTable, type SettingsTableColumn, type SettingsTableRow } from "@/components/management/SettingsTable";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Check, Pencil, Trash, X } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { RowIconButton } from "@/components/ui/row-icon-button";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { copyText } from "@/lib/clipboard";
import { displayExpiry } from "@/lib/token-expiry";
import { checksFromScope, scopeFromChecks, type ScopeChecks } from "@/lib/token-scope";
import { cn } from "@/lib/utils";
import { ScopeTogglesField } from "./ScopeTogglesField";
import { SettingsGroup } from "./SettingsLayout";
import "@/i18n/management-strings";

function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

function RevokeDialog({ token }: { token: ApiTokenDto }) {
  const { t } = useTranslation();
  const revoke = useRevokeApiToken();
  const [open, setOpen] = useState(false);

  async function confirm(): Promise<void> {
    try {
      await revoke.mutateAsync(token.id);
      setOpen(false);
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <RowIconButton label={t("settings.account.apiTokensRevoke")} tone="destructive" icon={<Trash className="h-4 w-4" aria-hidden="true" />} />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("settings.account.apiTokensRevokeTitle")}</DialogTitle>
          <DialogDescription>{t("settings.account.apiTokensRevokeDescription", { name: token.name })}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {t("settings.account.apiTokensCancel")}
            </Button>
          </DialogClose>
          <Button type="button" variant="destructive" disabled={revoke.isPending} onClick={() => void confirm()}>
            {t("settings.account.apiTokensRevokeConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Switches in place to the plaintext view, which is shown only this once: a toast would vanish after 5s and isn't selectable. */
function CreateTokenDialog() {
  const { t } = useTranslation();
  const create = useCreateApiToken();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [checks, setChecks] = useState<ScopeChecks>({ write: false, move: false, delete: false });
  const [expiresInDays, setExpiresInDays] = useState<CreateApiTokenInput["expiresInDays"]>(null);
  const [issued, setIssued] = useState<string | null>(null);

  function reset(): void {
    setName("");
    setChecks({ write: false, move: false, delete: false });
    setExpiresInDays(null);
    setIssued(null);
  }

  async function submit(): Promise<void> {
    try {
      const created = await create.mutateAsync({
        name: name.trim(),
        scope: scopeFromChecks(checks.write, checks.move, checks.delete),
        expiresInDays,
      });
      setIssued(created.token);
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          {t("settings.account.apiTokensCreate")}
        </Button>
      </DialogTrigger>
      <DialogContent
        dismissOnOutside={false}
        // dismissOnOutside blocks outside clicks in both views (form dialogs always do), so onPointerDownOutside is
        // redundant. The plaintext view also blocks Esc: a stray dismissal throws the token away and still uses a slot
        // of the per-user token cap (apiTokensPerUser), leaving Done and the top-right X as the only explicit closes.
        // Esc still closes the form view.
        onEscapeKeyDown={event => {
          if (issued !== null) event.preventDefault();
        }}
        onPointerDownOutside={event => {
          if (issued !== null) event.preventDefault();
        }}
      >
        {issued === null ? (
          <form
            onSubmit={event => {
              event.preventDefault();
              void submit();
            }}
          >
            <DialogHeader>
              <DialogTitle>{t("settings.account.apiTokensCreate")}</DialogTitle>
              {/* short dedicated hint: the long section text would appear twice on the page (getByText would match twice, and it reads verbosely) */}
              <DialogDescription>{t("settings.account.apiTokensCreateHint")}</DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-3">
              <Input
                value={name}
                aria-label={t("settings.account.apiTokensNameLabel")}
                placeholder={t("settings.account.apiTokensNamePlaceholder")}
                maxLength={64}
                onChange={event => setName(event.target.value)}
              />
              <fieldset aria-label={t("settings.account.apiTokensScopeLabel")} className="space-y-2">
                <p className="text-sm">{t("settings.account.apiTokensScopeReadFixed")}</p>
                <ScopeTogglesField value={checks} onChange={setChecks} />
              </fieldset>
              <Select
                variant="field"
                className="w-fit"
                aria-label={t("settings.account.apiTokensExpiryLabel")}
                value={expiresInDays === null ? "never" : String(expiresInDays)}
                onValueChange={next => setExpiresInDays(next === "never" ? null : (Number(next) as 30 | 90 | 365))}
                options={[
                  { value: "never", label: t("settings.account.apiTokensExpiryNever") },
                  ...[30, 90, 365].map(days => ({
                    value: String(days),
                    label: t("settings.account.apiTokensExpiryDays", { days }),
                  })),
                ]}
              />
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  {t("settings.account.apiTokensCancel")}
                </Button>
              </DialogClose>
              <Button type="submit" variant="brandDeep" disabled={create.isPending || name.trim() === ""}>
                {t("settings.account.apiTokensSubmit")}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t("settings.account.apiTokensTitle")}</DialogTitle>
              <DialogDescription>{t("settings.account.apiTokensOnceWarning")}</DialogDescription>
            </DialogHeader>
            {/* plaintext stays selectable: no reliance on a toast (gone in 5s, not selectable) or on the clipboard API succeeding. Not ManualCopyField: its built-in "copy failed, select manually" text (share.copyFailed) is wrong here, and its own DialogDescription would put two in one DialogContent, duplicating Radix's aria-describedby */}
            <Input
              readOnly
              value={issued}
              aria-label={t("settings.account.apiTokensValueLabel")}
              className="font-mono"
              autoFocus
              onFocus={event => event.currentTarget.select()}
            />
            <DialogFooter>
              <Button
                type="button"
                // not `secondary`: `--secondary` is oklch(0.97) in light mode, nearly the panel background, and in
                // dark mode equals `--accent` (ghost's hover background), so it looks like a hover highlight, not a button.
                variant="outline"
                onClick={() => {
                  void copyText(issued).then(ok => {
                    // No ManualCopyField on failure (see above): the plaintext is already selectable in the field.
                    toast(
                      ok
                        ? { title: t("settings.account.apiTokensCopied") }
                        : { title: t("settings.account.apiTokensCopyFailed"), variant: "destructive" }
                    );
                  });
                }}
              >
                {t("settings.account.apiTokensCopy")}
              </Button>
              <DialogClose asChild>
                <Button type="button" variant="brandDeep">{t("settings.account.apiTokensDone")}</Button>
              </DialogClose>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Move gets the destructive tint; delete keeps the default tone because deleted notes can be restored. */
function TokenScopePills({ scope }: { scope: TokenScope }) {
  const { t } = useTranslation();
  const checks = checksFromScope(scope);
  return (
    <div className="flex flex-wrap gap-1">
      <Pill>{t("settings.authorization.tokens.pillRead")}</Pill>
      {checks.write && <Pill>{t("settings.authorization.tokens.pillEdit")}</Pill>}
      {checks.move && <Pill tone="destructive">{t("settings.authorization.tokens.pillMove")}</Pill>}
      {checks.delete && <Pill>{t("settings.authorization.tokens.pillDelete")}</Pill>}
    </div>
  );
}

/** Pure: called inside a map, so no hooks. */
function tokenDates(token: ApiTokenDto, t: (key: string, opts?: Record<string, unknown>) => string, language: string) {
  const formatDate = (iso: string): string => new Date(iso).toLocaleDateString(language);
  const expiresAt = displayExpiry(token, OAUTH_APP_IDLE_DAYS);
  const expired = expiresAt !== null && new Date(expiresAt).getTime() <= Date.now();
  const lastUsed = token.lastUsedAt === null ? t("settings.account.apiTokensNeverUsed") : formatDate(token.lastUsedAt);
  const expires =
    expiresAt === null
      ? t("settings.account.apiTokensNoExpiry")
      : expired
        ? t("settings.account.apiTokensExpired")
        : formatDate(expiresAt);
  return { lastUsed, expires, expired, created: t("settings.account.apiTokensCreated", { when: formatDate(token.createdAt) }) };
}

/**
 * No Esc-to-cancel: Radix listens for Escape on document in the capture phase, so the input's bubble-phase
 * `onKeyDown` is always too late and Esc closes the whole settings panel. The cancel button is the only way out.
 * An emptied label is sent as `null` (back to the derived value); `AGENT_LABEL_RE` rejects empty strings.
 */
function TokenEditForm({ token, onDone }: { token: ApiTokenDto; onDone: () => void }) {
  const { t } = useTranslation();
  const update = useUpdateApiToken();
  const derivedLabel = deriveAgentLabel(token.name);
  const [label, setLabel] = useState(token.agentLabel);
  const [checks, setChecks] = useState<ScopeChecks>(() => checksFromScope(token.scope));
  const [error, setError] = useState<string | null>(null);

  async function save(): Promise<void> {
    // One request per row: the input and both buttons are disabled while pending; guard again for repeated Enter.
    if (update.isPending) return;
    const trimmed = label.trim();
    const nextLabel = trimmed === "" ? null : trimmed;
    if (nextLabel !== null && !AGENT_LABEL_RE.test(nextLabel)) {
      setError(t("settings.authorization.tokens.labelInvalid"));
      return;
    }
    const patch: UpdateApiTokenPatch = {};
    // `null` is needed only when the current label is an override (differs from the derived one).
    const labelChanged = nextLabel === null ? token.agentLabel !== derivedLabel : nextLabel !== token.agentLabel;
    if (labelChanged) patch.agentLabel = nextLabel;
    const scope = scopeFromChecks(checks.write, checks.move, checks.delete);
    if (scope !== token.scope) patch.scope = scope;
    if (Object.keys(patch).length === 0) {
      onDone();
      return;
    }
    setError(null);
    try {
      await update.mutateAsync({ id: token.id, patch });
      onDone();
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  return (
    <div className="flex flex-wrap items-start gap-3">
      <div className="min-w-[14ch] flex-1 space-y-1">
        <Input
          autoFocus
          value={label}
          aria-label={t("settings.authorization.tokens.label")}
          maxLength={32}
          disabled={update.isPending}
          onFocus={event => event.currentTarget.select()}
          onChange={event => setLabel(event.target.value)}
          onKeyDown={event => {
            if (event.key === "Enter") void save();
          }}
        />
        <p className="text-xs text-muted-foreground">{t("settings.authorization.tokens.editHint", { derived: derivedLabel })}</p>
        {error !== null && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
      <ScopeTogglesField value={checks} onChange={setChecks} disabled={update.isPending} />
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <RowIconButton
          label={t("settings.authorization.tokens.save")}
          icon={<Check className="h-4 w-4" aria-hidden="true" />}
          disabled={update.isPending}
          onClick={() => void save()}
        />
        <RowIconButton
          label={t("settings.account.apiTokensCancel")}
          icon={<X className="h-4 w-4" aria-hidden="true" />}
          disabled={update.isPending}
          onClick={onDone}
        />
      </div>
    </div>
  );
}

export function ApiTokensSection() {
  const { t, i18n } = useTranslation();
  const tokens = useApiTokens();
  const [editingIdState, setEditingId] = useState<string | null>(null);
  // Derived rather than an effect: if the edited row vanished (revoked in another tab), treat it as not editing, or other rows' pencils stay disabled forever.
  const editingId =
    editingIdState !== null && tokens.data?.some(token => token.id === editingIdState) === true ? editingIdState : null;

  const columns: SettingsTableColumn[] = [
    { id: "name", header: t("settings.authorization.tokens.name"), kind: "primary" },
    { id: "label", header: t("settings.authorization.tokens.label"), kind: "text" },
    { id: "permissions", header: t("settings.authorization.tokens.permissions"), kind: "text" },
    { id: "lastUsed", header: t("settings.authorization.tokens.lastUsed"), kind: "fixed" },
    { id: "expires", header: t("settings.authorization.tokens.expires"), kind: "fixed" },
    { id: "actions", header: t("settings.authorization.tokens.actions"), kind: "actions", buttons: 2 },
  ];
  const rows: SettingsTableRow[] = (tokens.data ?? []).map(token => {
    const dates = tokenDates(token, t, i18n.language);
    // Grey means the label shown is derived from the name. Accepted false positive: a manual label equal to the
    // derived one also renders grey, which looks the same to others.
    const derived = token.agentLabel === deriveAgentLabel(token.name);
    return {
      id: token.id,
      primary: {
        // External string (OAuth rows are client-supplied); SettingsTable bidi-isolates it, and OAuth rows are also marked unverified.
        name: token.name,
        weight: "medium",
        badges: (
          <span className="shrink-0 rounded border border-border px-1 text-xs text-muted-foreground">
            {token.kind === "oauth" ? t("settings.account.apiTokensKindOauth") : t("settings.account.apiTokensKindPat")}
          </span>
        ),
        subtitles: token.kind === "oauth" ? [dates.created, t("settings.account.apiTokensUnverifiedName")] : [dates.created],
      },
      cells: {
        label: (
          <span dir="ltr" className={cn("[unicode-bidi:isolate]", derived && "text-muted-foreground")}>
            {token.agentLabel}
          </span>
        ),
        permissions: <TokenScopePills scope={token.scope} />,
        lastUsed: { content: dates.lastUsed, tone: "muted" },
        expires: { content: dates.expires, tone: dates.expired ? "danger" : "muted" },
      },
      actions: (
        <>
          <RowIconButton
            label={t("settings.authorization.tokens.edit")}
            icon={<Pencil className="h-4 w-4" aria-hidden="true" />}
            softDisabled={editingId !== null}
            softDisabledReason={t("settings.authorization.tokens.editLocked")}
            onClick={() => setEditingId(token.id)}
          />
          <RevokeDialog token={token} />
        </>
      ),
      editing: token.id === editingId ? <TokenEditForm token={token} onDone={() => setEditingId(null)} /> : undefined,
    };
  });

  return (
    <SettingsGroup
      title={t("settings.account.apiTokensTitle")}
      description={t("settings.account.apiTokensDescription")}
      // In the header row rather than under the list, so it's clear the button creates a token.
      action={<CreateTokenDialog />}
    >
      <div className="space-y-2">
        {tokens.isError && (
          <p role="alert" className="text-sm text-destructive">
            {t("errors.fallback")}
          </p>
        )}
        {tokens.data !== undefined && (
          <SettingsTable label={t("settings.account.apiTokensTitle")} columns={columns} rows={rows} empty={t("settings.account.apiTokensEmpty")} />
        )}
        {/* footnotes: only useful after seeing one's own tokens */}
        <p className="pt-1 text-xs text-muted-foreground">{t("settings.authorization.tokens.footnote")}</p>
        <p className="text-xs text-muted-foreground">{t("settings.authorization.tokens.oauthExpiryNote", { days: OAUTH_APP_IDLE_DAYS })}</p>
        <p className="text-xs text-muted-foreground">{t("settings.account.apiTokensCleanupHint")}</p>
      </div>
    </SettingsGroup>
  );
}
