import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { FROSTED_SURFACE } from "@/components/ui/frosted";
import { History } from "@/components/ui/icons";
import { useIsPhone } from "@/lib/layout-tiers";
import { useVersions } from "@/lib/versions-context";
import { tourTarget } from "@/lib/tour-targets";

/**
 * 滑鼠 hover 要看得出來：毛玻璃面的 hover／按下只差幾個百分點（給手機浮動鈕用，那裡 hover 無關緊要），
 * 這顆泡泡在桌面上改成明顯變實，再加深一點陰影。放在同一個 class 字串最後，同變體的前一個值會被 twMerge 蓋掉。
 * `hover:` 只在可 hover 的指標上生效（Tailwind 預設包在 `@media (hover: hover)`），觸控不受影響。
 */
const BUBBLE_HOVER = "hover:shadow-xl supports-[backdrop-filter]:hover:bg-card/80 supports-[backdrop-filter]:active:bg-card/90";

/**
 * 文章欄底部的留白（640 起）：泡泡佔捲動區下緣往上 12–60px 這一段，欄底多留 72px，捲到底時最後一行（含打字的那一行）
 * 停在泡泡上緣之上、不被蓋住。640–767 的欄沒有額外的左右內距，文字會一路排到卡片右緣，最需要這段。
 */
export const BUBBLE_CLEARANCE = "sm:pb-[4.5rem]";

/**
 * 筆記右下角的歷史泡泡（< 640 沒有；那裡版本歷史在 ⋮ 選單）。
 *
 * 渲染在內文卡裡、捲動區與頁尾（提及列）之間：外層是零高度的定位基準，貼在捲動區的下緣，
 * 泡泡再往上 12px、離右緣 24px（讓出捲軸）。這樣它釘在筆記區域的右下角、不隨內文捲走，也不會壓到下方的提及列，
 * 不再落在視窗角落蓋到卡片外。三段筆記寬度與固定／浮動兩種版本面板都在同一張卡裡，位置一致。
 * 毛玻璃面與手機浮動鈕同一份（`ui/frosted.ts`）。
 *
 * 只在兩種情形不渲染：沒有版本功能（唯讀檢視者）、版本面板開著（面板本身就是入口）。捲動時不淡出。
 */
export function CornerStack() {
  const { t } = useTranslation();
  const versions = useVersions();
  const phone = useIsPhone();
  // 手機（< 640）沒有泡泡；與 ⋮ 的「版本歷史」項讀同一個 `useIsPhone()`，同一寬度恰好一個入口。
  const showVersions = versions.enabled && !versions.panelOpen && !phone;
  if (!showVersions) return null;

  return (
    <div data-testid="corner-anchor" className="pointer-events-none relative z-20 h-0 shrink-0">
      <div
        data-testid="corner-stack"
        className="pointer-events-auto absolute bottom-3 right-6 flex flex-col-reverse gap-3"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-testid="versions-bubble"
          {...tourTarget("versions")}
          aria-label={t("versions.bubble")}
          onClick={versions.open}
          className={`h-12 w-12 rounded-full text-brand-on-soft hover:text-brand-on-soft ${FROSTED_SURFACE} ${BUBBLE_HOVER}`}
        >
          <History aria-hidden="true" className="h-5 w-5" />
        </Button>
      </div>
    </div>
  );
}
