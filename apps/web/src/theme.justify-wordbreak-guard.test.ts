import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Body justified alignment: the `text-align: justify` and
 * `word-break: break-all` rules are **a pair** (see the comment above that block in `index.css`):
 * leaving justify alone stretches the only space on a line of the "short text + space + a long unbreakable thing" kind
 * to extremes (at 680px column width, 136.4px -> 7.9px, see the measurements in index.css).
 * This test pins "the two go in and out together": neither half may be deleted alone, and neither may be changed alone so that the other half loses its reason to exist.
 */

function readIndexCssWithoutComments(): string {
  return readFileSync(`${process.cwd()}/src/index.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("body justified alignment + long-identifier word-break (go in and out together)", () => {
  it("the text-align: justify (with hyphens: auto) and word-break: break-all rules must both exist", () => {
    const css = readIndexCssWithoutComments();

    const hasJustify = /text-align:\s*justify;/.test(css);
    const hasHyphens = /hyphens:\s*auto;/.test(css);
    const hasWordBreakAll = /word-break:\s*break-all;/.test(css);

    expect(hasJustify, "找不到 text-align: justify——這條若被刪，下面的 word-break: break-all 也該一起刪").toBe(
      true,
    );
    expect(hasHyphens, "找不到 hyphens: auto——與 text-align: justify 同一條規則、同進同出").toBe(true);
    expect(
      hasWordBreakAll,
      "找不到 word-break: break-all——justify 若沒有這條搭著，長識別字那一行會把唯一的空白拉爆",
    ).toBe(true);
  });

  it("word-break: break-all hits only the <a> of the link mark and inline code, not the wikilink <a> (#269: wikilinks aren't broken mid-word)", () => {
    const css = readIndexCssWithoutComments();
    // Since #269 a wikilink also renders as `<a>` (the outer span carries data-inline-content-type="wikilink"), and the old bare `a` selector would put
    // break-all on it too. The link one is now written **unquoted** as `[data-inline-content-type=link]` (same convention as `[data-content-type=...]` in this file):
    // adding quotes would pull it into `linkRules()` of `theme.link-guard.test.ts` and make its "exactly two rules" case go red.
    const rules = [...css.matchAll(/([^{}]*)\{([^}]*)\}/g)].filter((m) => /word-break:\s*break-all/.test(m[2]!));
    expect(rules, "word-break: break-all 應恰好一條規則").toHaveLength(1);
    // Split the comma list and judge one by one (repo convention).
    const selectors = rules[0]![1]!
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    document.body.innerHTML =
      '<div class="bn-editor"><div class="bn-inline-content">' +
      '<a data-inline-content-type="link" href="https://x.example/a">l</a>' +
      '<span data-inline-content-type="wikilink"><a href="/notes/x">w</a></span>' +
      "<code>c</code></div></div>";
    const hit = (el: Element) => selectors.some((s) => el.matches(s));
    expect(hit(document.querySelector('a[data-inline-content-type="link"]')!), "link mark 的 <a> 要命中").toBe(true);
    expect(hit(document.querySelector("code")!), "行內 code 要命中").toBe(true);
    expect(hit(document.querySelector('[data-inline-content-type="wikilink"] a')!), "wikilink 的 <a> 不得命中（#269）").toBe(false);
    document.body.innerHTML = "";
  });
});
