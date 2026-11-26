import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useCommentUnreadCount } from "@/api/comments";
import { Button } from "@/components/ui/button";
import { FROSTED_SURFACE } from "@/components/ui/frosted";
import { History, MessageSquare } from "@/components/ui/icons";
import { useComments } from "@/lib/comments-context";
import { useIsPhone } from "@/lib/layout-tiers";
import { useVersions } from "@/lib/versions-context";
import { tourTarget } from "@/lib/tour-targets";

/** Nothing sits under the bubble, so hover uses a brand background instead of opacity. Last in the class string so twMerge overrides the frosted hover/press values. `hover:` applies only on hover-capable pointers (`@media (hover: hover)`), so touch is unaffected. */
const BUBBLE_HOVER =
  "cursor-pointer hover:bg-brand-soft supports-[backdrop-filter]:hover:bg-brand-soft active:bg-brand-soft-strong supports-[backdrop-filter]:active:bg-brand-soft-strong";
const BUBBLE = `h-12 w-12 rounded-full text-brand-on-soft hover:text-brand-on-soft ${FROSTED_SURFACE} ${BUBBLE_HOVER}`;

/** None while either right-hand panel is open (the floating panel covers this corner) and none below 640, where the ⋮ menu has the entries. */
export function useCornerStackBubbles(): { versions: boolean; comments: boolean; count: number } {
  const versions = useVersions();
  const comments = useComments();
  const phone = useIsPhone();
  const shown = !phone && !versions.panelOpen && !comments.panelOpen;
  const v = shown && versions.enabled;
  const c = shown && comments.enabled;
  return { versions: v, comments: c, count: (v ? 1 : 0) + (c ? 1 : 0) };
}

/** Pinned to the scroll area bottom (zero-height anchor), not the window corner. Hidden below 640 (reads the same `useIsPhone()` as the ⋮ versions and comments items, so each width has exactly one entry). 18px above the scroll area bottom and 18px left of the scrollbar gutter (the scroll area reserves one from 640 up, `scrollbar-gutter: stable`). Does not fade on scroll. */
export function CornerStack({ scrollRef }: { scrollRef?: RefObject<HTMLElement | null> }) {
  const { t } = useTranslation();
  const versions = useVersions();
  const comments = useComments();
  const bubbles = useCornerStackBubbles();
  const show = bubbles.count > 0;
  const unread = useCommentUnreadCount(comments.noteId, bubbles.comments).data?.count ?? 0;
  // The gutter width is measured because Firefox thin scrollbars are narrower than `--scrollbar-size`; falls back to it when unmeasurable (jsdom, hidden).
  const [gutter, setGutter] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef?.current;
    if (!show || !el || typeof ResizeObserver === "undefined") return;
    const measure = () => setGutter(el.offsetWidth > 0 ? el.offsetWidth - el.clientWidth : null);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [show, scrollRef]);

  if (!show) return null;

  const commentsLabel = t("note.menu.comments");
  // `flex-col-reverse`: the first child is the bottom bubble, so the comments bubble sits above the version history bubble.
  return (
    <div data-testid="corner-anchor" className="pointer-events-none relative z-20 h-0 shrink-0">
      <div
        data-testid="corner-stack"
        className="pointer-events-auto absolute bottom-[18px] right-[calc(18px+var(--bubble-gutter,var(--scrollbar-size)))] flex flex-col-reverse gap-3"
        style={gutter !== null && gutter > 0 ? ({ "--bubble-gutter": `${gutter}px` } as CSSProperties) : undefined}
      >
        {bubbles.versions && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            data-testid="versions-bubble"
            {...tourTarget("versions")}
            aria-label={t("versions.bubble")}
            onClick={versions.open}
            className={BUBBLE}
          >
            <History aria-hidden="true" className="h-5 w-5" />
          </Button>
        )}
        {bubbles.comments && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            data-testid="comments-bubble"
            // The count joins the name without a translated pattern, which keeps the string out of the first bundle; the badge itself is hidden from screen readers.
            aria-label={unread > 0 ? `${commentsLabel} (${unread})` : commentsLabel}
            onClick={() => comments.open()}
            className={`relative ${BUBBLE}`}
          >
            <MessageSquare aria-hidden="true" className="h-5 w-5" />
            {unread > 0 && (
              <span
                aria-hidden="true"
                data-testid="comments-unread"
                className="absolute -right-0.5 -top-0.5 min-w-5 rounded-full bg-brand-deep px-1 text-center text-[11px] font-semibold leading-5 text-brand-fg"
              >
                {unread > 9 ? "9+" : unread}
              </span>
            )}
          </Button>
        )}
      </div>
    </div>
  );
}
