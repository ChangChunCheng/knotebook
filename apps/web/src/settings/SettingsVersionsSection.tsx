import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { VERSION_AUTO_WAIT_MINUTES_MAX, VERSION_AUTO_WAIT_MINUTES_MIN, VERSION_DAYS_MAX, type VersionSettingsDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useUpdateVersionSettings, useVersionSettings } from "@/api/versionSettings";
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

function SiteSwitchGroup({ data }: { data: VersionSettingsDto }) {
  const { t } = useTranslation();
  const update = useUpdateVersionSettings();
  return (
    <SettingsGroup title={t("admin.versions.title")}>
      <div className="space-y-1">
        <div className="flex items-center gap-3">
          <Switch
            id="site-auto-versions"
            checked={data.autoVersionsEnabled}
            disabled={update.isPending}
            onCheckedChange={(value) =>
              update.mutate({ autoVersionsEnabled: value }, { onError: (err) => toast({ title: errorMessage(t, err), variant: "destructive" }) })
            }
          />
          <label htmlFor="site-auto-versions" className="text-sm font-medium">
            {t("admin.versions.autoTitle")}
          </label>
        </div>
        <p className="text-sm text-muted-foreground">{t("admin.versions.autoDescription")}</p>
        <p className="text-xs text-muted-foreground">{t("versions.takesEffectNote")}</p>
      </div>
    </SettingsGroup>
  );
}

/**
 * Auto-version wait and retention days (#272): three integer fields share one Save. A `null` input shows the server value (as in
 * `HandleSection`). Validation checks the wait, then the days, and shows only the first failure.
 * The wait explanation carries the server value and sits below the form (under a single field it would misalign the three inputs).
 */
function RetentionGroup({ data }: { data: VersionSettingsDto }) {
  const { t } = useTranslation();
  const update = useUpdateVersionSettings();
  const [wait, setWait] = useState<string | null>(null);
  const [keepAll, setKeepAll] = useState<string | null>(null);
  const [dailyUntil, setDailyUntil] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const waitShown = wait ?? String(data.autoWaitMinutes);
  const keepAllShown = keepAll ?? String(data.keepAllDays);
  const dailyUntilShown = dailyUntil ?? String(data.dailyUntilDays);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const waitText = waitShown.trim();
    const minutes = Number(waitText);
    if (!/^\d+$/.test(waitText) || minutes < VERSION_AUTO_WAIT_MINUTES_MIN || minutes > VERSION_AUTO_WAIT_MINUTES_MAX) {
      setError(t("admin.versions.waitInvalid"));
      return;
    }
    const keepAllText = keepAllShown.trim();
    const dailyUntilText = dailyUntilShown.trim();
    const first = Number(keepAllText);
    const second = Number(dailyUntilText);
    if (!/^\d+$/.test(keepAllText) || !/^\d+$/.test(dailyUntilText) || first < 1 || first > second || second > VERSION_DAYS_MAX) {
      setError(t("admin.versions.daysInvalid"));
      return;
    }
    setError(null);
    try {
      await update.mutateAsync({ autoWaitMinutes: minutes, keepAllDays: first, dailyUntilDays: second });
      setWait(null);
      setKeepAll(null);
      setDailyUntil(null);
      toast({ title: t("admin.versions.saved") });
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  return (
    <SettingsGroup
      labelledByTitle
      title={t("admin.versions.retentionTitle")}
      description={t("admin.versions.retentionDescription", { keepAll: data.keepAllDays, dailyUntil: data.dailyUntilDays })}
    >
      <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label htmlFor="versions-auto-wait" className="text-sm font-medium">
            {t("admin.versions.waitLabel")}
          </label>
          <Input
            id="versions-auto-wait"
            inputMode="numeric"
            aria-describedby="versions-auto-wait-help"
            value={waitShown}
            onChange={(event) => {
              setWait(event.target.value);
              setError(null);
            }}
            className="w-32"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="versions-keep-all" className="text-sm font-medium">
            {t("admin.versions.keepAllLabel")}
          </label>
          <Input
            id="versions-keep-all"
            inputMode="numeric"
            value={keepAllShown}
            onChange={(event) => {
              setKeepAll(event.target.value);
              setError(null);
            }}
            className="w-32"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="versions-daily-until" className="text-sm font-medium">
            {t("admin.versions.dailyUntilLabel")}
          </label>
          <Input
            id="versions-daily-until"
            inputMode="numeric"
            value={dailyUntilShown}
            onChange={(event) => {
              setDailyUntil(event.target.value);
              setError(null);
            }}
            className="w-32"
          />
        </div>
        <Button type="submit" variant="outline" disabled={update.isPending}>
          {t("admin.versions.save")}
        </Button>
      </form>
      <p id="versions-auto-wait-help" className="mt-2 text-xs text-muted-foreground">
        {t("admin.versions.waitHelp", { minutes: data.autoWaitMinutes })}
      </p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </SettingsGroup>
  );
}

/**
 * Site switch (applies immediately) plus retention policy. Embedded in the storage plans page (inside `SettingsStorageSection`'s
 * `SettingsPage`, after the plan table), so no header of its own (embedding the whole page would stack two headers). Loading and error
 * each render as one `SettingsGroup`.
 */
export function SiteVersionsGroups() {
  const { t } = useTranslation();
  const query = useVersionSettings();
  if (query.isPending) {
    return (
      <SettingsGroup title={t("admin.versions.title")}>
        <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
      </SettingsGroup>
    );
  }
  if (query.isError) {
    return (
      <SettingsGroup title={t("admin.versions.title")}>
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(t, query.error)}
        </p>
      </SettingsGroup>
    );
  }
  return (
    <>
      <SiteSwitchGroup data={query.data} />
      <RetentionGroup data={query.data} />
    </>
  );
}
