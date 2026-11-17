import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { FROSTED_SURFACE } from "@/components/ui/frosted";
import { History } from "@/components/ui/icons";
import { useIsPhone } from "@/lib/layout-tiers";
import { useVersions } from "@/lib/versions-context";
import { tourTarget } from "@/lib/tour-targets";

/**
 * 滑鼠 hover：泡泡下面沒有東西，調透明度看不出差別，所以 hover 改成淺品牌色底（與 `brand` 鈕、`bg-brand-soft` 同一個色），按下再深一階；游標變手指。
 * 放在同一個 class 字串最後，同變體的毛玻璃 hover／按下值會被 twMerge 蓋掉。
 * `hover:` 只在可 hover 的指標上生效（Tailwind 預設包在 `@media (hover: hover)`），觸控不受影響。
 */
const BUBBLE_HOVER =
  "cursor-pointer hover:bg-brand-soft supports-[backdrop-filter]:hover:bg-brand-soft active:bg-brand-soft-strong supports-[backdrop-filter]:active:bg-brand-soft-strong";

/**
 * 筆記右下角的歷史泡泡（< 640 沒有；那裡版本歷史在 ⋮ 選單）。
 *
 * 渲染在內文卡裡、捲動區與頁尾（提及列）之間：外層是零高度的定位基準，貼在捲動區的下緣，
 * 泡泡再往上 24px、離右邊捲軸槽的左緣 24px（捲動區在 640 起固定預留捲軸槽，短筆記也一樣；槽寬量出來，Firefox 的細捲軸較窄也對得上）。
 * 它釘在筆記區域的右下角、不隨內文捲走，也不會壓到下方的提及列，
 * 不再落在視窗角落蓋到卡片外。三段筆記寬度與固定／浮動兩種版本面板都在同一張卡裡，位置一致。
 * 毛玻璃面與手機浮動鈕同一份（`ui/frosted.ts`）。
 *
 * 只在兩種情形不渲染：沒有版本功能（唯讀檢視者）、版本面板開著（面板本身就是入口）。捲動時不淡出。
 */
export function CornerStack({ scrollRef }: { scrollRef?: RefObject<HTMLElement | null> }) {
  const { t } = useTranslation();
  const versions = useVersions();
  const phone = useIsPhone();
  // 手機（< 640）沒有泡泡；與 ⋮ 的「版本歷史」項讀同一個 `useIsPhone()`，同一寬度恰好一個入口。
  const showVersions = versions.enabled && !versions.panelOpen && !phone;
  // 捲動區的捲軸槽寬（offsetWidth − clientWidth）：Chromium 是 `--scrollbar-size`，Firefox 的細捲軸較窄，所以用量的。
  // 量不到（沒有 ref、區塊被藏起來、jsdom）就退回 `--scrollbar-size`。
  const [gutter, setGutter] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef?.current;
    if (!showVersions || !el || typeof ResizeObserver === "undefined") return;
    const measure = () => setGutter(el.offsetWidth > 0 ? el.offsetWidth - el.clientWidth : null);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [showVersions, scrollRef]);

  if (!showVersions) return null;

  return (
    <div data-testid="corner-anchor" className="pointer-events-none relative z-20 h-0 shrink-0">
      <div
        data-testid="corner-stack"
        className="pointer-events-auto absolute bottom-6 right-[calc(1.5rem+var(--bubble-gutter,var(--scrollbar-size)))] flex flex-col-reverse gap-3"
        style={gutter !== null && gutter > 0 ? ({ "--bubble-gutter": `${gutter}px` } as CSSProperties) : undefined}
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
