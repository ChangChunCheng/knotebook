import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LIST_STICKY_TOP_VAR, PHONE_PAGE_SCROLL_ATTR, ROOT_FLAGS, STICKY_TOP_VAR } from "@/lib/page-scroll";

/**
 * 手機（< 640）上清單與筆記捲的是文件（`lib/page-scroll.ts`）。頁面層的樣式在 `index.css`：html／body 的底色、
 * 區塊讓開頁首的 scroll-margin、哪些畫面擋下拉重新整理、筆記滑入不用 transform。jsdom 不套 CSS，這裡只守原始碼。
 */
const css = readFileSync(`${process.cwd()}/src/index.css`, "utf8")
  .replaceAll("\r\n", "\n")
  .replace(/\/\*[\s\S]*?\*\//g, "");

/** 所有 `@media (width < 40rem) { … }` 區塊（只到第二層大括號）。 */
const phoneBlocks = css.match(/@media \(width < 40rem\) \{(?:[^{}]|\{[^{}]*\})*\}/g) ?? [];

/** 手機區塊裡，選擇器清單恰好是 `selectors` 的那一條規則的宣告；找不到回 null。 */
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

/** 在最外層（不在括號裡）的 `sep` 處切開。 */
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

/** 複合選擇器開頭的型別（`html`、`*`、`:root`……），沒有型別時是空字串。 */
function typeOf(compound: string): string {
  return /^(?:[a-zA-Z][\w-]*|\*|:root)?/.exec(compound)![0].toLowerCase();
}

/**
 * 錨點可能是 `<html>`／`<body>` 的 `:has()` 選擇器。逐一看每個複合選擇器，帶 `:has(` 而且符合其一就算：
 * 型別是 html／body／:root／`*`；或沒有型別也沒有 class、id、屬性限定（裸 `:has(`、`:not(.x):has(`），
 * 而它前面的複合選擇器只有 html／body／:root（或它就是第一個）。
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

describe("手機頁面捲動的頁面層樣式", () => {
  it("外框在時 html 與 body 的底色是卡片色（Safari 底部工具列後面、回彈露出的區域與內容同色）", () => {
    expect(phoneRule([APP, `${APP} body`])).toMatch(/background-color:\s*var\(--color-card\);/);
  });

  it("筆記的區塊（捲到段落、搜尋結果時的目標）帶 scroll-margin-top＝NoteEditor 量好的頁首高度；html 不設 scroll-padding-top（頁首自己的鈕拿回焦點時文件不會被捲走）", () => {
    const rule = phoneRule([`[${PHONE_PAGE_SCROLL_ATTR}] .bn-block-outer`, `[${PHONE_PAGE_SCROLL_ATTR}] .bn-block-content`]);
    expect(rule).toMatch(new RegExp(`scroll-margin-top:\\s*var\\(${STICKY_TOP_VAR},\\s*0px\\);`));
    expect(css).not.toContain("scroll-padding-top");
  });

  it("清單畫面（含搜尋層）與編輯中的筆記擋下拉重新整理；html 與 body 都設", () => {
    const rule = phoneRule([
      `html[${ROOT_FLAGS.listShown}]`,
      `html[${ROOT_FLAGS.listShown}] body`,
      `html[${ROOT_FLAGS.editToolbar}]`,
      `html[${ROOT_FLAGS.editToolbar}] body`,
    ]);
    expect(rule).toMatch(/overscroll-behavior-y:\s*contain;/);
  });

  it("頁面層的規則不以 html／body／:root 當 :has() 的錨點（任何節點插入或移除都可能讓整份文件重算樣式），改看 html 上的旗標", () => {
    expect(rootAnchoredHas(css)).toEqual([]);
  });

  it("上一條的檢查本身認得出各種寫法（含 :not() 之後的 :has()、*:has()、最外層裸 :has()），也不誤判一般元素上的 :has()", () => {
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

  it("這些規則都只在手機寬度（width < 40rem 之外沒有 data-phone-page-scroll／data-phone-list-shown 的規則）", () => {
    const outside = phoneBlocks.reduce((rest, block) => rest.replace(block, ""), css);
    expect(outside).not.toContain(PHONE_PAGE_SCROLL_ATTR);
    expect(outside).not.toContain("data-phone-list-shown");
    for (const flag of Object.values(ROOT_FLAGS)) expect(outside).not.toContain(flag);
  });

  it("筆記滑入動的是 transform（合成層），不動 left 之類會重排的屬性；浮動鈕不在滑動的元素裡（AppShell.page-scroll PS10）", () => {
    const frames = css.match(/@keyframes kb-phone-enter \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(frames).toMatch(/from \{\s*transform:\s*translateX\(100%\);\s*\}/);
    expect(frames).toMatch(/to \{\s*transform:\s*translateX\(0\);\s*\}/);
    expect(frames).not.toMatch(/\bleft:/);
    expect(css).toMatch(/\.kb-phone-enter \{\s*animation:\s*kb-phone-enter 200ms ease-out;\s*\}/);
  });

  it("清單列（連同列裡的連結與按鈕）帶 scroll-margin-top＝清單量好的釘住高度，焦點移過去時讓開頂列與標題列", () => {
    const rule = phoneRule([
      `[${PHONE_PAGE_SCROLL_ATTR}] [data-sidebar-list] [data-node-kind]`,
      `[${PHONE_PAGE_SCROLL_ATTR}] [data-sidebar-list] [data-node-kind] *`,
    ]);
    expect(rule).toMatch(new RegExp(`scroll-margin-top:\\s*var\\(${LIST_STICKY_TOP_VAR},\\s*0px\\);`));
  });

  it("簡報的投影片捲到頭尾不帶動背後的頁面（overscroll-behavior: contain）", () => {
    const present = readFileSync(`${process.cwd()}/src/present/present.css`, "utf8").replaceAll("\r\n", "\n").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(present).toMatch(/\.kn-present \.reveal \.slides section\[data-kn-slide-id\] \{[^}]*overscroll-behavior:\s*contain;/);
  });
});
