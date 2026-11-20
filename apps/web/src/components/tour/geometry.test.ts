import { describe, expect, it } from "vitest";
import {
  arrowPath,
  CARD_GAP,
  cardInsets,
  cardMaxSize,
  MIN_CARD_ROOM,
  HOLE_PADDING,
  HOLE_RADIUS,
  padRect,
  placeCard,
  unionRect,
  VIEWPORT_MARGIN,
  type Insets,
  type Rect,
  type Size,
} from "./geometry";

const VIEWPORT: Size = { width: 1280, height: 720 };
const CARD: Size = { width: 320, height: 160 };

const right = (r: Rect) => r.left + r.width;
const bottom = (r: Rect) => r.top + r.height;

function cardRect(hole: Rect | null, card: Size = CARD, viewport: Size = VIEWPORT): Rect {
  const p = placeCard(hole, card, viewport);
  return { left: p.left, top: p.top, width: card.width, height: card.height };
}

function expectInside(card: Rect, viewport: Size = VIEWPORT) {
  expect(card.left).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
  expect(card.top).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
  expect(right(card)).toBeLessThanOrEqual(viewport.width - VIEWPORT_MARGIN);
  expect(bottom(card)).toBeLessThanOrEqual(viewport.height - VIEWPORT_MARGIN);
}

function expectNoOverlap(a: Rect, b: Rect) {
  const overlaps = a.left < right(b) && b.left < right(a) && a.top < bottom(b) && b.top < bottom(a);
  expect(overlaps).toBe(false);
}

describe("padRect / unionRect", () => {
  it("the hole grows outward by 6px with an 8px corner radius", () => {
    expect(HOLE_PADDING).toBe(6);
    expect(HOLE_RADIUS).toBe(8);
    expect(padRect({ left: 100, top: 50, width: 40, height: 20 })).toEqual({ left: 94, top: 44, width: 52, height: 32 });
  });

  it("multiple targets give their union; no target gives null", () => {
    expect(
      unionRect([
        { left: 140, top: 5, width: 30, height: 20 },
        { left: 100, top: 10, width: 30, height: 30 },
      ]),
    ).toEqual({ left: 100, top: 5, width: 70, height: 35 });
    expect(unionRect([])).toBeNull();
  });
});

describe("placeCard: bottom, top, right, left; if none fits and there is a hole, stick to the top or bottom edge (the one covering less), with no hole center", () => {
  it("fits below -> placed below, horizontally centered on the target", () => {
    const hole: Rect = { left: 500, top: 100, width: 80, height: 40 };
    const p = placeCard(hole, CARD, VIEWPORT);
    expect(p.placement).toBe("bottom");
    expect(p.top).toBe(bottom(hole) + CARD_GAP);
    expect(p.left + CARD.width / 2).toBe(hole.left + hole.width / 2);
  });

  it("does not fit below but fits above -> placed above", () => {
    const hole: Rect = { left: 500, top: 600, width: 80, height: 40 };
    const p = placeCard(hole, CARD, VIEWPORT);
    expect(p.placement).toBe("top");
    expect(p.top + CARD.height).toBe(hole.top - CARD_GAP);
  });

  it("fits neither above nor below but fits on the right -> placed right, vertically centered on the target", () => {
    const hole: Rect = { left: 20, top: 100, width: 200, height: 520 };
    const p = placeCard(hole, CARD, VIEWPORT);
    expect(p.placement).toBe("right");
    expect(p.left).toBe(right(hole) + CARD_GAP);
    expect(p.top + CARD.height / 2).toBe(hole.top + hole.height / 2);
  });

  it("fits none of above, below, right -> placed left", () => {
    const hole: Rect = { left: 1000, top: 100, width: 260, height: 520 };
    const p = placeCard(hole, CARD, VIEWPORT);
    expect(p.placement).toBe("left");
    expect(p.left + CARD.width).toBe(hole.left - CARD_GAP);
  });

  it("fits on no side -> horizontally centered, against the bottom edge (when top and bottom cover the same amount)", () => {
    const hole: Rect = { left: 10, top: 10, width: 1260, height: 700 };
    const p = placeCard(hole, CARD, VIEWPORT);
    expect(p.placement).toBe("center");
    expect(p.left).toBe((VIEWPORT.width - CARD.width) / 2);
    expect(p.top).toBe(VIEWPORT.height - VIEWPORT_MARGIN - CARD.height);
  });

  it("fits on no side -> against the top or bottom edge, whichever covers less of the hole", () => {
    const wide: Rect = { left: 10, top: 40, width: 1260, height: 670 };
    // The hole spans 40 to 710: against the top edge (8-168) it covers 128, against the bottom (552-712) it covers 158.
    expect(placeCard(wide, CARD, VIEWPORT).top).toBe(VIEWPORT_MARGIN);
    // The hole spans 10 to 680: against the top it covers 158, against the bottom 128.
    const lower: Rect = { left: 10, top: 10, width: 1260, height: 670 };
    expect(placeCard(lower, CARD, VIEWPORT).top).toBe(VIEWPORT.height - VIEWPORT_MARGIN - CARD.height);
  });

  it("no hole -> centered", () => {
    expect(placeCard(null, CARD, VIEWPORT).placement).toBe("center");
  });

  it.each<[string, Rect]>([
    ["target at top-left", { left: 0, top: 0, width: 40, height: 40 }],
    ["target at top-right", { left: 1240, top: 0, width: 40, height: 40 }],
    ["target at bottom-left", { left: 0, top: 680, width: 40, height: 40 }],
    ["target at bottom-right", { left: 1240, top: 680, width: 40, height: 40 }],
    ["target at the right edge, vertically centered", { left: 1250, top: 340, width: 30, height: 40 }],
  ])("card stays inside the viewport and does not overlap the hole: %s", (_name, hole) => {
    const card = cardRect(hole);
    expectInside(card);
    expectNoOverlap(card, hole);
  });

  it("card wider than the viewport sticks to the left edge (no negative coordinates)", () => {
    const narrow: Size = { width: 300, height: 600 };
    const p = placeCard({ left: 100, top: 40, width: 40, height: 40 }, { width: 320, height: 160 }, narrow);
    expect(p.left).toBe(VIEWPORT_MARGIN);
  });
});

describe("placeCard: avoids insets (safe area, phone header and bottom round button)", () => {
  // 390x844 phone: 47 px notch at the top, pinned header down to 110; 34 px home indicator at the bottom, round button 88 up from the bottom.
  const PHONE: Size = { width: 390, height: 844 };
  const INSETS: Insets = { top: 110, right: 0, bottom: 88, left: 0 };
  const m = VIEWPORT_MARGIN;

  const inside = (p: { left: number; top: number }, card: Size, insets: Insets, viewport: Size = PHONE) => {
    expect(p.left).toBeGreaterThanOrEqual(insets.left + m);
    expect(p.top).toBeGreaterThanOrEqual(insets.top + m);
    expect(p.left + card.width).toBeLessThanOrEqual(viewport.width - insets.right - m);
    expect(p.top + card.height).toBeLessThanOrEqual(viewport.height - insets.bottom - m);
  };

  it("no hole: centered within the allowed range, not within the whole viewport", () => {
    const p = placeCard(null, CARD, PHONE, INSETS);
    inside(p, CARD, INSETS);
    expect(p.top).toBe((INSETS.top + m + (PHONE.height - INSETS.bottom - m) - CARD.height) / 2);
  });

  it("hole inside the pinned top row (avatar): the card goes at the band's lower edge, not right below the hole (which is still inside the band)", () => {
    const avatar = padRect({ left: 340, top: 50, width: 32, height: 32 });
    // Placing the card right below the hole plus its gap is still inside the band, so the card is pushed to the band's lower edge.
    expect(avatar.top + avatar.height + CARD_GAP).toBeLessThan(INSETS.top + m);
    const p = placeCard(avatar, CARD, PHONE, INSETS);
    expect(p.placement).toBe("bottom");
    expect(p.top).toBe(INSETS.top + m);
    inside(p, CARD, INSETS);
  });

  it("hole is the bottom-right round button: the card goes above and does not overlap the button's area", () => {
    const fab = padRect({ left: 318, top: 772, width: 56, height: 56 });
    const p = placeCard(fab, CARD, PHONE, INSETS);
    expect(p.placement).toBe("top");
    expect(p.top + CARD.height).toBeLessThanOrEqual(fab.top - CARD_GAP);
    inside(p, CARD, INSETS);
  });

  it("left and right safe areas (notch in landscape) are avoided too", () => {
    const side: Insets = { top: 0, right: 47, bottom: 21, left: 47 };
    const wide: Size = { width: 844, height: 390 };
    const p = placeCard(padRect({ left: 50, top: 20, width: 32, height: 32 }), CARD, wide, side);
    inside(p, CARD, side, wide);
  });

  it("320 wide: the card's max width is the width of the allowed range, so it stays inside the viewport", () => {
    const narrow: Size = { width: 320, height: 568 };
    const max = cardMaxSize(narrow, INSETS);
    expect(max.width).toBe(320 - 2 * m);
    expect(max.height).toBe(568 - INSETS.top - INSETS.bottom - 2 * m);
    const card: Size = { width: max.width, height: 200 };
    inside(placeCard(null, card, narrow, INSETS), card, INSETS, narrow);
    inside(placeCard(padRect({ left: 250, top: 496, width: 56, height: 56 }), card, narrow, INSETS), card, INSETS, narrow);
  });

  it("cardInsets: per side takes the larger of safe area and band; if less than MIN_CARD_ROOM height remains (small phone in landscape) only the safe area is kept", () => {
    const safe: Insets = { top: 0, right: 44, bottom: 21, left: 44 };
    const band: Insets = { top: 110, right: 0, bottom: 88, left: 0 };
    expect(cardInsets(safe, band, PHONE)).toEqual({ top: 110, right: 44, bottom: 88, left: 44 });
    const landscape: Size = { width: 568, height: 320 };
    expect(cardMaxSize(landscape, { top: 110, right: 44, bottom: 88, left: 44 }).height).toBeLessThan(MIN_CARD_ROOM);
    expect(cardInsets(safe, band, landscape)).toEqual(safe);
    const justEnough: Size = { width: 568, height: 110 + 88 + 2 * m + MIN_CARD_ROOM };
    expect(cardInsets(safe, band, justEnough)).toEqual({ top: 110, right: 44, bottom: 88, left: 44 });
  });

  it("cardInsets: when the screen is too small only keepOut is dropped, and blocked (covered by the keyboard) is still avoided", () => {
    const safe: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
    const band: Insets = { top: 60, right: 0, bottom: 72, left: 0 };
    const keyboard: Insets = { top: 0, right: 0, bottom: 180, left: 0 };
    const small: Size = { width: 568, height: 400 };
    expect(cardMaxSize(small, { ...band, bottom: 180 }).height).toBeLessThan(MIN_CARD_ROOM);
    expect(cardInsets(safe, band, small, keyboard)).toEqual(keyboard);
    expect(cardInsets(safe, band, PHONE, keyboard)).toEqual({ top: 60, right: 0, bottom: 180, left: 0 });
  });

  it("without insets behaves as before (only VIEWPORT_MARGIN from the viewport edge)", () => {
    expect(cardMaxSize(VIEWPORT)).toEqual({ width: VIEWPORT.width - 2 * m, height: VIEWPORT.height - 2 * m });
    expect(placeCard(null, CARD, VIEWPORT)).toEqual(placeCard(null, CARD, VIEWPORT, { top: 0, right: 0, bottom: 0, left: 0 }));
  });
});

describe("arrowPath: points from the card edge to the hole's edge", () => {
  function onSegment(value: number, from: number, to: number) {
    expect(value).toBeGreaterThanOrEqual(from);
    expect(value).toBeLessThanOrEqual(to);
  }

  it.each<[string, Rect]>([
    ["bottom", { left: 500, top: 100, width: 80, height: 40 }],
    ["top", { left: 500, top: 600, width: 80, height: 40 }],
    ["right", { left: 20, top: 100, width: 200, height: 520 }],
    ["left", { left: 1000, top: 100, width: 260, height: 520 }],
    ["bottom", { left: 1240, top: 20, width: 40, height: 40 }],
    // Part of the target is outside the viewport: the card is clamped inside it and cannot reach the target's center, but the endpoint must still land on the hole's straight segment.
    ["bottom", { left: 1275, top: 20, width: 40, height: 40 }],
  ])("%s: the endpoint is on the hole's edge facing the card and the start is on the card's edge", (expected, hole) => {
    const p = placeCard(hole, CARD, VIEWPORT);
    expect(p.placement).toBe(expected);
    const card: Rect = { left: p.left, top: p.top, width: CARD.width, height: CARD.height };
    const arrow = arrowPath(hole, card, p.placement);
    expect(arrow).not.toBeNull();
    const { from, to, d } = arrow!;
    expect(d).toBe(`M ${from.x} ${from.y} L ${to.x} ${to.y}`);
    switch (p.placement) {
      case "bottom":
        expect(to.y).toBe(bottom(hole));
        expect(from.y).toBe(card.top);
        onSegment(to.x, hole.left + HOLE_RADIUS, right(hole) - HOLE_RADIUS);
        onSegment(from.x, card.left, right(card));
        break;
      case "top":
        expect(to.y).toBe(hole.top);
        expect(from.y).toBe(bottom(card));
        onSegment(to.x, hole.left + HOLE_RADIUS, right(hole) - HOLE_RADIUS);
        onSegment(from.x, card.left, right(card));
        break;
      case "right":
        expect(to.x).toBe(right(hole));
        expect(from.x).toBe(card.left);
        onSegment(to.y, hole.top + HOLE_RADIUS, bottom(hole) - HOLE_RADIUS);
        onSegment(from.y, card.top, bottom(card));
        break;
      case "left":
        expect(to.x).toBe(hole.left);
        expect(from.x).toBe(right(card));
        onSegment(to.y, hole.top + HOLE_RADIUS, bottom(hole) - HOLE_RADIUS);
        onSegment(from.y, card.top, bottom(card));
        break;
    }
  });

  it("draws a straight line when the hole's center is within the card's width (the arrow is vertical when the target is directly above)", () => {
    const hole: Rect = { left: 500, top: 100, width: 80, height: 40 };
    const p = placeCard(hole, CARD, VIEWPORT);
    const arrow = arrowPath(hole, { left: p.left, top: p.top, ...CARD }, p.placement)!;
    expect(arrow.from.x).toBe(arrow.to.x);
  });

  it("no arrow when centered", () => {
    const hole: Rect = { left: 10, top: 10, width: 1260, height: 700 };
    expect(arrowPath(hole, { left: 480, top: 280, ...CARD }, "center")).toBeNull();
  });
});
