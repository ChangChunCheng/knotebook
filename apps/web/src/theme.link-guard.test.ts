import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Structural guard for link styling inside note content (issue #153, same technique as `theme.block-selection-guard.test.ts`).
 *
 * Failures in this family are silent, and invisible to jsdom / unit tests / eyeball review:
 * - Without the `.bn-editor` ancestor anchor => the selector falls back to (0,1,0), and BlockNote's CSS in the NotePage
 *   lazy chunk always loads after `index.css`, so at equal specificity we lose.
 * - Colour written as `--primary` => in this repo `--primary` is **neutral high-contrast** (near-black in light),
 *   so links look like body text and the issue isn't fixed.
 * - Underline removed => links are told apart by colour alone (WCAG 1.4.1).
 * - The icon's `mask-image` replaced by a hard-coded-colour `background-image` => across six accents x light/dark
 *   twelve cases, the icon and the text colour start to diverge.
 * - **The icon disappears entirely**: an inline-block with `content: ""` and no `width`/`height` is a
 *   0x0 box, and so is removing `display: inline-block` - neither reports an error or turns any
 *   other test red.
 * - **`--color-brand` declared outside `:root`** (e.g. someone adds a line inside `.dark`) => in dark
 *   mode the editor's `.bn-root.dark` takes it back again and the accent falls back to indigo, i.e.
 *   silently restoring the bug #153 worked around. The accent-vars test only requires it to appear in
 *   `@theme inline` and can't block an extra declaration.
 */

function readIndexCssWithoutComments(): string {
  return readFileSync(`${process.cwd()}/src/index.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Cuts out the **contents** of the whole block from where `pattern` matches, by brace matching (same-named helper as in
 * `theme.scrollbar-guard.test.ts`). Returns an empty string when not found; the caller asserts.
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

function linkRules(): Array<{ selectors: string[]; body: string }> {
  const css = readIndexCssWithoutComments();
  return [...css.matchAll(/([^{}]*data-inline-content-type[^{}]*)\{([^}]*)\}/g)]
    .map((m) => ({
      // Comma lists must be split and judged one by one (repo convention, see the comment in `theme.scrollbar-guard.test.ts`):
      // a whole-string `test()` would be fooled by the shape "a valid selector + an unanchored selector merged into one rule".
      selectors: m[1]!
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
      body: m[2]!,
    }))
    .filter((r) => r.selectors.some((s) => /data-inline-content-type\s*=\s*"link"/.test(s)));
}

const baseRule = () => linkRules().filter((r) => r.selectors.every((s) => !s.includes("::after")));
const afterRule = () => linkRules().filter((r) => r.selectors.every((s) => s.includes("::after")));

describe("link styling inside notes (issue #153)", () => {
  it("exactly two rules: one for the link itself, one for the new-tab icon (::after), with no rule mixing ::after and the link itself", () => {
    // A mixed shape (`a, a::after { ... }`) blurs the meaning of every assertion below - the link itself and the pseudo-element should set
    // different sets of properties. Block it first.
    expect(linkRules(), "index.css 找不到 link inline content 的樣式規則").toHaveLength(2);
    expect(baseRule(), "應有且只有一條連結本體的規則").toHaveLength(1);
    expect(afterRule(), "應有且只有一條 ::after 圖示的規則").toHaveLength(1);
  });

  it("every selector is anchored at .bn-editor (specificity must beat the later-loaded BlockNote CSS)", () => {
    for (const rule of linkRules()) {
      for (const selector of rule.selectors) {
        expect(selector, `少了 .bn-editor 錨點：${selector}`).toMatch(/^\.bn-editor\s/);
      }
    }
  });

  it("uses data-inline-content-type=\"link\" instead of a bare a (don't hit links inside the editor chrome)", () => {
    for (const rule of linkRules()) {
      for (const selector of rule.selectors) {
        expect(selector, `選擇器要用 link mark 的 data 屬性：${selector}`).toMatch(
          /\[data-inline-content-type\s*=\s*"link"\]/,
        );
        // A bare `a` would hit anchors in floating layers / toolbars / custom blocks all the way down.
        expect(selector, `選擇器不得含裸 a：${selector}`).not.toMatch(/(?:^|[\s>+~])a(?=[\s>+~:.[]|$)/);
      }
    }
  });

  it("link itself: theme colour --brand + a solid underline (links must not be told apart by colour alone)", () => {
    const { body } = baseRule()[0]!;
    expect(body, "顏色要走 var(--color-brand)").toContain("var(--color-brand)");
    // `--primary` is neutral high-contrast in this repo (near-black in light) - using it as the link colour changes nothing.
    expect(body, "不得用 --color-primary（中性色，看起來跟正文一樣）").not.toContain("var(--color-primary)");
    expect(body, "顏色不得寫字面值（就不跟使用者選的主題色走了）").not.toMatch(/#[0-9a-f]{3,8}|oklch\(|rgb\(/i);
    expect(body, "底線是 WCAG 1.4.1 的載體，不得拿掉").toMatch(/text-decoration(?:-line)?:\s*[^;]*underline/);
    expect(body).not.toMatch(/text-decoration(?:-line)?:\s*none/);
  });

  it("icon: CSS mask + currentColor (follows the theme colour automatically), no icon package, no hard-coded colour", () => {
    const { body } = afterRule()[0]!;
    expect(body, "偽元素要有 content").toMatch(/content:\s*""/);
    expect(body, "圖形走 mask-image ＋ 內嵌 SVG data URI").toMatch(/mask-image:\s*url\("data:image\/svg\+xml,/);
    // The colour comes from background-color taking currentColor => it follows the link itself's --brand, with no need
    // for a data URI per six accents x light/dark.
    expect(body, "顏色要取 currentColor").toMatch(/background-color:\s*currentColor/);
    // The `background-image` route would encode the colour into the SVG, and the icon would no longer match after a theme change.
    expect(body, "不得改用 background-image（顏色會被編進 SVG）").not.toContain("background-image:");
    expect(body, "圖示不得寫字面色").not.toMatch(/(?:background-)?color:\s*(?:#[0-9a-f]{3,8}|oklch\(|rgb\()/i);
    // Deliberately **not** pinning `pointer-events: none` here: in a headed run (Chrome 152) with and without it,
    // hover / click / drag-select behave identically (the only difference is the return value of `caretRangeFromPoint`,
    // and upstream's `handleClick` returns true, so that difference can't reach user actions), so this repo has no
    // such rule and shouldn't use a test to pin a claim whose effect can't be measured. The measurement details are in the index.css comment.
  });

  it("the icon actually renders and has spacing: inline-block + size and both side margins all non-zero", () => {
    const { body } = afterRule()[0]!;
    // The replaced content of `content: ""` is empty, so the box size is decided entirely by width/height - if either
    // is absent (or written as 0) the icon **disappears entirely** while every other assertion stays green.
    expect(body, "圖示盒子要 inline-block（inline 的 width/height 無效）").toMatch(
      /display:\s*inline-block/,
    );
    // Always judge `parseFloat(...) > 0`: this rejects `0` / `0px` / `0.0em` / `-0px` and also the shapes `auto` /
    // `max-content` / `initial` for which `parseFloat` gives `NaN` (`auto` renders here pixel-for-pixel the same as
    // `0.0em`, which is what this really needs to block). **Take the last match** - CSS takes the last one,
    // and looking only at the first would pass green if `width: 0` were appended at the end of the block.
    const declaration = (prop: string) =>
      [...body.matchAll(new RegExp(`(?:^|[;{])\\s*${prop}:\\s*([^;]+)`, "g"))].at(-1)?.[1]?.trim();

    // Size and both side margins only block "absent or non-positive" and don't pin concrete values - the values are a visual judgement, and pinning them would only
    // produce false reds on reasonable tweaks.
    for (const prop of ["width", "height", "margin-inline-start", "margin-inline-end"] as const) {
      const value = declaration(prop);
      expect(value, `圖示缺 ${prop}`).toBeDefined();
      expect(parseFloat(value!), `圖示的 ${prop} 不是正值：${value}`).toBeGreaterThan(0);
    }
    // A shorthand overrides the two longhands above as a group (appending a `margin-inline: 0` at the end would bypass them).
    expect(body, "這個區塊不得用 margin／margin-inline 簡寫（會覆蓋兩側 longhand）").not.toMatch(
      /(?:^|[;{])\s*margin(?:-inline)?:/,
    );
  });

  it("`--color-brand:` may be declared only inside `@theme inline` - that is the precondition of the dark-mode accent workaround", () => {
    // In dark mode `.bn-root` carries the `dark` class; before #154 it matched the bare `.dark`
    // base block in `index.css` and reset `--brand` back to indigo (#154 anchored the base block to `:root.dark`; the guard is
    // `theme.accent-vars.test.ts`, and this is the second line of defence). Links and wikilinks both go through `--color-brand` (declared only in
    // `@theme inline`, which Tailwind compiles to a single `:root,:host` place where the value is computed and then inherited) to work around
    // it. If someone declares `--color-brand:` again in `.dark` / `[data-accent]` / any other
    // selector, that workaround silently stops working and the bug comes back as before, and
    // `theme.accent-vars.test.ts` only checks that it appears in `@theme inline`, so it can't block this.
    const css = readIndexCssWithoutComments();
    const themeInline = extractBlock(css, /@theme\s+inline\s*\{/);
    expect(themeInline, "index.css 找不到 @theme inline 區塊").toContain("--color-brand:");

    const outside = css.replace(themeInline, "");
    const offenders = [...outside.matchAll(/([^{}]*)\{([^}]*)\}/g)]
      .filter((m) => /(?:^|[;{])\s*--color-brand:/.test(m[2]!))
      .map((m) => m[1]!.trim());
    expect(
      offenders,
      "`--color-brand:` 只能宣告在 @theme inline 內；多一處宣告就會讓 .bn-root.dark 奪回主題色",
    ).toEqual([]);
  });

  it("the icon is attached only to http(s) links - wikilinks and mailto: / tel: etc. must have no ::after icon", () => {
    const css = readIndexCssWithoutComments();
    const wikilinkAfter = [...css.matchAll(/([^{}]*data-inline-content-type\s*=\s*"wikilink"[^{}]*)\{/g)]
      .map((m) => m[1]!.trim())
      .filter((s) => s.includes("::after"));
    expect(wikilinkAfter, "wikilink 是同分頁導航的 <a>（#269），掛開新分頁圖示就是說謊").toEqual([]);
    // Reverse: **each** selector of the ::after rule must carry both the link type and an href prefix restriction. Without the type
    // restriction it would hit wikilinks; without the prefix restriction it would hit `mailto:` / `tel:` / `sms:` (link marks
    // that don't open in a tab), and "opens in a new tab" becomes a mislabel. The prefixes may only be the allowlist below (the #156 criterion).
    const ALLOWED_PREFIXES = [
      String.raw`[href^="http:" i]`,
      String.raw`[href^="https:" i]`,
      String.raw`[href^="//"]`,
      String.raw`[href^="\\\\"]`,
      String.raw`[href^="/\\"]`,
      String.raw`[href^="\\/"]`,
    ];
    for (const selector of afterRule()[0]!.selectors) {
      expect(selector, `::after 選擇器缺 link 型別限定（會命中 wikilink）：${selector}`).toMatch(
        /\[data-inline-content-type\s*=\s*"link"\]/,
      );
      const hrefParts = selector.match(/\[href[^\]]*\]/g) ?? [];
      expect(hrefParts, `::after 選擇器要恰好一個 href 前綴限定：${selector}`).toHaveLength(1);
      expect(ALLOWED_PREFIXES, `::after 選擇器的 href 限定不在 #156 的白名單裡：${selector}`).toContain(hrefParts[0]);
    }
    // Every allowlist entry must be covered by some selector (one fewer = external links written that way get no icon, the original #156 shape).
    for (const prefix of ALLOWED_PREFIXES) {
      expect(
        afterRule()[0]!.selectors.some((s) => s.includes(prefix)),
        `沒有任何 ::after 選擇器蓋到 ${prefix}`,
      ).toBe(true);
    }
  });

  it("#269: a wikilink's <a href> (even a same-site absolute URL) doesn't hit any ::after icon selector", () => {
    document.body.innerHTML =
      '<div class="bn-editor"><span data-inline-content-type="wikilink"><a href="https://kb.example.com/notes/x">t</a></span></div>';
    const a = document.querySelector("a")!;
    for (const selector of afterRule()[0]!.selectors) {
      expect(a.matches(selector.replace(/::after\s*$/, "")), selector).toBe(false);
    }
    document.body.innerHTML = "";
  });

  describe("#156: the icon criterion must agree with the browser's URL parsing (the selectors are actually matched against href)", () => {
    // Plain-http deployments look the same; for https pages see the same-scheme http:foo case below.
    const PAGE = "http://knotebook.local/n/some-note";
    const iconMatches = (href: string) => {
      const a = document.createElement("a");
      a.setAttribute("data-inline-content-type", "link");
      a.setAttribute("href", href);
      return afterRule()[0]!.selectors.some((s) =>
        a.matches(s.replace(/^\.bn-editor\s+/, "").replace(/::after$/, "")),
      );
    };
    const resolvesToAnotherHttpOrigin = (href: string) => {
      const url = new URL(href, PAGE);
      return (url.protocol === "http:" || url.protocol === "https:") && url.origin !== new URL(PAGE).origin;
    };

    const EXTERNAL = [
      "https://x.com",
      "http://x.com/a?b#c",
      "HTTPS://X.COM",
      "Http://x.com",
      "hTtPs://x.com",
      "//evil.com",
      "//evil.com/path",
      String.raw`\\evil.com`,
      String.raw`/\evil.com`,
      String.raw`\/evil.com`,
      String.raw`https:\\x.com`,
      String.raw`HTTPS:/\x.com`,
      "https:x.com", // cross-scheme (page is http): the parser ignores any number of slashes, the host is x.com
    ];
    it.each(EXTERNAL)("external link %s -> has icon", (href) => {
      expect(resolvesToAnotherHttpOrigin(href), `測資前提：${href} 應解析成另一個 http(s) 來源`).toBe(true);
      expect(iconMatches(href), `${href} 是外連卻沒有開新分頁圖示`).toBe(true);
    });

    // Case variants must be blocked too.
    const NO_ICON = [
      "mailto:a@b.com",
      "MAILTO:a@b.com",
      "tel:+886212345678",
      "sms:+886912345678",
      "callto:someone",
      "xmpp:a@b.com",
      "httpfoo:x", // another scheme that merely starts with http
      "/n/other-note",
      "other-note",
      "#heading",
      "?q=1",
    ];
    it.each(NO_ICON)("non-external %s -> no icon", (href) => {
      expect(resolvesToAnotherHttpOrigin(href), `測資前提：${href} 不應解析成另一個 http(s) 來源`).toBe(false);
      expect(iconMatches(href), `${href} 不開到別的網站卻掛了開新分頁圖示`).toBe(false);
    });

    it("same-scheme `http:foo` is a same-site relative path: an icon isn't a mislabel either (target=_blank, it really opens a new tab)", () => {
      // Parser: same scheme as the page and not followed by `//` => a relative path. The icon claims "opens a new tab",
      // which still holds; this case just records in plain text the consequence of the criterion deliberately comparing `http:` rather than `http://`.
      expect(new URL("http:foo", PAGE).origin).toBe(new URL(PAGE).origin);
      expect(iconMatches("http:foo")).toBe(true);
    });

    it("known not covered (can only under-mark, never mislabel; examples, not exhaustive): leading whitespace / control characters, a tab or newline anywhere in the URL", () => {
      // A literal prefix can't match, but the parser strips them (a tab / newline is removed entirely at **any position**). It's written as a test so that
      // if one day they are covered, this case goes red, reminding to update the "still not covered" notes in `docs/known-limitations.md` and the index.css comment.
      for (const href of [
        " https://x.com",
        "\thttps://x.com",
        "ht\ttps://x.com",
        "https\n://x.com",
        "/\t/x.com", // with the tab stripped it is `//x.com` (protocol-relative)
        "/\n/x.com",
        // Counter-example reminder: `https:/\n/x.com` **has** the icon (the literal prefix `https:` already matches), so it isn't in this list.
      ]) {
        expect(resolvesToAnotherHttpOrigin(href), `測資前提：${JSON.stringify(href)} 是外連`).toBe(true);
        expect(iconMatches(href), `${JSON.stringify(href)} 現在有圖示了——更新已知限制`).toBe(false);
      }
    });
  });
});
