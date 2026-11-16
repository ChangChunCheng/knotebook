import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 手機（< 640）內文標題縮小：改 BlockNote 的 `--level`／`--prev-level`（它的 font-size 規則吃這兩個變數），
 * 選擇器疊 `.bn-editor.bn-editor` 才贏得過晚載入、同為未分層的 BlockNote CSS。
 * jsdom 不套 CSS，這裡只守原始碼；computed font-size 不在這裡檢查。
 */
const css = readFileSync(`${process.cwd()}/src/index.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const block = css.match(/@media \(width < 40rem\) \{\s*\.bn-editor\.bn-editor \[data-content-type="heading"\][\s\S]*?\n\}/)?.[0] ?? "";

describe("手機標題字級", () => {
  it("在 width < 40rem 的媒體查詢裡，H1（沒有 data-level）、H2、H3 各改 --level", () => {
    expect(block).not.toBe("");
    expect(block).toMatch(/\.bn-editor\.bn-editor \[data-content-type="heading"\]:not\(\[data-level\]\)\s*\{\s*--level:\s*2em;/);
    expect(block).toMatch(/\[data-content-type="heading"\]\[data-level="2"\]\s*\{\s*--level:\s*1\.5em;/);
    expect(block).toMatch(/\[data-content-type="heading"\]\[data-level="3"\]\s*\{\s*--level:\s*1\.17em;/);
  });

  it("標題換類型轉場的起點 --prev-level 同步改成手機字級", () => {
    expect(block).toMatch(/\.bn-editor\.bn-editor \[data-prev-level="1"\]\s*\{\s*--prev-level:\s*2em;/);
    expect(block).toMatch(/\.bn-editor\.bn-editor \[data-prev-level="2"\]\s*\{\s*--prev-level:\s*1\.5em;/);
    expect(block).toMatch(/\.bn-editor\.bn-editor \[data-prev-level="3"\]\s*\{\s*--prev-level:\s*1\.17em;/);
  });

  it("每條都疊 .bn-editor.bn-editor，不寫裸 font-size", () => {
    expect(block.match(/\.bn-editor\.bn-editor \[data-content-type="heading"\]/g) ?? []).toHaveLength(3);
    expect(block.match(/\.bn-editor\.bn-editor \[data-prev-level=/g) ?? []).toHaveLength(3);
    expect(block).not.toMatch(/font-size/);
  });
});
