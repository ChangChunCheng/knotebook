import { useEffect, useId, useState } from "react";
import { useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import type { IdentityDto, ProviderIconDto } from "@knotebook/shared";
import { useIdentities, useStartLink, useUnlinkIdentity } from "@/api/account";
import { SettingsTable, type SettingsTableColumn, type SettingsTableRow } from "@/components/management/SettingsTable";
import { Button } from "@/components/ui/button";
import { Trash } from "@/components/ui/icons";
import { RowIconButton } from "@/components/ui/row-icon-button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import i18n from "@/i18n";
import { authErrorMessage } from "./auth-error-message";
import { SettingsGroup } from "./SettingsLayout";
import { ProviderIcon } from "@/components/ProviderIcon";
import "@/i18n/management-strings";

/**
 * Allowlist for `?link_error=` (#187) plus the two codes `failLocation` emits after the cookie decodes (`oidc_state_mismatch`,
 * `oidc_claim_too_long`, as on `/link-account`). Anything else falls back (an arbitrary query must never reach i18next).
 */
const LINK_ERROR_CODES = new Set<string>([
  "identity_taken", "identity_already_linked", "oidc_link_session_mismatch", "account_disabled",
  "oidc_exchange_failed", "oidc_unavailable", "oidc_state_mismatch", "oidc_claim_too_long",
]);

function issuerHost(issuer: string): string {
  try {
    return new URL(issuer).host;
  } catch {
    return issuer;
  }
}

/** Rows labelled by host (provider deleted or disabled) always use the generic icon. */
const HOST_ROW_ICON: ProviderIconDto = { type: "builtin", name: "generic" };

/** When unlinking is disallowed: `softDisabled` with a reason, and `aria-describedby` points at the same visible reason in the subtitle (`hintId`). */
function UnlinkButton({ identity, names, hintId }: { identity: IdentityDto; names: string; hintId: string }) {
  const { t } = useTranslation();
  const unlink = useUnlinkIdentity();
  const [open, setOpen] = useState(false);

  async function handleConfirm(): Promise<void> {
    try {
      await unlink.mutateAsync(identity.id);
      setOpen(false);
    } catch (err) {
      toast({ title: authErrorMessage(t, err), variant: "destructive" });
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <RowIconButton
          label={t("settings.account.signInMethods.unlink")}
          tone="destructive"
          icon={<Trash className="h-4 w-4" aria-hidden="true" />}
          softDisabled={!identity.unlinkable}
          softDisabledReason={t("settings.account.signInMethods.lastMethodHint")}
          aria-describedby={identity.unlinkable ? undefined : hintId}
        />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("settings.account.signInMethods.unlinkTitle")}</DialogTitle>
          <DialogDescription>{t("settings.account.signInMethods.unlinkDescription")}</DialogDescription>
        </DialogHeader>
        <p className="text-sm font-medium">{names}</p>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">{t("settings.account.signInMethods.cancel")}</Button>
          </DialogClose>
          <Button type="button" variant="destructive" onClick={() => void handleConfirm()} disabled={unlink.isPending}>
            {t("settings.account.signInMethods.unlink")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Whether unlinking is allowed comes from the server's `unlinkable`; the web side doesn't infer it. */
export function SignInMethodsSection() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const identities = useIdentities();
  const startLink = useStartLink();
  const baseId = useId();

  useEffect(() => {
    const linked = searchParams.get("linked");
    const linkError = searchParams.get("link_error");
    if (linked === null && linkError === null) return;
    if (linked !== null) toast({ title: t("settings.account.signInMethods.linked") });
    if (linkError !== null) {
      const code = LINK_ERROR_CODES.has(linkError) ? linkError : "fallback";
      toast({ title: t(`errors.${code}`, { defaultValue: t("errors.fallback") }), variant: "destructive" });
    }
    // Delete only these two one-shot keys; leave other params untouched.
    const params = new URLSearchParams(searchParams);
    params.delete("linked");
    params.delete("link_error");
    setSearchParams(params, { replace: true });
    // Handled once at mount (same as LoginPage's `?error=`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleLink(providerId: string): Promise<void> {
    try {
      const { url } = await startLink.mutateAsync(providerId);
      window.location.assign(url);
    } catch (err) {
      toast({ title: authErrorMessage(t, err), variant: "destructive" });
    }
  }

  const formatDate = (iso: string): string => new Date(iso).toLocaleDateString(i18n.language);
  const columns: SettingsTableColumn[] = [
    { id: "service", header: t("settings.account.signInMethods.tableService"), kind: "primary" },
    { id: "linkedOn", header: t("settings.account.signInMethods.tableLinkedOn"), kind: "fixed" },
    { id: "lastUsed", header: t("settings.account.signInMethods.tableLastUsed"), kind: "fixed" },
    { id: "actions", header: t("settings.account.signInMethods.tableActions"), kind: "actions", buttons: 1 },
  ];
  const rows: SettingsTableRow[] = (identities.data?.identities ?? []).map(identity => {
    const hintId = `${baseId}-${identity.id}-hint`;
    // The provider display name is admin input: text node only, never an i18n interpolation parameter. With no matching active
    // provider, show the issuer host.
    const names = identity.providers.length > 0 ? identity.providers.map(p => p.displayName).join(" / ") : issuerHost(identity.issuer);
    // With several, take the first: the server already sorts by (sort_order, created_at, id) (apps/server/src/auth/sign-in-methods.ts).
    // Don't write `identity.providers[0]?.icon ?? HOST_ROW_ICON`: `??` would turn "no icon" (null) into the generic icon.
    const first = identity.providers[0];
    const rowIcon = first === undefined ? HOST_ROW_ICON : first.icon;
    const subtitles = [
      ...(!identity.unlinkable ? [<span id={hintId}>{t("settings.account.signInMethods.lastMethodHint")}</span>] : []),
      ...(identity.providers.length === 0 ? [t("settings.account.signInMethods.unknownProvider")] : []),
    ];
    return {
      id: identity.id,
      primary: { name: names, weight: "medium", icon: <ProviderIcon icon={rowIcon} />, subtitles },
      cells: {
        linkedOn: formatDate(identity.createdAt),
        lastUsed: identity.lastLoginAt === null ? t("settings.account.signInMethods.neverUsed") : formatDate(identity.lastLoginAt),
      },
      actions: <UnlinkButton identity={identity} names={names} hintId={hintId} />,
    };
  });

  return (
    <SettingsGroup title={t("settings.account.signInMethods.title")} description={t("settings.account.signInMethods.description")}>
      {identities.isPending ? (
        <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
      ) : identities.data === undefined ? (
        <p role="alert" className="text-sm text-destructive">{authErrorMessage(t, identities.error)}</p>
      ) : (
        <div className="space-y-3">
          <SettingsTable
            label={t("settings.account.signInMethods.title")}
            columns={columns}
            rows={rows}
            empty={t("settings.account.signInMethods.empty")}
          />
          {identities.data.linkable.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {identities.data.linkable.map(p => (
                <Button key={p.providerId} type="button" variant="outline" size="sm" onClick={() => void handleLink(p.providerId)} disabled={startLink.isPending}>
                  <ProviderIcon icon={p.icon} />{t("settings.account.signInMethods.link")} {p.displayName}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}
    </SettingsGroup>
  );
}
