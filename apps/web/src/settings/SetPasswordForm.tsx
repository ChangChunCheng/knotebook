import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { MIN_PASSWORD_LENGTH } from "@knotebook/shared";
import { useSetPassword } from "@/api/account";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authErrorMessage } from "./auth-error-message";
import "@/i18n/management-strings";

/** Length and confirmation are checked on the client first; the server validates again. `outline` submit: the settings panel card has no solid button. */
export function SetPasswordForm({ onSuccess }: { onSuccess: () => void }) {
  const { t } = useTranslation();
  const setPassword = useSetPassword();
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    if (newPassword.length < MIN_PASSWORD_LENGTH) return setError(t("errors.password_too_short"));
    if (newPassword !== confirm) return setError(t("changePassword.mismatch"));
    try {
      await setPassword.mutateAsync(newPassword);
      setNewPassword("");
      setConfirm("");
      onSuccess();
    } catch (err) {
      setError(authErrorMessage(t, err));
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
      <div className="space-y-1">
        <label htmlFor="set-password-new" className="text-sm font-medium">{t("settings.account.setPassword.newPassword")}</label>
        <Input id="set-password-new" type="password" autoComplete="new-password" required value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
        <p className="text-xs text-muted-foreground">{t("changePassword.passwordHint", { min: MIN_PASSWORD_LENGTH })}</p>
      </div>
      <div className="space-y-1">
        <label htmlFor="set-password-confirm" className="text-sm font-medium">{t("settings.account.setPassword.confirm")}</label>
        <Input id="set-password-confirm" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </div>
      {error !== null && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button type="submit" variant="outline" disabled={setPassword.isPending}>
        {setPassword.isPending ? t("settings.account.setPassword.submitting") : t("settings.account.setPassword.submit")}
      </Button>
    </form>
  );
}
