import { useContext } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { HEADER_ICON_HIT } from "@/components/ui/hit-area";
import { ChevronLeft } from "@/components/ui/icons";
import { useIsPhone } from "@/lib/layout-tiers";
import { PhoneListContext } from "@/lib/phone-list";
import { tourTarget } from "@/lib/tour-targets";
import { cn } from "@/lib/utils";

/** 手機（< 640）筆記畫面頁首最左的「‹」：回清單。其餘寬度不渲染（那些寬度的入口是側欄鈕或固定側欄）。 */
export function BackToListButton() {
  const { t } = useTranslation();
  const phone = useIsPhone();
  const phoneList = useContext(PhoneListContext);
  if (!phone) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={t("note.backToList")}
      {...tourTarget("backToList")}
      onClick={() => phoneList?.backToList()}
      // 視覺 32px；觸控時點擊範圍擴到 40×44（與頁首其他圖示鈕同一個常數）。
      className={cn("h-8 w-8 shrink-0", HEADER_ICON_HIT)}
    >
      <ChevronLeft aria-hidden="true" className="h-5 w-5" />
    </Button>
  );
}
