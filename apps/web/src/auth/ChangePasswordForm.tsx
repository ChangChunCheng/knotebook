import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { MIN_PASSWORD_LENGTH } from "@knotebook/shared";
import { api, ApiFail } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SESSION_QUERY_KEY } from "@/auth/useSession";

export interface ChangePasswordFormProps {
  /** Navigation is up to the caller: navigating away from the settings modal would close it and tear down the background note's collab provider. */
  onSuccess: () => void;
  tone?: "page" | "outline";
}

/**
 * The length check is UX only; the server validates again. On success the server re-issues the session cookie with
 * the new tokenVersion, so changing the password doesn't log this user out.
 */
export function ChangePasswordForm({ onSuccess, tone = "page" }: ChangePasswordFormProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrorMessage(null);

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setErrorMessage(t("errors.password_too_short"));
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setErrorMessage(t("changePassword.mismatch"));
      return;
    }

    setSubmitting(true);
    try {
      await api<void>("/api/auth/password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      // Await the refetch so a navigating caller already sees mustChangePassword:false (else ChangePasswordGate bounces back).
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      // In the settings modal the form stays mounted; don't leave the passwords in state.
      setCurrentPassword("");
      setNewPassword("");
      setConfirmNewPassword("");
      onSuccess();
      return;
    } catch (err) {
      if (err instanceof ApiFail) {
        setErrorMessage(t(`errors.${err.code}`, { defaultValue: t("errors.fallback") }));
      } else {
        setErrorMessage(t("errors.fallback"));
      }
    } finally {
      setSubmitting(false);
    }
  }

  const fieldClass = tone === "page" ? "h-11" : undefined;

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
      <div className="space-y-1">
        <label htmlFor="change-password-current" className="text-sm font-medium">
          {t("changePassword.currentPassword")}
        </label>
        <Input
          id="change-password-current"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          className={fieldClass}
          required
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="change-password-new" className="text-sm font-medium">
          {t("changePassword.newPassword")}
        </label>
        <Input
          id="change-password-new"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          className={fieldClass}
          required
          minLength={MIN_PASSWORD_LENGTH}
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">{t("changePassword.passwordHint", { min: MIN_PASSWORD_LENGTH })}</p>
      </div>

      <div className="space-y-1">
        <label htmlFor="change-password-confirm" className="text-sm font-medium">
          {t("changePassword.confirmNewPassword")}
        </label>
        <Input
          id="change-password-confirm"
          name="confirmNewPassword"
          type="password"
          autoComplete="new-password"
          className={fieldClass}
          required
          minLength={MIN_PASSWORD_LENGTH}
          value={confirmNewPassword}
          onChange={(e) => setConfirmNewPassword(e.target.value)}
        />
      </div>

      {errorMessage && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage}
        </p>
      )}

      <Button
        type="submit"
        variant={tone === "outline" ? "outline" : "brandSolid"}
        size={tone === "page" ? "lg" : "default"}
        className={tone === "page" ? "w-full" : undefined}
        disabled={submitting}
      >
        {submitting ? t("changePassword.submitting") : t("changePassword.submit")}
      </Button>
    </form>
  );
}
