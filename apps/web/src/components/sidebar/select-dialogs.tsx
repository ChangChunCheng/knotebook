import "@/i18n/select-strings";
import type { ReactNode, Ref } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Destination } from "./select-model";

/**
 * 一般 tab 選取模式的移入群組／複製確認框（#181 PR-2c，spec §6.11；複製先確認是 Willie 裁定 Q2）。複數版移入確認框是通用句，
 * 不預查每篇的分享與公開連結（plan 讀碼發現 7）。篇數由呼叫端在目的地選定那一刻快照（讀碼發現 19）。
 * **送出中（`progress` 非 null）框開到批次結束**：送出與取消 disabled、框內顯示進度；✕（`DialogPrimitive.Close`）、Esc 與點框外
 * 都經 Dialog root 的 `onOpenChange(false)`，這裡一律忽略（不改 `ui/dialog.tsx`）。批次結束由呼叫端把 `open` 設 false。
 * 只准經 `SelectLazy` 引用。
 */

export type SelectProgress = { done: number; total: number } | null;

interface ConfirmProps {
  count: number;
  open: boolean;
  progress: SelectProgress;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
  /** 呼叫端的焦點守衛用（焦點仍在框內也算「沒有移到別處」）。 */
  contentRef?: Ref<HTMLDivElement>;
}

function ConfirmShell({
  title,
  description,
  submitLabel,
  submitVariant,
  open,
  progress,
  onConfirm,
  onOpenChange,
  onCloseAutoFocus,
  contentRef,
  children,
}: Omit<ConfirmProps, "count"> & {
  title: string;
  description: string;
  submitLabel: string;
  submitVariant: "destructive" | "outline";
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const busy = progress !== null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent ref={contentRef} dismissOnOutside={false} onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
        {progress !== null && (
          <p role="status" className="text-sm text-muted-foreground">
            {t("select.progress", progress)}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {t("share.move.cancel")}
          </Button>
          <Button type="button" variant={submitVariant} disabled={busy} onClick={onConfirm}>
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function MoveConfirmDialog({ count, groupName, ...rest }: ConfirmProps & { groupName: string }) {
  const { t } = useTranslation();
  return (
    <ConfirmShell
      {...rest}
      title={t("share.move.moveSubmit")}
      description={t("select.moveLead", { count, group: groupName })}
      submitLabel={t("share.move.moveSubmit")}
      submitVariant="destructive"
    >
      <ul className="list-disc space-y-1 pl-5 text-sm">
        <li>{t("select.moveRemovesShares")}</li>
        <li>{t("select.moveClosesPublicLinks")}</li>
        <li>{t("select.moveUrlChange")}</li>
        <li>{t("select.moveOwnership")}</li>
      </ul>
    </ConfirmShell>
  );
}

export function CopyConfirmDialog({ count, destination, ...rest }: ConfirmProps & { destination: Destination }) {
  const { t } = useTranslation();
  const label = destination.kind === "group" ? t("share.move.copySubmit") : t("share.move.copyPersonalSubmit");
  return (
    <ConfirmShell
      {...rest}
      title={label}
      description={
        destination.kind === "group" ? t("select.copyLead", { count, group: destination.name }) : t("select.copyLeadPersonal", { count })
      }
      submitLabel={label}
      submitVariant="outline"
    />
  );
}
