import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { FROSTED_SURFACE } from "@/components/ui/frosted";
import { History } from "@/components/ui/icons";
import { useIsPhone } from "@/lib/layout-tiers";
import { useVersions } from "@/lib/versions-context";
import { tourTarget } from "@/lib/tour-targets";

/** Nothing sits under the bubble, so hover uses a brand background instead of opacity. Last in the class string so twMerge overrides the frosted hover/press values. */
const BUBBLE_HOVER =
  "cursor-pointer hover:bg-brand-soft supports-[backdrop-filter]:hover:bg-brand-soft active:bg-brand-soft-strong supports-[backdrop-filter]:active:bg-brand-soft-strong";

/** Pinned to the scroll area bottom (zero-height anchor), not the window corner. Hidden on phones (⋮ menu has the entry). */
export function CornerStack({ scrollRef }: { scrollRef?: RefObject<HTMLElement | null> }) {
  const { t } = useTranslation();
  const versions = useVersions();
  const phone = useIsPhone();
  const showVersions = versions.enabled && !versions.panelOpen && !phone;
  // The gutter width is measured because Firefox thin scrollbars are narrower than `--scrollbar-size`; falls back to it when unmeasurable (jsdom, hidden).
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
        className="pointer-events-auto absolute bottom-[18px] right-[calc(18px+var(--bubble-gutter,var(--scrollbar-size)))] flex flex-col-reverse gap-3"
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
