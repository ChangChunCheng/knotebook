
// Pure functions; all coordinates are viewport coordinates (the `getBoundingClientRect` kind).
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export type Placement = "bottom" | "top" | "right" | "left" | "center";

/** Distances in px inward from each viewport edge. */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

export function sameInsets(a: Insets, b: Insets): boolean {
  return a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;
}

export interface CardPlacement {
  placement: Placement;
  left: number;
  top: number;
}

/** The cutout grows past the target: the outline is drawn on the cutout edge and would cover the target's own border and focus ring. */
export const HOLE_PADDING = 6;
export const HOLE_RADIUS = 8;
export const CARD_GAP = 20;
export const VIEWPORT_MARGIN = 8;

const rightOf = (r: Rect) => r.left + r.width;
const bottomOf = (r: Rect) => r.top + r.height;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function padRect(r: Rect, pad: number = HOLE_PADDING): Rect {
  return { left: r.left - pad, top: r.top - pad, width: r.width + pad * 2, height: r.height + pad * 2 };
}

export function unionRect(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map(rightOf));
  const bottom = Math.max(...rects.map(bottomOf));
  return { left, top, width: right - left, height: bottom - top };
}

/** If the area is smaller than the card, top and left win (the card's max size follows the same area, see `cardMaxSize`). */
function cardBounds(viewport: Size, insets: Insets): { minX: number; maxX: number; minY: number; maxY: number } {
  const m = VIEWPORT_MARGIN;
  return { minX: insets.left + m, maxX: viewport.width - insets.right - m, minY: insets.top + m, maxY: viewport.height - insets.bottom - m };
}

/** Minimum card-area height after subtracting `keepOut`; below it (e.g. a 568×320 landscape phone) `keepOut` isn't avoided. */
export const MIN_CARD_ROOM = 160;

function maxInsets(a: Insets, b: Insets): Insets {
  return { top: Math.max(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom), left: Math.max(a.left, b.left) };
}

/** If subtracting `keepOut` leaves less than `MIN_CARD_ROOM`, `keepOut` is ignored: overlapping the header or round buttons beats a sliver too narrow to read. The part covered by the keyboard is never used. */
export function cardInsets(safeArea: Insets, keepOut: Insets, viewport: Size, blocked: Insets = NO_INSETS): Insets {
  const base = maxInsets(safeArea, blocked);
  const merged = maxInsets(base, keepOut);
  return cardMaxSize(viewport, merged).height < MIN_CARD_ROOM ? base : merged;
}

export function cardMaxSize(viewport: Size, insets: Insets = NO_INSETS): Size {
  const b = cardBounds(viewport, insets);
  return { width: Math.max(0, b.maxX - b.minX), height: Math.max(0, b.maxY - b.minY) };
}

/** "Fits" looks only at the direction perpendicular to the cutout; the other axis is centred on the cutout and clamped, so the card never leaves the area. A cutout inside a subtracted band (e.g. the phone header's "‹") still gets the card outside the band, with a longer arrow. */
export function placeCard(hole: Rect | null, card: Size, viewport: Size, insets: Insets = NO_INSETS): CardPlacement {
  const { minX, maxX, minY, maxY } = cardBounds(viewport, insets);
  const xRange = (left: number) => clamp(left, minX, maxX - card.width);
  const yRange = (top: number) => clamp(top, minY, maxY - card.height);
  if (hole !== null) {
    const centerX = hole.left + hole.width / 2 - card.width / 2;
    const centerY = hole.top + hole.height / 2 - card.height / 2;
    const below = Math.max(bottomOf(hole) + CARD_GAP, minY);
    if (below + card.height <= maxY) {
      return { placement: "bottom", left: xRange(centerX), top: below };
    }
    const above = Math.min(hole.top - CARD_GAP, maxY) - card.height;
    if (above >= minY) {
      return { placement: "top", left: xRange(centerX), top: above };
    }
    const right = Math.max(rightOf(hole) + CARD_GAP, minX);
    if (right + card.width <= maxX) {
      return { placement: "right", left: right, top: yRange(centerY) };
    }
    const left = Math.min(hole.left - CARD_GAP, maxX) - card.width;
    if (left >= minX) {
      return { placement: "left", left, top: yRange(centerY) };
    }
  }
  const left = xRange((minX + maxX - card.width) / 2);
  if (hole === null) return { placement: "center", left, top: yRange((minY + maxY - card.height) / 2) };
  // Cutout too big for any side (e.g. a menu filling a narrow window): stick to the top or bottom of the area, whichever covers less of the cutout; the menu items it overlaps are hidden (the tour layer is above the menu), so less coverage = more readable items; tie → bottom.
  const overlap = (cardTop: number) => Math.max(0, Math.min(bottomOf(hole), cardTop + card.height) - Math.max(hole.top, cardTop));
  const topEdge = yRange(minY);
  const bottomEdge = yRange(maxY - card.height);
  return { placement: "center", left, top: overlap(topEdge) < overlap(bottomEdge) ? topEdge : bottomEdge };
}

/** The endpoint avoids the cutout's rounded corners so the arrow lands on a straight segment of the outline. A centred card doesn't touch the cutout: no arrow. */
export function arrowPath(hole: Rect, card: Rect, placement: Placement): { d: string; from: Point; to: Point } | null {
  const r = HOLE_RADIUS;
  let from: Point;
  let to: Point;
  switch (placement) {
    case "bottom":
    case "top": {
      const x = clamp(hole.left + hole.width / 2, card.left, rightOf(card));
      from = { x, y: placement === "bottom" ? card.top : bottomOf(card) };
      to = { x: clamp(x, hole.left + r, rightOf(hole) - r), y: placement === "bottom" ? bottomOf(hole) : hole.top };
      break;
    }
    case "right":
    case "left": {
      const y = clamp(hole.top + hole.height / 2, card.top, bottomOf(card));
      from = { x: placement === "right" ? card.left : rightOf(card), y };
      to = { x: placement === "right" ? rightOf(hole) : hole.left, y: clamp(y, hole.top + r, bottomOf(hole) - r) };
      break;
    }
    case "center":
      return null;
  }
  return { d: `M ${from.x} ${from.y} L ${to.x} ${to.y}`, from, to };
}
