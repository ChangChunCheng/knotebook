import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { canonicalNotePath } from "@knotebook/shared";
import { useBacklinks } from "@/api/notes";
import { BACKLINKS_SCROLL_ROW, SIDEBAR_ROW_HEIGHT } from "@/components/ui/rows";
import { useIsPhone } from "@/lib/layout-tiers";
import { cn } from "@/lib/utils";

/**
 * The chips row uses `overflow-x-scroll` (not `-auto`) so the scrollbar always takes space and chip position does not jump with count; geometry is in `BACKLINKS_SCROLL_ROW` (`ui/rows.ts`) and `items-center` is load-bearing (stretch would make chips full height).
 * The scrollbar sits in the footer `py-2` padding and the body card is `overflow-hidden`: only 2px remain, so do not reduce padding or add `overflow-hidden`.
 * Alignment compensation must be on the chips side, not the label (`mb-2.5` on the label pulls the whole row off the sidebar account row centre line).
 * Known residual: Firefox thin scrollbars (8px) put chips ~1px above the label; overlay scrollbars ~3px below.
 * Phone: no row at all when there are no mentions (including pending/failed query), so no blank strip.
 */
export function BacklinksSection({ noteId }: { noteId: string | undefined }) {
  const { t } = useTranslation();
  const backlinksQuery = useBacklinks(noteId);
  const backlinks = backlinksQuery.data;
  const settled = backlinks !== undefined;
  const phone = useIsPhone();
  // Desktop always renders the row (empty at 0: discoverability, stable card height). No text while pending/failed: the count is unknown.
  if (phone && (!settled || backlinks.length === 0)) return null;

  return (
    <div className="shrink-0 border-t border-border py-2 text-sm">
      {/* the outer element owns the divider and py-2 (equal-height contract with the sidebar account row) */}
      <div className={cn("flex items-center gap-3 px-5", SIDEBAR_ROW_HEIGHT)}>
        {settled && (
          <p className="shrink-0 text-xs font-medium text-muted-foreground">
            {backlinks.length === 0
              ? t("note.backlinks.empty")
              : t("note.backlinks.title", { count: backlinks.length })}
          </p>
        )}
        {settled && backlinks.length > 0 && (
          <div className={cn("flex min-w-0 flex-1 items-center gap-2 overflow-x-scroll", BACKLINKS_SCROLL_ROW)}>
            {backlinks.map((backlink) => (
              <Link
                key={backlink.id}
                to={canonicalNotePath(backlink)}
                className="shrink-0 whitespace-nowrap rounded-full bg-accent/60 px-3 py-1 text-xs hover:bg-accent"
              >
                {backlink.title}
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
