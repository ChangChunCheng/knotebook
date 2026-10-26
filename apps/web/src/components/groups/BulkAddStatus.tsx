import { useTranslation } from "react-i18next";
import { ApiFail } from "@/api/client";
import { Button } from "@/components/ui/button";
import { isRateLimited, type BulkAddOutcome, type BulkAddReport } from "./bulk-add";

/** 一輪批次加入的狀態：`report` 為 null＝還在跑。 */
export interface BulkAddState {
  done: number;
  total: number;
  report: BulkAddReport | null;
}

/** 摘要的分類與顯示順序。 */
const OUTCOMES: BulkAddOutcome[] = ["added", "alreadyMember", "notFound", "invalid", "failed", "notProcessed"];

/**
 * 批次加入的進度與結果（成員區塊加人表單下方）。跑的時候是「已處理 n／共 m」；跑完是逐類列出 email
 * （已加入／已是成員／沒有這個帳號／格式不對／失敗／未處理），停下時另列原因（429 有專門的「稍後再加」說明）。
 * `role="status"`：螢幕閱讀器會念出進度與結果。
 */
export function BulkAddStatus({ state, onDismiss }: { state: BulkAddState; onDismiss: () => void }) {
  const { t } = useTranslation();
  const { report } = state;
  if (report === null) {
    return (
      <p role="status" className="mt-2 text-sm text-muted-foreground">
        {t("groups.bulk.progress", { done: state.done, total: state.total })}
      </p>
    );
  }
  const cause = report.stopped?.cause;
  return (
    <div role="status" className="mt-3 space-y-2 rounded-md border border-input p-3 text-sm">
      {report.stopped && (
        <p className="text-destructive">
          {isRateLimited(cause)
            ? t("groups.bulk.stoppedRateLimit")
            : t("groups.bulk.stopped", {
                reason: cause instanceof ApiFail ? t(`errors.${cause.code}`, { defaultValue: t("errors.fallback") }) : t("errors.fallback"),
              })}
        </p>
      )}
      <ul className="space-y-1">
        {OUTCOMES.map((outcome) => {
          const emails = report.results.filter((r) => r.outcome === outcome).map((r) => r.email);
          if (emails.length === 0) return null;
          return (
            <li key={outcome} data-outcome={outcome} className="wrap-anywhere">
              <span className={outcome === "added" || outcome === "alreadyMember" ? "font-medium" : "font-medium text-destructive"}>
                {t(`groups.bulk.outcome.${outcome}`, { count: emails.length })}
              </span>{" "}
              <span className="text-muted-foreground">{emails.join(", ")}</span>
            </li>
          );
        })}
      </ul>
      <Button type="button" variant="outline" size="sm" onClick={onDismiss}>
        {t("groups.bulk.dismiss")}
      </Button>
    </div>
  );
}
