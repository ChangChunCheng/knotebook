import { createContext, useContext } from "react";

/** Context only, so `UserMenu` need not import `AppShell.tsx` (AppShell→SidebarContent→UserMenu→AppShell cycle). */

export type ShortcutsStartPage = "tour" | "global";

export interface ShortcutsDialogApi {
  /** `returnFocusTo` defaults to the element focused at open; `page` defaults to "global"; `reopenMenu`: on phones the "‹" of the item list closes the dialog and calls it (omitted: only closes). */
  open: (returnFocusTo?: HTMLElement | null, page?: ShortcutsStartPage, reopenMenu?: () => void) => void;
}

/** null outside AppShell: the menu then omits the item instead of showing a dead one. */
export const ShortcutsDialogContext = createContext<ShortcutsDialogApi | null>(null);

export function useShortcutsDialog(): ShortcutsDialogApi | null {
  return useContext(ShortcutsDialogContext);
}
