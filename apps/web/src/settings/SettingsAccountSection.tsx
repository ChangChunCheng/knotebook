import { useState } from "react";
import { useTranslation } from "react-i18next";
import { MAX_REGISTER_DISPLAY_NAME_LENGTH, normalizeHandle, validateHandle } from "@knotebook/shared";
import { useUpdateDisplayName, useUpdateHandle } from "@/api/profile";
import { ApiFail } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { useSession } from "@/auth/useSession";
import { AvatarSection } from "./AvatarSection";
import { SettingsGroup, SettingsPage } from "./SettingsLayout";
import "@/i18n/management-strings";

function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) {
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

/**
 * Display name (#247): the name others see in the share panel, version history and group member list; separate from the URL name.
 * The client only rejects blank-after-trim and over 100 code points (`[...s].length`, not `.length`: an emoji is two UTF-16 units);
 * anything else (NUL, lone surrogates) is left to the server's 400.
 */
function DisplayNameSection() {
  const { t } = useTranslation();
  const { user } = useSession();
  const update = useUpdateDisplayName();
  const [value, setValue] = useState<string | null>(null); // null = not edited; shows the current value
  const [error, setError] = useState<string | null>(null);

  const current = user?.displayName ?? "";
  const shown = value ?? current;
  const trimmed = shown.trim();

  async function save(): Promise<void> {
    if (trimmed === "" || [...trimmed].length > MAX_REGISTER_DISPLAY_NAME_LENGTH) {
      setError(t("settings.account.displayName.invalid"));
      return;
    }
    setError(null);
    try {
      await update.mutateAsync({ displayName: trimmed });
      setValue(null);
      toast({ title: t("settings.account.displayName.saved") });
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  return (
    <SettingsGroup title={t("settings.account.displayName.title")} description={t("settings.account.displayName.description")}>
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Input
          value={shown}
          aria-label={t("settings.account.displayName.label")}
          onChange={(event) => setValue(event.target.value)}
          className="max-w-xs"
        />
        <Button type="submit" variant="outline" disabled={update.isPending || trimmed === "" || trimmed === current}>
          {t("settings.account.displayName.save")}
        </Button>
      </form>
      {error !== null && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </SettingsGroup>
  );
}

/**
 * Rendered for both password and SSO-only accounts: SSO handles derive from preferred_username, so those users are the most likely to want a
 * rename. The client normalizes and validates first (an invalid format shows inline without an API call), but the server stays authoritative (409 `handle_taken`, 429 quota). The warning text deliberately mentions both `/n/` and `/p/` URL shapes.
 * `useUpdateHandle`'s onSuccess sets the session query data, then invalidates everything (see `api/profile.ts`).
 */
function HandleSection() {
  const { t } = useTranslation();
  const { user } = useSession();
  const updateHandle = useUpdateHandle();
  const [value, setValue] = useState<string | null>(null); // null = not edited; shows the current value
  const [error, setError] = useState<string | null>(null);

  const current = user?.handle ?? "";
  const shown = value ?? current;

  async function save(): Promise<void> {
    const normalized = normalizeHandle(shown.trim());
    if (validateHandle(normalized) !== null) {
      setError(t("settings.account.handleInvalid"));
      return;
    }
    setError(null);
    try {
      await updateHandle.mutateAsync({ handle: normalized });
      setValue(null); // onSuccess already wrote the new session, so current is the new value (no refetch)
      toast({ title: t("settings.account.handleSaved") });
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  return (
    <SettingsGroup
      title={t("settings.account.handleTitle")}
      description={t("settings.account.handleDescription")}
    >
      {/* form + type=submit: users always press Enter in a single-field form (same as ShareDialog/ChangePasswordForm) */}
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Input
          value={shown}
          aria-label={t("settings.account.handleLabel")}
          onChange={(event) => setValue(event.target.value)}
          className="max-w-xs"
        />
        <Button
          type="submit"
          variant="outline"
          disabled={updateHandle.isPending || shown.trim() === "" || normalizeHandle(shown.trim()) === current}
        >
          {t("settings.account.handleSave")}
        </Button>
      </form>
      {error !== null && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </SettingsGroup>
  );
}

export function SettingsAccountSection() {
  const { t } = useTranslation();
  return (
    <SettingsPage title={t("settings.nav.account")} description={t("settings.account.description")}>
      <AvatarSection />
      <DisplayNameSection />
      <HandleSection />
    </SettingsPage>
  );
}
