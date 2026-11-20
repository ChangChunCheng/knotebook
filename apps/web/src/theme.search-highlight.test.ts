import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Guard for the search highlight background token (`--search-highlight`) (same technique as `theme.accent-vars.test.ts`:
 * strip comments -> locate the block -> extract the value). The value is tied to the contrast measurement comment at the top of `index.css` - when changing
 * the value, rerun the contrast script and update the comment.
 */

const SRC = `${process.cwd()}/src`;

function readCssWithoutComments(): string {
  return readFileSync(`${SRC}/index.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

function blockBody(css: string, selector: RegExp, label: string): string {
  const match = selector.exec(css);
  expect(match, `index.css 找不到區塊：${label}`).not.toBeNull();
  const open = css.indexOf("{", match!.index);
  const close = css.indexOf("}", open);
  expect(open, `${label} 找不到 {`).toBeGreaterThan(-1);
  expect(close, `${label} 找不到 }`).toBeGreaterThan(-1);
  return css.slice(open + 1, close);
}

const norm = (value: string) => value.replace(/\s+/g, " ").trim();

describe("--search-highlight token", () => {
  it("declared once in each of the light and dark base blocks, values verbatim, and only these two in the whole file", () => {
    const css = readCssWithoutComments();
    const light = norm(blockBody(css, /:root\s*\{/, ":root"));
    const dark = norm(blockBody(css, /:root\.dark\s*\{/, ":root.dark"));
    expect(light).toContain("--search-highlight: oklch(0.924 0.12 95.746);");
    expect(dark).toContain("--search-highlight: oklch(0.420 0.080 85);");
    expect(css.match(/--search-highlight\s*:/g)).toHaveLength(2);
  });

  it("@theme inline wires it as --color-search-highlight", () => {
    const css = readCssWithoutComments();
    const theme = norm(blockBody(css, /@theme inline\s*\{/, "@theme inline"));
    expect(theme).toContain("--color-search-highlight: var(--search-highlight);");
  });

  it("the mark in SearchResults uses the bg-search-highlight utility", () => {
    const source = readFileSync(`${SRC}/components/sidebar/SearchResults.tsx`, "utf8");
    expect(source).toContain("bg-search-highlight");
  });
});
