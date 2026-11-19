/** Range 200-480: the lower bound keeps about 3 CJK characters of a group note title; no upper bound relative to the window (double-click the handle to reset). Floating drawer reuses the value, capped at window width - 4rem. */
export const SIDEBAR_WIDTH_DEFAULT = 320; // same as the versions panel's default width (VERSIONS_PANEL_WIDTH_DEFAULT)
export const SIDEBAR_WIDTH_MIN = 200;
export const SIDEBAR_WIDTH_MAX = 480;
export const SIDEBAR_WIDTH_STEP = 16;
export const SIDEBAR_WIDTH_STORAGE_KEY = "sidebar.width";

export function clampSidebarWidth(px: number): number {
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(px)));
}

/** A bad value is usually from an old version or a hand edit: default, do not clamp. */
export function readSidebarWidth(): number {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (raw === null) return SIDEBAR_WIDTH_DEFAULT;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < SIDEBAR_WIDTH_MIN || value > SIDEBAR_WIDTH_MAX) return SIDEBAR_WIDTH_DEFAULT;
    return value;
  } catch {
    return SIDEBAR_WIDTH_DEFAULT;
  }
}

export function writeSidebarWidth(px: number): void {
  try {
    if (px === SIDEBAR_WIDTH_DEFAULT) window.localStorage.removeItem(SIDEBAR_WIDTH_STORAGE_KEY);
    else window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(px));
  } catch {
    // Unwritable storage: the width stays only in this session's state.
  }
}
