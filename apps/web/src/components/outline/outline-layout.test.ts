import { describe, expect, it } from "vitest";
import {
  OUTLINE_PANEL_RIGHT_INSET,
  OUTLINE_PIN_RESERVED_WIDTH,
  canPinOutline,
  outlineMaxHeight,
  outlinePlacement,
  outlineTop,
} from "./outline-layout";

describe("reserved width", () => {
  it("is panel 240 + gap 16 + the panel's right inset 30 = 286", () => {
    expect(OUTLINE_PANEL_RIGHT_INSET).toBe(30);
    expect(OUTLINE_PIN_RESERVED_WIDTH).toBe(286);
  });
});

describe("canPinOutline", () => {
  it.each([926, 998, 1072, 1168, 1312])("width %i can pin", (w) => {
    expect(canPinOutline(w)).toBe(true);
  });
  it.each([912, 925])("width %i cannot pin", (w) => {
    expect(canPinOutline(w)).toBe(false);
  });
});

describe("outlinePlacement", () => {
  it("puts the rail on the bubble's column and the panel's right edge on the rail's right edge", () => {
    for (const w of [1072, 1360, 2000, 3000]) {
      const p = outlinePlacement(w);
      expect(p.railLeft + 12).toBe(w - 42);
      expect(p.panelLeft + 240).toBe(p.railLeft + 24);
      expect(w - (p.panelLeft + 240)).toBe(OUTLINE_PANEL_RIGHT_INSET);
    }
  });

  it("is the same for floating and pinned: only one panel position exists", () => {
    expect(Object.keys(outlinePlacement(1440)).sort()).toEqual(["panelLeft", "railLeft"]);
    expect(outlinePlacement(1440)).toEqual({ railLeft: 1386, panelLeft: 1170 });
  });

  it("keeps the rail inside the right edge and never gives a negative panel left", () => {
    expect(outlinePlacement(200).panelLeft).toBe(0);
    expect(outlinePlacement(60).railLeft).toBe(6);
  });

  it("leaves a 16px gap between the pinned column's right edge and the panel", () => {
    const W = 1440;
    const columnRightMax = W - OUTLINE_PIN_RESERVED_WIDTH;
    expect(outlinePlacement(W).panelLeft - columnRightMax).toBe(16);
  });
});

describe("outlineTop", () => {
  it("is the measured first line, or the fallback offset without one", () => {
    expect(outlineTop({ firstLineTop: 64 })).toBe(64);
    expect(outlineTop({ firstLineTop: null })).toBe(28);
  });
});

describe("outlineMaxHeight", () => {
  it("is two thirds of the container when that is the smaller limit", () => {
    expect(outlineMaxHeight(900, true, 64)).toBe(600);
    expect(outlineMaxHeight(900, false, 64)).toBe(600);
  });
  it("stops above the version bubble when that is the smaller limit", () => {
    expect(outlineMaxHeight(400, true, 64)).toBe(400 - 64 - 78);
  });
  it("leaves only the bottom gap without the bubble, still capped at two thirds", () => {
    expect(outlineMaxHeight(400, false, 28)).toBe(400 * (2 / 3));
    expect(outlineMaxHeight(200, false, 28)).toBe(200 * (2 / 3));
  });
  it("never goes negative", () => {
    expect(outlineMaxHeight(80, true)).toBe(0);
  });
});
