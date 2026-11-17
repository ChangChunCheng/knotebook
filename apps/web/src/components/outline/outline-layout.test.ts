import { describe, expect, it } from "vitest";
import { canPinOutline, outlineMaxHeight, outlinePlacement } from "./outline-layout";

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
    expect(outlinePlacement(1072, 991.5)).toEqual({ railLeft: 1007.5, panelLeft: 828, pinnedPanelLeft: 832 });
  });

  it("keeps the rail inside the right edge and floats the panel over the column in a narrow container", () => {
    const p = outlinePlacement(800, 790);
    expect(p.railLeft).toBe(772);
    expect(p.panelLeft).toBe(556);
  });

  it("puts rail and panel at the same left edge in a wide container", () => {
    const p = outlinePlacement(2000, 1528);
    expect(p.railLeft).toBe(1544);
    expect(p.panelLeft).toBe(1544);
  });

  it("never gives a negative panel left", () => {
    expect(outlinePlacement(200, 190).panelLeft).toBe(0);
  });
});

describe("outlineMaxHeight", () => {
  it("stops above the version bubble when it is shown", () => {
    expect(outlineMaxHeight(700, true)).toBe(610);
  });
  it("leaves only the bottom gap without the bubble", () => {
    expect(outlineMaxHeight(700, false)).toBe(676);
  });
  it("never goes negative", () => {
    expect(outlineMaxHeight(80, true)).toBe(0);
  });
});
