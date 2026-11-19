import { lazy, Suspense, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cardSurface } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { X } from "@/components/ui/icons";
import { ChunkLoadBeacon, LazyRouteErrorBoundary, LazyRouteLoading } from "@/components/ErrorBoundary";
import { managementCardPhone, managementTray } from "@/components/management/tray";
import { isPhone, useIsPhone } from "@/lib/layout-tiers";
import { cn } from "@/lib/utils";
import type { ShortcutsStartPage } from "@/lib/shortcuts-dialog";

/**
 * Content lives in a lazy chunk; `ShortcutsLazy` registers its string bundle at module top level, so never
 * import it from the entry bundle (scripts/check-bundle-size.mjs fails).
 */
const ShortcutsContent = lazy(() => import("@/components/shortcuts/ShortcutsLazy").then((m) => ({ default: m.ShortcutsContent })));

/**
 * Title, ✕ and Esc live in the shell, so the dialog still closes while the chunk loads or fails. On phones the card
 * sits on the sheet's bottom edge, so bottom padding is the larger of its own and the home-indicator safe area.
 */
const FALLBACK_CARD = cn(cardSurface, "min-w-0 flex-1 overflow-y-auto p-8 pt-12 max-sm:pb-[max(2rem,env(safe-area-inset-bottom))]", managementCardPhone);

/**
 * Focus: on open, focus the content area (auto-focus prevented), or the dialog itself until the chunk loads and
 * the content takes over. DOM order is ✕, categories, (narrow back button), content; Radix FocusScope `loop` cycles
 * Tab between content and ✕. A controlled Dialog without a `DialogTrigger` drops focus on body when closed, so
 * `onCloseAutoFocus` is prevented and `returnFocusRef` is focused instead (the focused element at open when opened by
 * keyboard; the UserMenu trigger when opened from the menu).
 *
 * Phone (< 640px): a bottom sheet without ✕, using the same back stack as `ManagementShell`: it opens on the category
 * list; the content's back returns to the list; the list's back closes, and if opened from a menu (`reopenMenuRef`)
 * reopens that menu once the sheet is down (labelled back-to-menu; otherwise labelled close). Tapping the dimmed strip
 * or Esc closes everything.
 *
 * `DialogTitle` must not get an `id`: Radix spreads props after its own `id`, so `aria-labelledby`
 * would point at a missing id and the dialog would have no name.
 *
 * `ChunkLoadBeacon` must stay inside `<Suspense>` (placement invariant in ErrorBoundary.tsx); card surfaces use `cn(cardSurface, …)` (card.guard.test.ts).
 */
export function ShortcutsDialog({
  open,
  onOpenChange,
  returnFocusRef,
  page = "global",
  reopenMenuRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
  /** Start page, read when the content mounts; each open remounts it, so later changes while open are ignored. */
  page?: ShortcutsStartPage;
  /** How to reopen the menu that opened it; null means it wasn't opened from a menu. */
  reopenMenuRef?: RefObject<(() => void) | null>;
}) {
  const { t } = useTranslation();
  // New key per open remounts the content and resets the start page, even when reopened mid close-animation.
  const [wasOpen, setWasOpen] = useState(open);
  const [openCount, setOpenCount] = useState(0);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setOpenCount((n) => n + 1);
  }
  const phone = useIsPhone();
  // Set when the list's back button is pressed: reopen the menu after closing instead of returning focus.
  const backToMenuRef = useRef(false);
  // Phone width at open time: "back to menu" applies only to a menu-opened phone session (opened wide then shrunk: "‹" just closes).
  const [phoneAtOpen, setPhoneAtOpen] = useState<boolean | null>(null);
  if (open && phoneAtOpen === null) setPhoneAtOpen(isPhone());
  else if (!open && phoneAtOpen !== null) setPhoneAtOpen(null);
  const canReturnToMenu = phoneAtOpen === true && (reopenMenuRef?.current ?? null) !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="panel"
        data-shortcuts-dialog=""
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const dialog = event.currentTarget as HTMLElement;
          // The visible layer's target (content, or the list's back button on a phone list); see `ShortcutsLazy`.
          (dialog.querySelector<HTMLElement>("[data-shortcuts-focus]") ?? dialog).focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const el = returnFocusRef.current;
          returnFocusRef.current = null;
          const reopen = backToMenuRef.current ? (reopenMenuRef?.current ?? null) : null;
          backToMenuRef.current = false;
          if (reopenMenuRef) reopenMenuRef.current = null;
          if (reopen) reopen();
          else if (el?.isConnected) el.focus();
        }}
      >
        <DialogTitle className="sr-only">{t("shortcuts.title")}</DialogTitle>
        <DialogDescription className="sr-only">{t("shortcuts.description")}</DialogDescription>
        <div className={cn(managementTray, "relative")}>
          {/* Read-only page, so no settings-style outside-click protection: ✕, Esc and outside click all close; ✕ comes first in the DOM (tray's top-right) */}
          {!phone && (
            <DialogClose asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-4 top-4 z-20 h-7 w-7 bg-card md:right-5 md:top-5"
                aria-label={t("management.close")}
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </Button>
            </DialogClose>
          )}
          <LazyRouteErrorBoundary resetKey={undefined} chunk="shortcuts" frame="inline" inlineErrorClassName={FALLBACK_CARD}>
            <Suspense
              fallback={
                <div className={FALLBACK_CARD}>
                  <LazyRouteLoading frame="inline" />
                </div>
              }
            >
              <ChunkLoadBeacon chunk="shortcuts" />
              <ShortcutsContent
                key={openCount}
                startPage={page}
                onClose={() => onOpenChange(false)}
                listBack={
                  phone
                    ? {
                        label: canReturnToMenu ? t("management.backToMenu") : t("management.close"),
                        onBack: () => {
                          backToMenuRef.current = canReturnToMenu;
                          onOpenChange(false);
                        },
                      }
                    : undefined
                }
              />
            </Suspense>
          </LazyRouteErrorBoundary>
        </div>
      </DialogContent>
    </Dialog>
  );
}
