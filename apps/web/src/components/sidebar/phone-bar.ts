/**
 * Shared outer frame so the search bar and the select action bar have the same height. The keyboard covers the bottom safe area, so no padding for it then.
 * Phones scroll the document: the bar is the list screen's last child, `sticky` at the window bottom, and takes its own height in flow so the last row can scroll above it.
 */
export const PHONE_BAR_FRAME = "shrink-0 border-t border-border bg-card px-2 pt-1.5 max-sm:sticky max-sm:bottom-0 max-sm:z-20";

export const PHONE_BAR_CONTROL_HEIGHT = "min-h-11";

export function phoneBarBottomPadding(keyboardOpen: boolean): string {
  return keyboardOpen ? "pb-1.5" : "pb-[calc(0.375rem+env(safe-area-inset-bottom))]";
}

export const PHONE_TOP_BAR_STICKY = "max-sm:sticky max-sm:top-0 max-sm:z-30 max-sm:bg-card";

/** Pinned right under the top bar (48 + top safe area, `data-phone-top-bar` in `AppShell`) so it stays reachable mid-list. */
export const PHONE_LIST_HEADER_STICKY = "max-sm:sticky max-sm:top-[calc(3rem+env(safe-area-inset-top))] max-sm:z-20 max-sm:bg-card";

/** Scroll container: on phones it doesn't scroll itself (the document does). */
export const PHONE_LIST_SCROLLER = "max-sm:overflow-y-visible";
