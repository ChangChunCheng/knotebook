import { createContext, useContext } from "react";

/** The phone ⋮ menu's "Heading outline" entry: whether it applies to the open note, and how to open the sheet. */
export interface OutlineMenuValue {
  available: boolean;
  /** Opens the sheet. `returnFocusTo`: where focus goes when it closes, unless the editor takes it back (the ⋮ passes its trigger). */
  open: (returnFocusTo?: HTMLElement | null) => void;
}

const NO_OUTLINE_MENU: OutlineMenuValue = { available: false, open: () => {} };

/**
 * Provided by the note editor around its whole card, header slot included, so the header ⋮ can reach it.
 * The sidebar's per-row ⋮ menus sit outside any provider and get the default: no entry.
 */
export const OutlineMenuContext = createContext<OutlineMenuValue>(NO_OUTLINE_MENU);

export function useOutlineMenu(): OutlineMenuValue {
  return useContext(OutlineMenuContext);
}
