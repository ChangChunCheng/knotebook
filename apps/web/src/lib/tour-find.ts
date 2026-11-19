/**
 * Every call re-queries the DOM: AppShell is swapped on navigation, so earlier results may be unmounted.
 * The tour's layout criterion lives only here (`tourLayout`); width breakpoints are in `lib/layout-tiers.ts`.
 * Imported only by the tour's lazy chain and the help dialog's lazy chunk, to stay out of the main bundle.
 */

import { isOverlay, isPhone, useIsOverlay, useIsPhone } from "@/lib/layout-tiers";
import { TOUR_TARGET_ATTR, type TourTargetId } from "@/lib/tour-targets";

/**
 * The sidebar exists twice (static card and drawer) with the same attribute: while the drawer is open Radix marks
 * everything outside it `aria-hidden`, so the drawer's copy wins. CSS invisibility is not checked here.
 */
export function findTourTarget(id: TourTargetId, root: ParentNode = document): Element | null {
  for (const el of root.querySelectorAll(`[${TOUR_TARGET_ATTR}="${id}"]`)) {
    if (el.closest('[aria-hidden="true"], [inert]') === null) return el;
  }
  return null;
}

/** The formatting toolbar is a portaled popover and its buttons carry no tour attribute: found by name, scoped to the popover so user content cannot clash. */
export function findFormattingToolbarButton(name: string): Element | null {
  for (const popover of document.querySelectorAll("[data-kb-formatting-toolbar-popover]")) {
    if (popover.closest('[aria-hidden="true"], [inert]') !== null) continue;
    for (const button of popover.querySelectorAll("button")) {
      if (button.getAttribute("aria-label") === name) return button;
    }
  }
  return null;
}

export function findDrawerButton(): Element | null {
  return findTourTarget("drawerButton");
}

export function findUserMenuTrigger(): Element | null {
  return findTourTarget("userMenu");
}

export type TourLayout = "wide" | "floating" | "phone";

export function tourLayout(): TourLayout {
  if (isPhone()) return "phone";
  return isOverlay() ? "floating" : "wide";
}

export function useTourLayout(): TourLayout {
  const phone = useIsPhone();
  const overlay = useIsOverlay();
  if (phone) return "phone";
  return overlay ? "floating" : "wide";
}

/** Floating: the user menu is in the closed drawer, so fall back to the drawer button; phone: the avatar in the list's top bar (the tour ends on the list). */
export function findUserMenuReturnTarget(): Element | null {
  return tourLayout() === "floating" ? findDrawerButton() : findUserMenuTrigger();
}
