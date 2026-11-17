/**
 * 功能導覽遮罩的幾何：挖洞範圍、卡片位置、箭頭。全部是純函式，座標一律是視窗座標（`getBoundingClientRect` 那一套）。
 */

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

/** 從視窗四邊往內量的距離（px）。 */
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

/** 挖洞比目標往外擴的距離：外框畫在洞的邊上，貼著目標畫會壓到目標自己的邊框與 focus ring。 */
export const HOLE_PADDING = 6;
export const HOLE_RADIUS = 8;
/** 卡片與挖洞之間的距離，箭頭畫在這段空隙裡。 */
export const CARD_GAP = 20;
/** 卡片離視窗邊緣（有 `insets` 時是離它們圍出的範圍）至少這麼遠。 */
export const VIEWPORT_MARGIN = 8;

const rightOf = (r: Rect) => r.left + r.width;
const bottomOf = (r: Rect) => r.top + r.height;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function padRect(r: Rect, pad: number = HOLE_PADDING): Rect {
  return { left: r.left - pad, top: r.top - pad, width: r.width + pad * 2, height: r.height + pad * 2 };
}

/** 多個目標合成一個挖洞範圍（例如頁首的「分享」與 ⋮）。 */
export function unionRect(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map(rightOf));
  const bottom = Math.max(...rects.map(bottomOf));
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * 卡片能放的範圍：視窗扣掉 `insets`（瀏海等 safe area、手機上釘住的頁首與底部的圓形鈕），再往內 `VIEWPORT_MARGIN`。
 * 範圍比卡片小時以上緣、左緣為準（卡片自己的最大尺寸也照這個範圍設，見 `cardMaxSize`）。
 */
function cardBounds(viewport: Size, insets: Insets): { minX: number; maxX: number; minY: number; maxY: number } {
  const m = VIEWPORT_MARGIN;
  return { minX: insets.left + m, maxX: viewport.width - insets.right - m, minY: insets.top + m, maxY: viewport.height - insets.bottom - m };
}

/** 扣掉 `keepOut` 之後卡片範圍至少要有這麼高；不夠（例如橫拿的小手機，568×320）就不避開它們。 */
export const MIN_CARD_ROOM = 160;

/** 每邊取大的。 */
function maxInsets(a: Insets, b: Insets): Insets {
  return { top: Math.max(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom), left: Math.max(a.left, b.left) };
}

/**
 * 卡片要讓開的邊：safe area、`blocked`（螢幕鍵盤、鍵盤上方的工具列，一律讓開）與 `keepOut`（頁首、圓形鈕）每邊取大的。
 * 連 `keepOut` 也扣掉後剩下的高度不到 `MIN_CARD_ROOM` 時不讓 `keepOut`：卡片疊在頁首或圓形鈕上，總比擠成一條讀不到的窄縫好；
 * 被鍵盤蓋住的部分怎樣都不能放。
 */
export function cardInsets(safeArea: Insets, keepOut: Insets, viewport: Size, blocked: Insets = NO_INSETS): Insets {
  const base = maxInsets(safeArea, blocked);
  const merged = maxInsets(base, keepOut);
  return cardMaxSize(viewport, merged).height < MIN_CARD_ROOM ? base : merged;
}

/** 卡片最大的寬高：能放的範圍（見 `cardBounds`），至少留 0。 */
export function cardMaxSize(viewport: Size, insets: Insets = NO_INSETS): Size {
  const b = cardBounds(viewport, insets);
  return { width: Math.max(0, b.maxX - b.minX), height: Math.max(0, b.maxY - b.minY) };
}

/**
 * 卡片放哪裡：下方放得下就放下方，否則依序試上、右、左，都放不下就貼範圍的上緣或下緣（蓋到挖洞比較少的一邊）、水平置中；沒有挖洞就整個置中。
 * 「放得下」只看與挖洞垂直的那個方向；另一個方向對齊挖洞中心後夾在範圍內，所以卡片不會出界。
 * 範圍是視窗扣掉 `insets`：挖洞在被扣掉的邊帶裡（例如手機頁首的「‹」）時，卡片仍放在邊帶外，箭頭拉長一點。
 */
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
  // 挖洞大到四邊都放不下（例如窄視窗裡撐滿整個畫面的選單）：卡片貼範圍的上緣或下緣，挑蓋到挖洞比較少的一邊，
  // 疊到的那一段選單項目會被卡片擋住（導覽層在選單之上），蓋得少就讀得到的項目多；一樣多就貼下緣。
  const overlap = (cardTop: number) => Math.max(0, Math.min(bottomOf(hole), cardTop + card.height) - Math.max(hole.top, cardTop));
  const topEdge = yRange(minY);
  const bottomEdge = yRange(maxY - card.height);
  return { placement: "center", left, top: overlap(topEdge) < overlap(bottomEdge) ? topEdge : bottomEdge };
}

/**
 * 箭頭：從卡片對著挖洞的那條邊，畫直線到挖洞對著卡片的那條邊。挖洞中心落在卡片的寬（或高）範圍內時，是一條垂直（或水平）的線。
 * 終點避開挖洞的圓角，箭頭才會落在外框的直線段上。置中時卡片不靠著挖洞，不畫箭頭。
 */
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
