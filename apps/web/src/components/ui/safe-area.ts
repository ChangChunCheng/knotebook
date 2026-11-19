/** `index.html` sets `viewport-fit=cover`, which extends content under notches and the Home indicator, so edge-hugging layouts back off with `env(safe-area-inset-*)`; where there is no inset `env()` is 0 and `max(base, inset)` is the base. Four sides written separately (no shorthand): Tailwind arbitrary values map to a single property, and class literals must appear in full, so these are constant strings. */

export const SAFE_FRAME_PADDING =
  "pt-[max(0.75rem,env(safe-area-inset-top))] pr-[max(0.75rem,env(safe-area-inset-right))] pb-[max(0.75rem,env(safe-area-inset-bottom))] pl-[max(0.75rem,env(safe-area-inset-left))]";

export const SAFE_PAGE_PADDING =
  "pt-[max(2rem,env(safe-area-inset-top))] pr-[max(2rem,env(safe-area-inset-right))] pb-[max(2rem,env(safe-area-inset-bottom))] pl-[max(2rem,env(safe-area-inset-left))]";

export const SAFE_PAGE_PADDING_COMPACT =
  "pt-[max(1.5rem,env(safe-area-inset-top))] pr-[max(1.5rem,env(safe-area-inset-right))] pb-[max(1.5rem,env(safe-area-inset-bottom))] pl-[max(1.5rem,env(safe-area-inset-left))]";

export const SAFE_INSETS =
  "pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]";
