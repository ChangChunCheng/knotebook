import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 內文標題字級（所有寬度）：改 BlockNote 的 `--level`／`--prev-level`（它的 font-size 規則吃這兩個變數），
 * 選擇器疊 `.bn-editor.bn-editor` 才贏得過晚載入、同為未分層的 BlockNote CSS。
 * 桌面側邊選單的高度（BlockNote 依舊字級寫死）與拖曳預覽（複製到 body、不在 .bn-editor 裡）也要跟著。
 * jsdom 不套 CSS，這裡只守原始碼；computed 值由 e2e 量。
 */
const css = readFileSync(`${process.cwd()}/src/index.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** 從 startNeedle 到 endNeedle 所在規則結尾（含）的片段，加上 start 之前的大括號深度（0＝不在任何 @media／@layer 裡）。 */
function slice(startNeedle: string, endNeedle: string): { block: string; depth: number } {
  const start = css.indexOf(startNeedle);
  const end = css.indexOf(endNeedle, start);
  if (start < 0 || end < 0) return { block: "", depth: -1 };
  const before = css.slice(0, start);
  const depth = (before.match(/\{/g) ?? []).length - (before.match(/\}/g) ?? []).length;
  return { block: css.slice(start, css.indexOf("}", end) + 1), depth };
}

const editor = slice('.bn-editor.bn-editor [data-content-type="heading"]:not([data-level])', '[data-prev-level="3"]');
const preview = slice('.bn-drag-preview.bn-drag-preview [data-content-type="heading"]:not([data-level])', '[data-level="3"]');
const sideMenu = slice('.bn-side-menu.bn-side-menu[data-block-type="heading"][data-level="1"]', '[data-level="3"]');
const block = editor.block;

describe("內文標題字級", () => {
  it("H1（沒有 data-level）、H2、H3 各改 --level 為 2／1.5／1.25em，且不在媒體查詢裡", () => {
    expect(block).not.toBe("");
    expect(editor.depth).toBe(0);
    expect(block).not.toMatch(/@media/);
    expect(block).toMatch(/\.bn-editor\.bn-editor \[data-content-type="heading"\]:not\(\[data-level\]\)\s*\{\s*--level:\s*2em;/);
    expect(block).toMatch(/\[data-content-type="heading"\]\[data-level="2"\]\s*\{\s*--level:\s*1\.5em;/);
    expect(block).toMatch(/\[data-content-type="heading"\]\[data-level="3"\]\s*\{\s*--level:\s*1\.25em;/);
  });

  it("標題換類型轉場的起點 --prev-level 同步", () => {
    expect(block).toMatch(/\.bn-editor\.bn-editor \[data-prev-level="1"\]\s*\{\s*--prev-level:\s*2em;/);
    expect(block).toMatch(/\.bn-editor\.bn-editor \[data-prev-level="2"\]\s*\{\s*--prev-level:\s*1\.5em;/);
    expect(block).toMatch(/\.bn-editor\.bn-editor \[data-prev-level="3"\]\s*\{\s*--prev-level:\s*1\.25em;/);
  });

  it("每條都疊 .bn-editor.bn-editor，不寫裸 font-size", () => {
    expect(block.match(/\.bn-editor\.bn-editor \[data-content-type="heading"\]/g) ?? []).toHaveLength(3);
    expect(block.match(/\.bn-editor\.bn-editor \[data-prev-level=/g) ?? []).toHaveLength(3);
    expect(block).not.toMatch(/font-size/);
  });

  it("拖曳預覽（.bn-drag-preview，在 body 下）的標題 --level 同組字級", () => {
    expect(preview.block).not.toBe("");
    expect(preview.depth).toBe(0);
    expect(preview.block).toMatch(/\.bn-drag-preview\.bn-drag-preview \[data-content-type="heading"\]:not\(\[data-level\]\)\s*\{\s*--level:\s*2em;/);
    expect(preview.block).toMatch(/\.bn-drag-preview\.bn-drag-preview \[data-content-type="heading"\]\[data-level="2"\]\s*\{\s*--level:\s*1\.5em;/);
    expect(preview.block).toMatch(/\.bn-drag-preview\.bn-drag-preview \[data-content-type="heading"\]\[data-level="3"\]\s*\{\s*--level:\s*1\.25em;/);
  });

  it("桌面側邊選單高度＝36px ＋ 1.5 × 字級：H1 84、H2 72、H3 66（疊兩次 class 贏過 BlockNote）", () => {
    expect(sideMenu.block).not.toBe("");
    expect(sideMenu.depth).toBe(0);
    expect(sideMenu.block).toMatch(/\.bn-side-menu\.bn-side-menu\[data-block-type="heading"\]\[data-level="1"\]\s*\{\s*height:\s*84px;/);
    expect(sideMenu.block).toMatch(/\.bn-side-menu\.bn-side-menu\[data-block-type="heading"\]\[data-level="2"\]\s*\{\s*height:\s*72px;/);
    expect(sideMenu.block).toMatch(/\.bn-side-menu\.bn-side-menu\[data-block-type="heading"\]\[data-level="3"\]\s*\{\s*height:\s*66px;/);
  });
});
