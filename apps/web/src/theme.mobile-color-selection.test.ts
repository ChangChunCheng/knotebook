import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 手機色盤開著時的選取反白（外框、不蓋底色）只在編輯器根節點帶 `data-mobile-color-open` 時生效；
 * AI 框等其他用途的 `[data-show-selection]` 反白不能被改到。
 */
const css = readFileSync(`${process.cwd()}/src/index.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

describe("色盤開著時的選取反白樣式", () => {
  it("碰 [data-show-selection] 的規則恰一條，且限定在 data-mobile-color-open 底下", () => {
    const rules = css.match(/[^{}]*\[data-show-selection\][^{}]*\{[^}]*\}/g) ?? [];
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatch(/\.bn-editor\[data-mobile-color-open\]\s+\[data-show-selection\]/);
  });

  it("底色改透明、改畫外框（不然會蓋住剛套上的背景色）", () => {
    const rule = css.match(/\.bn-editor\[data-mobile-color-open\] \[data-show-selection\]\s*\{[^}]*\}/)![0];
    expect(rule).toMatch(/background-color:\s*transparent/);
    expect(rule).toMatch(/outline:\s*2px solid var\(--color-brand\)/);
  });
});
