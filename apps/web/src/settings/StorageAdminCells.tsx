import { useState } from "react";
import { useTranslation } from "react-i18next";
import { formatBytes, type StoragePlanDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { isQuotaReached } from "@/lib/storage-usage";
import "@/i18n/management-strings";

function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

/** The second line is never red: only the first line reflects the limit. */
export function StorageCell({ storage }: { storage: { usedBytes: number; quotaBytes: number | null; contentBytes: number } }) {
  const { t } = useTranslation();
  const text =
    storage.quotaBytes === null
      ? t("storage.cellUnlimited", { used: formatBytes(storage.usedBytes) })
      : t("storage.cell", { used: formatBytes(storage.usedBytes), quota: formatBytes(storage.quotaBytes) });
  return (
    <div>
      <span className={isQuotaReached(storage) ? "text-destructive" : undefined}>{text}</span>{" "}
      <span data-testid="content-bytes" className="block text-xs text-muted-foreground">
        {t("admin.storageContent", { size: formatBytes(storage.contentBytes) })}
      </span>
    </div>
  );
}

/**
 * Saves on pick (toast on failure). Controlled by the server value, so a failed save needs no rollback. Before the plan
 * list loads only the name shows. If the current plan is missing from the list (its cache older than the row), an option
 * for it is added; otherwise the trigger renders blank and the current plan can't be seen.
 */
export function PlanSelect({ label, describedBy, planId, planName, plans, onAssign }: {
  label: string;
  /** Group names aren't unique: points at the row's created-at cell so same-name rows can be told apart. */
  describedBy?: string;
  planId: string;
  planName: string;
  plans: StoragePlanDto[] | undefined;
  onAssign: (planId: string) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  // Show the just-picked plan while saving; the controlled value is still the server's and would snap back during the request. Cleared on failure, falling back to the server value.
  const [pendingId, setPendingId] = useState<string | null>(null);
  if (!plans) return <span>{planName}</span>;
  const options = plans.some((p) => p.id === planId) ? plans : [{ id: planId, name: planName }, ...plans];
  return (
    <Select
      variant="inline"
      aria-label={label}
      aria-describedby={describedBy}
      className="max-w-48"
      value={pendingId ?? planId}
      disabled={pendingId !== null}
      options={options.map((p) => ({ value: p.id, label: p.name }))}
      onValueChange={(next) => {
        setPendingId(next);
        onAssign(next)
          .catch((err: unknown) => toast({ title: errorMessage(t, err), variant: "destructive" }))
          .finally(() => setPendingId(null));
      }}
    />
  );
}
