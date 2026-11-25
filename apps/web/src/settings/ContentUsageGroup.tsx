import { useTranslation } from "react-i18next";
import { formatBytes, type ContentUsageDto } from "@knotebook/shared";
import { SettingsGroup } from "./SettingsLayout";
import "@/i18n/management-strings";

/** No rows while `content` is undefined (loading or error): the usage group on the same page shows errors. */
export function ContentUsageGroup({ content, pending }: { content: ContentUsageDto | undefined; pending: boolean }) {
  const { t } = useTranslation();
  const rows = content === undefined ? [] : [
    { testId: "content-usage-note", label: t("settings.storage.contentNote"), bytes: content.noteBytes },
    { testId: "content-usage-history", label: t("settings.storage.contentHistory"), bytes: content.historyBytes },
  ];
  return (
    <SettingsGroup title={t("settings.storage.contentTitle")} description={t("settings.storage.contentDescription")}>
      {pending ? (
        <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
      ) : (
        <ul>
          {rows.map((row) => (
            <li key={row.testId} data-testid={row.testId} className="flex items-center justify-between gap-3 border-b border-border py-2.5 text-sm">
              <span>{row.label}</span>
              <span className="tabular-nums text-muted-foreground">{formatBytes(row.bytes)}</span>
            </li>
          ))}
        </ul>
      )}
    </SettingsGroup>
  );
}
