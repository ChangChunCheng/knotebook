import { useState } from "react";
import { useTranslation } from "react-i18next";
import { formatBytes, type StoragePlanDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { isQuotaReached } from "@/lib/storage-usage";

function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

/** 站台管理表格的用量格（使用者表、群組表共用）：「X of Y」／「X (no limit)」；已達上限（>=）→ 警示色。 */
export function StorageCell({ storage }: { storage: { usedBytes: number; quotaBytes: number | null } }) {
  const { t } = useTranslation();
  const text =
    storage.quotaBytes === null
      ? t("storage.cellUnlimited", { used: formatBytes(storage.usedBytes) })
      : t("storage.cell", { used: formatBytes(storage.usedBytes), quota: formatBytes(storage.quotaBytes) });
  return <span className={isQuotaReached(storage) ? "text-destructive" : undefined}>{text}</span>;
}

/**
 * 方案下拉，選了即存（失敗 toast）。受控於 server 值：失敗時不必回滾，畫面自然停在原方案。
 * 方案清單還沒到 → 只顯示方案名。目前方案不在清單裡（清單快取比列舊）→ 補一個該方案的選項，
 * 否則觸發鈕找不到對應選項而顯示空白，看不出目前是哪個方案。
 */
export function PlanSelect({ label, describedBy, planId, planName, plans, onAssign }: {
  label: string;
  /** 補充描述的元素 id（群組名不唯一時，指到該列的建立時間格讓同名列可區分）。 */
  describedBy?: string;
  planId: string;
  planName: string;
  plans: StoragePlanDto[] | undefined;
  onAssign: (planId: string) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  // 儲存中先顯示剛選的方案（受控值仍是 server 值，不暫存的話下拉會在請求期間彈回舊方案）；失敗時清掉 → 自然回到 server 值。
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
