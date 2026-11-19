import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LIST_STICKY_TOP_VAR, PHONE_PAGE_SCROLL_ATTR, ROOT_FLAGS, STICKY_TOP_VAR } from "@/lib/page-scroll";

/**
 * On phones (< 640) the list and notes scroll the document (`lib/page-scroll.ts`). The page-level styles are in `index.css`: the html / body background colour,
 * the scroll-margin that makes blocks clear the header, which screens block pull-to-refresh, and note slide-in not using transform. jsdom doesn't apply CSS, so this guards only the source.
 */
const css = readFileSync(`${process.cwd()}/src/index.css`, "utf8")
  .replaceAll("\r\n", "\n")
  .replace(/\/\*[\s\S]*?\*\//g, "");

const phoneBlocks = css.match(/@media \(width < 40rem\) \{(?:[^{}]|\{[^{}]*\})*\}/g) ?? [];

function phoneRule(selectors: string[]): string | null {
  const want = [...selectors].sort().join("|");
  for (const block of phoneBlocks) {
    for (const match of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const list = match[1]!.replace(/^[\s\S]*?\{/, "").split(",").map((s) => s.trim()).filter(Boolean);
      if ([...list].sort().join("|") === want) return match[2]!;
    }
  }
  return null;
}

const APP = `html[${ROOT_FLAGS.pageScroll}]`;

function splitTopLevel(text: string, isSep: (ch: string) => boolean): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (depth === 0 && isSep(ch)) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

const ROOT_TYPES = ["html", "body", ":root"];

function typeOf(compound: string): string {
  return /^(?:[a-zA-Z][\w-]*|\*|:root)?/.exec(compound)![0].toLowerCase();
}

/**
 * The anchor may be a `:has()` selector on `<html>` / `<body>`. Look at each compound selector: one carrying `:has(` counts if it matches either of:
 * the type is html / body / :root / `*`; or it has no type and no class, id or attribute qualifier (a bare `:has(`, `:not(.x):has(`),
 * and the compound selectors before it are only html / body / :root (or it is the first).
 */
function rootAnchoredHas(source: string): string[] {
  const hits: string[] = [];
  for (const match of source.matchAll(/([^{}]+)\{/g)) {
    const prelude = match[1]!.slice(match[1]!.lastIndexOf(";") + 1).trim();
    if (prelude.startsWith("@")) continue;
    for (const raw of splitTopLevel(prelude, (ch) => ch === ",")) {
      const selector = raw.trim();
      const compounds = splitTopLevel(selector, (ch) => /[\s>+~]/.test(ch)).filter(Boolean);
      const hit = compounds.some((compound, index) => {
        if (!compound.includes(":has(")) return false;
        const type = typeOf(compound);
        if (ROOT_TYPES.includes(type) || type === "*") return true;
        const bare = type === "" && !/^[.#[]/.test(compound);
        return bare && compounds.slice(0, index).every((before) => ROOT_TYPES.includes(typeOf(before)));
      });
      if (hit) hits.push(selector);
    }
  }
  return hits;
}

describe("page-level styles for phone page scrolling", () => {
  it("when the frame is present the html and body background is the card colour (the area behind Safari's bottom toolbar and revealed by bounce matches the content)", () => {
    expect(phoneRule([APP, `${APP} body`])).toMatch(/background-color:\s*var\(--color-card\);/);
  });

  it("note blocks (the target when scrolling to a paragraph or search result) carry scroll-margin-top = the header height NoteEditor measures; html sets no scroll-padding-top (when the header's own button regains focus the document isn't scrolled away)", () => {
    const rule = phoneRule([`[${PHONE_PAGE_SCROLL_ATTR}] .bn-block-outer`, `[${PHONE_PAGE_SCROLL_ATTR}] .bn-block-content`]);
    expect(rule).toMatch(new RegExp(`scroll-margin-top:\\s*var\\(${STICKY_TOP_VAR},\\s*0px\\);`));
    expect(css).not.toContain("scroll-padding-top");
  });

  it("list screens (including the search layer) and a note being edited block pull-to-refresh; set on both html and body", () => {
    const rule = phoneRule([
      `html[${ROOT_FLAGS.listShown}]`,
      `html[${ROOT_FLAGS.listShown}] body`,
      `html[${ROOT_FLAGS.editToolbar}]`,
      `html[${ROOT_FLAGS.editToolbar}] body`,
    ]);
    expect(rule).toMatch(/overscroll-behavior-y:\s*contain;/);
  });

  it("page-level rules don't use html / body / :root as the anchor of :has() (any node insertion or removal can make the whole document recompute styles); they look at a flag on html instead", () => {
    expect(rootAnchoredHas(css)).toEqual([]);
  });

  it("the check above recognises the various writings (including :has() after :not(), *:has(), a bare outermost :has()) and doesn't misjudge :has() on ordinary elements", () => {
    const bad = [
      "html:has([data-x]) { a: b; }",
      "html:has([data-x]) body { a: b; }",
      "html:not(.dark):has([data-x]) body { a: b; }",
      "html[data-y]:has(.z) { a: b; }",
      "body:has(> .x) { a: b; }",
      ":root:has(.x) { a: b; }",
      "*:has(> .x) { a: b; }",
      ":has(> .x) { a: b; }",
      ":not(.a):has(.x) .y { a: b; }",
      ".ok, html:has(.x) { a: b; }",
      "html[data-has-x] body:has(.y) { a: b; }",
      "html > body:has(.y) { a: b; }",
      ":root body:has(.y) { a: b; }",
      "html > :has(.y) { a: b; }",
      "@media (width < 40rem) { html:has(.x) { a: b; } }",
    ];
    for (const rule of bad) expect(rootAnchoredHas(rule), rule).not.toEqual([]);
    const good = [
      ".bn-block:has(> .bn-block-content) { a: b; }",
      "[data-radix-popper-content-wrapper]:has(> .kb-menu-sheet)::before { a: b; }",
      ".a :has(.b) { a: b; }",
      "html .x:has(.y) { a: b; }",
      "html[data-has-x] body { a: b; }",
      "li:has(> input[type=checkbox]) { a: b; }",
      "html .x:has(.y) .z { a: b; }",
      "body > .app :has(.y) { a: b; }",
    ];
    for (const rule of good) expect(rootAnchoredHas(rule), rule).toEqual([]);
  });

  it("these rules apply only at phone width (outside width < 40rem there is no rule with data-phone-page-scroll / data-phone-list-shown)", () => {
    const outside = phoneBlocks.reduce((rest, block) => rest.replace(block, ""), css);
    expect(outside).not.toContain(PHONE_PAGE_SCROLL_ATTR);
    expect(outside).not.toContain("data-phone-list-shown");
    for (const flag of Object.values(ROOT_FLAGS)) expect(outside).not.toContain(flag);
  });

  it("note slide-in animates transform (a compositing layer), not left or other reflow properties; the floating button isn't inside the sliding element", () => {
    const frames = css.match(/@keyframes kb-phone-enter \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(frames).toMatch(/from \{\s*transform:\s*translateX\(100%\);\s*\}/);
    expect(frames).toMatch(/to \{\s*transform:\s*translateX\(0\);\s*\}/);
    expect(frames).not.toMatch(/\bleft:/);
    expect(css).toMatch(/\.kb-phone-enter \{\s*animation:\s*kb-phone-enter 200ms ease-out;\s*\}/);
  });

  it("list rows (with the links and buttons inside) carry scroll-margin-top = the pinned height the list measured, so that when focus moves there it clears the top bar and title row", () => {
    const rule = phoneRule([
      `[${PHONE_PAGE_SCROLL_ATTR}] [data-sidebar-list] [data-node-kind]`,
      `[${PHONE_PAGE_SCROLL_ATTR}] [data-sidebar-list] [data-node-kind] *`,
    ]);
    expect(rule).toMatch(new RegExp(`scroll-margin-top:\\s*var\\(${LIST_STICKY_TOP_VAR},\\s*0px\\);`));
  });

  it("presentation slides scrolled to the ends don't drag the page behind (overscroll-behavior: contain)", () => {
    const present = readFileSync(`${process.cwd()}/src/present/present.css`, "utf8").replaceAll("\r\n", "\n").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(present).toMatch(/\.kn-present \.reveal \.slides section\[data-kn-slide-id\] \{[^}]*overscroll-behavior:\s*contain;/);
  });
});
