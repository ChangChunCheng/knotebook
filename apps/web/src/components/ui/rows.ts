/**
 * Shared row height for the sidebar footer account row and the note card's backlinks row: both sit on their cards' bottom edge side by side, and computing each separately would drift when either's padding changes. Consumers: `UserMenu.tsx` trigger, `BacklinksSection.tsx` inner flex row.
 * Both containers' vertical padding (`p-2`/`py-2`) and top `border-t` must stay equal too; this constant covers only the content row (`rows.equal-height.test.ts` pins the usage; padding is guarded by each component's class assertions).
 */
export const SIDEBAR_ROW_HEIGHT = "h-9";

/**
 * Geometry for the backlinks strip's chips container (row 36px + scrollbar 6px). The three values interlock: change one, recompute the rest.
 *   `h-[42px]`        = `SIDEBAR_ROW_HEIGHT` (36) + scrollbar 6
 *   `-mb-1.5`         -6px pulls the margin box back to 36, so the row isn't taller; the scrollbar falls below the row, into the footer's `py-2` space
 *   `scrollbar-x-thin` index.css class: this strip's 6px scrollbar (global is 10px) + 1px thumb border. Not Tailwind's arbitrary-variant spelling (pseudo-element in the class name): that lands in `@layer utilities` and loses to index.css top-level rules (the scrollbar stayed 10px).
 *                     The class name isn't written literally here either: Tailwind's scanner doesn't skip comments, so it would emit dead CSS for it.
 * Kept next to `SIDEBAR_ROW_HEIGHT` so changing the row height shows this must change too; trade-offs in `BacklinksSection.tsx`.
 */
export const BACKLINKS_SCROLL_ROW = "h-[42px] -mb-1.5 scrollbar-x-thin";
