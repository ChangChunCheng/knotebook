import "@/i18n/select-strings";
import { useId, useLayoutEffect, useRef, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { ApiFail } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ChevronRight } from "@/components/ui/icons";
import { destinationItemIcon } from "./destination-icon";
import type { DestItem, DestMode, DestPathStep, DestTarget } from "./destination-level";

type Translate = (key: string, options?: Record<string, unknown>) => string;

function errorMessage(t: Translate, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

/** Scroll-to-top and focus move only when `levelKey` changes, not on a same-level re-render (folder refetch). Closing and focus handoff belong to the caller. Import only through the SelectLazy chain and tests. */
export function DestinationPickerDialog({
  mode,
  count,
  hasFolders,
  level,
  levelKey,
  error,
  open,
  onDrill,
  onBack,
  onPick,
  onOpenChange,
  onCloseAutoFocus,
}: {
  mode: DestMode;
  count: number;
  hasFolders: boolean;
  level: readonly DestItem[] | null;
  levelKey: string;
  error: unknown;
  open: boolean;
  onDrill: (step: DestPathStep) => void;
  onBack: () => void;
  onPick: (target: DestTarget) => void;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const { t } = useTranslation();
  const descriptionId = useId();
  const crossSpaceId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Items disabled for crossing spaces add a description line included in aria-describedby (a disabled button's title isn't read by screen readers).
  const crossSpace = level?.some((item) => item.kind !== "separator" && item.kind !== "back" && item.disabled === "crossSpace") ?? false;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus} aria-describedby={crossSpace ? `${descriptionId} ${crossSpaceId}` : descriptionId}>
        <DialogHeader>
          <DialogTitle>{t(mode === "move" ? "select.moveTo" : "select.copyTo")}</DialogTitle>
          <DialogDescription id={descriptionId}>{t(hasFolders ? "select.pickerDescriptionItems" : "select.pickerDescription", { count })}</DialogDescription>
          {crossSpace && (
            <p id={crossSpaceId} className="text-sm text-muted-foreground">
              {t("select.foldersOnlyWithinSpace")}
            </p>
          )}
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(t, error)}
          </p>
        ) : level === null ? (
          <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
        ) : (
          <DestinationLevelList level={level} levelKey={levelKey} fallbackRef={cancelRef} onDrill={onDrill} onBack={onBack} onPick={onPick} />
        )}
        <DialogFooter>
          <Button ref={cancelRef} type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("share.move.cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Mounted inside the dialog content: no focus move on first mount (Radix auto-focus handles it). On later level changes focus goes to the first enabled item (from the second level that is "Back"); when every item is disabled it goes to `fallbackRef` (footer Cancel),
 * so it doesn't fall to body when the buttons are replaced.
 */
function DestinationLevelList({
  level,
  levelKey,
  fallbackRef,
  onDrill,
  onBack,
  onPick,
}: {
  level: readonly DestItem[];
  levelKey: string;
  fallbackRef: RefObject<HTMLButtonElement | null>;
  onDrill: (step: DestPathStep) => void;
  onBack: () => void;
  onPick: (target: DestTarget) => void;
}) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLUListElement>(null);
  const firstRef = useRef<HTMLButtonElement>(null);
  const prevKey = useRef(levelKey);
  useLayoutEffect(() => {
    if (prevKey.current === levelKey) return;
    prevKey.current = levelKey;
    if (listRef.current) listRef.current.scrollTop = 0;
    (firstRef.current ?? fallbackRef.current)?.focus();
  }, [levelKey, fallbackRef]);
  const firstEnabled = level.findIndex((item) => item.kind === "back" || (item.kind !== "separator" && item.disabled === null));
  return (
    <ul ref={listRef} className="max-h-80 space-y-0.5 overflow-y-auto">
      {level.map((item, position) => {
        if (item.kind === "separator") return <li key={item.key} role="separator" className="my-1 h-px bg-border" />;
        const drill = item.kind === "folder" || item.kind === "space" ? item.drill : null;
        const disabled = item.kind === "back" ? null : item.disabled;
        const Icon = destinationItemIcon(item);
        return (
          <li key={item.key}>
            <Button
              ref={position === firstEnabled ? firstRef : undefined}
              type="button"
              variant="ghost"
              className="w-full justify-start gap-2"
              aria-label={item.accessibleName}
              disabled={disabled !== null}
              title={disabled === "crossSpace" ? t("select.foldersOnlyWithinSpace") : undefined}
              onClick={() => {
                if (item.kind === "back") onBack();
                else if (drill !== null) onDrill(drill);
                else onPick(item.target);
              }}
            >
              {Icon !== null && <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />}
              <span className="truncate">{item.label}</span>
              {drill !== null && <ChevronRight aria-hidden="true" className="ml-auto h-4 w-4 shrink-0" />}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
