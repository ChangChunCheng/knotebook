import { useSyncExternalStore } from "react";

/**
 * Phone = Tailwind `sm` (640px), overlay = `xl` (1280px). Query strings use the form Tailwind
 * emits (`not all and (min-width: …)`), not range syntax, so CSS and JS classify the same width
 * identically on older browsers.
 */
export const PHONE_QUERY = "not all and (min-width: 40rem)";
export const OVERLAY_QUERY = "not all and (min-width: 80rem)";
export const NO_HOVER_QUERY = "(hover: none)";
/** Heading outline only (Tailwind `md`); not a layout tier. */
export const OUTLINE_COMPACT_QUERY = "not all and (min-width: 48rem)";

function matches(query: string): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}

export function isPhone(): boolean {
  return matches(PHONE_QUERY);
}

export function isOverlay(): boolean {
  return matches(OVERLAY_QUERY);
}

export function isOutlineCompact(): boolean {
  return matches(OUTLINE_COMPACT_QUERY);
}

export function isNoHover(): boolean {
  return matches(NO_HOVER_QUERY);
}

function subscribeTo(query: string) {
  return (onChange: () => void): (() => void) => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
    const mql = window.matchMedia(query);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  };
}

const subscribePhone = subscribeTo(PHONE_QUERY);
const subscribeOverlay = subscribeTo(OVERLAY_QUERY);
const subscribeOutlineCompact = subscribeTo(OUTLINE_COMPACT_QUERY);
const subscribeNoHover = subscribeTo(NO_HOVER_QUERY);

export function useIsPhone(): boolean {
  return useSyncExternalStore(subscribePhone, isPhone, () => false);
}

export function useIsOverlay(): boolean {
  return useSyncExternalStore(subscribeOverlay, isOverlay, () => false);
}

export function useIsOutlineCompact(): boolean {
  return useSyncExternalStore(subscribeOutlineCompact, isOutlineCompact, () => false);
}

export function useNoHover(): boolean {
  return useSyncExternalStore(subscribeNoHover, isNoHover, () => false);
}
