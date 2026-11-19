import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COLUMN_GAP_PX, COLUMN_MIN_IMAGE_PX, COLUMN_MIN_TEXT_PX } from "./layout";

/**
 * Source guard for the columns section of `index.css`. BlockNote's CSS lives in a lazy chunk, later than `index.css`, and neither is layered: an override that doesn't anchor `.bn-editor` always loses at equal specificity, silently has no effect, and jsdom stays green; values must be the same as `layout.ts`'s constants.
 * Not covered: whether the rules really make it into the build output (Lightning CSS silently drops selectors it can't parse) - grep `dist/assets/*.css` after build.
 */

const css = readFileSync(`${process.cwd()}/src/index.css`, "utf8").replace(/\r\n/g, "\n");

/** Contents of the rule block whose selector list is verbatim `selector` (the last one is taken, since in CSS the later one wins). */
function block(selector: string): string | undefined {
  const blocks: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    const selectors = m[1].replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (selectors === selector) blocks.push(m[2]);
  }
  return blocks.at(-1);
}

const RULES: Array<[string, Record<string, string>]> = [
  [".bn-editor .bn-block-column-list", { gap: `${COLUMN_GAP_PX}px`, "align-items": "flex-start" }],
  [
    ".bn-editor .bn-block-column,\n.bn-editor .bn-block-column:first-child,\n.bn-editor .bn-block-column:last-child",
    { "padding-inline": "0", "min-width": `${COLUMN_MIN_TEXT_PX}px` },
  ],
  ['.bn-editor .bn-block-column[data-kb-col-kind="image"]', { "min-width": `${COLUMN_MIN_IMAGE_PX}px` }],
  [".bn-editor .bn-block-column-list[data-stacked]", { display: "block" }],
  [".bn-editor .bn-block-column-list[data-stacked] > .bn-block-column", { "min-width": "0" }],
  [".bn-editor .bn-block-column-list[data-stacked] > .bn-block-column + .bn-block-column", { "margin-top": "12px" }],
  [".bn-editor .bn-block-column [data-file-block] .bn-file-block-content-wrapper", { "max-width": "100%" }],
  [".bn-editor .bn-block-column [data-file-block] .bn-visual-media", { "max-width": "100%" }],
];

function declarations(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const decl of body.replace(/\/\*[\s\S]*?\*\//g, "").split(";")) {
    const i = decl.indexOf(":");
    if (i > 0) out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
  }
  return out;
}

describe("index.css columns section", () => {
  it("every rule exists verbatim and every item in the selector list starts with `.bn-editor `", () => {
    for (const [selector] of RULES) {
      expect(block(selector), selector).toBeDefined();
      for (const part of selector.split(",")) expect(part.trim().startsWith(".bn-editor "), part).toBe(true);
    }
  });

  it("declared values equal layout.ts's constants (gap, the two min-widths)", () => {
    for (const [selector, expected] of RULES) {
      const actual = declarations(block(selector) ?? "");
      for (const [prop, value] of Object.entries(expected)) expect(actual[prop], `${selector} ${prop}`).toBe(value);
    }
  });

  it("columns zero only the left/right padding and keep core's 12px top/bottom: column rules must not have `padding`, `padding-block` or other padding declarations", () => {
    const actual = declarations(block(RULES[1][0]) ?? "");
    expect(Object.keys(actual).filter((prop) => prop.startsWith("padding"))).toEqual(["padding-inline"]);
  });

  it("the section comes after the narrow-viewport section and before the version diff styles; the image column rule comes after the column 200px rules", () => {
    const at = css.indexOf(".bn-editor .bn-block-column-list {");
    expect(at).toBeGreaterThan(css.indexOf("@media (width < 48rem) {"));
    expect(at).toBeLessThan(css.indexOf(".kb-diff [data-diff="));
    expect(css.indexOf("@media (width < 48rem) {")).toBeGreaterThan(-1);
    // The image column's 96px has the same specificity (0,3,0) as the 200px of `:first-child`/`:last-child` and wins only by coming later; the two columns of a two-column row are always first or last.
    const textMin = css.indexOf(".bn-editor .bn-block-column:last-child {");
    expect(textMin).toBeGreaterThan(-1);
    expect(css.indexOf('.bn-editor .bn-block-column[data-kb-col-kind="image"] {')).toBeGreaterThan(textMin);
  });
});
