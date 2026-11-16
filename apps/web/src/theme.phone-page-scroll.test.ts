import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LIST_STICKY_TOP_VAR, PHONE_PAGE_SCROLL_ATTR, STICKY_TOP_VAR } from "@/lib/page-scroll";

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

const APP = `html:has([${PHONE_PAGE_SCROLL_ATTR}])`;

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
      "html:has([data-phone-list-shown])",
      "html:has([data-phone-list-shown]) body",
      "html:has([data-mobile-edit-toolbar])",
      "html:has([data-mobile-edit-toolbar]) body",
    ]);
    expect(rule).toMatch(/overscroll-behavior-y:\s*contain;/);
  });

  it("這些規則都只在手機寬度（width < 40rem 之外沒有 data-phone-page-scroll／data-phone-list-shown 的規則）", () => {
    const outside = phoneBlocks.reduce((rest, block) => rest.replace(block, ""), css);
    expect(outside).not.toContain(PHONE_PAGE_SCROLL_ATTR);
    expect(outside).not.toContain("data-phone-list-shown");
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
