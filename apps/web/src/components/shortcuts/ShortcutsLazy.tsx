import "@/i18n/shortcuts-strings";
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useLocation } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { fetchAiActions } from "@/api/ai";
import { useSession } from "@/auth/useSession";
import { Button } from "@/components/ui/button";
import { cardSurface } from "@/components/ui/card";
import { ArrowLeft, ChevronLeft, ChevronRight } from "@/components/ui/icons";
import {
  managementBackTopPhone,
  managementContentTopPhone,
  managementHeadingUpPhone,
  managementCardPhone,
  managementCardPhoneInset,
  managementListHeaderPhone,
  managementListPaddingPhone,
  managementNavItemClass,
  managementNavListClass,
} from "@/components/management/tray";
import { isPhone, useIsPhone } from "@/lib/layout-tiers";
import { cn } from "@/lib/utils";
import { isMacPlatform } from "@/lib/platform";
import { useTour } from "@/lib/tour-context";
import { findUserMenuReturnTarget } from "@/lib/tour-find";
import type { ShortcutsStartPage } from "@/lib/shortcuts-dialog";
import { RELEASE_HIGHLIGHTS, visibleHighlightItems } from "./release-highlights";
import { visibleShortcuts, type KeyToken, type ShortcutCategory, type ShortcutEntry, type ShortcutKeys } from "./shortcut-list";

/**
 * Not routed, so the left column is state-driven buttons (`aria-current`), not `ManagementShell`'s NavLinks.
 * The AI section is listed only when the `["ai-actions"]` query has data, and the send-instruction entry only
 * when an action has `kind === "instruct"`; loading, error and an empty array all count as none.
 * Symbol keys are `aria-hidden` with an sr-only name beside them (screen readers can't read ⌘ ⇧ ↑); the `+` and
 * fullwidth-slash separators are `aria-hidden` too, and the slash gets an sr-only word from the entry's `sep`: "or"
 * for alternative ways to do the same thing, an enumeration comma for different actions.
 * Focus: opening lands on the right card's content (a focusable scroll container, so PageDown scrolls at
 * once). On wide screens picking a category leaves focus on the clicked item: `aria-current` and the right
 * card's region name (the category name) tell screen readers the content changed. On narrow screens focus
 * moves into the content, and back returns it to the current item.
 * This file imports `lib/tour-context` (first bundle) and `lib/tour-find` (not in the first bundle; finds the
 * user menu trigger after the tour) but nothing under `components/tour/`, keeping the tour strings and stop
 * table out of this chunk (enforced by release-highlights.guard.test.ts).
 */

type TFn = (key: string) => string;

function SymbolKey({ symbol, name }: { symbol: string; name: string }) {
  return (
    <>
      <span aria-hidden="true">{symbol}</span>
      <span className="sr-only">{name}</span>
    </>
  );
}

function keyLabel(token: KeyToken, mac: boolean, t: TFn): ReactNode {
  switch (token) {
    case "Mod":
      return mac ? <SymbolKey symbol="⌘" name={t("shortcutsGuide.srKeys.command")} /> : "Ctrl";
    case "Shift":
      return mac ? <SymbolKey symbol="⇧" name={t("shortcutsGuide.srKeys.shift")} /> : "Shift";
    case "Alt":
      return mac ? <SymbolKey symbol="⌥" name={t("shortcutsGuide.srKeys.option")} /> : "Alt";
    case "ArrowUp":
      return <SymbolKey symbol="↑" name={t("shortcutsGuide.srKeys.up")} />;
    case "ArrowDown":
      return <SymbolKey symbol="↓" name={t("shortcutsGuide.srKeys.down")} />;
    case "ArrowLeft":
      return <SymbolKey symbol="←" name={t("shortcutsGuide.srKeys.left")} />;
    case "ArrowRight":
      return <SymbolKey symbol="→" name={t("shortcutsGuide.srKeys.right")} />;
    case "Space":
      return t("shortcutsGuide.keys.space");
    case "Enter":
      return t("shortcutsGuide.keys.enter");
    case "Esc":
      return t("shortcutsGuide.keys.esc");
    case "Tab":
      return t("shortcutsGuide.keys.tab");
    case "Backspace":
      return t("shortcutsGuide.keys.backspace");
    case "Delete":
      return t("shortcutsGuide.keys.delete");
    case "Click":
      return t("shortcutsGuide.keys.click");
    default:
      return token;
  }
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-border bg-muted px-1.5 font-mono text-xs">{children}</kbd>;
}

function Plus() {
  return (
    <span aria-hidden="true" className="px-0.5 text-xs text-muted-foreground">
      +
    </span>
  );
}

function Combo({ keys, mac, t }: { keys: readonly KeyToken[]; mac: boolean; t: TFn }) {
  return (
    <>
      {keys.map((token, index) => (
        <Fragment key={index}>
          {index > 0 && <Plus />}
          <Kbd>{keyLabel(token, mac, t)}</Kbd>
        </Fragment>
      ))}
    </>
  );
}

/** `withSpace`: the typed trigger must be followed by a space, so a Space key is appended. */
function OneKeys({ keys, mac, t, withSpace }: { keys: ShortcutKeys; mac: boolean; t: TFn; withSpace: boolean }) {
  if (keys.kind === "combo") return <Combo keys={keys.keys} mac={mac} t={t} />;
  if (keys.kind === "typed") {
    return (
      <>
        <Kbd>{keys.text}</Kbd>
        {withSpace && (
          <>
            <Plus />
            <Kbd>{keyLabel("Space", mac, t)}</Kbd>
          </>
        )}
      </>
    );
  }
  return null;
}

function EntryKeys({ entry, mac, t }: { entry: ShortcutEntry; mac: boolean; t: TFn }) {
  const list = mac && entry.macKeys ? entry.macKeys : entry.keys;
  if (list.every((k) => k.kind === "action")) return null;
  // One trailing Space when every typed trigger needs it, instead of a row of repeated Spaces.
  const sharedSpace = list.every((k) => k.kind === "typed" && k.thenSpace === true);
  const sepName = entry.sep === "pair" ? t("shortcutsGuide.srKeys.pair") : t("shortcutsGuide.srKeys.or");
  return (
    <>
      {list.map((keys, index) => (
        <Fragment key={index}>
          {index > 0 && (
            <>
              <span aria-hidden="true" className="px-0.5 text-xs text-muted-foreground">
                ／
              </span>
              <span className="sr-only">{sepName}</span>
            </>
          )}
          <OneKeys keys={keys} mac={mac} t={t} withSpace={!sharedSpace && keys.kind === "typed" && keys.thenSpace === true} />
        </Fragment>
      ))}
      {sharedSpace && (
        <>
          <Plus />
          <Kbd>{keyLabel("Space", mac, t)}</Kbd>
        </>
      )}
    </>
  );
}

type Layer = "items" | "content";

type HelpPage = "tour" | "whatsNew" | ShortcutCategory;

/** Same `md` breakpoint as ManagementShell; only narrow viewports move focus. */
function isNarrowViewport(): boolean {
  return !window.matchMedia("(min-width: 768px)").matches;
}

/** Same as `ManagementShell`: phone cards sit flush with the sheet's left edge, so the button clears the left safe area itself. */
const PHONE_BACK_LEFT = "max-sm:left-[max(0.5rem,env(safe-area-inset-left))]";

/** Same as `ManagementShell`: the phone back button is 44x44 regardless of pointer type. */
const PHONE_BACK_HIT = "max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-[''] pointer-coarse:after:absolute pointer-coarse:after:-inset-2 pointer-coarse:after:content-['']";

/**
 * `onClose` runs before a tour starts. `listBack` (passed by the shell on phones) is the category list's "‹":
 * closes the dialog, or reopens the menu it was opened from; the shell provides its name.
 */
export function ShortcutsContent({
  startPage = "global",
  onClose,
  listBack,
}: {
  startPage?: ShortcutsStartPage;
  onClose: () => void;
  listBack?: { label: string; onBack: () => void };
}) {
  const { t } = useTranslation();
  const mac = isMacPlatform();
  const uid = useId();
  const location = useLocation();
  const tour = useTour();
  const { user } = useSession();
  const ai = useQuery({ queryKey: ["ai-actions"], queryFn: fetchAiActions });
  const actions = ai.data ?? [];
  const groups = visibleShortcuts({ aiAvailable: actions.length > 0, aiInstruct: actions.some((a) => a.kind === "instruct") });
  const tt: TFn = (key) => t(key);

  // The selected page falls back to the first if it disappears (e.g. the site disables AI while open).
  const pages: HelpPage[] = [...(tour ? (["tour"] as const) : []), "whatsNew", ...groups.map((g) => g.category)];
  const [selected, setSelected] = useState<HelpPage>(startPage);
  const activePage: HelpPage = pages.includes(selected) ? selected : pages[0]!;
  const activeGroup = groups.find((g) => g.category === activePage);
  const highlights = visibleHighlightItems(RELEASE_HIGHLIGHTS.items, user?.isAdmin === true);
  // Initially "content": 640-767px screens see content right away; phones (< 640px) start on the category list.
  const [layer, setLayer] = useState<Layer>(() => (isPhone() ? "items" : "content"));
  const phone = useIsPhone();
  const [focusRequest, setFocusRequest] = useState<{ target: Layer; seq: number } | null>(null);
  const seqRef = useRef(0);
  const navRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const contentId = `${uid}-content`;
  const headingId = `${uid}-heading`;
  const shortcutsLabelId = `${uid}-shortcuts-label`;

  function startTour(): void {
    if (!tour) return;
    // Close first: closing returns focus to the opener, and only then should the tour move it.
    onClose();
    tour.start({ returnTo: `${location.pathname}${location.search}${location.hash}`, returnFocus: findUserMenuReturnTarget });
  }

  const pageLabel = (page: "tour" | "whatsNew"): string => t(`helpGuide.nav.${page}`);
  const navButtonProps = (page: HelpPage) => ({
    "aria-current": page === activePage ? ("true" as const) : undefined,
    "data-shortcuts-focus": layer === "items" && !listBack && page === activePage ? "" : undefined,
    "aria-controls": contentId,
    onClick: () => {
      setSelected(page);
      switchTo("content");
    },
    className: cn(managementNavItemClass(page === activePage), "w-full text-left max-sm:w-auto"),
  });
  const navChevron = <ChevronRight aria-hidden="true" className="ml-auto h-4 w-4 shrink-0 sm:hidden" />;

  function switchTo(target: Layer): void {
    setLayer(target);
    if (!isNarrowViewport()) return; // wide viewports keep native focus (on the clicked item)
    seqRef.current += 1;
    setFocusRequest({ target, seq: seqRef.current });
  }

  // The target is display:none until setLayer commits, so a synchronous focus() fails silently in real browsers.
  useLayoutEffect(() => {
    if (focusRequest === null) return;
    if (focusRequest.target === "content") contentRef.current?.focus();
    else navRef.current?.querySelector<HTMLElement>('[aria-current="true"]')?.focus();
    setFocusRequest(null);
  }, [focusRequest]);

  // If this chunk arrives after the Dialog, the shell's onOpenAutoFocus found no target and focused the dialog itself; take over here.
  // The target is the visible layer's `[data-shortcuts-focus]`: the content area, or on a phone's category
  // list the list's back button (without one, the current category).
  useEffect(() => {
    const focused = document.activeElement;
    if (!focused || focused === document.body || focused.getAttribute("role") === "dialog") {
      document.querySelector<HTMLElement>("[data-shortcuts-focus]")?.focus();
    }
  }, []);

  return (
    <>
      <div
        data-shortcuts-card="items"
        className={cn(
          cardSurface,
          "relative w-full shrink-0 flex-col overflow-hidden p-4 md:w-64",
          managementCardPhone,
          managementListPaddingPhone,
          layer === "items" ? "flex" : "hidden",
          "md:flex",
        )}
      >
        {/* visual title only; the dialog's name is the shell's sr-only DialogTitle */}
        <div className={cn("mb-3 flex h-10 items-center gap-2 px-3", listBack && "pl-10", managementListHeaderPhone)}>
          {listBack && layer === "items" && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              data-shortcuts-focus={layer === "items" ? "" : undefined}
              className={cn("absolute left-2 top-2 z-10 h-7 w-7 bg-card", PHONE_BACK_LEFT, managementBackTopPhone, PHONE_BACK_HIT)}
              aria-label={listBack.label}
              onClick={listBack.onBack}
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </Button>
          )}
          <p aria-hidden="true" className="truncate text-[15px] font-semibold leading-tight tracking-normal max-sm:text-lg">
            {t("shortcuts.title")}
          </p>
        </div>
        <nav ref={navRef} aria-label={t("shortcuts.title")} className={managementNavListClass}>
          {tour && (
            <button type="button" data-help-page="tour" {...navButtonProps("tour")}>
              <span className="min-w-0 truncate">{pageLabel("tour")}</span>
              {navChevron}
            </button>
          )}
          <button type="button" data-help-page="whatsNew" {...navButtonProps("whatsNew")}>
            <span className="min-w-0 truncate">{pageLabel("whatsNew")}</span>
            {navChevron}
          </button>
          <div role="separator" className="my-2 h-px bg-border" />
          <div role="group" aria-labelledby={shortcutsLabelId} className="flex flex-col gap-1 max-sm:gap-0">
            <p id={shortcutsLabelId} className="px-3 pb-1 text-xs font-medium text-muted-foreground max-sm:px-0">
              {t("helpGuide.nav.shortcuts")}
            </p>
            {groups.map(({ category }) => (
              <button key={category} type="button" data-shortcuts-category={category} {...navButtonProps(category)}>
                <span className="min-w-0 truncate">{t(`shortcutsGuide.categories.${category}`)}</span>
                {navChevron}
              </button>
            ))}
          </div>
        </nav>
        {/* hint only, no button: the tour starts from the tour page's start button */}
        <div data-shortcuts-footer className="mt-auto flex flex-wrap items-center gap-2 border-t border-border px-1 pt-3 text-xs text-muted-foreground">
          <p>
            <Trans
              i18nKey="shortcutsGuide.footer"
              components={{
                keys: (
                  <span className="inline-flex items-center gap-1 align-middle">
                    <Combo keys={["Mod", "/"]} mac={mac} t={tt} />
                  </span>
                ),
              }}
            />
          </p>
        </div>
      </div>
      <div
        data-shortcuts-card="content"
        className={cn(
          cardSurface,
          "relative min-w-0 flex-1 flex-col overflow-hidden",
          managementCardPhone,
          managementCardPhoneInset,
          layer === "content" ? "flex" : "hidden",
          "md:flex",
        )}
      >
        {/* child order is load-bearing: back, content (close is earlier in the DOM, in the shell) */}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn("absolute left-2 top-2 z-10 h-7 w-7 bg-card md:hidden", PHONE_BACK_LEFT, managementBackTopPhone, PHONE_BACK_HIT)}
          aria-label={t("management.back")}
          onClick={() => switchTo("items")}
        >
          {phone ? <ChevronLeft className="h-4 w-4" aria-hidden="true" /> : <ArrowLeft className="h-4 w-4" aria-hidden="true" />}
        </Button>
        <div
          ref={contentRef}
          id={contentId}
          data-shortcuts-content=""
          data-shortcuts-focus={layer === "content" ? "" : undefined}
          role="region"
          aria-labelledby={headingId}
          tabIndex={0}
          className={cn("min-h-0 flex-1 overflow-y-auto p-4 pt-12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:p-8", managementContentTopPhone)}
        >
          {activePage === "tour" && (
            <section data-help-page-content="tour">
              <h3 id={headingId} className={cn("mb-1 text-base font-semibold max-sm:text-lg", managementHeadingUpPhone)}>
                {t("helpGuide.tour.heading")}
              </h3>
              <p className="mb-4 text-sm text-muted-foreground">{t("helpGuide.tour.intro")}</p>
              <Button type="button" onClick={startTour}>
                {t("helpGuide.tour.start")}
              </Button>
            </section>
          )}
          {activePage === "whatsNew" && (
            <section data-help-page-content="whatsNew">
              {highlights.length === 0 ? (
                <>
                  <h3 id={headingId} className="sr-only">
                    {pageLabel("whatsNew")}
                  </h3>
                  <p className="text-sm text-muted-foreground">{t("helpGuide.whatsNew.empty")}</p>
                </>
              ) : (
                <>
                  <h3 id={headingId} className={cn("mb-1 text-base font-semibold max-sm:text-lg", managementHeadingUpPhone)}>
                    {t("helpGuide.whatsNew.heading", { version: RELEASE_HIGHLIGHTS.version })}
                  </h3>
                  <ul className="divide-y divide-border">
                    {highlights.map((item) => (
                      <li key={item.id} data-highlight-id={item.id} className="py-2.5">
                        <p className="text-sm font-medium max-sm:text-base">{t(`helpGuide.whatsNew.items.${item.id}.title`)}</p>
                        <p className="text-sm text-muted-foreground">{t(`helpGuide.whatsNew.items.${item.id}.desc`, { mod: mac ? "⌘" : "Ctrl+" })}</p>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}
          {activeGroup && (
            <section data-shortcut-category={activeGroup.category}>
              <h3 id={headingId} className={cn("mb-1 text-base font-semibold max-sm:text-lg", managementHeadingUpPhone)}>
                {t(`shortcutsGuide.categories.${activeGroup.category}`)}
              </h3>
              <ul className="divide-y divide-border">
                {activeGroup.entries.map((entry) => (
                  <li key={entry.id} data-shortcut-id={entry.id} className="flex flex-col gap-1.5 py-2.5 sm:flex-row sm:gap-4">
                    <div className="flex shrink-0 flex-wrap items-center gap-1 sm:w-56">
                      <EntryKeys entry={entry} mac={mac} t={tt} />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium max-sm:text-base">{t(`shortcutsGuide.items.${entry.id}.name`)}</p>
                      <p className="text-sm text-muted-foreground">{t(`shortcutsGuide.items.${entry.id}.desc`)}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
