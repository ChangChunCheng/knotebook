import { useTranslation } from "react-i18next";
import type { VersionKindFilter } from "@/api/versions";
import { Button } from "@/components/ui/button";
import { useVersions } from "@/lib/versions-context";
import { cn } from "@/lib/utils";
import { PRESSED_CLASS } from "./version-labels";

const OPTIONS: Array<{ value: VersionKindFilter; labelKey: string }> = [
  { value: "all", labelKey: "versions.filter.all" },
  { value: "manual", labelKey: "versions.filter.manual" },
];

/** State lives in `useVersions().kindFilter` (the controller owns it, not reset on note change, persisted in localStorage); it affects only the list and the compare dropdown options, not the current preview/compare target. */
export function KindFilter({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { kindFilter, setKindFilter } = useVersions();
  return (
    <div role="group" aria-label={t("versions.filter.label")} data-testid="versions-filter" className={cn("flex gap-1", className)}>
      {OPTIONS.map(({ value, labelKey }) => (
        <Button
          key={value}
          type="button"
          variant="ghost"
          size="sm"
          aria-pressed={kindFilter === value}
          className={cn("h-7 max-sm:h-9", kindFilter === value && PRESSED_CLASS)}
          onClick={() => setKindFilter(value)}
        >
          {t(labelKey)}
        </Button>
      ))}
    </div>
  );
}

export function KindFilterEmpty() {
  const { t } = useTranslation();
  return (
    <li data-testid="versions-filter-empty" className="px-2 py-1.5 text-xs text-muted-foreground">
      {t("versions.filter.emptyManual")}
    </li>
  );
}
