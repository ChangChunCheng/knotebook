import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Structural guard for the scrollbar block (same technique as `theme.blocknote-vars.test.ts`: strip comments ->
 * locate the block -> verify the structure).
 *
 * Background: see the comment above the scrollbar block in `index.css`: once the standard `scrollbar-width` /
 * `scrollbar-color` is set in Chromium 121+, the whole `::-webkit-scrollbar` family of
 * pseudo-element styles is disabled (a Chromium implementation rule) - so the standard properties must be wrapped in
 * `@supports (-moz-appearance: none)` (matched only by Firefox).
 *
 * When this invariant breaks it is **hardly noticeable**: Chromium still shows a 10px + same-colour thumb, but silently loses the
 * rounded corners, the content-box inset and hover - eyeball review and the whole unit suite
 * can't catch it, only the source structure guard here.
 *
 * **The one exception (issue #111)**: standard properties on `::picker(select)` inside `@supports (appearance: base-select)`.
 * That pseudo-element has no webkit styles to disable (that selector chain is dropped by Tailwind's Lightning CSS at build time),
 * so only the standard properties are available. The exception requires both "inside that block" and "selector contains ::picker(select)"
 * to hold, see the assertions below.
 */

function readIndexCssWithoutComments(): string {
  const path = `${process.cwd()}/src/index.css`;
  const css = readFileSync(path, "utf8");
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

const SUPPORTS_GUARD = /@supports \(-moz-appearance: none\)\s*\{/;

/**
 * Cuts out the whole block (the content inside the braces) from where `pattern` matches, by brace matching.
 *
 * Returns an empty string when not found: this helper is currently used only to cut the `@supports (appearance: base-select)`
 * block from the rest of the CSS, and that block is issue #111's progressive enhancement - if it were ever rolled back entirely, this
 * guard should keep guarding what it was meant to (where the webkit rules are), rather than blow up because "the block wasn't found".
 */
function extractBlock(css: string, pattern: RegExp): string {
  const match = pattern.exec(css);
  if (!match) return "";
  let i = css.indexOf("{", match.index);
  const from = i + 1;
  for (let depth = 1; depth > 0; ) {
    i += 1;
    expect(i, `區塊花括號不配對：${pattern.source}`).toBeLessThan(css.length);
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") depth -= 1;
  }
  return css.slice(from, i);
}

function splitAtSupportsGuard(css: string): { inside: string; outside: string } {
  const match = SUPPORTS_GUARD.exec(css);
  expect(match, "index.css 找不到 @supports (-moz-appearance: none) guard 區塊").not.toBeNull();
  const braceStart = css.indexOf("{", match!.index);
  let depth = 0;
  for (let i = braceStart; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) {
        return {
          inside: css.slice(braceStart + 1, i),
          outside: css.slice(0, match!.index) + css.slice(i + 1),
        };
      }
    }
  }
  expect.unreachable("@supports guard 區塊花括號不配對");
}

describe("scrollbar @supports guard structure", () => {
  it("the standard scrollbar-width/scrollbar-color appear only inside the guard, and the guard has both", () => {
    const { inside, outside } = splitAtSupportsGuard(readIndexCssWithoutComments());

    expect(inside, "guard 內應設 scrollbar-width").toContain("scrollbar-width:");
    expect(inside, "guard 內應設 scrollbar-color").toContain("scrollbar-color:");
    // The Firefox branch must also take the shared value (issue #111) - otherwise "one value" is a misnomer:
    // hard-coding a colour here would make Firefox's scrollbar and Chromium's go their own ways.
    expect(inside, "Firefox 分支的 thumb 顏色要走 --scrollbar-thumb").toContain("var(--scrollbar-thumb)");

    // With any standard property outside the guard, Chromium 121+ disables the ::-webkit-scrollbar pseudo-element styles under **that element**
    // as a whole (silently, hard to spot by eye).
    //
    // The one exception (issue #111): `::picker(select)` (the list a customisable select expands to). That
    // pseudo-element has **no** webkit styles to disable - the browser does accept the `::picker(select)::-webkit-scrollbar` chain,
    // but Tailwind v4's Lightning CSS can't parse it and drops the whole rule at build time
    // (0 occurrences in dist, also with `cssMinify:false`), so only the standard properties are available there.
    //
    // The exception is let through only when **both conditions hold**: the rule is inside the `@supports (appearance: base-select)`
    // block and the selector contains `::picker(select)`. Looking at the selector string alone,
    // `.some-panel, .x::picker(select) { scrollbar-width: thin }` would let `.some-panel` (a real element) through along with it
    // - and that element's ::-webkit-scrollbar styles would be silently disabled by Chromium, which is exactly why this file exists.
    const baseSelect = extractBlock(outside, /@supports\s*\(\s*appearance:\s*base-select\s*\)\s*\{/);
    const rulesOf = (css: string) =>
      [...css.matchAll(/([^{}]*)\{([^}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! }));

    const offenders = rulesOf(outside.replace(baseSelect, "")).filter((r) =>
      /scrollbar-(?:width|color):/.test(r.body),
    );
    expect(
      offenders.map((r) => r.selector),
      "guard 外只有 @supports (appearance: base-select) 內的 ::picker(select) 可以用標準 scrollbar-width/color",
    ).toEqual([]);

    // Inside the base-select block only the picker may use them too - the select itself (a real element) selector is there as well.
    // The comma list must be **split and checked one by one**: if "::picker(select) appears somewhere in the whole string" let it pass,
    // `.some-panel, .x::picker(select) { scrollbar-width: thin }` would smuggle the real element
    // `.some-panel` in, and its ::-webkit-scrollbar styles would be silently disabled by Chromium
    // - exactly why this file exists.
    const insideBaseSelect = rulesOf(baseSelect).filter(
      (r) =>
        /scrollbar-(?:width|color):/.test(r.body) &&
        !r.selector.split(",").every((one) => /::picker\(select\)/.test(one)),
    );
    expect(
      insideBaseSelect.map((r) => r.selector),
      "base-select 區塊內用標準 scrollbar 屬性的規則，**每一個**選擇器都必須是 ::picker(select)",
    ).toEqual([]);
  });

  it("::-webkit-scrollbar pseudo-element rules are outside the guard, and none inside", () => {
    const { inside, outside } = splitAtSupportsGuard(readIndexCssWithoutComments());

    // All basic parts must be present: base, track, thumb, thumb hover, corner.
    // `(?<![\w.-])` excludes the shape "right after a class / id / element name": index.css also has
    // `.scrollbar-x-thin::-webkit-scrollbar{...}` (the backlinks strip's 6px scrollbar), which,
    // unanchored, would stand in for the global rule - deleting the real global declaration would stay green.
    // Boundary: it can't block a whitespace-separated descendant selector shape (`.card ::-webkit-scrollbar{...}`),
    // which isn't a naturally occurring form, so no complexity is added for it.
    for (const selector of [
      /(?<![\w.-])::-webkit-scrollbar\s*\{/,
      /(?<![\w.-])::-webkit-scrollbar-track\s*\{/,
      /(?<![\w.-])::-webkit-scrollbar-thumb\s*\{/,
      /(?<![\w.-])::-webkit-scrollbar-thumb:hover\s*\{/,
      /(?<![\w.-])::-webkit-scrollbar-corner\s*\{/,
    ]) {
      expect(outside, `guard 外應有 ${selector.source} 規則`).toMatch(selector);
    }
    expect(inside, "guard 內不該有 ::-webkit-scrollbar 規則（Firefox 用不到、也會誤導維護者）").not.toContain("::-webkit-scrollbar");
  });
});

/**
 * issue #111: the scrollbar of the select picker (the list expanded by `appearance: base-select`) must use the **same set of values** as the note one.
 *
 * Why "two rule sets, one set of values" rather than merging into one rule: `::picker(select)` is an invalid selector in browsers that
 * don't support it yet, and **one invalid selector in a selector list voids the whole rule** - merged into the global one,
 * Firefox would lose the scrollbar styles of the entire app. What is guarded here is that this compromise hasn't drifted: the picker set
 * may only reference `--scrollbar-*` variables, and any literal value means another copy was made (the values would go their own ways).
 */
describe("select picker scrollbar shares one set of values with the global one", () => {
  // Of the four variables, the one shared three ways is `--scrollbar-thumb` (global webkit, the Firefox branch and the picker
  // all use it); the other three are used only by the global set (the picker can only use standard properties and can't give size or inset).
  // All are listed so that deleting or renaming any variable also turns red.
  const SHARED_VARS = ["--scrollbar-size", "--scrollbar-thumb", "--scrollbar-thumb-inset", "--scrollbar-thumb-hover"];

  function pickerScrollbarBodies(): string[] {
    const css = readIndexCssWithoutComments();
    return [...css.matchAll(/::picker\(select\)[^{]*\{([^}]*)\}/g)]
      .map((m) => m[1]!)
      .filter((body) => /scrollbar/.test(body));
  }

  it("all four variables are defined, and the global scrollbar rules reference variables rather than literal values", () => {
    const css = readIndexCssWithoutComments();
    for (const name of SHARED_VARS) {
      expect(css, `index.css 缺共用變數 ${name}`).toContain(`${name}:`);
    }
    const globalThumb = /(?<![\w.-])::-webkit-scrollbar-thumb\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(globalThumb, "全域 thumb 的顏色要走共用變數").toContain("var(--scrollbar-thumb)");
    expect(globalThumb, "全域 thumb 不得再寫死 color-mix（那份值就會與 picker 各走各的）").not.toContain("color-mix");
  });

  it("the picker's scrollbar is set, its thumb colour references the shared variable and has no literal colour", () => {
    const bodies = pickerScrollbarBodies();
    expect(bodies.length, "index.css 缺 ::picker(select) 的捲軸設定——清單會用瀏覽器預設捲軸（含 stepper 箭頭）").toBeGreaterThan(0);

    const joined = bodies.join(" ");
    expect(joined, "picker 的 thumb 顏色要走 --scrollbar-thumb（與筆記那條同一份值）").toContain(
      "var(--scrollbar-thumb)",
    );
    expect(joined, "picker 的軌道要透明，與全域一致").toContain("transparent");

    // A literal colour = another copy was made, and the values would go their own ways.
    const literals = joined.match(/(?:color-mix|#[0-9a-f]{3,8}|oklch\()/gi) ?? [];
    expect(literals, `picker 的捲軸出現字面色 ${literals.join(", ")}——改引用 --scrollbar-* 變數`).toEqual([]);
  });
});
