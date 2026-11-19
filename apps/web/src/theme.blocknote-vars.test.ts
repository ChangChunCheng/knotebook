import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Parity guard for BlockNote dark overrides.
 *
 * Background: see the comment above the override block in `index.css`: floating layers (slash menu / formatting
 * toolbar / file panel etc.) have only `bn-root` and no `bn-container`, and BlockNote's
 * CSS always loads after `index.css`, so the override selector is fixed as
 * `.dark .bn-root[data-color-scheme="dark"]` (specificity (0,3,0) is what beats the
 * built-in `.bn-root[data-color-scheme=dark]`'s (0,2,0)).
 *
 * This guards two things:
 * 1. Every overridden `--bn-colors-*` variable name must exist in the dark block of the currently installed BlockNote
 *    version - a rename on upgrade would silently invalidate the declaration (a mistyped CSS custom property name
 *    reports no error, it just doesn't apply); this test blows up at the moment of the rename.
 * 2. The full literal of the override selector (including the `.dark ` prefix) really appears in the source - removing
 *    the prefix drops specificity back to (0,2,0), tying with the built-in and losing to the later-loaded lazy chunk.
 *
 * The oracle reads `@blocknote/react/dist/style.css` installed in node_modules directly
 * (BlockNote is MPL-2.0 and this project is MIT, so it is deliberately not copied into this project).
 */

function readIndexCssWithoutComments(): string {
  const path = `${process.cwd()}/src/index.css`;
  const css = readFileSync(path, "utf8");
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

const OVERRIDE_SELECTOR = /\.dark \.bn-root\[data-color-scheme="dark"\]\s*\{/;

function extractOverrideBlock(cssNoComments: string): string {
  const match = OVERRIDE_SELECTOR.exec(cssNoComments);
  expect(match, "index.css 找不到 .dark .bn-root[data-color-scheme=\"dark\"] 覆寫區塊").not.toBeNull();
  const start = match!.index;
  const end = cssNoComments.indexOf("}", start);
  expect(end, "覆寫區塊選擇器後找不到結尾 }").toBeGreaterThan(-1);
  return cssNoComments.slice(start, end + 1);
}

describe("BlockNote dark override parity", () => {
  it("every overridden --bn-colors-* variable name exists in the installed BlockNote dark definition", () => {
    const cssNoComments = readIndexCssWithoutComments();
    const overrideBlock = extractOverrideBlock(cssNoComments);

    const varNames = [...overrideBlock.matchAll(/(--bn-colors-[a-z-]+):/g)].map((m) => m[1]);
    expect(varNames.length).toBeGreaterThan(0);

    const blockNoteCssPath = `${process.cwd()}/node_modules/@blocknote/react/dist/style.css`;
    const blockNoteCss = readFileSync(blockNoteCssPath, "utf8");
    const darkSelector = /\.bn-root\[data-color-scheme=["']?dark["']?\]\s*\{/;
    const darkMatch = darkSelector.exec(blockNoteCss);
    expect(darkMatch, "@blocknote/react/dist/style.css 找不到 .bn-root[data-color-scheme=dark] 區塊").not.toBeNull();
    const darkStart = darkMatch!.index;
    const darkEnd = blockNoteCss.indexOf("}", darkStart);
    expect(darkEnd).toBeGreaterThan(-1);
    const darkBlock = blockNoteCss.slice(darkStart, darkEnd + 1);

    for (const varName of varNames) {
      expect(darkBlock, `${varName} 應存在於 BlockNote 深色定義中`).toContain(`${varName}:`);
    }
  });

  it("the full literal of the override selector (including the .dark prefix) appears in index.css", () => {
    // Removing the `.dark ` prefix drops specificity back to (0,2,0), tying with BlockNote's built-in
    // `.bn-root[data-color-scheme=dark]` and losing to the later-loaded lazy chunk CSS.
    const cssNoComments = readIndexCssWithoutComments();
    expect(cssNoComments).toMatch(OVERRIDE_SELECTOR);
  });
});
