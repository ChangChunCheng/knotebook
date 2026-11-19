import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { TRASH_RETENTION_DAYS_DEFAULT, TRASH_RETENTION_DAYS_MAX, TRASH_RETENTION_DAYS_MIN, type TrashSettingsDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useTrashSettings, useUpdateTrashSettings } from "@/api/trash";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { SettingsGroup } from "./SettingsLayout";
import "@/i18n/management-strings";

function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

/**
 * Edits stay local until Save: sending the default 7 days the moment the toggle opens could purge a batch of
 * old trash within the hour. Save sends the days when on, `null` when off. Local `null` shows the server value
 * (as in `RetentionGroup`) and is reset to `null` after a successful save.
 */
function TrashForm({ data }: { data: TrashSettingsDto }) {
  const { t } = useTranslation();
  const update = useUpdateTrashSettings();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [days, setDays] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const enabledShown = enabled ?? data.retentionDays !== null;
  const daysShown = days ?? String(data.retentionDays ?? TRASH_RETENTION_DAYS_DEFAULT);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = daysShown.trim();
    const n = Number(trimmed);
    if (enabledShown && (!/^\d+$/.test(trimmed) || n < TRASH_RETENTION_DAYS_MIN || n > TRASH_RETENTION_DAYS_MAX)) {
      setError(t("admin.trash.daysInvalid"));
      return;
    }
    setError(null);
    try {
      await update.mutateAsync({ retentionDays: enabledShown ? n : null });
      setEnabled(null);
      setDays(null);
      toast({ title: t("admin.trash.saved") });
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  return (
    <>
      <form onSubmit={(event) => void handleSubmit(event)} className="space-y-3">
        <div className="flex items-center gap-3">
          <Switch
            id="trash-auto-purge"
            checked={enabledShown}
            onCheckedChange={(value) => {
              setEnabled(value);
              setError(null);
            }}
          />
          <label htmlFor="trash-auto-purge" className="text-sm font-medium">
            {t("admin.trash.autoLabel")}
          </label>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          {enabledShown && (
            <div className="space-y-1">
              <label htmlFor="trash-retention-days" className="text-sm font-medium">
                {t("admin.trash.daysLabel")}
              </label>
              <Input
                id="trash-retention-days"
                inputMode="numeric"
                value={daysShown}
                onChange={(event) => {
                  setDays(event.target.value);
                  setError(null);
                }}
                className="w-32"
              />
            </div>
          )}
          <Button type="submit" variant="outline" disabled={update.isPending}>
            {t("admin.trash.save")}
          </Button>
        </div>
      </form>
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </>
  );
}

/**
 * Retention is 1–3650 days. Hint text (hourly, at most 2,000 per run) mirrors server `trash/purge.ts`:
 * `TRASH_PURGE_INTERVAL_MS` (60 min) and `TRASH_PURGE_BATCH × TRASH_PURGE_MAX_BATCHES` (100 × 20). All three states render
 * as a region with the same title because the page has another Save button.
 */
export function SiteTrashGroup() {
  const { t } = useTranslation();
  const query = useTrashSettings();
  if (query.isPending) {
    return (
      <SettingsGroup labelledByTitle title={t("admin.trash.title")}>
        <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
      </SettingsGroup>
    );
  }
  if (query.isError) {
    return (
      <SettingsGroup labelledByTitle title={t("admin.trash.title")}>
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(t, query.error)}
        </p>
      </SettingsGroup>
    );
  }
  return (
    <SettingsGroup labelledByTitle title={t("admin.trash.title")} description={t("admin.trash.description")}>
      <TrashForm data={query.data} />
    </SettingsGroup>
  );
}
