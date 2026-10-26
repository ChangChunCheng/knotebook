import "@/i18n/select-strings";
import { useTranslation } from "react-i18next";
import { ApiFail } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { User, Users } from "@/components/ui/icons";
import type { Destination, DestinationNode } from "./select-model";

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** ApiFail → errors.<code>；其餘 → errors.fallback（各檔各自一份，是既有慣例）。 */
function errorMessage(t: Translate, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

/**
 * 「移動到」「複製到」的目的地選擇框（spec §6.11、§9-7）。步驟 2 只有根；PR-3b 掛資料夾子節點與展開鈕，筆記 ⋮ 的「選擇資料夾…」也開這一個。
 * 選了就呼叫 `onPick`，關框與焦點交接由呼叫端決定（選了交給確認框、取消才還給開框鈕）。只准經 `SelectLazy` 引用。
 */
export function DestinationPickerDialog({
  mode,
  count,
  nodes,
  error,
  open,
  onPick,
  onOpenChange,
  onCloseAutoFocus,
}: {
  mode: "move" | "copy";
  count: number;
  /** null＝群組載入中。 */
  nodes: readonly DestinationNode[] | null;
  error: unknown;
  open: boolean;
  onPick: (destination: Destination) => void;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const { t } = useTranslation();
  // 「工作坊」小標只用來分隔「我的筆記」與群組（plan T5）；move 只有群組時不放。
  const firstGroup = nodes?.findIndex((node) => node.destination.kind === "group") ?? -1;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{t(mode === "move" ? "select.moveTo" : "select.copyTo")}</DialogTitle>
          <DialogDescription>{t("select.pickerDescription", { count })}</DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(t, error)}
          </p>
        ) : nodes === null ? (
          <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
        ) : (
          <ul className="max-h-80 space-y-0.5 overflow-y-auto">
            {nodes.map((node, index) => (
              <DestinationRow key={node.key} node={node} heading={index === firstGroup && index > 0 ? t("sidebar.workspace") : null} onPick={onPick} />
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("share.move.cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DestinationRow({ node, heading, onPick }: { node: DestinationNode; heading: string | null; onPick: (destination: Destination) => void }) {
  const Icon = node.destination.kind === "personal" ? User : Users;
  return (
    <>
      {heading !== null && (
        <li role="presentation" className="px-2 pt-2 pb-0.5 text-[11px] font-semibold tracking-wide text-muted-foreground">
          {heading}
        </li>
      )}
      <li>
        <Button
          type="button"
          variant="ghost"
          className="w-full justify-start gap-2"
          aria-label={node.accessibleName}
          disabled={node.disabled}
          onClick={() => onPick(node.destination)}
        >
          <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
          <span className="truncate">{node.label}</span>
        </Button>
      </li>
    </>
  );
}
