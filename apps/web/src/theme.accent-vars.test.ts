import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import en from "./i18n/en.json";
import zhTW from "./i18n/zh-TW.json";
import { type Accent, ACCENTS } from "./theme";

/**
 * Parity guard for the accent theme tokens (same technique as `theme.blocknote-vars.test.ts`:
 * strip comments -> locate the block -> extract values).
 *
 * Background: see the block comment above the twelve accent blocks in `index.css`:
 * - Six colours x light/dark make twelve `[data-accent=...]` blocks; the values must be copied verbatim from the established value table.
 * - The five `--brand*` tokens in the `:root` / `:root.dark` base blocks (`--brand-fg` doesn't count, see below)
 *   are the fallback when the attribute is absent and must equal the indigo set verbatim - this is the pivot of
 *   "the first-paint fallback and the colour set on hydrate are the same".
 * - `--brand-fg` isn't per colour: it is declared only in the two base blocks `:root` / `:root.dark`, and all six colours share one
 *   foreground colour that doesn't change with the accent. It isn't in `TOKEN_NAMES` (that is for per-colour tokens),
 *   and is guarded separately below: both base blocks must have it, and it must not appear in any
 *   `[data-accent=...]` block.
 * - `--brand-soft` / `--brand-soft-strong` always derive from the three oklch values of that colour's dark `--brand` (the base colour)
 *   (light /14%, /20%; dark /16%, /24%), never from the light `--brand`.
 *
 * General rule: tokens are matched **by exact name, anchored by the colon** (the four exact names `--brand:` /
 * `--brand-soft:` / `--brand-soft-strong:` / `--brand-on-soft:`).
 * With the colon right after the name, `--brand-soft-strong:` can't match `--brand-soft:` and
 * `--brand-swatch-*:` can't match `--brand:`, so no extra prefix-exclusion logic is needed.
 * Any extraction failure (regex not found) must fail immediately through `expect(...).not.toBeNull()`,
 * so that undefined never reaches later comparisons and passes falsely as undefined===undefined.
 *
 * The colour list always comes from `ACCENTS` imported from `theme.tsx` (never copied by hand): adding a colour changes only ACCENTS;
 * a missing CSS block is caught by the block checks below, a missing i18n colour name by the i18n check.
 */

const COLORS = ACCENTS;
type Color = Accent;

const TOKEN_NAMES = ["--brand", "--brand-soft", "--brand-soft-strong", "--brand-on-soft", "--brand-deep"] as const;

function readIndexCssWithoutComments(): string {
  const path = `${process.cwd()}/src/index.css`;
  const css = readFileSync(path, "utf8");
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// These blocks contain no nested braces, so the first `}` after the start ends the block.
function extractBlockBody(css: string, selectorRegex: RegExp, label: string): string {
  const match = selectorRegex.exec(css);
  expect(match, `index.css 找不到區塊：${label}`).not.toBeNull();
  const start = match!.index;
  const braceStart = css.indexOf("{", start);
  expect(braceStart, `${label} 找不到起始 {`).toBeGreaterThan(-1);
  const end = css.indexOf("}", braceStart);
  expect(end, `${label} 找不到結尾 }`).toBeGreaterThan(-1);
  return css.slice(braceStart + 1, end);
}

function extractDataAccentBlock(css: string, prefix: ":root" | ":root.dark", color: Color): string {
  // `:root\[` won't swallow `:root.dark[...]` (a `.dark` sits in between), so the two prefixes don't overlap.
  const escapedPrefix = prefix === ":root" ? ":root" : ":root\\.dark";
  const regex = new RegExp(`${escapedPrefix}\\[data-accent=${color}\\]\\s*\\{`);
  return extractBlockBody(css, regex, `${prefix}[data-accent=${color}]`);
}

function extractBaseBlock(css: string, prefix: ":root" | ":root.dark"): string {
  const escapedPrefix = prefix === ":root" ? ":root" : ":root\\.dark";
  const regex = new RegExp(`${escapedPrefix}\\s*\\{`);
  return extractBlockBody(css, regex, `基底 ${prefix}`);
}

function extractToken(body: string, name: (typeof TOKEN_NAMES)[number], label: string): string {
  const regex = new RegExp(`${name}:\\s*([^;]+);`);
  const match = regex.exec(body);
  expect(match, `${label} 找不到 token ${name}`).not.toBeNull();
  return match![1].trim();
}

function extractSwatch(body: string, color: Color, label: string): string {
  const regex = new RegExp(`--brand-swatch-${color}:\\s*([^;]+);`);
  const match = regex.exec(body);
  expect(match, `${label} 找不到 --brand-swatch-${color}`).not.toBeNull();
  return match![1].trim();
}

function extractOklchTriple(value: string, label: string): string {
  const match = /oklch\(([^)/]+)\)/.exec(value);
  expect(match, `${label} 的 --brand 值不是純 oklch(三值) 型式：${value}`).not.toBeNull();
  return match![1].trim();
}

describe("accent theme token parity", () => {
  const cssNoComments = readIndexCssWithoutComments();

  it("all twelve [data-accent=...] blocks and the :root / :root.dark base blocks have all four exact-name tokens", () => {
    for (const color of COLORS) {
      const lightBody = extractDataAccentBlock(cssNoComments, ":root", color);
      const darkBody = extractDataAccentBlock(cssNoComments, ":root.dark", color);
      for (const name of TOKEN_NAMES) {
        extractToken(lightBody, name, `:root[data-accent=${color}]`);
        extractToken(darkBody, name, `:root.dark[data-accent=${color}]`);
      }
    }

    const baseLight = extractBaseBlock(cssNoComments, ":root");
    const baseDark = extractBaseBlock(cssNoComments, ":root.dark");
    for (const name of TOKEN_NAMES) {
      extractToken(baseLight, name, "基底 :root");
      extractToken(baseDark, name, "基底 :root.dark");
    }
  });

  it("all :root.dark[data-accent=...] blocks come after all :root[data-accent=...] blocks", () => {
    const lightIndices = COLORS.map((color) => {
      const regex = new RegExp(`:root\\[data-accent=${color}\\]\\s*\\{`);
      const match = regex.exec(cssNoComments);
      expect(match, `找不到 :root[data-accent=${color}]`).not.toBeNull();
      return match!.index;
    });
    const darkIndices = COLORS.map((color) => {
      const regex = new RegExp(`:root\\.dark\\[data-accent=${color}\\]\\s*\\{`);
      const match = regex.exec(cssNoComments);
      expect(match, `找不到 :root.dark[data-accent=${color}]`).not.toBeNull();
      return match!.index;
    });

    const maxLightIndex = Math.max(...lightIndices);
    const minDarkIndex = Math.min(...darkIndices);
    expect(maxLightIndex).toBeLessThan(minDarkIndex);
  });

  it("swatch equals the matching block's --brand; the four tokens of the :root / :root.dark base blocks = the indigo block values", () => {
    const baseLight = extractBaseBlock(cssNoComments, ":root");
    const baseDark = extractBaseBlock(cssNoComments, ":root.dark");

    for (const color of COLORS) {
      const lightBody = extractDataAccentBlock(cssNoComments, ":root", color);
      const darkBody = extractDataAccentBlock(cssNoComments, ":root.dark", color);

      const swatchLight = extractSwatch(baseLight, color, "基底 :root");
      const swatchDark = extractSwatch(baseDark, color, "基底 :root.dark");

      expect(swatchLight, `--brand-swatch-${color}（:root）應等於 :root[data-accent=${color}] 的 --brand`).toBe(
        extractToken(lightBody, "--brand", `:root[data-accent=${color}]`),
      );
      expect(swatchDark, `--brand-swatch-${color}（:root.dark）應等於 :root.dark[data-accent=${color}] 的 --brand`).toBe(
        extractToken(darkBody, "--brand", `:root.dark[data-accent=${color}]`),
      );
    }

    const indigoLightBody = extractDataAccentBlock(cssNoComments, ":root", "indigo");
    const indigoDarkBody = extractDataAccentBlock(cssNoComments, ":root.dark", "indigo");
    for (const name of TOKEN_NAMES) {
      expect(extractToken(baseLight, name, "基底 :root"), `基底 :root 的 ${name} 應等於 :root[data-accent=indigo]`).toBe(
        extractToken(indigoLightBody, name, ":root[data-accent=indigo]"),
      );
      expect(extractToken(baseDark, name, "基底 :root.dark"), `基底 :root.dark 的 ${name} 應等於 :root.dark[data-accent=indigo]`).toBe(
        extractToken(indigoDarkBody, name, ":root.dark[data-accent=indigo]"),
      );
    }
  });

  it("the six --color-brand* mapping lines appear inside the @theme inline block", () => {
    const themeInlineSelector = /@theme inline\s*\{/;
    const match = themeInlineSelector.exec(cssNoComments);
    expect(match, "找不到 @theme inline 區塊").not.toBeNull();
    const start = match!.index;
    const braceStart = cssNoComments.indexOf("{", start);
    const blockEnd = cssNoComments.indexOf("}", braceStart);
    expect(blockEnd).toBeGreaterThan(-1);

    const mappingNames = [
      "--color-brand",
      "--color-brand-soft",
      "--color-brand-soft-strong",
      "--color-brand-on-soft",
      "--color-brand-deep",
      "--color-brand-fg",
    ];
    for (const name of mappingNames) {
      const regex = new RegExp(`${name}:`, "g");
      let found = false;
      let occurrence: RegExpExecArray | null;
      while ((occurrence = regex.exec(cssNoComments))) {
        if (occurrence.index > braceStart && occurrence.index < blockEnd) {
          found = true;
          break;
        }
      }
      expect(found, `${name}: 應出現在 @theme inline 區塊內（不是 @theme 或其他地方）`).toBe(true);
    }
  });

  it("per colour, --brand-soft / --brand-soft-strong = the three values of that colour's :root.dark --brand + the matching alpha", () => {
    for (const color of COLORS) {
      const darkBody = extractDataAccentBlock(cssNoComments, ":root.dark", color);
      const darkBrand = extractToken(darkBody, "--brand", `:root.dark[data-accent=${color}]`);
      const triple = extractOklchTriple(darkBrand, `:root.dark[data-accent=${color}]`);

      const lightBody = extractDataAccentBlock(cssNoComments, ":root", color);

      const expectedLightSoft = normalizeWhitespace(`oklch(${triple} / 14%)`);
      const expectedLightStrong = normalizeWhitespace(`oklch(${triple} / 20%)`);
      const expectedDarkSoft = normalizeWhitespace(`oklch(${triple} / 16%)`);
      const expectedDarkStrong = normalizeWhitespace(`oklch(${triple} / 24%)`);

      expect(
        normalizeWhitespace(extractToken(lightBody, "--brand-soft", `:root[data-accent=${color}]`)),
        `:root[data-accent=${color}] 的 --brand-soft 應＝該色 dark --brand 三值 /14%`,
      ).toBe(expectedLightSoft);
      expect(
        normalizeWhitespace(extractToken(lightBody, "--brand-soft-strong", `:root[data-accent=${color}]`)),
        `:root[data-accent=${color}] 的 --brand-soft-strong 應＝該色 dark --brand 三值 /20%`,
      ).toBe(expectedLightStrong);
      expect(
        normalizeWhitespace(extractToken(darkBody, "--brand-soft", `:root.dark[data-accent=${color}]`)),
        `:root.dark[data-accent=${color}] 的 --brand-soft 應＝該色 dark --brand 三值 /16%`,
      ).toBe(expectedDarkSoft);
      expect(
        normalizeWhitespace(extractToken(darkBody, "--brand-soft-strong", `:root.dark[data-accent=${color}]`)),
        `:root.dark[data-accent=${color}] 的 --brand-soft-strong 應＝該色 dark --brand 三值 /24%`,
      ).toBe(expectedDarkStrong);
    }
  });

  it("every accent has i18n colour names in both languages", () => {
    // With a missing key the UI silently shows the raw key (e.g. accent.purple) as aria-label / tooltip,
    // and the en <-> zh-TW parity test can't see "missing on both sides" - so this checks coverage against ACCENTS directly.
    for (const color of COLORS) {
      expect(en.accent, `en 缺 accent.${color}`).toHaveProperty(color);
      expect(zhTW.accent, `zh-TW 缺 accent.${color}`).toHaveProperty(color);
    }
  });

  it("--brand-fg is declared only in the :root / :root.dark base blocks - not per colour, all six share the same one", () => {
    const brandFgRe = /--brand-fg:\s*([^;]+);/;
    const baseLight = extractBaseBlock(cssNoComments, ":root");
    const baseDark = extractBaseBlock(cssNoComments, ":root.dark");
    expect(brandFgRe.exec(baseLight), "基底 :root 找不到 --brand-fg").not.toBeNull();
    expect(brandFgRe.exec(baseDark), "基底 :root.dark 找不到 --brand-fg").not.toBeNull();

    for (const color of COLORS) {
      const lightBody = extractDataAccentBlock(cssNoComments, ":root", color);
      const darkBody = extractDataAccentBlock(cssNoComments, ":root.dark", color);
      expect(
        brandFgRe.exec(lightBody),
        `:root[data-accent=${color}] 不該宣告 --brand-fg（不分色票，改色不該讓它跟著換）`,
      ).toBeNull();
      expect(
        brandFgRe.exec(darkBody),
        `:root.dark[data-accent=${color}] 不該宣告 --brand-fg（不分色票，改色不該讓它跟著換）`,
      ).toBeNull();
    }
  });

  it("in rules that declare theme variables, every item of the selector list must be anchored at :root / html (#154: the editor subtree must not reset theme variables)", () => {
    // BlockNote writes light/dark as classes on `.bn-root` and `portalElement`, and writes `data-color-scheme` on `.bn-root`. Any rule **not anchored at the root element**
    // that declares a theme variable may hit again inside the editor subtree (or any other subtree) and reset the user's chosen accent (and other theme variables) there
    // - a utility like `text-brand` is evaluated on the element, so inside the editor it goes back to indigo (the original #154 shape).
    // So the criterion does **not look at** whether the selector mentions `.dark`: `[data-color-scheme=dark]` and `.bn-root` are just as dangerous.
    // Theme variables should be declared only once on the root element and inherited downward.
    //
    const declaredNames = (body: string) => [...body.matchAll(/(?:^|[;{\s])(--[\w-]+)\s*:/g)].map((m) => m[1]!);
    const themeVars = new Set([
      ...declaredNames(extractBaseBlock(cssNoComments, ":root")),
      ...declaredNames(extractBaseBlock(cssNoComments, ":root.dark")),
    ]);
    expect(themeVars.has("--brand"), "主題變數集合應含 --brand（抽基底塊失敗就會是空集合、守衛形同虛設）").toBe(true);

    // Valid shape: a **single compound selector** starting with `:root` or `html` (no whitespace or combinator in between),
    // e.g. `:root`, `:root.dark`, `:root.dark[data-accent=gold]`, `html.dark`.
    const anchored = /^(?::root|html)(?![\w-])[^\s>+~]*$/;

    const offenders: string[] = [];
    let checked = 0;
    // The innermost `selector { body }`: rules inside `@media` / `@supports` and CSS-nested `&.dark { ... }`
    // are also hit by this (for the nested shape the extracted selector is `&.dark`, which doesn't start with :root => a violation).
    for (const m of cssNoComments.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      // The first top-level block is preceded by `@import ...;` / `@custom-variant ...;`, so the selector is whatever follows the last `;`.
      const selectorText = m[1]!.split(";").at(-1)!;
      const declared = declaredNames(m[2]!).filter((name) => themeVars.has(name));
      if (declared.length === 0) continue;
      // Comma lists must be split and judged one by one (repo convention): `:root.dark, .dark { ... }` tested as a whole would be fooled by the legal half.
      for (const selector of selectorText.split(",").map((s) => s.trim())) {
        checked += 1;
        if (!anchored.test(selector)) offenders.push(`${selector}  （宣告了 ${declared.slice(0, 3).join("、")}…）`);
      }
    }
    // Must not run idle: the two base blocks + twelve accent blocks, so at least fourteen must be checked.
    expect(checked, "應至少檢查到 14 條宣告主題變數的規則").toBeGreaterThanOrEqual(2 + 2 * COLORS.length);
    expect(
      offenders,
      "這些規則會在 BlockNote 的 `.bn-root`／浮層（或任何子樹）上把主題變數重設；選擇器要錨在 :root（例如 `:root.dark`）",
    ).toEqual([]);
  });
});
