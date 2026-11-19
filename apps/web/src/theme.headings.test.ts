import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Body heading sizes (all widths): change BlockNote's `--level` / `--prev-level` (its font-size rule consumes these two variables),
 * with the selector doubled as `.bn-editor.bn-editor` so it beats BlockNote's CSS, which loads later and is likewise unlayered.
 * The desktop side-menu height (BlockNote hard-codes it for the old font size) and the drag preview (copied to body, not inside .bn-editor) must follow too.
 * jsdom doesn't apply CSS, so this guards only the source; computed values are measured by e2e.
 */
const css = readFileSync(`${process.cwd()}/src/index.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The slice from startNeedle to the end of the rule containing endNeedle (inclusive), plus the brace depth before start (0 = not inside any @media / @layer). */
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

describe("body heading sizes", () => {
  it("H1 (no data-level), H2, H3 set --level to 2 / 1.5 / 1.25em, and not inside a media query", () => {
    expect(block).not.toBe("");
    expect(editor.depth).toBe(0);
    expect(block).not.toMatch(/@media/);
    expect(block).toMatch(/\.bn-editor\.bn-editor \[data-content-type="heading"\]:not\(\[data-level\]\)\s*\{\s*--level:\s*2em;/);
    expect(block).toMatch(/\[data-content-type="heading"\]\[data-level="2"\]\s*\{\s*--level:\s*1\.5em;/);
    expect(block).toMatch(/\[data-content-type="heading"\]\[data-level="3"\]\s*\{\s*--level:\s*1\.25em;/);
  });

  it("the heading-type-change transition's starting --prev-level is kept in sync", () => {
    expect(block).toMatch(/\.bn-editor\.bn-editor \[data-prev-level="1"\]\s*\{\s*--prev-level:\s*2em;/);
    expect(block).toMatch(/\.bn-editor\.bn-editor \[data-prev-level="2"\]\s*\{\s*--prev-level:\s*1\.5em;/);
    expect(block).toMatch(/\.bn-editor\.bn-editor \[data-prev-level="3"\]\s*\{\s*--prev-level:\s*1\.25em;/);
  });

  it("each rule doubles .bn-editor.bn-editor and never writes a bare font-size", () => {
    expect(block.match(/\.bn-editor\.bn-editor \[data-content-type="heading"\]/g) ?? []).toHaveLength(3);
    expect(block.match(/\.bn-editor\.bn-editor \[data-prev-level=/g) ?? []).toHaveLength(3);
    expect(block).not.toMatch(/font-size/);
  });

  it("the drag preview's (.bn-drag-preview, under body) heading --level uses the same sizes", () => {
    expect(preview.block).not.toBe("");
    expect(preview.depth).toBe(0);
    expect(preview.block).toMatch(/\.bn-drag-preview\.bn-drag-preview \[data-content-type="heading"\]:not\(\[data-level\]\)\s*\{\s*--level:\s*2em;/);
    expect(preview.block).toMatch(/\.bn-drag-preview\.bn-drag-preview \[data-content-type="heading"\]\[data-level="2"\]\s*\{\s*--level:\s*1\.5em;/);
    expect(preview.block).toMatch(/\.bn-drag-preview\.bn-drag-preview \[data-content-type="heading"\]\[data-level="3"\]\s*\{\s*--level:\s*1\.25em;/);
  });

  it("desktop side-menu height = 36px + 1.5 x font size: H1 84, H2 72, H3 66 (class doubled to beat BlockNote)", () => {
    expect(sideMenu.block).not.toBe("");
    expect(sideMenu.depth).toBe(0);
    expect(sideMenu.block).toMatch(/\.bn-side-menu\.bn-side-menu\[data-block-type="heading"\]\[data-level="1"\]\s*\{\s*height:\s*84px;/);
    expect(sideMenu.block).toMatch(/\.bn-side-menu\.bn-side-menu\[data-block-type="heading"\]\[data-level="2"\]\s*\{\s*height:\s*72px;/);
    expect(sideMenu.block).toMatch(/\.bn-side-menu\.bn-side-menu\[data-block-type="heading"\]\[data-level="3"\]\s*\{\s*height:\s*66px;/);
  });
});
