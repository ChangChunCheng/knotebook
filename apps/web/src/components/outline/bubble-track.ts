/**
 * Geometry for the outline bubble's track: the vertical strip along the right edge that the chip slides along, where the
 * chip's place on the track is how far down the note the reader has scrolled.
 */

/** Height of the chip (`h-9`). */
export const OUTLINE_BUBBLE_HEIGHT_PX = 36;
/** Gap between the anchored track and the top and bottom of the scroll container (`top-2`). */
export const OUTLINE_TRACK_GAP_PX = 8;

export interface ScrollMetrics {
  top: number;
  max: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function readScrollMetrics(target: HTMLElement | Window): ScrollMetrics {
  if (!(target instanceof HTMLElement)) {
    return {
      top: target.scrollY,
      max: Math.max(0, document.documentElement.scrollHeight - target.innerHeight),
    };
  }
  return { top: target.scrollTop, max: Math.max(0, target.scrollHeight - target.clientHeight) };
}

export function scrollFraction(m: ScrollMetrics): number {
  return m.max <= 0 ? 0 : clamp(m.top / m.max, 0, 1);
}

export interface BottomReserveInput {
  placement: "page" | "anchor";
  keyboardInset: number;
  colorPanelHeight: number;
  editToolbarHeight: number;
  bottomReserve: number;
  /** `anchor` only: distance from the bottom of the scroll container to the bottom of the window. */
  containerBottomGap: number;
}

/** Space to keep clear at the bottom of the track. */
export function trackBottomReserve(i: BottomReserveInput): number {
  // The anchored track lives in the scroll container: only the part of the keyboard that overlaps it counts.
  if (i.placement === "anchor") return Math.max(i.bottomReserve, i.keyboardInset - i.containerBottomGap, 0);
  // The edit toolbar is fixed at the keyboard's top edge with the colour panel (when open) between them, so they stack;
  // each of the two is 0 while it is closed.
  if (i.editToolbarHeight > 0) return i.keyboardInset + i.colorPanelHeight + i.editToolbarHeight;
  return Math.max(i.keyboardInset, i.bottomReserve);
}
