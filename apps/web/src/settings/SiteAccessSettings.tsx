import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAdminAuthSettings, usePatchAdminAuthSettings, type PatchAdminAuthSettingsBody } from "@/api/adminAuth";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { authErrorMessage } from "./auth-error-message";
import { SettingsGroup } from "./SettingsLayout";
import "@/i18n/management-strings";

/**
 * Switches are controlled by the server value: on a 409 (either self-lockout guard code) the value is unchanged, so
 * the switch stays put and only a toast shows. Turning password login off goes through a confirm dialog (showing
 * usersWithoutSso); turning it on always sends at once (the server always allows it). The two "can't turn off"
 * reasons (no enabled provider, no usable SSO for yourself) disable it up front with visible text plus
 * aria-describedby, as a preview only; the PATCH is authoritative. Registration only governs password signup but
 * stays toggleable while password login is effectively off, with visible text plus aria-describedby saying it has
 * no effect, so admins can turn it off before temporarily enabling password login.
 */
export function SiteAccessSettings() {
  const { t } = useTranslation();
  const settings = useAdminAuthSettings();
  const patch = usePatchAdminAuthSettings();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const reasonId = useId();
  const noEffectId = useId();

  async function save(body: PatchAdminAuthSettingsBody): Promise<boolean> {
    try {
      await patch.mutateAsync(body);
      return true;
    } catch (err) {
      toast({ title: authErrorMessage(t, err), variant: "destructive" });
      return false;
    }
  }

  // The count in the confirm dialog must be current at open (per the shared DTO's JSDoc): refetch, showing the cached snapshot meanwhile.
  function openConfirm(): void {
    void settings.refetch();
    setConfirmOpen(true);
  }

  if (settings.isPending) {
    return (
      <SettingsGroup title={t("admin.auth.access.title")}>
        <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
      </SettingsGroup>
    );
  }
  // Only when there is no data: a failed refetch with cached data must not tear down the switches and an open confirm dialog.
  if (settings.data === undefined) {
    return (
      <SettingsGroup title={t("admin.auth.access.title")}>
        <p role="alert" className="text-sm text-destructive">{authErrorMessage(t, settings.error)}</p>
      </SettingsGroup>
    );
  }
  const s = settings.data;
  const passwordEffectiveOff = !(s.passwordLoginEnabled || s.passwordLoginForced);
  const turnOffBlockedReason = !s.passwordLoginEnabled
    ? null
    : s.passwordLoginImpact.enabledProviders === 0
      ? t("admin.auth.access.needProvider")
      : !s.passwordLoginImpact.actingAdminHasSso
        ? t("admin.auth.access.needAdminLink")
        : null;

  return (
    <SettingsGroup title={t("admin.auth.access.title")}>
      <div className="space-y-4">
        {s.passwordLoginForced && (
          <p role="status" className="text-sm text-destructive">{t("admin.auth.access.forced")}</p>
        )}
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Switch
              id="site-password-login"
              checked={s.passwordLoginEnabled}
              onCheckedChange={checked => (checked ? void save({ passwordLoginEnabled: true }) : openConfirm())}
              disabled={patch.isPending || turnOffBlockedReason !== null}
              aria-describedby={turnOffBlockedReason !== null ? reasonId : undefined}
            />
            <label htmlFor="site-password-login" className="text-sm font-medium">{t("admin.auth.access.passwordLogin")}</label>
          </div>
          <p className="text-xs text-muted-foreground">{t("admin.auth.access.passwordLoginHelp")}</p>
          {turnOffBlockedReason !== null && (
            <p id={reasonId} className="text-xs text-muted-foreground">{turnOffBlockedReason}</p>
          )}
        </div>
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Switch
              id="site-registration"
              checked={s.registrationEnabled}
              onCheckedChange={checked => void save({ registrationEnabled: checked })}
              disabled={patch.isPending}
              aria-describedby={passwordEffectiveOff ? noEffectId : undefined}
            />
            <label htmlFor="site-registration" className="text-sm font-medium">{t("admin.auth.access.registration")}</label>
          </div>
          <p className="text-xs text-muted-foreground">{t("admin.auth.access.registrationHelp")}</p>
          {passwordEffectiveOff && (
            <p id={noEffectId} className="text-xs text-muted-foreground">{t("admin.auth.access.registrationNoEffect")}</p>
          )}
        </div>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("admin.auth.access.confirmTitle")}</DialogTitle>
            <DialogDescription>{t("admin.auth.access.passwordLoginHelp")}</DialogDescription>
          </DialogHeader>
          <p className="text-sm">{t("admin.auth.access.usersWithoutSso", { number: s.passwordLoginImpact.usersWithoutSso })}</p>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">{t("admin.auth.cancel")}</Button>
            </DialogClose>
            <Button
              type="button"
              variant="brandDeep"
              disabled={patch.isPending}
              onClick={() => void save({ passwordLoginEnabled: false }).then(() => setConfirmOpen(false))}
            >
              {t("admin.auth.access.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsGroup>
  );
}
