import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { COLORS_DARK_MODE_DEFAULT, COLORS_DEFAULT } from "@blocknote/core";

const css = readFileSync(`${process.cwd()}/src/present/present.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function rule(selectorStart: string): string {
  const index = css.indexOf(selectorStart);
  expect(index, selectorStart).toBeGreaterThanOrEqual(0);
  return css.slice(index, css.indexOf("}", index));
}

describe("present.css", () => {
  it("每條規則都錨在 .kn-present 或 :root.dark .kn-present 底下（不碰全域）", () => {
    // 媒體查詢的外殼（`@media (…) {`）不是選擇器；拿掉外殼後，裡面的規則照樣要錨在 .kn-present 底下。
    const selectors = css
      .replace(/@media[^{]*\{/g, "")
      .split("}")
      .map((block) => block.split("{")[0].trim())
      .filter((selector) => selector !== "")
      .flatMap((selector) => selector.split(",").map((part) => part.trim()));
    expect(selectors.length).toBeGreaterThan(40);
    for (const selector of selectors) expect(selector, selector).toMatch(/^(\.kn-present|:root\.dark \.kn-present)\b/);
  });

  it.each(Object.keys(COLORS_DEFAULT))("色名 %s：淺色與深色的字色、底色逐值等於 BlockNote 匯出的常數（末列）", (name) => {
    expect(rule(`.kn-present [data-text-color="${name}"]`)).toContain(`color: ${COLORS_DEFAULT[name].text};`);
    expect(rule(`.kn-present [data-background-color="${name}"]`)).toContain(`background-color: ${COLORS_DEFAULT[name].background};`);
    expect(rule(`:root.dark .kn-present [data-text-color="${name}"]`)).toContain(`color: ${COLORS_DARK_MODE_DEFAULT[name].text};`);
    expect(rule(`:root.dark .kn-present [data-background-color="${name}"]`)).toContain(`background-color: ${COLORS_DARK_MODE_DEFAULT[name].background};`);
  });

  it("手機（width < 40rem）：投影片的 H1／H2／H3 縮小且仍是 h1 > h2 > h3，寫在桌面規則之後才蓋得過", () => {
    const phone = css.match(/@media \(width < 40rem\) \{\s*\.kn-present \.kn-slide-body h1 \{[^@]*?\n\}/);
    expect(phone).not.toBeNull();
    const size = (h: string) => Number(new RegExp(`\\.kn-slide-body ${h} \\{ font-size: ([\\d.]+)em;`).exec(phone![0])?.[1]);
    expect(size("h1")).toBe(1.75);
    expect(size("h2")).toBe(1.5);
    expect(size("h3")).toBe(1.25);
    expect(size("h1")).toBeGreaterThan(size("h2"));
    expect(size("h2")).toBeGreaterThan(size("h3"));
    // 桌面的 h4 是 1.2em：手機的 h3 仍比它大。
    expect(size("h3")).toBeGreaterThan(1.2);
    for (const h of ["h1", "h2", "h3"]) {
      expect(css.indexOf(phone![0])).toBeGreaterThan(css.indexOf(`.kn-present .kn-slide-body ${h} { font-size: `));
    }
  });

  it("無轉場規則存在（deck.ts 的 NO_TRANSITION_CLASS）", () => {
    expect(rule(".kn-present .reveal.kn-present-no-transition .slides section")).toContain("transition: none !important;");
  });

  it("E6：沒有溢出的投影片 touch-action:none（溢出的帶 data-prevent-swipe，維持瀏覽器捲動）", () => {
    expect(rule(".kn-present .reveal .slides section[data-kn-slide-id]:not([data-prevent-swipe])")).toContain("touch-action: none;");
  });

  it("並排——堆疊的列 display:block !important、列的 gap 24px !important（蓋過正規形 inline style）", () => {
    expect(rule(".kn-present .kn-slide-body [data-kb-columns][data-stacked] {")).toContain("display: block !important;");
    expect(rule(".kn-present .kn-slide-body [data-kb-columns] {")).toContain("gap: 24px !important;");
  });

  it("E6：未溢出投影片裡沒橫向溢出的 <pre> 也 touch-action:none（<pre> 是捲動容器，否則從短程式碼起手的滑動不換頁）", () => {
    expect(rule(".kn-present .reveal .slides section[data-kn-slide-id]:not([data-prevent-swipe]) pre:not([data-prevent-swipe])")).toContain("touch-action: none;");
  });
});
