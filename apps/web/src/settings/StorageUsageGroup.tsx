import { useTranslation } from "react-i18next";
import type { UseQueryResult } from "@tanstack/react-query";
import { formatBytes, type StorageUsageDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { isQuotaReached } from "@/lib/storage-usage";
import { cn } from "@/lib/utils";
import { SettingsGroup } from "./SettingsLayout";

function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

/** Display only, no plan change. Trash notes count toward usage, without a separate trash figure (#181). */
export function StorageUsageGroup({ title, query }: { title: string; query: UseQueryResult<StorageUsageDto> }) {
  const { t } = useTranslation();
  let body;
  if (query.isPending) {
    body = <p className="text-sm text-muted-foreground">{t("app.loading")}</p>;
  } else if (query.isError) {
    body = <p role="alert" className="text-sm text-destructive">{errorMessage(t, query.error)}</p>;
  } else {
    const u = query.data;
    const over = isQuotaReached(u);
    const text =
      u.quotaBytes === null
        ? t("storage.usageUnlimited", { used: formatBytes(u.usedBytes), plan: u.planName })
        : t("storage.usage", { used: formatBytes(u.usedBytes), quota: formatBytes(u.quotaBytes), plan: u.planName });
    body = (
      <div className="space-y-1">
        <p data-testid="storage-usage" className={cn("text-sm", over && "text-destructive")}>{text}</p>
        {over && <p className="text-sm text-destructive">{t("storage.overQuota")}</p>}
        <p className="text-xs text-muted-foreground">{t("storage.trashNote")}</p>
      </div>
    );
  }
  return <SettingsGroup title={title}>{body}</SettingsGroup>;
}
