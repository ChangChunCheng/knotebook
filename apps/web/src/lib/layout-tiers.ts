import { useSyncExternalStore } from "react";

/**
 * 版面三段的判準，版面段只有這兩個：
 * - 手機：視窗比 40rem（640px）窄，與 Tailwind 預設的 `sm` 同界，CSS 端用 `sm:`／`max-sm:`。
 * - 浮動或手機（側欄、版本面板不固定）：視窗比 80rem（1280px）窄，與 Tailwind 預設的 `xl` 同界，CSS 端用 `xl:`／`max-xl:`。
 * 另有一個指標能力的查詢 `NO_HOVER_QUERY`（沒有 hover 的觸控裝置），不是版面段。
 * JS 端一律 import 這裡的常數或 hook，不在別處另寫 `matchMedia(…)`。
 * 查詢字串寫成 Tailwind build 後 CSS 實際輸出的形（`not all and (min-width: …)`），不用 range 語法：
 * 舊瀏覽器上 CSS 與 JS 對同一寬度判成同一段。
 */
export const PHONE_QUERY = "not all and (min-width: 40rem)";
export const OVERLAY_QUERY = "not all and (min-width: 80rem)";
export const NO_HOVER_QUERY = "(hover: none)";
/** Heading outline only: below 48rem (768px, Tailwind `md`) it is the position bubble and bottom sheet instead of the rail. Not a layout tier. */
export const OUTLINE_COMPACT_QUERY = "not all and (min-width: 48rem)";

function matches(query: string): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}

/** 視窗比 640px 窄。沒有 matchMedia（SSR／極舊環境）回 false。 */
export function isPhone(): boolean {
  return matches(PHONE_QUERY);
}

/** 視窗比 1280px 窄（含手機）。沒有 matchMedia 回 false。 */
export function isOverlay(): boolean {
  return matches(OVERLAY_QUERY);
}

/** 視窗比 768px 窄（標題大綱用手機形）。沒有 matchMedia 回 false。 */
export function isOutlineCompact(): boolean {
  return matches(OUTLINE_COMPACT_QUERY);
}

/** 主要指標不能 hover（觸控）。沒有 matchMedia 回 false。 */
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

/** 訂閱 `PHONE_QUERY` 的 change，翻轉即重繪。 */
export function useIsPhone(): boolean {
  return useSyncExternalStore(subscribePhone, isPhone, () => false);
}

/** 訂閱 `OVERLAY_QUERY` 的 change，翻轉即重繪。 */
export function useIsOverlay(): boolean {
  return useSyncExternalStore(subscribeOverlay, isOverlay, () => false);
}

/** 訂閱 `OUTLINE_COMPACT_QUERY` 的 change，翻轉即重繪。 */
export function useIsOutlineCompact(): boolean {
  return useSyncExternalStore(subscribeOutlineCompact, isOutlineCompact, () => false);
}

/** 訂閱 `NO_HOVER_QUERY` 的 change，翻轉即重繪。 */
export function useNoHover(): boolean {
  return useSyncExternalStore(subscribeNoHover, isNoHover, () => false);
}
