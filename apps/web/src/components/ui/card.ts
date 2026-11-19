/** Single source of the card surface shared by ~12 places; callers use `cn(cardSurface, "<other classes>")`. A constant, not a component: the call sites span `<aside>`/`<div>` with their own layout classes, and a component would need `asChild` or change the DOM shape, breaking layout tests that assert tag/class chains. */
export const cardSurface = "rounded-xl border border-border bg-card";
