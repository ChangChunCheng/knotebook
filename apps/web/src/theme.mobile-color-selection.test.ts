import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The selection highlight while the mobile colour palette is open (outline, no fill) applies only when the editor root carries `data-mobile-color-open`;
 * the `[data-show-selection]` highlight used by other things such as the AI box must not be changed.
 */
const css = readFileSync(`${process.cwd()}/src/index.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

describe("selection highlight style while the palette is open", () => {
  it("exactly one rule touches [data-show-selection], and it is limited under data-mobile-color-open", () => {
    const rules = css.match(/[^{}]*\[data-show-selection\][^{}]*\{[^}]*\}/g) ?? [];
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatch(/\.bn-editor\[data-mobile-color-open\]\s+\[data-show-selection\]/);
  });

  it("background goes transparent and an outline is drawn (otherwise it would cover the just-applied background colour)", () => {
    const rule = css.match(/\.bn-editor\[data-mobile-color-open\] \[data-show-selection\]\s*\{[^}]*\}/)![0];
    expect(rule).toMatch(/background-color:\s*transparent/);
    expect(rule).toMatch(/outline:\s*2px solid var\(--color-brand\)/);
  });
});
