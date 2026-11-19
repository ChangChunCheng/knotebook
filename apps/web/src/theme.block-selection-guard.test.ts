import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Structural guard for the block selection outline (node selection) override (same technique as `theme.scrollbar-guard.test.ts`).
 *
 * BlockNote draws a node selection as a hard-coded `outline: 4px solid #64a0ff`. In
 * `index.css` we use a (0,3,0) selector to override **all** blocks with a thin theme-colour outline - **once the ancestor anchor
 * `.bn-editor` is removed** (the selector falls back to (0,2,0)), BlockNote's CSS, which in the NotePage
 * lazy chunk always loads after index.css, wins at equal specificity and the blue outline **silently**
 * comes back: unit tests and jsdom can't see layout / cascade.
 */

function readIndexCss(): string {
  return readFileSync(`${process.cwd()}/src/index.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Extracts the two selectors and the declaration body of the selection-outline rule. */
function selectionRule(): { selectors: string[]; body: string } {
  const css = readIndexCss();
  // Scan the whole file rather than take only the first match: if someone later adds another selectednode rule before it,
  // taking only the first would verify that one and lose its ability to discriminate the real override rule.
  const matches = [...css.matchAll(/([^}]*ProseMirror-selectednode[^{}]*)\{([^}]*)\}/g)].filter((m) => /outline/.test(m[2]!));
  expect(matches, "index.css 應**只有一條** ProseMirror-selectednode 的覆寫規則").toHaveLength(1);
  const match = matches[0]!;
  return {
    selectors: match[1]!
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    body: match[2]!,
  };
}

describe("block selection outline override", () => {
  it("both selectednode landing spots must be covered (it may be on .bn-block-content itself or an outer element)", () => {
    const { selectors } = selectionRule();
    expect(selectors).toHaveLength(2);
    expect(selectors.some((s) => /\.bn-block-content\.ProseMirror-selectednode\s*>\s*\*/.test(s))).toBe(true);
    expect(selectors.some((s) => /\.ProseMirror-selectednode\s*>\s*\.bn-block-content\s*>\s*\*/.test(s))).toBe(true);
  });

  it("every selector is anchored at .bn-editor (specificity must beat the built-in (0,2,0))", () => {
    for (const selector of selectionRule().selectors) {
      expect(selector, `少了 .bn-editor 錨點就墊不到 (0,3,0)：${selector}`).toMatch(/^\.bn-editor\s/);
    }
  });

  it("colour only while focus is still inside the editor container: transparent by default, `.bn-container:focus-within` sets the variable to the theme colour (no outline left after blur, no fall back to the built-in bright blue)", () => {
    const { body } = selectionRule();
    expect(body).toMatch(/outline:\s*2px solid var\(--kb-node-frame,\s*transparent\)/);
    const css = readIndexCss();
    expect(css).toMatch(/\.bn-container:focus-within\s*\{[^}]*--kb-node-frame:\s*var\(--color-brand\)/);
  });

  it("file block selection filename background: reset to transparent after blur, hover unaffected", () => {
    const css = readIndexCss();
    const rule = css.match(/([^{}]*ProseMirror-selectednode[^{}]*bn-file-name-with-icon[^{}]*)\{([^}]*)\}/);
    expect(rule, "少了檔名底色的失焦規則").not.toBeNull();
    expect(rule![1]).toMatch(/\.bn-container:not\(:focus-within\)\s+\.bn-editor\s/);
    expect(rule![1]).toContain(":not(:hover)");
    expect(rule![2]).toMatch(/background-color:\s*transparent/);
  });

  it("applies to all blocks, not tied to a single block type", () => {
    for (const selector of selectionRule().selectors) {
      expect(selector, `選取外框要全 app 統一，不該只挑某種 block：${selector}`).not.toContain("[data-content-type");
    }
  });

  it("the outline uses the theme colour token, and the outline itself must not be removed (the selected state must be visible)", () => {
    const { body } = selectionRule();
    expect(readIndexCss()).toContain("--kb-node-frame: var(--color-brand)");
    expect(body).not.toMatch(/outline:\s*none/);
    expect(body, "不該把 BlockNote 寫死的藍抄過來").not.toContain("#64a0ff");
  });
});
