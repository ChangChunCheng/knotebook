import { useTranslation } from "react-i18next";
import { useIdentities } from "@/api/account";
import { ChangePasswordForm } from "@/auth/ChangePasswordForm";
import { useSession } from "@/auth/useSession";
import { toast } from "@/components/ui/toast";
import { SetPasswordForm } from "./SetPasswordForm";
import { SettingsGroup, SettingsPage } from "./SettingsLayout";
import { SignInMethodsSection } from "./SignInMethodsSection";
import "@/i18n/management-strings";

/**
 * Must stay on this page: the server's OIDC link return always redirects here and `SignInMethodsSection` reads
 * `?linked=`/`?link_error=`; moved elsewhere, the toast is lost (the AppRoutes case in `SignInMethodsSection.test.tsx`
 * guards this). `hasPassword === false` is explicit so an unready query (undefined) falls into the change-password branch
 * instead of flashing the set-password form; `passwordLoginEnabled` defaults on via `!== false`. A successful password
 * change only toasts: `navigate("/")` would close the modal and tear down the background note's collaboration. Both forms
 * sit in `max-w-sm`: the panel's right card is wide and full-width inputs read poorly.
 */
export function SettingsLoginSection() {
  const { t } = useTranslation();
  const { user } = useSession();
  const identities = useIdentities();
  const passwordLoginEnabled = identities.data?.passwordLoginEnabled !== false;

  return (
    <SettingsPage title={t("settings.nav.login")} description={t("settings.login.description")}>
      <SignInMethodsSection />
      {user?.hasPassword === false ? (
        passwordLoginEnabled ? (
          <SettingsGroup title={t("settings.account.setPassword.title")} description={t("settings.account.setPassword.description")}>
            <div className="max-w-sm">
              <SetPasswordForm onSuccess={() => toast({ title: t("settings.account.setPassword.success") })} />
            </div>
          </SettingsGroup>
        ) : (
          <SettingsGroup>
            <p className="text-sm text-muted-foreground">{t("settings.account.setPassword.ssoOnlyNotice")}</p>
          </SettingsGroup>
        )
      ) : (
        <SettingsGroup title={t("changePassword.title")} description={t("changePassword.description")}>
          {!passwordLoginEnabled && <p className="mb-3 text-sm text-muted-foreground">{t("settings.account.passwordLoginOffNote")}</p>}
          <div className="max-w-sm">
            {/* outline: the panel card has no solid button; the /change-password page keeps the default. */}
            <ChangePasswordForm tone="outline" onSuccess={() => toast({ title: t("changePassword.successMessage") })} />
          </div>
        </SettingsGroup>
      )}
    </SettingsPage>
  );
}
