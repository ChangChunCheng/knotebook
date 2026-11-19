import { SAFE_PAGE_PADDING } from "@/components/ui/safe-area";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { useAuthConfig } from "@/api/authConfig";
import { useSession } from "@/auth/useSession";
import { ChangePasswordForm } from "@/auth/ChangePasswordForm";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";

/**
 * Navigates to "/" after success and lets `ChangePasswordGate` pass once `mustChangePassword` is false; the page doesn't decide whether to
 * skip the gate.
 * The success toast doesn't ask to sign in again because there is no logout (the server re-issues the session; see `ChangePasswordForm`).
 */
export default function ChangePasswordPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { logout } = useSession();
  const authConfig = useAuthConfig();

  function handleSuccess(): void {
    toast({ title: t("changePassword.successMessage") });
    navigate("/", { replace: true });
  }

  /**
   * Without a way out, a user who forgot the current password is stuck: the gate blocks every other protected route and `/login` doesn't
   * clear the cookie, so it redirects back while the session is valid. Same logout as `UserMenu.handleLogout`, then `/login` to sign in
   * normally or ask an admin to reset the account.
   */
  async function handleLogout(): Promise<void> {
    await logout();
    navigate("/login", { replace: true });
  }

  return (
    <main className={`flex min-h-screen items-center justify-center ${SAFE_PAGE_PADDING}`}>
      <div className="w-full max-w-sm space-y-4">
        <div className="flex justify-end">
          <Button type="button" variant="ghost" size="lg" onClick={() => void handleLogout()}>
            {t("userMenu.logout")}
          </Button>
        </div>

        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">{t("changePassword.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("changePassword.description")}</p>
        </div>

        {authConfig.data?.passwordLogin.enabled === false && (
          // While password login is off, must_change_password still applies and only changing the password clears it: the note says this
          // password is unusable for now, but the temporary one must still be replaced.
          <p className="text-sm text-muted-foreground">{t("changePassword.ssoOnlyNote")}</p>
        )}

        <ChangePasswordForm onSuccess={handleSuccess} />
      </div>
    </main>
  );
}
