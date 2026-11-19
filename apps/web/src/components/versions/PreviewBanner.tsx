import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Columns2, ListFilter, Rows3 } from "@/components/ui/icons-extra";
import { useVersions } from "@/lib/versions-context";
import { cn } from "@/lib/utils";
import { ComparePicker } from "./ComparePicker";
import { PRESSED_CLASS, TINT_HOVER_CLASS } from "./version-labels";
import { useTargetLabel } from "./use-target-label";

const MODE_BUTTON = `h-7 w-7 shrink-0 ${TINT_HOVER_CLASS}`;

/**
 * The banner has no ✕: leaving preview is Esc (in NotePage), clicking blank space in the panel list, clicking the selected row again, or closing the panel (`close()` leaves preview too). Time and editors are omitted (the panel rows have them).
 * Background `bg-brand-soft`: `--primary` is neutral near-black and can't be used. Single row: `flex-nowrap` and `shrink-0` buttons (overflow horizontally rather than wrap).
 * `narrow`: the full-page narrow view has no side-by-side, so the split/single buttons aren't rendered; nor when the preview area is below `SPLIT_MIN_WIDTH` (controller `previewWide` false).
 */
/** Only affects single-column: disabled while the preview is actually side-by-side (controller `splitActive`, reported by `VersionPreview`). `aria-disabled`, not `disabled`: `disabled:pointer-events-none` would stop `title` showing, so the explanation would be invisible; the click is blocked in the handler. The narrow full page doesn't pass `iconOnly`: touch has no hover, so `title` can't be seen. */
export function OnlyChangesToggle({ iconOnly = false }: { iconOnly?: boolean }) {
  const { t } = useTranslation();
  const { onlyChanges, setOnlyChanges, splitActive } = useVersions();
  // `title` isn't visible on touch nor always read by screen readers: when disabled an sr-only explanation is attached for aria-describedby.
  const hintId = useId();
  const label = t("versions.preview.onlyChanges");
  const hint = t("versions.preview.onlyChangesSplitHint");
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size={iconOnly ? "icon" : "sm"}
        className={cn(iconOnly ? MODE_BUTTON : `h-7 shrink-0 ${TINT_HOVER_CLASS}`, onlyChanges && PRESSED_CLASS, splitActive && "cursor-not-allowed opacity-50")}
        aria-label={iconOnly ? label : undefined}
        aria-pressed={onlyChanges}
        aria-disabled={splitActive || undefined}
        title={splitActive ? hint : iconOnly ? label : undefined}
        aria-describedby={splitActive ? hintId : undefined}
        onClick={() => {
          if (!splitActive) setOnlyChanges(!onlyChanges);
        }}
      >
        {iconOnly ? <ListFilter aria-hidden="true" className="h-4 w-4" /> : label}
      </Button>
      {splitActive && (
        <span id={hintId} className="sr-only">
          {t("versions.preview.onlyChangesSplitHint")}
        </span>
      )}
    </>
  );
}

export function PreviewBanner({ narrow = false }: { narrow?: boolean }) {
  const { t } = useTranslation();
  const { preview, setSplitMode, previewWide, splitActive } = useVersions();
  const label = useTargetLabel(preview);
  if (!preview) return null;
  const toggle = (on: boolean) => cn(MODE_BUTTON, on && PRESSED_CLASS);
  return (
    <div data-testid="preview-banner" className="flex flex-nowrap items-center gap-2 border-b border-border bg-brand-soft px-5 py-2 text-xs">
      <span className="min-w-0 truncate font-medium" title={label}>{t("versions.preview.banner", { label })}</span>
      {/* Compare targets: side-by-side the two dropdowns are the column headers; the banner shows "left → right" only in single-column */}
      {!splitActive && (
        <>
          <ComparePicker side="left" />
          <span aria-hidden="true" className="shrink-0 text-muted-foreground">
            →
          </span>
          <ComparePicker side="right" />
        </>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {!narrow && previewWide && (
          <>
            {/* No side-by-side when the preview area is too narrow (previewWide=false): neither button renders.
                Pressed follows the layout actually in effect (`splitActive`): in auto the auto-picked one is pressed, after a manual choice that one; never neither. */}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={toggle(splitActive)}
              aria-label={t("versions.preview.split")}
              title={t("versions.preview.split")}
              aria-pressed={splitActive}
              onClick={() => setSplitMode("split")}
            >
              <Columns2 aria-hidden="true" className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={toggle(!splitActive)}
              aria-label={t("versions.preview.single")}
              title={t("versions.preview.single")}
              aria-pressed={!splitActive}
              onClick={() => setSplitMode("single")}
            >
              <Rows3 aria-hidden="true" className="h-4 w-4" />
            </Button>
          </>
        )}
        <OnlyChangesToggle iconOnly />
      </div>
    </div>
  );
}
