import type { ButtonHTMLAttributes, JSX } from "react";
import { useTranslation } from "react-i18next";
import { ZoomIn } from "@/components/ui/icons-extra";
import { cn } from "@/lib/utils";

/** 圖片與 mermaid 共用的放大鈕。長相全靠 `.block-control`，位置由呼叫端的容器決定。 */
export function ZoomButton({ className, ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">): JSX.Element {
  const { t } = useTranslation();
  const label = t("note.zoom.open");
  return (
    <button {...props} type="button" aria-label={label} title={label} className={cn("block-control", className)}>
      <ZoomIn className="h-3.5 w-3.5" />
    </button>
  );
}
