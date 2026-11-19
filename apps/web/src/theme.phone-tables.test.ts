import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Right-edge fade hint for wide tables on phones (< 640): pure CSS when scroll-driven animations are supported, otherwise `lib/table-scroll-hint.ts`
 * adds `data-kb-more-right`. jsdom doesn't apply CSS, so this guards only the source.
 */
const css = readFileSync(`${process.cwd()}/src/index.css`, "utf8")
  .replaceAll("\r\n", "\n")
  .replace(/\/\*[\s\S]*?\*\//g, "");
const start = css.indexOf("@media (width < 40rem) {\n  .bn-editor.bn-editor [data-content-type=\"table\"] .tableWrapper {");
const block = start < 0 ? "" : css.slice(start, css.indexOf("\n}\n", start) + 3);
const WRAPPER = '.bn-editor.bn-editor [data-content-type="table"] .tableWrapper';

describe("phone table right-edge hint", () => {
  it("the fade width is a registered <length> property defaulting to 0 (no mask at all when there is no hint)", () => {
    expect(css).toMatch(/@property --kb-table-fade\s*\{\s*syntax:\s*"<length>";\s*inherits:\s*false;\s*initial-value:\s*0px;/);
  });

  it("the mask is only inside a width < 40rem media query, and the selector doubles .bn-editor.bn-editor", () => {
    expect(block).not.toBe("");
    expect(block).toContain(`${WRAPPER} {\n    mask-image: linear-gradient(to right, #000 calc(100% - var(--kb-table-fade)), transparent);`);
    expect(css.match(/\.tableWrapper[^{]*\{[^}]*mask-image/g) ?? []).toHaveLength(1);
  });

  it("when animation-timeline is supported it is driven by the table's own horizontal scroll; when not, it looks at data-kb-more-right", () => {
    expect(block).toMatch(/@supports \(animation-timeline: scroll\(self inline\)\) \{[^@]*animation-timeline:\s*scroll\(self inline\);/);
    expect(block).toMatch(/@supports not \(animation-timeline: scroll\(self inline\)\) \{\s*\.bn-editor\.bn-editor \[data-content-type="table"\] \.tableWrapper\[data-kb-more-right\] \{\s*--kb-table-fade:\s*1\.5rem;/);
  });

  it("the animation holds 1.5rem until scrolled to the far right, and shrinks to 0 at the end", () => {
    const frames = css.match(/@keyframes kb-table-fade \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(frames).toMatch(/0%,\s*95% \{\s*--kb-table-fade:\s*1\.5rem;/);
    expect(frames).toMatch(/100% \{\s*--kb-table-fade:\s*0px;/);
  });
});
