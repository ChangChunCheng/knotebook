import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 手機（< 640）寬表格的右緣淡出提示：支援捲動驅動動畫時純 CSS，不支援時由 `lib/table-scroll-hint.ts`
 * 加 `data-kb-more-right`。jsdom 不套 CSS，這裡只守原始碼。
 */
const css = readFileSync(`${process.cwd()}/src/index.css`, "utf8")
  .replaceAll("\r\n", "\n")
  .replace(/\/\*[\s\S]*?\*\//g, "");
const start = css.indexOf("@media (width < 40rem) {\n  .bn-editor.bn-editor [data-content-type=\"table\"] .tableWrapper {");
const block = start < 0 ? "" : css.slice(start, css.indexOf("\n}\n", start) + 3);
const WRAPPER = '.bn-editor.bn-editor [data-content-type="table"] .tableWrapper';

describe("手機表格右緣提示", () => {
  it("淡出寬度是註冊過的 <length> 屬性，預設 0（沒有提示時完全不遮）", () => {
    expect(css).toMatch(/@property --kb-table-fade\s*\{\s*syntax:\s*"<length>";\s*inherits:\s*false;\s*initial-value:\s*0px;/);
  });

  it("遮罩只在 width < 40rem 的媒體查詢內，選擇器疊 .bn-editor.bn-editor", () => {
    expect(block).not.toBe("");
    expect(block).toContain(`${WRAPPER} {\n    mask-image: linear-gradient(to right, #000 calc(100% - var(--kb-table-fade)), transparent);`);
    expect(css.match(/\.tableWrapper[^{]*\{[^}]*mask-image/g) ?? []).toHaveLength(1);
  });

  it("支援 animation-timeline 時以表格自己的橫向捲動驅動；不支援時改看 data-kb-more-right", () => {
    expect(block).toMatch(/@supports \(animation-timeline: scroll\(self inline\)\) \{[^@]*animation-timeline:\s*scroll\(self inline\);/);
    expect(block).toMatch(/@supports not \(animation-timeline: scroll\(self inline\)\) \{\s*\.bn-editor\.bn-editor \[data-content-type="table"\] \.tableWrapper\[data-kb-more-right\] \{\s*--kb-table-fade:\s*1\.5rem;/);
  });

  it("動畫在捲到最右前維持 1.5rem、到底收成 0", () => {
    const frames = css.match(/@keyframes kb-table-fade \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(frames).toMatch(/0%,\s*95% \{\s*--kb-table-fade:\s*1\.5rem;/);
    expect(frames).toMatch(/100% \{\s*--kb-table-fade:\s*0px;/);
  });
});
