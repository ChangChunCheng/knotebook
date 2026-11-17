import { describe, expect, it } from "vitest";
import { canPinOutline, outlineMaxHeight, outlinePlacement, outlineTop } from "./outline-layout";

describe("canPinOutline", () => {
  it.each([998, 1072, 1168, 1312, 920])("width %i can pin", (w) => {
    expect(canPinOutline(w)).toBe(true);
  });
  it.each([912, 919])("width %i cannot pin", (w) => {
    expect(canPinOutline(w)).toBe(false);
  });
});

describe("outlinePlacement", () => {
  it("places rail and panel beside the column when there is room", () => {
    expect(outlinePlacement(1072, 991.5)).toEqual({ railLeft: 1018, panelLeft: 828, pinnedPanelLeft: 820 });
  });

  it("puts the pinned panel beside the column when the column already leaves room", () => {
    // 2000 wide, standard column right at 1528: same place as the floating panel.
    expect(outlinePlacement(2000, 1528).pinnedPanelLeft).toBe(1544);
  });

  it("keeps the pinned panel half the slack inside the right edge while the column moves aside", () => {
    // Settled: the pinned column ends 268 from the right edge, the panel follows 16 later and ends 12 from it.
    expect(outlinePlacement(1360, 1092).pinnedPanelLeft).toBe(1108);
    // Mid-transition the column is still further right; the panel already sits where it will end up.
    expect(outlinePlacement(1360, 1150).pinnedPanelLeft).toBe(1108);
  });

  it("keeps the rail inside the right edge and floats the panel over the column in a narrow container", () => {
    const p = outlinePlacement(800, 790);
    expect(p.railLeft).toBe(746);
    expect(p.panelLeft).toBe(556);
  });

  it("puts rail and panel at the same left edge in a wide container", () => {
    const p = outlinePlacement(2000, 1528);
    expect(p.railLeft).toBe(1946);
    // The panel is moved right to cover the rail; the pinned panel stays beside the column.
    expect(p.panelLeft).toBe(1730);
    expect(p.pinnedPanelLeft).toBe(1544);
  });

  it("never gives a negative panel left", () => {
    expect(outlinePlacement(200, 190).panelLeft).toBe(0);
  });
});

describe("panel covers the rail", () => {
  it.each([[800, 790], [1072, 991.5], [1360, 1092], [2000, 1528], [3000, 1528]])("width %i column %f", (w, col) => {
    const p = outlinePlacement(w, col);
    expect(p.panelLeft).toBeLessThanOrEqual(p.railLeft);
    expect(p.panelLeft + 240).toBeGreaterThanOrEqual(p.railLeft + 24);
  });
});

describe("rail column", () => {
  it("centers the rail on the version bubble whatever the column does", () => {
    // Bubble: right edge 18 inside the width, 48 wide, so its center is width - 42.
    for (const [w, col] of [[1072, 991.5], [2000, 1528], [800, 790]] as const) {
      expect(outlinePlacement(w, col).railLeft + 12).toBe(w - 42);
    }
  });
});

describe("outlineTop", () => {
  it("is the measured first line, or the fallback offset without one", () => {
    expect(outlineTop({ firstLineTop: 64 })).toBe(64);
    expect(outlineTop({ firstLineTop: null })).toBe(28);
  });
});

describe("outlineMaxHeight", () => {
  it("uses the given top", () => {
    expect(outlineMaxHeight(700, true, 64)).toBe(558);
  });
  it("stops above the version bubble when it is shown", () => {
    expect(outlineMaxHeight(700, true)).toBe(594);
  });
  it("leaves only the bottom gap without the bubble", () => {
    expect(outlineMaxHeight(700, false)).toBe(660);
  });
  it("never goes negative", () => {
    expect(outlineMaxHeight(80, true)).toBe(0);
  });
});
