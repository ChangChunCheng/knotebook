import { useTranslation } from "react-i18next";
import { useVersionList } from "@/api/versions";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuItemIndicator,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Check, ChevronDown } from "@/components/ui/icons";
import { useVersions } from "@/lib/versions-context";
import { TINT_HOVER_CLASS, versionLabel } from "./version-labels";
import { useTargetLabel } from "./use-target-label";

const CURRENT = "current";

/** Diff direction is always left → right: a newer left and older right gives a reverse diff, sides aren't swapped. Left lists all loaded versions; right lists "Current state" plus all. When more pages exist a last item loads earlier versions: `preventDefault` keeps the menu open and calls `fetchNextPage`; no automatic retry on failure. */
export function ComparePicker({ side }: { side: "left" | "right" }) {
  const { t } = useTranslation();
  const { noteId, preview, compareRight, kindFilter, startPreview, setCompareRight } = useVersions();
  // Options follow the list filter (#258). The trigger shows "name (short id)": from the list row when present (renames show at once), else the `target.name` recorded at selection (`useTargetLabel`) when filtered out; long names truncate, full label in title, so the banner stays one row.
  const list = useVersionList(noteId ?? "", preview !== null, kindFilter);
  const rows = list.data?.pages.flatMap((p) => p.versions) ?? [];
  const target = side === "left" ? preview : compareRight;
  const value = target === CURRENT ? CURRENT : (target?.id ?? "");
  const targetLabel = useTargetLabel(target === CURRENT ? null : target);
  const label = target === CURRENT ? t("versions.preview.currentOption") : targetLabel;

  const choose = (next: string) => {
    // Re-selecting the checked item does nothing (no re-sampling of "Current state", no preview rebuild).
    if (next === value) return;
    if (next === CURRENT) {
      setCompareRight(CURRENT);
      return;
    }
    const row = rows.find((r) => r.id === next);
    if (!row) return;
    const picked = { seq: row.seq, id: row.id, name: row.name };
    if (side === "left") startPreview(picked);
    else setCompareRight(picked);
  };

  const itemClass =
    "relative flex items-center rounded-sm py-1.5 pl-8 pr-2 pointer-coarse:py-2.5 text-sm transition-colors focus:bg-accent focus:text-accent-foreground data-[highlighted]:bg-accent";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={`h-7 min-w-0 shrink-0 gap-1 ${TINT_HOVER_CLASS}`}
          aria-label={t(side === "left" ? "versions.preview.leftPicker" : "versions.preview.rightPicker")}
        >
          <span className="max-w-48 truncate" title={label}>{label}</span>
          <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[min(20rem,var(--radix-dropdown-menu-content-available-height))] max-w-72 overflow-y-auto">
        <DropdownMenuRadioGroup value={value} onValueChange={choose}>
          {side === "right" && (
            <DropdownMenuRadioItem value={CURRENT} className={itemClass}>
              <ItemCheck />
              {t("versions.preview.currentOption")}
            </DropdownMenuRadioItem>
          )}
          {rows.map((row) => (
            <DropdownMenuRadioItem key={row.id} value={row.id} className={itemClass}>
              <ItemCheck />
              <span className="truncate">{versionLabel(row)}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {list.hasNextPage && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={list.isFetchingNextPage}
              onSelect={(event) => {
                event.preventDefault();
                void list.fetchNextPage();
              }}
            >
              {t("versions.loadMore")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ItemCheck() {
  return (
    <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
      <DropdownMenuItemIndicator>
        <Check aria-hidden="true" className="h-4 w-4" />
      </DropdownMenuItemIndicator>
    </span>
  );
}
