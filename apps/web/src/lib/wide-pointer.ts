import { useSyncExternalStore } from "react";

/** Decides the menu interaction form, not a layout breakpoint (see `layout-tiers.ts`). A browser without range-syntax support never matches → narrow. */
export const WIDE_POINTER_QUERY = "(width >= 48rem) and (hover: hover) and (pointer: fine)";

export function isWidePointer(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(WIDE_POINTER_QUERY).matches;
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mql = window.matchMedia(WIDE_POINTER_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

export function useWidePointer(): boolean {
  return useSyncExternalStore(subscribe, isWidePointer, () => false);
}
