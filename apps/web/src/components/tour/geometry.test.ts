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

describe("padRect／unionRect", () => {
  it("挖洞往外擴 6px、圓角 8px", () => {
    expect(HOLE_PADDING).toBe(6);
    expect(HOLE_RADIUS).toBe(8);
    expect(padRect({ left: 100, top: 50, width: 40, height: 20 })).toEqual({ left: 94, top: 44, width: 52, height: 32 });
  });

  it("多個目標取聯集；沒有目標回 null", () => {
    expect(
      unionRect([
        { left: 140, top: 5, width: 30, height: 20 },
        { left: 100, top: 10, width: 30, height: 30 },
      ]),
    ).toEqual({ left: 100, top: 5, width: 70, height: 35 });
    expect(unionRect([])).toBeNull();
  });
});

describe("placeCard：下、上、右、左；四邊放不下且有挖洞就貼上緣或下緣（蓋得少的一邊），沒有挖洞就置中", () => {
  it("下方放得下 → 放下方，水平對齊目標中心", () => {
    const hole: Rect = { left: 500, top: 100, width: 80, height: 40 };
    const p = placeCard(hole, CARD, VIEWPORT);
    expect(p.placement).toBe("bottom");
    expect(p.top).toBe(bottom(hole) + CARD_GAP);
    expect(p.left + CARD.width / 2).toBe(hole.left + hole.width / 2);
  });

  it("下方放不下、上方放得下 → 放上方", () => {
    const hole: Rect = { left: 500, top: 600, width: 80, height: 40 };
    const p = placeCard(hole, CARD, VIEWPORT);
    expect(p.placement).toBe("top");
    expect(p.top + CARD.height).toBe(hole.top - CARD_GAP);
  });

  it("上下都放不下、右邊放得下 → 放右邊，垂直對齊目標中心", () => {
    const hole: Rect = { left: 20, top: 100, width: 200, height: 520 };
    const p = placeCard(hole, CARD, VIEWPORT);
    expect(p.placement).toBe("right");
    expect(p.left).toBe(right(hole) + CARD_GAP);
    expect(p.top + CARD.height / 2).toBe(hole.top + hole.height / 2);
  });

  it("上下右都放不下 → 放左邊", () => {
    const hole: Rect = { left: 1000, top: 100, width: 260, height: 520 };
    const p = placeCard(hole, CARD, VIEWPORT);
    expect(p.placement).toBe("left");
    expect(p.left + CARD.width).toBe(hole.left - CARD_GAP);
  });

  it("四邊都放不下 → 水平置中、貼視窗下緣（上下蓋到的一樣多時）", () => {
    const hole: Rect = { left: 10, top: 10, width: 1260, height: 700 };
    const p = placeCard(hole, CARD, VIEWPORT);
    expect(p.placement).toBe("center");
    expect(p.left).toBe((VIEWPORT.width - CARD.width) / 2);
    expect(p.top).toBe(VIEWPORT.height - VIEWPORT_MARGIN - CARD.height);
  });

  it("四邊都放不下 → 貼視窗上緣或下緣，挑蓋到挖洞比較少的一邊", () => {
    const wide: Rect = { left: 10, top: 40, width: 1260, height: 670 };
    // 洞從 40 到 710：貼上緣（8–168）蓋 128，貼下緣（552–712）蓋 158。
    expect(placeCard(wide, CARD, VIEWPORT).top).toBe(VIEWPORT_MARGIN);
    // 洞從 10 到 680：貼上緣蓋 158，貼下緣蓋 128。
    const lower: Rect = { left: 10, top: 10, width: 1260, height: 670 };
    expect(placeCard(lower, CARD, VIEWPORT).top).toBe(VIEWPORT.height - VIEWPORT_MARGIN - CARD.height);
  });

  it("沒有挖洞 → 置中", () => {
    expect(placeCard(null, CARD, VIEWPORT).placement).toBe("center");
  });

  it.each<[string, Rect]>([
    ["目標貼左上", { left: 0, top: 0, width: 40, height: 40 }],
    ["目標貼右上", { left: 1240, top: 0, width: 40, height: 40 }],
    ["目標貼左下", { left: 0, top: 680, width: 40, height: 40 }],
    ["目標貼右下", { left: 1240, top: 680, width: 40, height: 40 }],
    ["目標貼右邊、垂直置中", { left: 1250, top: 340, width: 30, height: 40 }],
  ])("卡片不出界、不壓到挖洞：%s", (_name, hole) => {
    const card = cardRect(hole);
    expectInside(card);
    expectNoOverlap(card, hole);
  });

  it("卡片比視窗寬時貼左邊界（不跑到負座標）", () => {
    const narrow: Size = { width: 300, height: 600 };
    const p = placeCard({ left: 100, top: 40, width: 40, height: 40 }, { width: 320, height: 160 }, narrow);
    expect(p.left).toBe(VIEWPORT_MARGIN);
  });
});

describe("placeCard：避開 insets（safe area、手機的頁首與底部圓形鈕）", () => {
  // 390×844 的手機：頂端 47 的瀏海、釘住的頁首到 110；底部 34 的 Home 指示條、圓形鈕從底部往上 88。
  const PHONE: Size = { width: 390, height: 844 };
  const INSETS: Insets = { top: 110, right: 0, bottom: 88, left: 0 };
  const m = VIEWPORT_MARGIN;

  const inside = (p: { left: number; top: number }, card: Size, insets: Insets, viewport: Size = PHONE) => {
    expect(p.left).toBeGreaterThanOrEqual(insets.left + m);
    expect(p.top).toBeGreaterThanOrEqual(insets.top + m);
    expect(p.left + card.width).toBeLessThanOrEqual(viewport.width - insets.right - m);
    expect(p.top + card.height).toBeLessThanOrEqual(viewport.height - insets.bottom - m);
  };

  it("沒有挖洞：在範圍內置中，不是在整個視窗置中", () => {
    const p = placeCard(null, CARD, PHONE, INSETS);
    inside(p, CARD, INSETS);
    expect(p.top).toBe((INSETS.top + m + (PHONE.height - INSETS.bottom - m) - CARD.height) / 2);
  });

  it("挖洞在釘住的頂列裡（頭像）：卡片放在邊帶下緣，不是挖洞正下方（那裡還在邊帶裡）", () => {
    const avatar = padRect({ left: 340, top: 50, width: 32, height: 32 });
    // 挖洞正下方加間距還在邊帶裡，卡片要被推到邊帶下緣。
    expect(avatar.top + avatar.height + CARD_GAP).toBeLessThan(INSETS.top + m);
    const p = placeCard(avatar, CARD, PHONE, INSETS);
    expect(p.placement).toBe("bottom");
    expect(p.top).toBe(INSETS.top + m);
    inside(p, CARD, INSETS);
  });

  it("挖洞是右下的圓形鈕：卡片放在上方，不疊在圓形鈕那一帶", () => {
    const fab = padRect({ left: 318, top: 772, width: 56, height: 56 });
    const p = placeCard(fab, CARD, PHONE, INSETS);
    expect(p.placement).toBe("top");
    expect(p.top + CARD.height).toBeLessThanOrEqual(fab.top - CARD_GAP);
    inside(p, CARD, INSETS);
  });

  it("左右的 safe area（橫拿的瀏海）也讓開", () => {
    const side: Insets = { top: 0, right: 47, bottom: 21, left: 47 };
    const wide: Size = { width: 844, height: 390 };
    const p = placeCard(padRect({ left: 50, top: 20, width: 32, height: 32 }), CARD, wide, side);
    inside(p, CARD, side, wide);
  });

  it("320 寬：卡片的最大寬度是範圍的寬，放上去不出界", () => {
    const narrow: Size = { width: 320, height: 568 };
    const max = cardMaxSize(narrow, INSETS);
    expect(max.width).toBe(320 - 2 * m);
    expect(max.height).toBe(568 - INSETS.top - INSETS.bottom - 2 * m);
    const card: Size = { width: max.width, height: 200 };
    inside(placeCard(null, card, narrow, INSETS), card, INSETS, narrow);
    inside(placeCard(padRect({ left: 250, top: 496, width: 56, height: 56 }), card, narrow, INSETS), card, INSETS, narrow);
  });

  it("cardInsets：safe area 與邊帶每邊取大的；扣完不到 MIN_CARD_ROOM 高（橫拿的小手機）就只留 safe area", () => {
    const safe: Insets = { top: 0, right: 44, bottom: 21, left: 44 };
    const band: Insets = { top: 110, right: 0, bottom: 88, left: 0 };
    expect(cardInsets(safe, band, PHONE)).toEqual({ top: 110, right: 44, bottom: 88, left: 44 });
    const landscape: Size = { width: 568, height: 320 };
    expect(cardMaxSize(landscape, { top: 110, right: 44, bottom: 88, left: 44 }).height).toBeLessThan(MIN_CARD_ROOM);
    expect(cardInsets(safe, band, landscape)).toEqual(safe);
    // 剛好夠就照常避開。
    const justEnough: Size = { width: 568, height: 110 + 88 + 2 * m + MIN_CARD_ROOM };
    expect(cardInsets(safe, band, justEnough)).toEqual({ top: 110, right: 44, bottom: 88, left: 44 });
  });

  it("cardInsets：畫面太小時只放掉 keepOut，被鍵盤蓋住的 blocked 照樣讓開", () => {
    const safe: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
    const band: Insets = { top: 60, right: 0, bottom: 72, left: 0 };
    const keyboard: Insets = { top: 0, right: 0, bottom: 180, left: 0 };
    const small: Size = { width: 568, height: 400 };
    expect(cardMaxSize(small, { ...band, bottom: 180 }).height).toBeLessThan(MIN_CARD_ROOM);
    expect(cardInsets(safe, band, small, keyboard)).toEqual(keyboard);
    expect(cardInsets(safe, band, PHONE, keyboard)).toEqual({ top: 60, right: 0, bottom: 180, left: 0 });
  });

  it("不給 insets 時與以前一樣（只離視窗邊 VIEWPORT_MARGIN）", () => {
    expect(cardMaxSize(VIEWPORT)).toEqual({ width: VIEWPORT.width - 2 * m, height: VIEWPORT.height - 2 * m });
    expect(placeCard(null, CARD, VIEWPORT)).toEqual(placeCard(null, CARD, VIEWPORT, { top: 0, right: 0, bottom: 0, left: 0 }));
  });
});

describe("arrowPath：從卡片邊緣指到挖洞邊上", () => {
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
    // 目標有一部分在視窗外：卡片被夾在視窗內、對不到目標中心，終點仍要落在挖洞的直線段上
    ["bottom", { left: 1275, top: 20, width: 40, height: 40 }],
  ])("%s：終點在挖洞對著卡片的那條邊上，起點在卡片邊上", (expected, hole) => {
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

  it("挖洞中心落在卡片寬度內時畫直線（目標在正上方時箭頭垂直）", () => {
    const hole: Rect = { left: 500, top: 100, width: 80, height: 40 };
    const p = placeCard(hole, CARD, VIEWPORT);
    const arrow = arrowPath(hole, { left: p.left, top: p.top, ...CARD }, p.placement)!;
    expect(arrow.from.x).toBe(arrow.to.x);
  });

  it("置中時沒有箭頭", () => {
    const hole: Rect = { left: 10, top: 10, width: 1260, height: 700 };
    expect(arrowPath(hole, { left: 480, top: 280, ...CARD }, "center")).toBeNull();
  });
});
