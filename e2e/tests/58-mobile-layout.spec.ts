import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { E2E_ORIGIN } from "../ports.js";
import { ADMIN, createUserViaInvite, editorLocator, loginAs, randomEmail, showSidebarTab, startSidebarSelection, tapAreaOf, waitForEditorSelection } from "./helpers.js";

/**
 * 內文標題字級（所有寬度）與手機（< 640）版面：內容貼齊畫面邊緣、提及列在內文捲動容器裡、寬表格的右緣提示。全部量瀏覽器算出來的值，不看 class 名稱。
 *
 * 58-1 標題字級（390、800）：內文 H1／H2／H3 的 computed font-size 是基準字級的 2／1.5／1.25 倍（基準 16px），兩種寬度一樣；
 *      手機寬度下筆記標題框仍是 20px。
 * 58-2 貼邊（390、800）：390 時內文卡的 x＝0、寬＝視窗寬，AppShell 外框的 padding 四邊都是 0；800 時外框仍是 12px、內文卡不貼邊。
 * 58-3 簡報（390）：投影片的 h1 > h2 > h3，h1 是它所在容器字級的 1.75 倍。
 * 58-4 短筆記沒有多餘的捲動範圍（390，鍵盤收起）：一行字的筆記，文件 scrollHeight − 視窗高 ＝ 0（手機上捲的是文件）——沒有提及時沒有提及列；
 *      有提及時提及列在第一屏內、排在文章欄之後；編輯中（工具列在）時工具列的空白是捲動內容的最後一個子節點，範圍仍是 0。
 * 58-5 寬表格右緣提示（390）：表格還能往右捲時 `--kb-table-fade` 是 1.5rem（24px），捲到底變 0；沒有溢出的表格是 0。
 * 58-6 不支援捲動驅動動畫時的後備（390）：委派的捲動監聽在還能往右捲的表格上標 `data-kb-more-right`，捲到底拿掉，
 *      沒有溢出的表格不標；非手機寬度不標。
 * 58-7 桌面側邊選單（1280，滑鼠）：hover H1／H2／H3 時，拖曳把手的垂直中線與標題首行文字的中線差 ≤ 1px。
 * 58-8 對話框是貼底的 sheet（390）：分享框的底緣＝視窗底、左右貼齊視窗、上緣有圓角；✕ 的點擊範圍 44×44；
 *      螢幕鍵盤（假的 `visualViewport`）升起時 sheet 的底緣跟著升到鍵盤上方，收起後回到視窗底。
 * 58-9 版本整頁（390）：「Back」鈕高 44。
 * 58-10 公開頁頁首（390）：標題比改前寬（≥ 180px）、「Present」只剩圖示、唯讀只剩一個點（文字只給螢幕閱讀器）。
 * 58-17 手機筆記頁（390）：沒在編輯時左下 Search、右下 New note 兩顆毛玻璃浮動鈕（位置與清單畫面相同；背景半透明加 backdrop-filter 模糊）；
 *      開始編輯時不在、離開編輯回來；Search 開搜尋層（層開著時不在）；New note 建新筆記；長筆記最後一段能捲到鈕之上。
 * 58-18 選單 sheet（390 觸控）：筆記頁 ⋮、清單列 ⋮、資料夾 ⋮、頭像選單貼齊視窗左右與底（x＝0、寬＝390、底＝844），文字列高 ≥ 48，
 *      背板蓋滿視窗；移動到…換掉整個 sheet 內容、最上面一列 Back，逐層進出、Back 回主選單；假鍵盤升起時底緣跟著升；點背板關閉。
 * 58-19 寬螢幕（1280）：筆記頁 ⋮ 仍是貼著按鈕的小選單（右緣對齊按鈕、在按鈕下方），沒有背板。
 * 58-20 開 ⋮ 的那一下（390×560，清單最低的一列；放開的那一點在 sheet 升起後落在選單項上）：觸控按住 250ms（含減少動態）、滑鼠按住 250ms 放開後，sheet 開在主選單，
 *      沒有選到任何項目（沒有寫入請求、網址不變、沒有對話框）。觸控用 CDP 的 touchStart／touchEnd，Playwright 的 tap 是瞬間放開。
 * 58-16 管理面板（390 觸控）：從帳號選單開的設定是幾乎滿高的 sheet（左右與底貼齊、上方 0～40 的縫、上圓角），先停在項次清單，
 *      左上角「‹」（Back to menu、點擊範圍 44）；選項次後同一個位置是 Back to sections；沒有 ✕；視窗變矮時跟著變矮；
 *      清單的「‹」關掉並重開帳號選單；點上方的縫整個關掉；深連結停在那一頁，清單的「‹」（Close）只關。
 *      面板與同一個畫面的選單 sheet 是同一家族（淺色、深色各量一次）：卡的底色與陰影等於選單 sheet 的、上圓角 12px、托盤沒有模糊與底色；
 *      項次清單的列高 ≥ 48、16px 一般字重、列與列相貼、4px 圓角、沒有常駐底色、列尾 16px 的「›」；標題 18px/600、列頭有髮絲線；
 *      第二層標題 18px/600 並與「‹」垂直置中。
 * 58-21 站台管理、快捷鍵頁從帳號選單開、群組面板從群組列 ⋮ 開：清單的「‹」重開開啟它的那個選單；三個面板同樣量上述表面、清單與標題，
 *      快捷鍵條目名稱 16px、說明 14px。
 * 58-11～58-15 手機清單（390）：兩顆 56px 浮動鈕的位置、最後一列捲得到鈕上方、搜尋中／選取／垃圾桶的顯示；桌面星號與 ⋮ 的位置；
 *      列的左右內距相等、星號與 ⋮ 的點擊範圍不重疊、字級 15／12、頂列標題與頭像對齊；筆記頁首位置在標題正下方、「‹」置中於區塊。
 * 58-22～58-31 手機上捲的是文件、不是內層容器（58-22～58-27、58-29），以及管理面板的表面（58-28、58-30、58-31）：
 *      58-22 清單（390×844）：滑輪捲動的是文件（window.scrollY 變、清單容器沒有捲動範圍）；頂列貼在頂端、標題列緊接在下、兩者底色不透明；
 *            最後一列捲得到浮動鈕上方；html／body 的底色與清單相同、清單延伸到視窗底；清單 → 筆記時 scrollY 是 0，系統返回回到原本的 scrollY。
 *      58-23 短清單：文件沒有捲動範圍，清單仍延伸到視窗底。
 *      58-24 長筆記（390×844）：滑輪捲動的是文件；頁首貼在頂端（標題、「‹」在視窗內）、底色不透明、高度等於區塊的 scroll-margin-top；
 *            最後一段捲得到浮動鈕上方；html／body 與內文卡同色、卡延伸到視窗底；開關 ⋮ 選單與分享對話框（Radix 鎖捲動）時 scrollY 不變；
 *            搜尋層從頂端開始，Cancel 回到原本的 scrollY。
 *      58-25 下拉重新整理：清單與編輯中的筆記 html／body 的 overscroll-behavior-y 是 contain，瀏覽中的筆記是 auto。
 *      58-26 寬螢幕（1280×800）：文件沒有捲動範圍，滑輪捲動的是內文容器，scrollY 恆為 0。
 *      58-27 轉向跨過 640（390×844 → 844×390 → 390×844）：長筆記停在同一段（橫拿時在內文容器頂端、轉回時在頁首正下方）。
 *      58-28 寬螢幕（1280）：管理面板維持原樣——列 36px／14px／8px 圓角、目前的項次有品牌底、沒有「›」、托盤有毛玻璃、第二層標題 20px；700 的清單層仍是 ← 與 ✕、36px／14px。
 *      58-29 轉向跨過 640：清單轉回直拿時同一列仍在標題列正下方（橫拿時清單收在抽屜裡）。
 *      58-30 手機（390）深色：表格卡的主欄格與「‹」的底色跟卡一致。
 *      58-31 矮的手機螢幕（568×320）：項次清單自己捲動、列頭不動，最後一列捲得到、點得到。
 *
 * 量不到、列在實機清單：iOS Safari 的工具列是否隨捲動收起、內容是否延伸到半透明的底部工具列後面、瀏海與 Home 指示條的 safe area、
 * 真實螢幕鍵盤升起時的捲動範圍與釘住的頁首位置、下拉重新整理是否真的被擋。
 *
 * 帳號與資料：用邀請建一個帳號（alice），資料以 API 建一次，之後各案例開新 context。
 */

test.use({ actionTimeout: 15_000 });

const RUN = Date.now();
const PASSWORD = "e2e-mobile-layout-pw";
const ORIGIN = E2E_ORIGIN;
const BASE_FONT_PX = 16;

const TITLES = {
  headings: `E2E layout headings ${RUN}`,
  short: `E2E layout short ${RUN}`,
  mentioned: `E2E layout mentioned ${RUN}`,
  mentioner: `E2E layout mentioner ${RUN}`,
  wide: `E2E layout wide table ${RUN}`,
  deck: `E2E layout deck ${RUN}`,
  published: `E2E layout public ${RUN}`,
  long: `E2E layout long ${RUN}`,
};

const HEADINGS_MD = ["# Heading one", "", "## Heading two", "", "### Heading three", "", "body text"].join("\n");
const DECK_MD = ["# Slide one", "", "## Slide two", "", "### Slide three", "", "slide text"].join("\n");
const LONG_LAST = "the very last paragraph";
const LONG_MD = [...Array.from({ length: 40 }, (_, i) => `paragraph number ${i}`), LONG_LAST].join("\n\n");
const WIDE_ROW = Array.from({ length: 10 }, (_, i) => `a rather long cell ${i}`);
const TABLE_MD = [
  "wide and narrow",
  "",
  `| ${WIDE_ROW.map((_, i) => `Column ${i}`).join(" | ")} |`,
  `| ${WIDE_ROW.map(() => "---").join(" | ")} |`,
  `| ${WIDE_ROW.join(" | ")} |`,
  "",
  "| Name | Value |",
  "| --- | --- |",
  "| a | 1 |",
].join("\n");

let alice: { email: string; displayName: string };
const paths: Record<keyof typeof TITLES, string> = { headings: "", short: "", mentioned: "", mentioner: "", wide: "", deck: "", published: "", long: "" };

async function createNoteVia(page: Page, title: string, content?: string): Promise<{ id: string; path: string }> {
  const res = await page.request.post("/api/notes", { headers: { Origin: ORIGIN }, data: content === undefined ? { title } : { title, content } });
  expect(res.status(), await res.text()).toBe(201);
  const note = (await res.json()) as { id: string; slug: string; ownerHandle: string };
  return { id: note.id, path: `/n/${note.ownerHandle}/${note.slug}` };
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  alice = { email: randomEmail(), displayName: `alice ${RUN}` };
  const admin = await browser.newContext();
  try {
    const page = await admin.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await createUserViaInvite(page, { ...alice, password: PASSWORD });
  } finally {
    await admin.close();
  }
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    const page = await context.newPage();
    await loginAs(page, alice.email, PASSWORD);
    paths.headings = (await createNoteVia(page, TITLES.headings, HEADINGS_MD)).path;
    paths.short = (await createNoteVia(page, TITLES.short, "one line")).path;
    paths.wide = (await createNoteVia(page, TITLES.wide, TABLE_MD)).path;
    paths.deck = (await createNoteVia(page, TITLES.deck, DECK_MD)).path;
    paths.long = (await createNoteVia(page, TITLES.long, LONG_MD)).path;
    const mentioned = await createNoteVia(page, TITLES.mentioned, "mentioned text");
    paths.mentioned = mentioned.path;
    // 提及：在另一篇裡打 `[[` 連到上面那篇，等反向連結出現
    const mentioner = await createNoteVia(page, TITLES.mentioner, "see");
    paths.mentioner = mentioner.path;
    await page.goto(mentioner.path);
    await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible({ timeout: 15_000 });
    await editorLocator(page).click();
    await page.keyboard.press("ControlOrMeta+End");
    await waitForEditorSelection(page);
    await page.keyboard.type(" [[");
    await page.keyboard.type(TITLES.mentioned);
    const menu = page.locator(".bn-suggestion-menu");
    await expect(menu.getByText(TITLES.mentioned, { exact: true })).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Enter");
    await expect(editorLocator(page).locator('[data-inline-content-type="wikilink"]')).toHaveCount(1, { timeout: 10_000 });
    await expect(async () => {
      const res = await page.request.get(`/api/notes/${mentioned.id}/backlinks`);
      expect(res.status()).toBe(200);
      const { backlinks } = (await res.json()) as { backlinks: Array<{ id: string }> };
      expect(backlinks.map((b) => b.id)).toContain(mentioner.id);
    }).toPass({ timeout: 20_000 });
  } finally {
    await context.close();
  }
});

async function open(browser: Browser, width: number, key: keyof typeof TITLES, opts: { touch?: boolean; height?: number; init?: () => void; backlinks?: boolean } = {}): Promise<{ context: BrowserContext; page: Page }> {
  const viewport = { width, height: opts.height ?? 844 };
  const context = await browser.newContext(opts.touch === false ? { viewport } : { hasTouch: true, isMobile: true, viewport });
  const page = await context.newPage();
  if (opts.init) await page.addInitScript(opts.init);
  await loginAs(page, alice.email, PASSWORD);
  await expect(page).toHaveURL(/\/$/);
  // 提及查詢的回應：先登記再 goto，之後「沒有提及列」的斷言才是在查詢回來之後做的
  const backlinksResponse = opts.backlinks ? page.waitForResponse((r) => r.url().endsWith("/backlinks") && r.ok()) : null;
  await page.goto(paths[key]);
  await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible({ timeout: 15_000 });
  await backlinksResponse;
  return { context, page };
}

const fontPx = (target: Locator): Promise<number> => target.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

/** 內文標題（區塊內的文字節點層）。 */
const headingText = (page: Page, text: string): Locator =>
  editorLocator(page).locator('[data-content-type="heading"] .bn-inline-content').filter({ hasText: new RegExp(`^${text}$`) });

async function headingSizes(page: Page): Promise<{ base: number; h1: number; h2: number; h3: number }> {
  await expect(headingText(page, "Heading three")).toBeVisible({ timeout: 15_000 });
  const base = await headingText(page, "Heading one").evaluate((el) => parseFloat(getComputedStyle(el.closest(".bn-block")!).fontSize));
  return {
    base,
    h1: await fontPx(headingText(page, "Heading one")),
    h2: await fontPx(headingText(page, "Heading two")),
    h3: await fontPx(headingText(page, "Heading three")),
  };
}

const scrollerOf = (page: Page): Locator => page.getByTestId("article-column").locator("xpath=ancestor::div[contains(@class,'overflow-y-auto')][1]");
const nextFrame = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

test("58-1 標題字級：390 與 800 都是 2／1.5／1.25 倍", async ({ browser }) => {
  const phone = await open(browser, 390, "headings");
  try {
    const sizes = await headingSizes(phone.page);
    expect(sizes.base).toBe(BASE_FONT_PX);
    expect(sizes.h1).toBeCloseTo(BASE_FONT_PX * 2, 1);
    expect(sizes.h2).toBeCloseTo(BASE_FONT_PX * 1.5, 1);
    expect(sizes.h3).toBeCloseTo(BASE_FONT_PX * 1.25, 1);
    expect(await fontPx(phone.page.getByRole("textbox", { name: "Note title" }))).toBe(20);
  } finally {
    await phone.context.close();
  }
  const wide = await open(browser, 800, "headings", { touch: false });
  try {
    const sizes = await headingSizes(wide.page);
    expect(sizes.base).toBe(BASE_FONT_PX);
    expect(sizes.h1).toBeCloseTo(BASE_FONT_PX * 2, 1);
    expect(sizes.h2).toBeCloseTo(BASE_FONT_PX * 1.5, 1);
    expect(sizes.h3).toBeCloseTo(BASE_FONT_PX * 1.25, 1);
  } finally {
    await wide.context.close();
  }
});

test("58-2 貼邊：390 內文卡貼齊視窗、外框 padding 0；800 仍有外框與卡片邊", async ({ browser }) => {
  const phone = await open(browser, 390, "short");
  try {
    const card = phone.page.locator("[data-note-header-slot]").locator("xpath=..");
    const box = await card.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBe(0);
    expect(box!.width).toBe(390);
    const frame = await phone.page.locator("div.h-dvh").first().evaluate((el) => {
      const cs = getComputedStyle(el);
      return [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft];
    });
    expect(frame).toEqual(["0px", "0px", "0px", "0px"]);
    const radius = await card.evaluate((el) => [getComputedStyle(el).borderTopLeftRadius, getComputedStyle(el).borderTopWidth]);
    expect(radius).toEqual(["0px", "0px"]);
  } finally {
    await phone.context.close();
  }
  const wide = await open(browser, 800, "short", { touch: false });
  try {
    const card = wide.page.locator("[data-note-header-slot]").locator("xpath=..");
    const box = await card.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(12);
    const frame = await wide.page.locator("div.h-dvh").first().evaluate((el) => {
      const cs = getComputedStyle(el);
      return [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft];
    });
    for (const side of frame) expect(parseFloat(side)).toBeGreaterThanOrEqual(12);
    expect(await card.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).not.toBe("0px");
  } finally {
    await wide.context.close();
  }
});

test("58-3 簡報（390）：h1 > h2 > h3，h1 是所在容器字級的 1.75 倍", async ({ browser }) => {
  const { context, page } = await open(browser, 390, "deck");
  try {
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "Present" }).click();
    await expect(page.getByRole("dialog", { name: `${TITLES.deck} — presentation` })).toBeVisible();
    await expect(page.locator(".reveal.ready")).toBeVisible({ timeout: 15_000 });
    const sizes = await page.evaluate(() => {
      const size = (selector: string) => {
        const el = document.querySelector(selector);
        return el === null ? null : { px: parseFloat(getComputedStyle(el).fontSize), parentPx: parseFloat(getComputedStyle(el.parentElement!).fontSize) };
      };
      return { h1: size(".kn-slide-body h1"), h2: size(".kn-slide-body h2"), h3: size(".kn-slide-body h3") };
    });
    expect(sizes.h1).not.toBeNull();
    expect(sizes.h2).not.toBeNull();
    expect(sizes.h3).not.toBeNull();
    expect(sizes.h1!.px / sizes.h1!.parentPx).toBeCloseTo(1.75, 2);
    expect(sizes.h1!.px).toBeGreaterThan(sizes.h2!.px);
    expect(sizes.h2!.px).toBeGreaterThan(sizes.h3!.px);
  } finally {
    await context.close();
  }
});

/** 手機上捲的是文件：文件比視窗高出多少。 */
async function scrollRange(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
}

/** 手機上把文件捲到底／頂。 */
const scrollPageToEnd = (page: Page): Promise<void> => page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
const scrollPageToTop = (page: Page): Promise<void> => page.evaluate(() => window.scrollTo(0, 0));

test("58-4 短筆記沒有多餘的捲動範圍：沒有提及時沒有提及列", async ({ browser }) => {
  const { context, page } = await open(browser, 390, "short", { backlinks: true });
  try {
    await expect(editorLocator(page).getByText("one line")).toBeVisible({ timeout: 15_000 });
    await nextFrame(page);
    expect(await scrollRange(page)).toBeLessThanOrEqual(1);
    await expect(page.getByText(/Mentioned in|No mentions yet/)).toHaveCount(0);
    // 編輯中：工具列的空白是捲動內容的最後一個子節點，範圍仍是 0
    await editorLocator(page).getByText("one line").click();
    await expect(page.locator("[data-mobile-edit-toolbar]")).toBeVisible({ timeout: 10_000 });
    expect(await scrollRange(page)).toBeLessThanOrEqual(1);
    const lastIsSpacer = await scrollerOf(page).evaluate((el) => (el.firstElementChild!.lastElementChild as HTMLElement).hasAttribute("data-mobile-toolbar-spacer"));
    expect(lastIsSpacer).toBe(true);
  } finally {
    await context.close();
  }
});

test("58-4b 短筆記有提及時：提及列在第一屏內、排在文章欄之後，範圍仍是 0", async ({ browser }) => {
  const { context, page } = await open(browser, 390, "mentioned");
  try {
    const title = page.getByText(/^Mentioned in 1 note$/);
    await expect(title).toBeVisible({ timeout: 15_000 });
    expect(await scrollRange(page)).toBeLessThanOrEqual(1);
    const geometry = await scrollerOf(page).evaluate((scroller) => {
      const column = scroller.querySelector('[data-testid="article-column"]') as HTMLElement;
      const footer = column.nextElementSibling as HTMLElement;
      const f = footer.getBoundingClientRect();
      return { footerText: footer.textContent ?? "", footerBottom: f.bottom, footerTop: f.top, viewportBottom: window.innerHeight, columnBottom: column.getBoundingClientRect().bottom };
    });
    expect(geometry.footerText).toContain("Mentioned in 1 note");
    expect(geometry.footerBottom).toBeLessThanOrEqual(geometry.viewportBottom + 0.5);
    expect(geometry.footerTop).toBeGreaterThanOrEqual(geometry.columnBottom - 0.5);
    // 編輯中：頁尾之後才是工具列的空白，頁尾仍在可視範圍內
    await editorLocator(page).getByText("mentioned text").click();
    await expect(page.locator("[data-mobile-edit-toolbar]")).toBeVisible({ timeout: 10_000 });
    expect(await scrollRange(page)).toBeLessThanOrEqual(1);
    const order = await scrollerOf(page).evaluate((el) => Array.from(el.firstElementChild!.children).map((child) => (child as HTMLElement).dataset.testid ?? (child.hasAttribute("data-mobile-toolbar-spacer") ? "spacer" : "footer")));
    expect(order).toEqual(["article-column", "footer", "spacer"]);
  } finally {
    await context.close();
  }
});

interface TableState {
  overflow: boolean;
  fade: number;
  marked: boolean;
  scrollLeft: number;
}

async function tableStates(page: Page): Promise<TableState[]> {
  return page.locator(".tableWrapper").evaluateAll((wrappers) =>
    wrappers.map((el) => ({
      overflow: el.scrollWidth - el.clientWidth > 1,
      fade: parseFloat(getComputedStyle(el).getPropertyValue("--kb-table-fade")) || 0,
      marked: el.hasAttribute("data-kb-more-right"),
      scrollLeft: el.scrollLeft,
    })),
  );
}

async function scrollTableTo(page: Page, index: number, where: "start" | "end"): Promise<void> {
  await page.locator(".tableWrapper").nth(index).evaluate((el, to) => {
    el.scrollLeft = to === "end" ? el.scrollWidth : 0;
  }, where);
  await nextFrame(page);
}

test("58-5 寬表格右緣提示：還能往右捲時有、捲到底沒有；沒有溢出的表格沒有", async ({ browser }) => {
  const { context, page } = await open(browser, 390, "wide");
  try {
    await expect(page.locator(".tableWrapper")).toHaveCount(2, { timeout: 15_000 });
    await nextFrame(page);
    const fades = async () => (await tableStates(page)).map((s) => Math.round(s.fade));
    const [wide, narrow] = await tableStates(page);
    expect(wide!.overflow).toBe(true);
    expect(narrow!.overflow).toBe(false);
    await expect.poll(fades).toEqual([24, 0]);
    await scrollTableTo(page, 0, "end");
    expect((await tableStates(page))[0]!.scrollLeft).toBeGreaterThan(0);
    await expect.poll(fades).toEqual([0, 0]);
    await scrollTableTo(page, 0, "start");
    await expect.poll(fades).toEqual([24, 0]);
  } finally {
    await context.close();
  }
});

test("58-6 後備：不支援捲動驅動動畫時，委派監聽標 data-kb-more-right；非手機寬度不標", async ({ browser }) => {
  const noScrollTimeline = () => {
    const supports = CSS.supports.bind(CSS);
    CSS.supports = ((...args: [string] | [string, string]) => (String(args[0]).includes("animation-timeline") ? false : (supports as (...a: unknown[]) => boolean)(...args))) as typeof CSS.supports;
  };
  const phone = await open(browser, 390, "wide", { init: noScrollTimeline });
  try {
    await expect(phone.page.locator(".tableWrapper")).toHaveCount(2, { timeout: 15_000 });
    await expect.poll(async () => (await tableStates(phone.page)).map((s) => s.marked)).toEqual([true, false]);
    await scrollTableTo(phone.page, 0, "end");
    await expect.poll(async () => (await tableStates(phone.page)).map((s) => s.marked)).toEqual([false, false]);
    await scrollTableTo(phone.page, 0, "start");
    await expect.poll(async () => (await tableStates(phone.page)).map((s) => s.marked)).toEqual([true, false]);
  } finally {
    await phone.context.close();
  }
  const desktop = await open(browser, 1280, "wide", { touch: false, init: noScrollTimeline });
  try {
    await expect(desktop.page.locator(".tableWrapper")).toHaveCount(2, { timeout: 15_000 });
    // 1280 寬時寬表格確實溢出（不然「沒標」什麼都證明不了）
    await expect.poll(async () => (await tableStates(desktop.page)).map((s) => s.overflow)).toEqual([true, false]);
    await nextFrame(desktop.page);
    await expect.poll(async () => (await tableStates(desktop.page)).map((s) => s.marked)).toEqual([false, false]);
    await expect.poll(async () => (await tableStates(desktop.page)).map((s) => s.fade)).toEqual([0, 0]);
  } finally {
    await desktop.context.close();
  }
});

test("58-7 桌面側邊選單：拖曳把手與 H1／H2／H3 首行文字垂直置中", async ({ browser }) => {
  const desktop = await open(browser, 1280, "headings", { touch: false });
  try {
    const { page } = desktop;
    await expect(headingText(page, "Heading three")).toBeVisible({ timeout: 15_000 });
    for (const text of ["Heading one", "Heading two", "Heading three"]) {
      const inline = headingText(page, text);
      await inline.hover();
      const handle = page.getByRole("button", { name: "Open block menu" });
      await expect(handle).toBeVisible();
      // 側邊選單位置有轉場，等把手的中線穩定再量
      await expect(async () => {
        const geo = await inline.evaluate((el) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          const line = range.getClientRects()[0]!;
          const button = document.querySelector('button[aria-label="Open block menu"]')!.getBoundingClientRect();
          return { lineMid: line.top + line.height / 2, buttonMid: button.top + button.height / 2 };
        });
        expect(Math.abs(geo.buttonMid - geo.lineMid), text).toBeLessThanOrEqual(1);
      }).toPass({ timeout: 5_000 });
    }
  } finally {
    await desktop.context.close();
  }
});

/** 螢幕鍵盤的替身：把 `window.visualViewport` 換成可調高度的假物件（版面視窗不縮，同 iOS）。 */
function stubVisualViewport(): void {
  const target = new EventTarget();
  const state = { keyboard: 0 };
  Object.defineProperties(target, {
    height: { get: () => window.innerHeight - state.keyboard },
    width: { get: () => window.innerWidth },
    offsetTop: { value: 0 },
    offsetLeft: { value: 0 },
    pageTop: { value: 0 },
    pageLeft: { value: 0 },
    scale: { value: 1 },
  });
  Object.defineProperty(window, "visualViewport", { get: () => target, configurable: true });
  (window as unknown as { __setKeyboard: (px: number) => void }).__setKeyboard = (px) => {
    state.keyboard = px;
    target.dispatchEvent(new Event("resize"));
  };
}

async function setKeyboard(page: Page, px: number): Promise<void> {
  await page.evaluate((value) => (window as unknown as { __setKeyboard: (px: number) => void }).__setKeyboard(value), px);
  await nextFrame(page);
}

test("58-8 對話框是貼底的 sheet：貼齊視窗底與左右、✕ 點擊範圍 44；鍵盤升起時跟著升", async ({ browser }) => {
  const { context, page } = await open(browser, 390, "short", { init: stubVisualViewport });
  try {
    await page.locator("header").getByRole("button", { name: "Share", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Share note" });
    await expect(dialog).toBeVisible();
    // 進場動畫跑完再量（位置在動時 boundingBox 不準）
    await expect(async () => {
      const box = (await dialog.boundingBox())!;
      expect(box.x).toBe(0);
      expect(box.width).toBe(390);
      expect(box.y + box.height).toBeCloseTo(844, 0);
    }).toPass({ timeout: 5_000 });
    expect(await dialog.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).not.toBe("0px");
    expect(await dialog.evaluate((el) => getComputedStyle(el).borderBottomLeftRadius)).toBe("0px");
    const close = dialog.getByRole("button", { name: "Close" });
    const area = await tapAreaOf(close);
    expect(area.tap[0], "✕ 點擊寬").toBeGreaterThanOrEqual(43);
    expect(area.tap[1], "✕ 點擊高").toBeGreaterThanOrEqual(43);

    // 鍵盤升起 300px：sheet 底緣在視覺視窗底（844 − 300）；收起後回到視窗底
    await setKeyboard(page, 300);
    await expect(async () => {
      const box = (await dialog.boundingBox())!;
      expect(box.y + box.height).toBeCloseTo(844 - 300, 0);
    }).toPass({ timeout: 5_000 });
    await setKeyboard(page, 0);
    await expect(async () => {
      const box = (await dialog.boundingBox())!;
      expect(box.y + box.height).toBeCloseTo(844, 0);
    }).toPass({ timeout: 5_000 });

    await close.click();
    // 離場動畫期間 body 還有 pointer-events: none，等對話框真的移除再做下一件事
    await expect(dialog).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("58-9 版本整頁（390）：「Back」鈕高 44", async ({ browser }) => {
  const { context, page } = await open(browser, 390, "short");
  try {
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "Version history" }).click();
    const sheet = page.getByRole("dialog", { name: "Version history" });
    await expect(sheet).toBeVisible();
    const back = sheet.getByRole("button", { name: "Back", exact: true });
    await expect(back).toBeVisible();
    await expect(async () => {
      const box = (await back.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(43.5);
    }).toPass({ timeout: 5_000 });
    await back.click();
    await expect(sheet).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("58-10 公開頁頁首（390）：標題 ≥ 180px、Present 只剩圖示、唯讀只剩一個點", async ({ browser }) => {
  const owner = await open(browser, 390, "short");
  let token: string;
  try {
    const note = await createNoteVia(owner.page, TITLES.published, "public text");
    const res = await owner.page.request.put(`/api/notes/${note.id}/public-link`, { headers: { Origin: ORIGIN } });
    expect(res.status(), await res.text()).toBe(200);
    token = ((await res.json()) as { token: string }).token;
  } finally {
    await owner.context.close();
  }
  const anonymous = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  try {
    const page = await anonymous.newPage();
    await page.goto(`/p/${token}`);
    const heading = page.getByRole("heading", { name: TITLES.published, level: 1 });
    await expect(heading).toBeVisible({ timeout: 15_000 });
    const present = page.getByRole("button", { name: "Present", exact: true });
    await expect(present).toBeVisible();
    // 名稱還在（螢幕閱讀器讀得到），但鈕只剩圖示的寬度，沒有可見文字
    expect((await present.boundingBox())!.width, "Present 鈕只剩圖示").toBeLessThanOrEqual(48);
    const dot = page.locator("[data-readonly-dot]");
    await expect(dot).toBeVisible();
    expect((await dot.boundingBox())!.width).toBeLessThanOrEqual(8);
    // 唯讀文字仍在（螢幕閱讀器讀得到），但看不見
    const readonlyText = page.getByText("Read-only", { exact: false }).first();
    expect(await readonlyText.evaluate((el) => el.getBoundingClientRect().width <= 1)).toBe(true);
    await expect(async () => {
      expect((await heading.boundingBox())!.width).toBeGreaterThanOrEqual(180);
    }).toPass({ timeout: 5_000 });
  } finally {
    await anonymous.close();
  }
});

// ── 手機清單畫面與列（58-11～58-15）───────────────────────────────────────────

async function openList(browser: Browser, width: number, touch: boolean): Promise<{ context: BrowserContext; page: Page }> {
  const viewport = { width, height: 844 };
  const context = await browser.newContext(touch ? { hasTouch: true, isMobile: true, viewport } : { viewport });
  const page = await context.newPage();
  await loginAs(page, alice.email, PASSWORD);
  await expect(page).toHaveURL(/\/$/);
  await showSidebarTab(page, "My notes");
  return { context, page };
}

async function favoriteViaApi(page: Page, noteId: string): Promise<void> {
  const res = await page.request.put(`/api/favorites/${encodeURIComponent(noteId)}`, { headers: { Origin: ORIGIN } });
  expect(res.status(), await res.text()).toBeLessThan(300);
}

const box = async (target: Locator): Promise<{ x: number; y: number; width: number; height: number }> => {
  const b = await target.boundingBox();
  expect(b, "元素要有版面").not.toBeNull();
  return b!;
};

/** 清單可視區的左右緣（不含捲軸）。 */
async function listEdges(page: Page): Promise<{ left: number; right: number }> {
  return page.locator("[data-sidebar-list]").first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.left + el.clientWidth };
  });
}

test("58-11 手機清單（390）：Search 在左下、New note 在右下，各 56×56、離邊 16px、同底；沒有底部搜尋列", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await openList(browser, 390, true);
  try {
    await expect(page.locator("[data-phone-list-bar]")).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Search notes", exact: true })).toHaveCount(0);
    const fabs = page.locator("[data-phone-list-fabs]");
    const search = fabs.getByRole("button", { name: "Search notes", exact: true });
    const create = fabs.getByRole("button", { name: "New note", exact: true });
    const s = await box(search);
    const c = await box(create);
    for (const b of [s, c]) {
      expect(b.width).toBeCloseTo(56, 0);
      expect(b.height).toBeCloseTo(56, 0);
      expect(844 - (b.y + b.height), "離視窗下緣").toBeCloseTo(16, 0);
    }
    expect(s.x, "Search 左緣").toBeCloseTo(16, 0);
    expect(390 - (c.x + c.width), "New note 右緣").toBeCloseTo(16, 0);
    expect(Math.abs(s.y - c.y)).toBeLessThanOrEqual(1);
  } finally {
    await context.close();
  }
});

test("58-12 手機清單（390）：最後一列能捲到浮動鈕上方；搜尋中與選取模式沒有浮動鈕；垃圾桶沒有 New note", async ({ browser }) => {
  test.setTimeout(180_000);
  const { context, page } = await openList(browser, 390, true);
  try {
    for (let i = 0; i < 16; i++) await createNoteVia(page, `E2E layout fab filler ${RUN} ${String(i).padStart(2, "0")}`);
    await page.reload();
    await showSidebarTab(page, "My notes");
    const fabs = page.locator("[data-phone-list-fabs]");
    const list = page.locator("[data-sidebar-list]").first();
    const notes = list.locator('[data-node-kind="note"]');
    await expect(notes.nth(15)).toBeAttached({ timeout: 15_000 });
    await scrollPageToEnd(page);
    const fabTop = Math.min((await box(fabs.getByRole("button", { name: "Search notes", exact: true }))).y, (await box(fabs.getByRole("button", { name: "New note", exact: true }))).y);
    await expect(async () => {
      const last = await box(notes.last());
      expect(last.y + last.height, "最後一列的下緣在浮動鈕上緣之上").toBeLessThanOrEqual(fabTop);
    }).toPass({ timeout: 5_000 });

    // 搜尋中：沒有浮動鈕，搜尋列在
    await fabs.getByRole("button", { name: "Search notes", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Search notes", exact: true })).toBeFocused();
    await expect(fabs).toHaveCount(0);
    await page.locator("[data-phone-list-bar]").getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(fabs.getByRole("button", { name: "Search notes", exact: true })).toBeVisible();
    // 關搜尋層後焦點回到 Search 鈕
    await expect(fabs.getByRole("button", { name: "Search notes", exact: true })).toBeFocused();

    // 選取模式：沒有浮動鈕（動作列在底部）
    await startSidebarSelection(page);
    await expect(fabs).toHaveCount(0);
    await page.getByRole("button", { name: "Done", exact: true }).first().click();
    await expect(fabs.getByRole("button", { name: "Search notes", exact: true })).toBeVisible();

    // 垃圾桶：只有 Search；最後一列與保留天數說明都在 Search 鈕上緣之上，說明在安全範圍內
    for (let i = 0; i < 12; i++) {
      const note = await createNoteVia(page, `E2E layout trash filler ${RUN} ${String(i).padStart(2, "0")}`);
      const res = await page.request.delete(`/api/notes/${note.id}`, { headers: { Origin: ORIGIN } });
      expect(res.status(), await res.text()).toBeLessThan(300);
    }
    await page.reload();
    await page.getByRole("tablist", { name: "Sidebar sections" }).getByRole("tab", { name: "Trash", exact: true }).click();
    const searchFab = fabs.getByRole("button", { name: "Search notes", exact: true });
    await expect(searchFab).toBeVisible();
    await expect(fabs.getByRole("button", { name: "New note", exact: true })).toHaveCount(0);
    const trashList = page.locator("[data-sidebar-list]").first();
    const trashRows = trashList.locator('[data-node-kind="note"]');
    await expect(trashRows.nth(11)).toBeAttached({ timeout: 15_000 });
    await scrollPageToEnd(page);
    const footer = page.getByTestId("trash-footer");
    await expect(footer).toBeVisible();
    const searchTop = (await box(searchFab)).y;
    await expect(async () => {
      const last = await box(trashRows.last());
      const foot = await box(footer);
      expect(last.y + last.height, "最後一列的下緣在說明之上").toBeLessThanOrEqual(foot.y + 1);
      // 說明的底部內距是留給浮動鈕的空位，文字本身（不含底部內距）要在 Search 鈕上緣之上
      const padBottom = await footer.evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom));
      // 文字下緣離 Search 鈕上緣至少 6px（連陰影一起清開）
      expect(foot.y + foot.height - padBottom, "保留天數說明文字的下緣在 Search 鈕上緣之上").toBeLessThanOrEqual(searchTop - 6);
    }).toPass({ timeout: 5_000 });
  } finally {
    await context.close();
  }
});

test("58-13 桌面（1280）：沒滑過時最愛星號在最右；滑過時 ⋮ 在最右、星號左移一格；左右內距相等", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await openList(browser, 1280, false);
  try {
    const created = await createNoteVia(page, `E2E layout fav row ${RUN}`);
    await favoriteViaApi(page, created.id);
    await page.reload();
    await showSidebarTab(page, "My notes");
    const row = page.locator(`[data-node-id="${created.id}"]`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    const star = row.getByRole("button", { name: "Favorite", exact: true });
    const more = row.getByRole("button", { name: /^Note actions for / });
    await page.mouse.move(700, 600);
    const edges = await listEdges(page);
    const moveAway = (): Promise<void> => page.mouse.move(700, 600);
    const textLeft = (await box(row.getByRole("link"))).x;
    const leftInset = textLeft - edges.left;
    const starGlyph = async (): Promise<number> => {
      const g = await box(star.locator("svg"));
      return g.x + g.width;
    };
    const idleInset = edges.right - (await starGlyph());
    expect(leftInset, "文字左緣離清單左緣").toBeCloseTo(16, 0);
    expect(Math.abs(idleInset - leftInset), `右內距 ${idleInset} 與左內距 ${leftInset} 相差`).toBeLessThanOrEqual(1);
    // ⋮ 沒浮出時透明、寬度 0（不佔位）；標題一直延伸到星號前一個 gap
    expect(await more.evaluate((el) => getComputedStyle(el).opacity), "⋮ 沒浮出").toBe("0");
    expect((await box(more)).width, "⋮ 沒浮出時不佔位").toBeLessThanOrEqual(1);
    const idleLink = await box(row.getByRole("link"));
    const idleStar = await box(star);
    expect(idleStar.x - (idleLink.x + idleLink.width), "沒浮出時標題與星號之間只有一個 gap").toBeLessThanOrEqual(4.5);

    await row.hover();
    await expect(async () => {
      expect(await more.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
      expect((await box(more)).width).toBeCloseTo(24, 0);
    }).toPass({ timeout: 5_000 });
    // 不重疊：標題在 ⋮ 之前結束（標題縮短了）、⋮ 在星號左邊
    const hoverLink = await box(row.getByRole("link"));
    const hoverMore = await box(more);
    const hoverStar = await box(star);
    expect(hoverLink.x + hoverLink.width, "標題不蓋到 ⋮").toBeLessThanOrEqual(hoverMore.x + 0.5);
    expect(hoverMore.x + hoverMore.width, "⋮ 不蓋到星號").toBeLessThanOrEqual(hoverStar.x + 0.5);
    expect(hoverLink.width, "浮出後標題縮短").toBeLessThan(idleLink.width);
    expect(Math.abs(hoverStar.x - idleStar.x), "星號不動").toBeLessThanOrEqual(0.5);
    // 星號不動；⋮ 浮在星號左邊一格（右緣離星號左緣 4px）
    expect(Math.abs(idleInset - (edges.right - (await starGlyph()))), "星號位置不變").toBeLessThanOrEqual(0.5);
    const moreBox = await box(more);
    const starBox = await box(star);
    expect(Math.abs(starBox.x - (moreBox.x + moreBox.width) - 4), "⋮ 與星號的間距").toBeLessThanOrEqual(1);
    expect(moreBox.x, "⋮ 在星號左邊").toBeLessThan(starBox.x);
    await moveAway();
  } finally {
    await context.close();
  }
});

test("58-14 手機（390）：列右內距＝左內距；星號與 ⋮ 的點擊範圍不重疊；字級 15／12；頂列標題在左、頭像在右並與列對齊", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await openList(browser, 390, true);
  try {
    const created = await createNoteVia(page, `E2E layout phone row ${RUN}`);
    await favoriteViaApi(page, created.id);
    await page.reload();
    await showSidebarTab(page, "My notes");
    const row = page.locator(`[data-node-id="${created.id}"]`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    // 觸控：最愛列上沒有星號鈕，只有不能點的標記；⋮ 在標記左邊
    await expect(row.getByRole("button", { name: "Favorite", exact: true })).toHaveCount(0);
    const marker = row.getByRole("img", { name: "Favorite", exact: true });
    const more = row.getByRole("button", { name: /^Note actions for / });
    await expect(marker).toBeVisible();
    await expect(more).toBeVisible();

    const edges = await listEdges(page);
    const link = row.getByRole("link");
    const leftInset = (await box(link)).x - edges.left;
    // ⋮ 一律是最右一格：圖示右緣離清單邊＝左內距；標記在它左邊約 8px（圖示到圖示）
    const moreGlyph = await box(more.locator("svg"));
    const rightInset = edges.right - (moreGlyph.x + moreGlyph.width);
    expect(Math.abs(rightInset - leftInset), `⋮ 右內距 ${rightInset} 左內距 ${leftInset}`).toBeLessThanOrEqual(1);
    const markerGlyph = await box(marker.locator("svg"));
    const iconGap = moreGlyph.x - (markerGlyph.x + markerGlyph.width);
    expect(iconGap, "標記與 ⋮ 的圖示間距").toBeGreaterThanOrEqual(6);
    expect(iconGap, "標記與 ⋮ 的圖示間距").toBeLessThanOrEqual(11);
    const moreBox = await box(more);
    const markerBox = await box(marker);
    expect(moreBox.x, "⋮ 在標記右邊").toBeGreaterThanOrEqual(markerBox.x + markerBox.width - 0.5);
    // 標記與標題可見尾端（截斷後的連結框右緣；有角色字時再加上它）之間要有留白
    const linkBox = await box(link);
    expect(markerBox.x - (linkBox.x + linkBox.width), "標記與標題右緣").toBeGreaterThanOrEqual(11);
    const roleLabel = row.getByText(/^(Editor|Viewer)$/);
    if ((await roleLabel.count()) > 0) {
      const roleBox = await box(roleLabel.first());
      expect(markerBox.x - (roleBox.x + roleBox.width), "標記與角色字右緣").toBeGreaterThanOrEqual(11);
    }
    // 沒加入最愛的列：只有 ⋮；它的右緣與最愛列的 ⋮ 上下對齊（差 1px 以內）
    const plainRow = page.locator('li[data-node-kind="note"]').filter({ hasNot: page.getByRole("img", { name: "Favorite", exact: true }) }).first();
    const plainMore = await box(plainRow.getByRole("button", { name: /^Note actions for / }));
    expect(Math.abs(plainMore.x + plainMore.width - (moreBox.x + moreBox.width)), "各列 ⋮ 右緣").toBeLessThanOrEqual(1);
    expect(plainMore.width).toBeLessThanOrEqual(24.5);

    // 字級：標題 15px
    expect(await link.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBe(15);
    // 最近分頁的兩行列：標題 15px、第二行 12px
    await showSidebarTab(page, "Recent");
    const recent = page.locator(`[data-node-id="${created.id}"]`).first().getByRole("link");
    await expect(recent).toBeVisible({ timeout: 15_000 });
    expect(await recent.locator("div").nth(0).evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBe(15);
    expect(await recent.locator("div").nth(1).evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBe(12);

    // 頂列：標題（K）左緣＝列文字左緣；頭像視覺右緣＝列尾圖示右緣
    await showSidebarTab(page, "My notes");
    const top = page.locator("[data-phone-top-bar]");
    const mark = await box(top.locator("span[aria-hidden]").first());
    expect(Math.abs(mark.x - (edges.left + leftInset)), "標題左緣").toBeLessThanOrEqual(1);
    const avatarButton = top.getByRole("button", { name: alice.displayName, exact: true });
    const avatar = await box(avatarButton.locator("> *").first());
    expect(avatar.width).toBeCloseTo(32, 0);
    expect(Math.abs(edges.right - (avatar.x + avatar.width) - rightInset), "頭像右緣").toBeLessThanOrEqual(1);
    expect((await box(avatarButton)).width, "頭像點擊範圍").toBeGreaterThanOrEqual(44);
    expect((await box(top.getByText("Knotebook", { exact: true }))).x).toBeLessThan((await box(avatarButton)).x);
  } finally {
    await context.close();
  }
});

test("58-15 手機筆記頁首（390）：位置在標題正下方、左緣與標題對齊；「‹」垂直置中於標題＋位置區塊", async ({ browser }) => {
  const { context, page } = await open(browser, 390, "short");
  try {
    const block = page.getByTestId("note-header-block");
    await expect(block).toBeVisible();
    const title = await box(page.getByRole("textbox", { name: "Note title" }));
    const location = await box(page.getByRole("button", { name: /^Show in list: / }));
    expect(location.y, "位置在標題下方").toBeGreaterThanOrEqual(title.y + title.height - 1);
    expect(Math.abs(location.x - title.x), "位置與標題左緣").toBeLessThanOrEqual(1);
    const blockBox = await box(block);
    const back = await box(page.getByRole("button", { name: "Back to notes", exact: true }));
    const more = await box(page.locator("header").getByRole("button", { name: "More", exact: true }));
    const centre = blockBox.y + blockBox.height / 2;
    expect(Math.abs(back.y + back.height / 2 - centre), "「‹」圓心").toBeLessThanOrEqual(2);
    expect(Math.abs(more.y + more.height / 2 - centre), "⋮ 圓心").toBeLessThanOrEqual(2);
    expect(await page.getByRole("textbox", { name: "Note title" }).evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBe(20);
    expect(await page.getByRole("button", { name: /^Show in list: / }).evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBe(12);
    // 連線點緊跟在位置文字後面（不是推到最右邊）
    const dot = await box(page.getByTestId("note-header-subline").getByRole("status").locator("span").first());
    expect(dot.x - (location.x + location.width), "連線點離位置文字右緣").toBeLessThanOrEqual(12);
    expect(dot.x, "連線點在位置文字之後").toBeGreaterThanOrEqual(location.x + location.width - 1);
  } finally {
    await context.close();
  }
});

/** 手機管理面板 sheet：等進場動畫跑完，量貼齊左右與底、上方留一道縫（0 < 縫 < 40）、上圓角。回傳縫的高度。 */
async function expectPanelSheet(page: Page, dialog: Locator): Promise<number> {
  const size = page.viewportSize()!;
  let gap = 0;
  await expect(async () => {
    const b = (await dialog.boundingBox())!;
    expect(b.x).toBe(0);
    expect(b.width).toBe(size.width);
    expect(Math.abs(b.y + b.height - size.height), "底緣貼齊視窗底").toBeLessThanOrEqual(1);
    gap = b.y;
    expect(gap, "上方的縫").toBeGreaterThan(0);
    expect(gap, "上方的縫").toBeLessThan(40);
  }).toPass({ timeout: 5_000 });
  expect(await dialog.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).not.toBe("0px");
  expect(await dialog.evaluate((el) => getComputedStyle(el).borderBottomLeftRadius)).toBe("0px");
  await expectCardEdgeToEdge(page, dialog, "第一眼");
  return gap;
}

/** 看得見的那張卡（面板外框是透明的，看得到的是裡面的卡）：左右貼齊視窗、底緣貼齊外框底，同選單 sheet 一樣滿版。 */
async function expectCardEdgeToEdge(page: Page, dialog: Locator, label: string): Promise<void> {
  const width = page.viewportSize()!.width;
  const edges = await dialog.evaluate((el) => {
    const outer = el.getBoundingClientRect();
    const card = Array.from(el.querySelectorAll<HTMLElement>("[data-management-card], [data-shortcuts-card]")).find((c) => c.getBoundingClientRect().width > 0);
    if (!card) return null;
    const r = card.getBoundingClientRect();
    return { left: r.left, right: r.right, bottomGap: outer.bottom - r.bottom, topGap: r.top - outer.top };
  });
  expect(edges, `${label}：要有一張看得見的卡`).not.toBeNull();
  console.log(`MEASURE card ${label} left ${edges!.left} right ${edges!.right} top ${edges!.topGap} bottom ${edges!.bottomGap}`);
  expect(edges!.left, `${label}：卡的左緣`).toBe(0);
  expect(edges!.right, `${label}：卡的右緣`).toBe(width);
  expect(edges!.topGap, `${label}：卡的上緣貼齊外框`).toBe(0);
  expect(edges!.bottomGap, `${label}：卡的底緣貼齊外框`).toBe(0);
}

interface SurfaceMetrics {
  bg: string;
  radius: string;
  shadow: string;
}
interface PanelMetrics extends SurfaceMetrics {
  trayBg: string;
  trayBlur: string;
}
interface ListMetrics {
  title: { fontSize: number; fontWeight: number };
  headerBorder: number;
  headerLeft: number;
  headerRight: number;
  viewportWidth: number;
  rows: {
    height: number;
    fontSize: number;
    fontWeight: number;
    bgAlpha: number;
    top: number;
    left: number;
    right: number;
    textLeft: number;
    chevronRight: number;
    radius: number;
    chevronWidth: number;
    chevronDisplay: string;
    chevronColor: string;
    /** 緊接在上一列後面（DOM 上相鄰）；說明視窗的清單裡，分隔線與「快捷鍵」小標題前後的列不相鄰。 */
    joined: boolean;
  }[];
  navBg: string;
}

/** 選單 sheet（role=menu）的表面：底色、左上圓角、陰影。 */
const menuSurface = (menu: Locator): Promise<SurfaceMetrics> =>
  menu.evaluate((el) => {
    const s = getComputedStyle(el);
    return { bg: s.backgroundColor, radius: s.borderTopLeftRadius, shadow: s.boxShadow };
  });

/** 選單 sheet 第一個選項內容的左緣（x，列左緣加左內距；列首的圖示與文字都從這裡起）。 */
const menuTextLeft = (menu: Locator): Promise<number> =>
  menu.evaluate((el) => {
    const item = el.querySelector('[role="menuitem"]')!;
    return item.getBoundingClientRect().left + parseFloat(getComputedStyle(item).paddingLeft);
  });

/** 面板 sheet 看得見的那張卡的底色與左上圓角、外框（Dialog 內容）的陰影，加上托盤的底色與模糊。 */
const panelSurface = (dialog: Locator): Promise<PanelMetrics> =>
  dialog.evaluate((el) => {
    const card = Array.from(el.querySelectorAll<HTMLElement>("[data-management-card], [data-shortcuts-card]")).find((c) => c.getBoundingClientRect().width > 0)!;
    const c = getComputedStyle(card);
    const tray = getComputedStyle(card.parentElement!);
    return { bg: c.backgroundColor, radius: c.borderTopLeftRadius, shadow: getComputedStyle(el).boxShadow, trayBg: tray.backgroundColor, trayBlur: tray.backdropFilter };
  });

/** 項次清單層：標題字級、列頭髮絲線、每一列的高／字級／字重／底色 alpha／圓角／「›」。 */
const listMetrics = (dialog: Locator): Promise<ListMetrics> =>
  dialog.evaluate((el) => {
    const card = Array.from(el.querySelectorAll<HTMLElement>("[data-management-card='items'], [data-shortcuts-card='items']")).find((c) => c.getBoundingClientRect().width > 0)!;
    const header = card.firstElementChild as HTMLElement;
    const title = (header.querySelector("h2") ?? header.querySelector("p")) as HTMLElement;
    const nav = card.querySelector("nav") as HTMLElement;
    // 列＝清單裡的連結與按鈕（說明視窗的清單另有分隔線與分組小標題，不算列）。
    const rowEls = Array.from(nav.querySelectorAll<HTMLElement>("a, button"));
    const alpha = (color: string): number => {
      const m = color.match(/\/\s*([\d.]+)(%?)\s*\)$/) ?? color.match(/rgba\([^)]*,\s*([\d.]+)\)$/);
      return m ? parseFloat(m[1]) / (m[2] === "%" ? 100 : 1) : 1;
    };
    return {
      title: { fontSize: parseFloat(getComputedStyle(title).fontSize), fontWeight: parseInt(getComputedStyle(title).fontWeight, 10) },
      headerBorder: parseFloat(getComputedStyle(header).borderBottomWidth),
      headerLeft: header.getBoundingClientRect().left,
      headerRight: header.getBoundingClientRect().right,
      viewportWidth: window.innerWidth,
      navBg: getComputedStyle(nav).backgroundColor,
      rows: rowEls.map((row, i) => {
        const s = getComputedStyle(row);
        const svg = row.querySelector("svg") as SVGElement | null;
        return {
          height: row.getBoundingClientRect().height,
          fontSize: parseFloat(s.fontSize),
          fontWeight: parseInt(s.fontWeight, 10),
          bgAlpha: alpha(s.backgroundColor),
          top: row.getBoundingClientRect().top,
          left: row.getBoundingClientRect().left,
          right: row.getBoundingClientRect().right,
          textLeft: (row.firstElementChild as HTMLElement).getBoundingClientRect().left,
          chevronRight: svg ? svg.getBoundingClientRect().right : 0,
          radius: parseFloat(s.borderTopLeftRadius),
          chevronWidth: svg ? svg.getBoundingClientRect().width : 0,
          chevronDisplay: svg ? getComputedStyle(svg).display : "none",
          chevronColor: svg ? getComputedStyle(svg).color : "",
          joined: i > 0 && row.previousElementSibling === rowEls[i - 1],
        };
      }),
    };
  });

/** 手機：面板的表面（卡底色、上圓角、陰影）與同一個畫面的選單 sheet 一模一樣；托盤沒有模糊與底色。 */
function expectSameSurface(panel: PanelMetrics, menu: SurfaceMetrics, label: string): void {
  console.log(`MEASURE surface ${label} panel ${panel.bg} ${panel.radius} | menu ${menu.bg} ${menu.radius} | shadow ${panel.shadow}`);
  expect(panel.bg, `${label}：卡的底色＝選單 sheet 的底色`).toBe(menu.bg);
  expect(panel.radius, `${label}：上圓角`).toBe("12px");
  expect(menu.radius, `${label}：選單的上圓角`).toBe("12px");
  expect(panel.shadow, `${label}：陰影＝選單 sheet 的陰影`).toBe(menu.shadow);
  expect(panel.shadow, `${label}：有陰影`).not.toBe("none");
  expect(panel.trayBlur, `${label}：托盤沒有模糊`).toBe("none");
  expect(alphaOf(panel.trayBg), `${label}：托盤沒有底色`).toBe(0);
}

/** 手機：項次清單的列像選單的列——至少 48 高、16px、一般字重、相貼、4px 圓角、沒有常駐底色、列尾有 16px 的「›」；標題 18px/600、列頭有 1px 髮絲線。 */
function expectPhoneList(list: ListMetrics, label: string): void {
  console.log(`MEASURE list ${label} title ${list.title.fontSize}/${list.title.fontWeight} border ${list.headerBorder} row0 ${JSON.stringify(list.rows[0])}`);
  expect(list.title.fontSize, `${label}：標題字級`).toBe(18);
  expect(list.title.fontWeight, `${label}：標題字重`).toBe(600);
  expect(list.headerBorder, `${label}：列頭髮絲線`).toBe(1);
  expect(list.headerLeft, `${label}：髮絲線從左緣起`).toBe(0);
  expect(list.headerRight, `${label}：髮絲線到右緣止`).toBe(list.viewportWidth);
  expect(list.rows.length, `${label}：有列`).toBeGreaterThan(1);
  list.rows.forEach((row, i) => {
    expect(row.height, `${label}：列 ${i} 高`).toBeGreaterThanOrEqual(48);
    expect(row.fontSize, `${label}：列 ${i} 字級`).toBe(16);
    expect(row.fontWeight, `${label}：列 ${i} 字重`).toBe(400);
    expect(row.radius, `${label}：列 ${i} 圓角`).toBe(4);
    expect(row.bgAlpha, `${label}：列 ${i} 沒有常駐底色（目前的項次也一樣）`).toBe(0);
    expect(row.chevronWidth, `${label}：列 ${i} 的「›」`).toBe(16);
    expect(row.chevronDisplay).not.toBe("none");
    // 左右對稱：底色離兩側同樣遠，文字與「›」離卡緣同樣遠（16px）
    expect(Math.abs(row.left - (list.viewportWidth - row.right)), `${label}：列 ${i} 左右內縮相等`).toBeLessThanOrEqual(0.5);
    expect(row.left, `${label}：列 ${i} 底色離邊緣 8px`).toBe(8);
    expect(row.textLeft, `${label}：列 ${i} 文字離邊緣 16px`).toBe(16);
    expect(list.viewportWidth - row.chevronRight, `${label}：列 ${i}「›」離邊緣 16px`).toBe(16);
    if (row.joined) expect(row.top - (list.rows[i - 1].top + list.rows[i - 1].height), `${label}：列 ${i} 與上一列相貼`).toBeCloseTo(0, 0);
  });
}

/** 手機：項次清單的文字左緣與選單 sheet 的文字左緣一樣（±1）。 */
function expectAlignedWithMenu(list: ListMetrics, menuX: number, label: string): void {
  console.log(`MEASURE align ${label} menu text x ${menuX} | row text x ${list.rows[0].textLeft} row left ${list.rows[0].left} right ${list.rows[0].right}`);
  for (const [i, row] of list.rows.entries()) expect(Math.abs(row.textLeft - menuX), `${label}：列 ${i} 文字與選單文字同 x`).toBeLessThanOrEqual(1);
}

/** 手機第二層：標題（h1／h3）18px/600，且與左上角的「‹」垂直置中對齊。 */
async function expectPhoneContentHeading(dialog: Locator, heading: Locator, label: string): Promise<void> {
  await expect(heading).toBeVisible();
  // 區段頁載入時標題節點可能被換掉（舊節點量到空字串）：輪詢到量得到數字為止。
  await expect.poll(() => fontPx(heading), { message: `${label}：第二層標題字級` }).toBe(18);
  expect(await heading.evaluate((el) => parseInt(getComputedStyle(el).fontWeight, 10)), `${label}：第二層標題字重`).toBe(600);
  const back = await box(dialog.getByRole("button", { name: "Back to sections", exact: true }));
  const title = await box(heading);
  expect(Math.abs(title.y + title.height / 2 - (back.y + back.height / 2)), `${label}：標題與「‹」垂直置中`).toBeLessThanOrEqual(1);
  // 「‹」的底色＝卡（sheet）的底色：看起來透明，捲動的內容經過時遮住它
  const surface = await panelSurface(dialog);
  expect(await dialog.getByRole("button", { name: "Back to sections", exact: true }).evaluate((el) => getComputedStyle(el).backgroundColor), `${label}：「‹」底色＝卡底色`).toBe(surface.bg);
  // 內容區頂端讓出「‹」（符號到 54px、點擊範圍到 62px）：沒有自己標題的內容（載入中、錯誤）不落在它底下
  const padTop = await dialog.locator("[data-management-content], [data-shortcuts-content]").evaluateAll((els) =>
    els.filter((el) => el.getBoundingClientRect().width > 0).map((el) => parseFloat(getComputedStyle(el).paddingTop)),
  );
  expect(padTop.length, `${label}：看得見的內容區`).toBe(1);
  expect(padTop[0], `${label}：內容區頂端內距 ≥ 62`).toBeGreaterThanOrEqual(62);
}

test("58-16 手機（390）管理面板是幾乎滿高的 sheet：從帳號選單開先停在項次清單；「‹」一路退回帳號選單；沒有 ✕；深連結停在那一頁、清單的「‹」只關；點上方的縫關掉", async ({ browser }) => {
  test.setTimeout(150_000);
  const { context, page } = await openList(browser, 390, true);
  try {
    const avatarButton = page.locator("[data-phone-top-bar]").getByRole("button", { name: alice.displayName, exact: true });
    const openSettingsFromMenu = async (): Promise<Locator> => {
      await avatarButton.click();
      await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Settings" });
      await expect(dialog).toBeVisible({ timeout: 15_000 });
      return dialog;
    };
    const insideViewport = async (target: Locator, label: string): Promise<void> => {
      const b = await box(target);
      const size = page.viewportSize()!;
      expect(b.x, `${label} 左`).toBeGreaterThanOrEqual(0);
      expect(b.y, `${label} 上`).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width, `${label} 右`).toBeLessThanOrEqual(size.width);
      expect(b.y + b.height, `${label} 下`).toBeLessThanOrEqual(size.height);
    };

    // ── 帳號選單 → Settings：sheet、第一層（項次清單）、左上角「Back to menu」、沒有 ✕ ──
    let dialog = await openSettingsFromMenu();
    const gap = await expectPanelSheet(page, dialog);
    const lightPanel = await panelSurface(dialog);
    const lightList = await listMetrics(dialog);
    expectPhoneList(lightList, "Settings 清單");
    await expect(dialog.getByRole("navigation", { name: "Settings" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);
    const toMenu = dialog.getByRole("button", { name: "Back to menu", exact: true });
    await expect(toMenu).toBeVisible();
    await expect(toMenu).toBeFocused();
    await insideViewport(toMenu, "清單的「‹」");
    const listBack = await box(toMenu);
    const listArea = await tapAreaOf(toMenu);
    expect(listArea.tap[0]).toBeGreaterThanOrEqual(43);
    expect(listArea.tap[1]).toBeGreaterThanOrEqual(43);

    // ── 選項次 → 第二層：同一個位置是「Back to sections」、仍沒有 ✕ ──
    await dialog.getByRole("link", { name: "Sign-in", exact: true }).click();
    const toList = dialog.getByRole("button", { name: "Back to sections", exact: true });
    await expect(toList).toBeVisible();
    await expect(dialog.getByRole("navigation", { name: "Settings" })).toBeHidden();
    await expect(dialog.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);
    const contentBack = await box(toList);
    await expectCardEdgeToEdge(page, dialog, "內容層");
    await expectPhoneContentHeading(dialog, dialog.getByRole("heading", { level: 1 }), "Settings 第二層");
    expect(Math.abs(contentBack.x - listBack.x), "兩層「‹」的 x").toBeLessThanOrEqual(1);
    expect(Math.abs(contentBack.y - listBack.y), "兩層「‹」的 y").toBeLessThanOrEqual(1);
    const contentArea = await tapAreaOf(toList);
    expect(contentArea.tap[0]).toBeGreaterThanOrEqual(43);
    expect(contentArea.tap[1]).toBeGreaterThanOrEqual(43);

    // 視窗變矮（模擬工具列佔掉高度）：sheet 跟著變矮、底緣仍貼底、「‹」仍在畫面內
    await page.setViewportSize({ width: 390, height: 740 });
    await expect(async () => {
      const b = await box(dialog);
      expect(Math.abs(b.y + b.height - 740)).toBeLessThanOrEqual(1);
      expect(Math.abs(b.y - gap)).toBeLessThanOrEqual(1);
    }).toPass({ timeout: 5_000 });
    await insideViewport(toList, "矮視窗的「‹」");
    await page.setViewportSize({ width: 390, height: 844 });

    // ── 「‹」→ 第一層 → 「‹」→ sheet 收下去、帳號選單（sheet）重新打開 ──
    await toList.click();
    await expect(dialog.getByRole("navigation", { name: "Settings" })).toBeVisible();
    await dialog.getByRole("button", { name: "Back to menu", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute("data-menu-sheet");
    await expect(menu.getByRole("menuitem", { name: "Settings", exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    const lightMenu = await menuSurface(menu);
    expectSameSurface(lightPanel, lightMenu, "淺色");
    expectAlignedWithMenu(lightList, await menuTextLeft(menu), "淺色");
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    // ── 深色：同一個畫面的選單 sheet 與面板，表面仍一模一樣（底色換了、仍相同）──
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    await avatarButton.click();
    await expect(menu).toHaveAttribute("data-menu-sheet");
    const darkMenu = await menuSurface(menu);
    const darkMenuX = await menuTextLeft(menu);
    expect(darkMenu.bg, "深色底色與淺色不同").not.toBe(lightMenu.bg);
    await menu.getByRole("menuitem", { name: "Settings", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expectPanelSheet(page, dialog);
    expectSameSurface(await panelSurface(dialog), darkMenu, "深色");
    const darkList = await listMetrics(dialog);
    expectPhoneList(darkList, "深色 Settings 清單");
    expectAlignedWithMenu(darkList, darkMenuX, "深色");
    await dialog.getByRole("link", { name: "Sign-in", exact: true }).click();
    await expectPhoneContentHeading(dialog, dialog.getByRole("heading", { level: 1 }), "深色 Settings 第二層");
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
    await expect(menu).toHaveCount(0);

    // ── 點上方的縫：整個關掉，不重開選單 ──
    dialog = await openSettingsFromMenu();
    await expectPanelSheet(page, dialog);
    // 縫的上三分之一：觸控的目標修正會把太靠近 sheet 的一下歸給 sheet（縫太窄時就點不到，見 `ui/dialog.tsx`）
    await page.touchscreen.tap(195, Math.max(2, gap / 3));
    await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
    await page.waitForTimeout(300);
    await expect(page.getByRole("menu")).toHaveCount(0);

    // ── 深連結：直接停在那一頁；退到清單後的「‹」名稱是 Close、只關 ──
    await page.goto("/settings/login");
    dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog.getByRole("button", { name: "Back to sections", exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByRole("navigation", { name: "Settings" })).toBeHidden();
    await dialog.getByRole("button", { name: "Back to sections", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Back to menu", exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
    await page.waitForTimeout(300);
    await expect(page.getByRole("menu")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

/** computed 顏色（rgb／rgba／color()／oklab／oklch…）的 alpha；沒寫 alpha 就是 1。 */
function alphaOf(color: string): number {
  const slash = color.match(/\/\s*([\d.]+)(%?)\s*\)$/);
  if (slash) return parseFloat(slash[1]) / (slash[2] === "%" ? 100 : 1);
  const rgba = color.match(/^rgba\(\s*[\d.]+,\s*[\d.]+,\s*[\d.]+,\s*([\d.]+)\)$/);
  return rgba ? parseFloat(rgba[1]) : 1;
}

test("58-17 手機筆記頁（390）：兩顆毛玻璃浮動鈕與清單同位置；編輯時不在；Search 開搜尋層；New note 建筆記；最後一段捲得到鈕上方", async ({ browser }) => {
  test.setTimeout(180_000);
  const { context, page } = await open(browser, 390, "long");
  try {
    // 筆記頁底部這一組（側欄裡那一組藏在後面，也有同一個屬性）
    const fabs = page.getByTestId("note-browse-bar").locator("[data-phone-list-fabs]");
    const search = fabs.getByRole("button", { name: "Search notes", exact: true });
    const create = fabs.getByRole("button", { name: "New note", exact: true });
    await expect(search).toBeVisible();
    await expect(create).toBeVisible();
    await expect(fabs).toHaveCount(1);

    // 位置：56×56、離邊 16px、同底；與清單畫面逐像素相同
    const onNote = { s: await box(search), c: await box(create) };
    for (const b of [onNote.s, onNote.c]) {
      expect(b.width).toBeCloseTo(56, 0);
      expect(b.height).toBeCloseTo(56, 0);
      expect(844 - (b.y + b.height), "離視窗下緣").toBeCloseTo(16, 0);
    }
    expect(onNote.s.x, "Search 左緣").toBeCloseTo(16, 0);
    expect(390 - (onNote.c.x + onNote.c.width), "New note 右緣").toBeCloseTo(16, 0);

    // 毛玻璃：半透明背景＋背景模糊＋細框；New note 靠圖示的 brand 色強調，不是實心底
    const style = (target: Locator) =>
      target.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { bg: cs.backgroundColor, filter: cs.backdropFilter || cs.getPropertyValue("-webkit-backdrop-filter"), border: cs.borderTopWidth, color: cs.color, shadow: cs.boxShadow };
      });
    const sStyle = await style(search);
    const cStyle = await style(create);
    for (const st of [sStyle, cStyle]) {
      expect(st.filter, "backdrop-filter").toContain("blur");
      expect(alphaOf(st.bg), `背景 ${st.bg} 的 alpha`).toBeLessThan(1);
      expect(alphaOf(st.bg), `背景 ${st.bg} 的 alpha`).toBeGreaterThan(0.15);
      expect(alphaOf(st.bg), `背景 ${st.bg} 的 alpha`).toBeLessThan(0.35);
      expect(st.border).toBe("1px");
      expect(st.shadow).not.toBe("none");
    }
    expect(cStyle.bg, "兩顆同一款底").toBe(sStyle.bg);
    expect(cStyle.color, "New note 的圖示是 brand 色、與 Search 不同").not.toBe(sStyle.color);
    await expect(create.locator("svg")).toHaveAttribute("data-icon", "pen-line");

    // 長筆記：最後一段捲得到鈕上方
    await scrollPageToEnd(page);
    const last = editorLocator(page).getByText(LONG_LAST, { exact: true });
    await expect(async () => {
      const lastBox = await box(last);
      const top = Math.min((await box(search)).y, (await box(create)).y);
      expect(lastBox.y + lastBox.height, "最後一段的下緣在浮動鈕上緣之上").toBeLessThanOrEqual(top);
    }).toPass({ timeout: 5_000 });
    await scrollPageToTop(page);

    // 編輯中沒有；離開編輯回來
    // 編輯器連上共編之前點不進去（唯讀期間的點擊不算編輯中），所以點到浮動鈕消失為止。
    await expect(async () => {
      await editorLocator(page).getByText("paragraph number 0", { exact: true }).tap({ position: { x: 2, y: 4 } });
      await expect(fabs).toHaveCount(0, { timeout: 1_500 });
    }).toPass({ timeout: 15_000 });
    await page.getByRole("textbox", { name: "Note title" }).click();
    await expect(fabs).toHaveCount(1);

    // Search：開搜尋層（鈕不在）、Cancel 回這篇、焦點回 Search
    await search.click();
    await expect(page.getByRole("textbox", { name: "Search notes", exact: true })).toBeFocused();
    await expect(fabs).toHaveCount(0);
    await page.locator("[data-phone-list-bar]").getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(search).toBeFocused();
    await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue(TITLES.long);

    // 與清單畫面同位置
    await page.goto("/");
    await showSidebarTab(page, "My notes");
    const listFabs = page.locator("[data-phone-list-fabs]");
    const listS = await box(listFabs.getByRole("button", { name: "Search notes", exact: true }));
    const listC = await box(listFabs.getByRole("button", { name: "New note", exact: true }));
    for (const [a, b] of [[onNote.s, listS], [onNote.c, listC]] as const) {
      expect(Math.abs(a.x - b.x)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(0.5);
    }

    // New note：從筆記頁建新筆記
    await page.goto(paths.long);
    await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue(TITLES.long, { timeout: 15_000 });
    await page.getByTestId("note-browse-bar").getByRole("button", { name: "New note", exact: true }).click();
    await page.waitForURL(/\/n\/[^/]+\/untitled-[0-9a-f]{8}$/, { timeout: 15_000 });
    await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("Untitled", { timeout: 15_000 });
  } finally {
    await context.close();
  }
});

/** 手機選單 sheet：等進場動畫跑完，量貼齊視窗左右與底（x＝0、寬＝視窗寬、底＝視窗底）；每個文字列（menuitem、`rows` 另加 menuitemradio）高 ≥ 48。 */
async function expectMenuSheet(page: Page, opts: { width?: number; height?: number; radioRows?: boolean } = {}): Promise<Locator> {
  const width = opts.width ?? 390;
  const height = opts.height ?? 844;
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(async () => {
    const b = (await menu.boundingBox())!;
    expect(b.x).toBe(0);
    expect(b.width).toBe(width);
    expect(b.y + b.height).toBeCloseTo(height, 0);
  }).toPass({ timeout: 5_000 });
  const selector = opts.radioRows ? '[role="menuitem"], [role="menuitemradio"]' : '[role="menuitem"]';
  const rows = await menu.evaluate((el, sel) => Array.from(el.querySelectorAll(sel)).map((item) => ({ name: item.textContent ?? "", height: item.getBoundingClientRect().height })), selector);
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) expect(row.height, `「${row.name}」列高`).toBeGreaterThanOrEqual(48 - 0.5);
  return menu;
}

/** sheet 目前的列（可及名稱：帶 aria-label 的取它，否則文字）。 */
const sheetRowNames = (menu: Locator): Promise<string[]> =>
  menu.evaluate((el) => Array.from(el.querySelectorAll('[role="menuitem"]')).map((item) => item.getAttribute("aria-label") ?? item.textContent ?? ""));

test("58-18 手機（390 觸控）：筆記頁 ⋮、清單列 ⋮、資料夾 ⋮、頭像選單都是貼底滿寬的 sheet，列高 ≥ 48；Move to… 在 sheet 裡逐層進出；鍵盤升起時跟著升；點背板關閉", async ({ browser }) => {
  test.setTimeout(150_000);
  const { context, page } = await open(browser, 390, "short", { init: stubVisualViewport });
  try {
    // 移動到…的第一層要有資料夾才有「, open」可點：建 F ⊃ F1
    const F = `E2E sheet folder ${RUN}`;
    const F1 = `E2E sheet sub ${RUN}`;
    const created = await page.request.post("/api/folders", { headers: { Origin: ORIGIN }, data: { name: F, space: { kind: "personal" } } });
    expect(created.status(), await created.text()).toBe(201);
    const fId = ((await created.json()) as { id: string }).id;
    const sub = await page.request.post("/api/folders", { headers: { Origin: ORIGIN }, data: { name: F1, parentId: fId } });
    expect(sub.status(), await sub.text()).toBe(201);
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible({ timeout: 15_000 });

    // ── 筆記頁 ⋮ ──
    await page.locator("header").getByRole("button", { name: "More", exact: true }).click();
    let menu = await expectMenuSheet(page);
    expect(await menu.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).not.toBe("0px");
    expect(await menu.evaluate((el) => getComputedStyle(el).borderBottomLeftRadius)).toBe("0px");
    await expect(menu.getByText(TITLES.short, { exact: true })).toBeVisible();
    // 背板：wrapper 的 ::before 蓋滿視窗、半透明黑
    const backdrop = await menu.evaluate((el) => {
      const style = getComputedStyle(el.parentElement!, "::before");
      return { position: style.position, top: style.top, left: style.left, width: style.width, height: style.height, color: style.backgroundColor };
    });
    expect(backdrop).toEqual({ position: "fixed", top: "0px", left: "0px", width: "390px", height: "844px", color: "rgba(0, 0, 0, 0.5)" });

    // 鍵盤升起 300px：sheet 底緣在鍵盤上方；收起後回到視窗底
    await setKeyboard(page, 300);
    await expect(async () => {
      const b = (await menu.boundingBox())!;
      expect(b.y + b.height).toBeCloseTo(844 - 300, 0);
    }).toPass({ timeout: 5_000 });
    await setKeyboard(page, 0);
    await expect(async () => {
      const b = (await menu.boundingBox())!;
      expect(b.y + b.height).toBeCloseTo(844, 0);
    }).toPass({ timeout: 5_000 });

    // Move to…：換掉整個 sheet 內容，最上面一列 Back；逐層進出；Back 回主選單
    await menu.getByRole("menuitem", { name: "Move to…", exact: true }).click();
    await expect.poll(() => sheetRowNames(menu)).toEqual(["Back", `${F}, open`]);
    await expect(menu.getByRole("menuitem", { name: "Back", exact: true })).toBeFocused();
    await expect(menu.getByText("Move to…", { exact: true })).toBeVisible();
    await expectMenuSheet(page);
    await menu.getByRole("menuitem", { name: `${F}, open`, exact: true }).click();
    await expect.poll(() => sheetRowNames(menu)).toEqual(["Back", "Move here", F1]);
    await expectMenuSheet(page);
    await menu.getByRole("menuitem", { name: "Back", exact: true }).click();
    await expect.poll(() => sheetRowNames(menu)).toEqual(["Back", `${F}, open`]);
    await menu.getByRole("menuitem", { name: "Back", exact: true }).click();
    await expect(menu.getByRole("menuitem", { name: "Copy link", exact: true })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Move to…", exact: true })).toBeFocused();
    await expect(menu.getByText(TITLES.short, { exact: true })).toBeVisible();

    // 點背板（sheet 上方）關閉
    await page.touchscreen.tap(195, 60);
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue(TITLES.short);

    // ── 清單列 ⋮、資料夾 ⋮ ──
    await page.goto("/");
    const panel = await showSidebarTab(page, "My notes");
    await panel.getByRole("button", { name: `Note actions for ${TITLES.short}`, exact: true }).click();
    menu = await expectMenuSheet(page);
    await expect(menu.getByText(TITLES.short, { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);

    await panel.getByRole("button", { name: `Folder menu for ${F}`, exact: true }).click();
    menu = await expectMenuSheet(page, { radioRows: true });
    await page.touchscreen.tap(195, 60);
    await expect(page.getByRole("menu")).toHaveCount(0);

    // ── 頭像選單 ──
    await page.locator("[data-phone-top-bar]").getByRole("button", { name: alice.displayName, exact: true }).click();
    menu = await expectMenuSheet(page);
    await expect(menu.getByRole("menuitem", { name: "Log out", exact: true })).toBeVisible();
    await page.touchscreen.tap(195, 30);
    await expect(page.getByRole("menu")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("58-19 寬螢幕（1280）：筆記頁 ⋮ 仍是貼著按鈕的小選單（不是 sheet、沒有背板）", async ({ browser }) => {
  const { context, page } = await open(browser, 1280, "short", { touch: false });
  try {
    const more = page.locator("header").getByRole("button", { name: "More", exact: true });
    // 先量按鈕：選單開著時 Radix 把選單外的內容標成 aria-hidden，getByRole 就找不到它
    const button = await box(more);
    await more.click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await expect(menu).not.toHaveAttribute("data-menu-sheet");
    await expect(async () => {
      const b = (await menu.boundingBox())!;
      expect(b.width).toBeLessThan(400);
      // align="end"：右緣對齊按鈕右緣；在按鈕下方 4px
      expect(Math.abs(b.x + b.width - (button.x + button.width))).toBeLessThanOrEqual(1);
      expect(b.y).toBeCloseTo(button.y + button.height + 4, 0);
    }).toPass({ timeout: 5_000 });
    expect(await menu.evaluate((el) => getComputedStyle(el.parentElement!, "::before").content)).toBe("none");
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  } finally {
    await context.close();
  }
});

/** 清單裡最低的一顆列 ⋮（避開底部浮動鈕）：sheet 從底部升起，越低的列，按住時手指底下越可能出現選單項。 */
async function lowestRowMenu(page: Page, opts: { hover: boolean }): Promise<{ button: Locator; x: number; y: number }> {
  const viewport = page.viewportSize()!;
  const buttons = page.getByRole("complementary").getByRole("button", { name: /^Note actions for / });
  const count = await buttons.count();
  let best = -1;
  let bestY = -1;
  for (let i = 0; i < count; i += 1) {
    const button = buttons.nth(i);
    if (opts.hover) await button.locator("xpath=ancestor::li[1]").hover();
    const b = await button.boundingBox();
    if (b === null || b.width === 0 || b.y + b.height > viewport.height - 96) continue;
    if (b.y > bestY) {
      best = i;
      bestY = b.y;
    }
  }
  expect(best, "清單裡要有看得見的列 ⋮").toBeGreaterThanOrEqual(0);
  expect(bestY, "那顆 ⋮ 要在畫面下半部（sheet 會升到它底下）").toBeGreaterThan(viewport.height * 0.4);
  const button = buttons.nth(best);
  if (opts.hover) await button.locator("xpath=ancestor::li[1]").hover();
  const b = (await button.boundingBox())!;
  return { button, x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** 按住 `ms` 再放開：觸控走 CDP 的 touchStart／touchEnd（Playwright 的 tap／click 是瞬間放開，量不到這個問題），滑鼠走 down／up。 */
async function pressAndHold(page: Page, point: { x: number; y: number }, ms: number, kind: "touch" | "mouse"): Promise<void> {
  if (kind === "touch") {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x, y: point.y }] });
    await page.waitForTimeout(ms);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.detach();
    return;
  }
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

for (const variant of [
  { label: "觸控按住 250ms", kind: "touch", reduced: false, ms: 250 },
  { label: "觸控按住 250ms、減少動態", kind: "touch", reduced: true, ms: 250 },
  { label: "滑鼠按住 250ms", kind: "mouse", reduced: false, ms: 250 },
] as const) {
  test(`58-20 手機（390×560）${variant.label}：開 ⋮ 的那一下不會選到 sheet 升起後在手指底下的項目`, async ({ browser }) => {
    test.setTimeout(120_000);
    const { context, page } = await openList(browser, 390, variant.kind === "touch");
    try {
      await page.setViewportSize({ width: 390, height: 560 });
      if (variant.reduced) await page.emulateMedia({ reducedMotion: "reduce" });
      await expect(page.getByRole("complementary").getByRole("button", { name: /^Note actions for / }).first()).toBeAttached({ timeout: 15_000 });
      const writes: string[] = [];
      page.on("request", (request) => {
        if (request.method() !== "GET" && request.url().includes("/api/")) writes.push(`${request.method()} ${request.url()}`);
      });
      const url = page.url();
      const target = await lowestRowMenu(page, { hover: variant.kind === "mouse" });
      await pressAndHold(page, target, variant.ms, variant.kind);

      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      await expect(menu).toHaveAttribute("data-menu-sheet");
      // 讓進場動畫與任何延遲的 click 都跑完，再看狀態
      await page.waitForTimeout(400);
      await expect(menu).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: "Copy link", exact: true })).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: "Back", exact: true })).toHaveCount(0);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(page.url()).toBe(url);
      // 這一案有意義的前提：放開的那一點現在落在 sheet 的選單項上（舊行為下那一下就會選到它）
      const under = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest('[role="menuitem"]')?.textContent ?? null, [target.x, target.y] as const);
      expect(under, "按下的那一點在 sheet 的選單項上").not.toBeNull();
      expect(writes, "開 ⋮ 不該送出任何寫入").toEqual([]);

      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
}

test("58-21 手機（390 觸控）：站台管理、快捷鍵頁從帳號選單開，群組面板從群組列 ⋮ 開——清單的「‹」關掉後重開開啟它的那個選單", async ({ browser }) => {
  test.setTimeout(150_000);
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await expect(page).toHaveURL(/\/$/);
    const groupName = `E2E sheet group ${RUN}`;
    const created = await page.request.post("/api/groups", { headers: { Origin: ORIGIN }, data: { name: groupName } });
    expect(created.status(), await created.text()).toBe(201);
    await page.reload();
    const avatarButton = page.locator("[data-phone-top-bar]").getByRole("button", { name: /.+/ }).last();
    const menu = page.getByRole("menu");

    // ── 站台管理 ──
    await avatarButton.click();
    await expect(menu).toHaveAttribute("data-menu-sheet");
    const accountSheet = await menuSurface(menu);
    const accountX = await menuTextLeft(menu);
    await menu.getByRole("menuitem", { name: "Site admin", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "Site admin" });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expectPanelSheet(page, dialog);
    expectSameSurface(await panelSurface(dialog), accountSheet, "Site admin");
    const adminList = await listMetrics(dialog);
    expectPhoneList(adminList, "Site admin 清單");
    expectAlignedWithMenu(adminList, accountX, "Site admin");
    await expect(dialog.getByRole("navigation", { name: "Site admin" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);
    await dialog.getByRole("link", { name: "Groups", exact: true }).click();
    await expectPhoneContentHeading(dialog, dialog.getByRole("heading", { level: 1 }), "Site admin 第二層");
    await dialog.getByRole("button", { name: "Back to sections", exact: true }).click();
    await dialog.getByRole("button", { name: "Back to menu", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Site admin" })).toHaveCount(0);
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Site admin", exact: true })).toBeVisible();

    // ── 說明視窗（同一個帳號選單）──
    await menu.getByRole("menuitem", { name: "Help", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Help" });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expectPanelSheet(page, dialog);
    expectSameSurface(await panelSurface(dialog), accountSheet, "快捷鍵");
    const shortcutsList = await listMetrics(dialog);
    expectPhoneList(shortcutsList, "快捷鍵清單");
    expectAlignedWithMenu(shortcutsList, accountX, "快捷鍵");
    await expect(dialog.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);
    const shortcutsBack = dialog.getByRole("button", { name: "Back to menu", exact: true });
    await expect(shortcutsBack).toBeVisible({ timeout: 15_000 });
    const listBox = await box(shortcutsBack);
    await dialog.getByRole("button", { name: "Sidebar", exact: true }).click();
    const sectionsBack = dialog.getByRole("button", { name: "Back to sections", exact: true });
    await expect(sectionsBack).toBeVisible();
    await expectPhoneContentHeading(dialog, dialog.getByRole("heading", { level: 3 }), "快捷鍵第二層");
    const entryFonts = await dialog.locator("[data-shortcut-id]").first().evaluate((li) => ({
      name: parseFloat(getComputedStyle(li.querySelector("p.font-medium")!).fontSize),
      desc: parseFloat(getComputedStyle(li.querySelector("p.text-muted-foreground")!).fontSize),
      divider: parseFloat(getComputedStyle(li).borderBottomWidth),
    }));
    expect(entryFonts).toEqual({ name: 16, desc: 14, divider: 1 });
    const contentBox = await box(sectionsBack);
    expect(Math.abs(contentBox.x - listBox.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(contentBox.y - listBox.y)).toBeLessThanOrEqual(1);
    await sectionsBack.click();
    await dialog.getByRole("button", { name: "Back to menu", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Help" })).toHaveCount(0);
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    // ── 群組面板：群組列 ⋮ → Members & settings → 清單的「‹」→ 回到那個 ⋮ ──
    const panel = await showSidebarTab(page, "Groups");
    await panel.getByRole("button", { name: `Group actions for ${groupName}`, exact: true }).click();
    await expect(menu).toHaveAttribute("data-menu-sheet");
    const groupSheet = await menuSurface(menu);
    const groupX = await menuTextLeft(menu);
    await menu.getByRole("menuitem", { name: "Members & settings", exact: true }).click();
    dialog = page.getByRole("dialog", { name: groupName });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expectPanelSheet(page, dialog);
    await expect(dialog.getByRole("navigation", { name: groupName })).toBeVisible();
    expectSameSurface(await panelSurface(dialog), groupSheet, "群組");
    const groupList = await listMetrics(dialog);
    expectPhoneList(groupList, "群組清單");
    expectAlignedWithMenu(groupList, groupX, "群組");
    await dialog.getByRole("link", { name: "About", exact: true }).click();
    await expectPhoneContentHeading(dialog, dialog.getByRole("heading", { level: 1 }), "群組第二層");
    await dialog.getByRole("button", { name: "Back to sections", exact: true }).click();
    await dialog.getByRole("button", { name: "Back to menu", exact: true }).click();
    await expect(page.getByRole("dialog", { name: groupName })).toHaveCount(0);
    await expect(menu).toBeVisible();
    await expect(menu.getByText(groupName, { exact: true })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Members & settings", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  } finally {
    await context.close();
  }
});

// ── 手機上捲的是文件（58-22～58-26）─────────────────────────────────────────

/** 文件目前的捲動位置。 */
const pageScrollY = (page: Page): Promise<number> => page.evaluate(() => window.scrollY);

/** 元素在視窗座標裡的上下緣。 */
const edgesOf = (target: Locator): Promise<{ top: number; bottom: number }> =>
  target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  });

/** 用滑輪捲（使用者的捲動，不是程式設 scrollTop）：落在 `x, y` 那一點底下會捲的東西上。 */
async function wheelAt(page: Page, x: number, y: number, dy: number): Promise<void> {
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, dy);
}

test("58-22 手機清單（390）：文件在捲（清單容器不自己捲）；頂列與標題列釘在頂端；最後一列捲得到浮動鈕上方；底色到視窗底；清單 → 筆記從頂端開始、返回回到原位", async ({ browser }) => {
  test.setTimeout(180_000);
  const { context, page } = await openList(browser, 390, false);
  try {
    for (let i = 0; i < 24; i++) await createNoteVia(page, `E2E page scroll row ${RUN} ${String(i).padStart(2, "0")}`);
    await page.reload();
    await showSidebarTab(page, "My notes");
    const list = page.locator("[data-sidebar-list]").first();
    const rows = list.locator('[data-node-kind="note"]');
    await expect(rows.nth(23)).toBeAttached({ timeout: 15_000 });

    // 文件比視窗高、清單容器自己沒有捲動範圍
    expect(await scrollRange(page), "文件要能捲").toBeGreaterThan(300);
    expect(await list.evaluate((el) => el.scrollHeight - el.clientHeight), "清單容器不自己捲").toBeLessThanOrEqual(1);

    // 滑輪捲：動的是文件
    await wheelAt(page, 195, 500, 600);
    await expect.poll(() => pageScrollY(page)).toBeGreaterThan(100);
    expect(await list.evaluate((el) => el.scrollTop)).toBe(0);

    // 頂列釘在頂端、不透明；標題列緊接在它下方
    const topBar = page.locator("[data-phone-top-bar]");
    const header = page.locator("[data-sidebar-header]").first();
    const topEdges = await edgesOf(topBar);
    expect(topEdges.top).toBeCloseTo(0, 0);
    expect(topEdges.bottom).toBeCloseTo(48, 0);
    expect((await edgesOf(header)).top).toBeCloseTo(topEdges.bottom, 0);
    expect(alphaOf(await topBar.evaluate((el) => getComputedStyle(el).backgroundColor)), "頂列底色不透明").toBe(1);
    expect(alphaOf(await header.evaluate((el) => getComputedStyle(el).backgroundColor)), "標題列底色不透明").toBe(1);
    await expect(topBar.getByRole("button").last()).toBeInViewport();

    // 捲到底：最後一列在浮動鈕上緣之上
    await scrollPageToEnd(page);
    const fabs = page.locator("[data-phone-list-fabs]");
    const fabTop = Math.min((await box(fabs.getByRole("button", { name: "Search notes", exact: true }))).y, (await box(fabs.getByRole("button", { name: "New note", exact: true }))).y);
    await expect(async () => {
      const last = await box(rows.last());
      expect(last.y + last.height, "最後一列的下緣在浮動鈕上緣之上").toBeLessThanOrEqual(fabTop);
    }).toPass({ timeout: 5_000 });

    // 底色：html 與 body 都是清單的底色（卡片色），清單延伸到視窗底，最底那一點是清單
    const colors = await page.evaluate(() => ({
      html: getComputedStyle(document.documentElement).backgroundColor,
      body: getComputedStyle(document.body).backgroundColor,
      aside: getComputedStyle(document.querySelector("aside[data-sidebar-instance]")!).backgroundColor,
      asideBottom: document.querySelector("aside[data-sidebar-instance]")!.getBoundingClientRect().bottom,
      bottomHit: document.elementFromPoint(195, window.innerHeight - 1)?.closest("aside[data-sidebar-instance]") !== null,
    }));
    expect(colors.html).toBe(colors.aside);
    expect(colors.body).toBe(colors.aside);
    expect(colors.asideBottom).toBeGreaterThanOrEqual(844 - 0.5);
    expect(colors.bottomHit, "視窗最底那一點落在清單上").toBe(true);

    // 清單 → 筆記：從頂端開始；系統返回：回到原位
    await page.evaluate(() => window.scrollTo(0, 400));
    const before = await pageScrollY(page);
    expect(before).toBe(400);
    const target = await list.evaluate((el) => {
      const headerBottom = document.querySelector("[data-sidebar-header]")!.getBoundingClientRect().bottom;
      const link = Array.from(el.querySelectorAll<HTMLAnchorElement>("a[href^='/n/']")).find((a) => {
        const r = a.getBoundingClientRect();
        return r.top >= headerBottom + 4 && r.bottom <= window.innerHeight - 100;
      });
      return link?.getAttribute("href") ?? null;
    });
    expect(target).not.toBeNull();
    await list.locator(`a[href="${target}"]`).click();
    await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible({ timeout: 15_000 });
    expect(await pageScrollY(page), "筆記從頂端開始").toBe(0);
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect.poll(() => pageScrollY(page), { message: "回到清單原本的位置" }).toBe(before);
  } finally {
    await context.close();
  }
});

test("58-23 手機短清單（390）：沒有多餘的捲動範圍，清單仍延伸到視窗底", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await openList(browser, 390, false);
  try {
    // 這個帳號沒有人分享筆記給它：與我共享是空的
    await showSidebarTab(page, "Shared with me");
    await expect(page.locator("[data-sidebar-header]").first()).toBeVisible();
    expect(await scrollRange(page)).toBeLessThanOrEqual(1);
    const asideBottom = await page.locator("aside[data-sidebar-instance]").first().evaluate((el) => el.getBoundingClientRect().bottom);
    expect(asideBottom).toBeCloseTo(844, 0);
  } finally {
    await context.close();
  }
});

test("58-24 手機長筆記（390）：文件在捲；頁首釘在頂端、不透明；最後一段捲得到浮動鈕上方；對話框與選單開關不跳；搜尋層 Cancel 回到原位", async ({ browser }) => {
  test.setTimeout(180_000);
  const { context, page } = await open(browser, 390, "long", { touch: false });
  try {
    const last = editorLocator(page).getByText(LONG_LAST, { exact: true });
    await expect(last).toBeAttached({ timeout: 15_000 });
    expect(await scrollRange(page), "文件要能捲").toBeGreaterThan(300);
    expect(await scrollerOf(page).evaluate((el) => el.scrollHeight - el.clientHeight), "內文容器不自己捲").toBeLessThanOrEqual(1);
    expect(await pageScrollY(page), "筆記從頂端開始").toBe(0);

    // 滑輪捲：動的是文件，頁首留在頂端
    await wheelAt(page, 195, 500, 700);
    await expect.poll(() => pageScrollY(page)).toBeGreaterThan(100);
    const slot = page.locator("[data-note-header-slot]");
    expect((await edgesOf(slot)).top).toBeCloseTo(0, 0);
    await expect(page.getByRole("textbox", { name: "Note title" })).toBeInViewport();
    await expect(page.getByRole("button", { name: "Back to notes", exact: true })).toBeInViewport();
    expect(alphaOf(await slot.evaluate((el) => getComputedStyle(el).backgroundColor)), "頁首底色不透明").toBe(1);
    // 頁首高度寫進 --kb-sticky-top，區塊的 scroll-margin-top 跟著它（捲到段落時讓開頁首）
    const slotHeight = await slot.evaluate((el) => Math.round(el.getBoundingClientRect().height));
    expect(await last.evaluate((el) => getComputedStyle(el.closest(".bn-block-outer")!).scrollMarginTop)).toBe(`${slotHeight}px`);

    // 捲到底：最後一段在浮動鈕上緣之上；底色到視窗底
    await scrollPageToEnd(page);
    const fabs = page.getByTestId("note-browse-bar").locator("[data-phone-list-fabs]");
    const fabTop = Math.min((await box(fabs.getByRole("button", { name: "Search notes", exact: true }))).y, (await box(fabs.getByRole("button", { name: "New note", exact: true }))).y);
    await expect(async () => {
      const b = await box(last);
      expect(b.y + b.height, "最後一段的下緣在浮動鈕上緣之上").toBeLessThanOrEqual(fabTop);
      // 尾端沒有多出的空白：捲到底時最後一段離視窗底只差浮動鈕的空位與欄的下內距
      expect(844 - (b.y + b.height), "最後一段離視窗底").toBeLessThanOrEqual(200);
    }).toPass({ timeout: 5_000 });
    const colors = await page.evaluate(() => {
      const card = document.querySelector("[data-note-header-slot]")!.parentElement!;
      return {
        html: getComputedStyle(document.documentElement).backgroundColor,
        body: getComputedStyle(document.body).backgroundColor,
        card: getComputedStyle(card).backgroundColor,
        cardBottom: card.getBoundingClientRect().bottom,
      };
    });
    expect(colors.html).toBe(colors.card);
    expect(colors.body).toBe(colors.card);
    expect(colors.cardBottom).toBeGreaterThanOrEqual(844 - 0.5);

    // 選單（Radix 鎖捲動，關掉時焦點還給 ⋮）開著與關掉後，位置都不變。用座標點：只量 app 自己的行為，
    // 不讓 Playwright 點之前的「捲進視窗」介入。
    const clickAt = async (target: Locator) => {
      const b = await box(target);
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    };
    await page.evaluate(() => window.scrollTo(0, 500));
    const y = await pageScrollY(page);
    expect(y).toBe(500);
    await clickAt(page.locator("header").getByRole("button", { name: "More", exact: true }));
    await expect(page.getByRole("menu")).toBeVisible();
    expect(await pageScrollY(page), "選單開著時不跳").toBe(y);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    expect(await pageScrollY(page), "選單關掉後不跳").toBe(y);
    // 對話框（分享）同樣
    await clickAt(page.locator("header").getByRole("button", { name: "Share", exact: true }));
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(await pageScrollY(page), "對話框開著時不跳").toBe(y);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await pageScrollY(page), "對話框關掉後不跳").toBe(y);

    // 搜尋層：從頂端開始；Cancel 回到這篇原本的位置
    await clickAt(page.getByTestId("note-browse-bar").getByRole("button", { name: "Search notes", exact: true }));
    await expect(page.getByRole("textbox", { name: "Search notes", exact: true })).toBeFocused();
    expect(await pageScrollY(page)).toBe(0);
    await page.locator("[data-phone-list-bar]").getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible();
    await expect.poll(() => pageScrollY(page)).toBe(y);
  } finally {
    await context.close();
  }
});

test("58-25 下拉重新整理：清單與編輯中的筆記擋掉（overscroll-behavior-y: contain），瀏覽中的筆記照舊", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await open(browser, 390, "long");
  try {
    const overscroll = () => page.evaluate(() => ({ html: getComputedStyle(document.documentElement).overscrollBehaviorY, body: getComputedStyle(document.body).overscrollBehaviorY }));
    await expect(editorLocator(page).getByText("paragraph number 0", { exact: true })).toBeVisible({ timeout: 15_000 });
    expect(await overscroll()).toEqual({ html: "auto", body: "auto" });
    // 編輯中（工具列在）；編輯器連上共編之前點不進去，所以點到工具列出現為止
    await expect(async () => {
      await editorLocator(page).getByText("paragraph number 0", { exact: true }).tap({ position: { x: 2, y: 4 } });
      await expect(page.locator("[data-mobile-edit-toolbar]")).toBeVisible({ timeout: 1_500 });
    }).toPass({ timeout: 15_000 });
    expect(await overscroll()).toEqual({ html: "contain", body: "contain" });
    // 清單
    await page.getByRole("button", { name: "Back to notes", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    expect(await overscroll()).toEqual({ html: "contain", body: "contain" });
  } finally {
    await context.close();
  }
});

test("58-26 寬螢幕（1280×800）：頁面本身不捲（scrollY 恆為 0），筆記的內文容器在捲", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await open(browser, 1280, "long", { touch: false, height: 800 });
  try {
    await expect(editorLocator(page).getByText(LONG_LAST, { exact: true })).toBeAttached({ timeout: 15_000 });
    expect(await scrollRange(page), "文件沒有捲動範圍").toBeLessThanOrEqual(0);
    const scroller = scrollerOf(page);
    const scrollerBox = await box(scroller);
    await wheelAt(page, scrollerBox.x + scrollerBox.width / 2, scrollerBox.y + scrollerBox.height / 2, 700);
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
    expect(await pageScrollY(page)).toBe(0);
    // 外框仍鎖在視窗高；body 照舊是頁底色（不是手機的卡片色）
    expect(await page.locator("[data-phone-page-scroll]").evaluate((el) => el.getBoundingClientRect().height)).toBeCloseTo(800, 0);
    const colors = await page.evaluate(() => ({ body: getComputedStyle(document.body).backgroundColor, card: getComputedStyle(document.querySelector("[data-note-header-slot]")!.parentElement!).backgroundColor }));
    expect(colors.body).not.toBe(colors.card);
  } finally {
    await context.close();
  }
});

async function bubbleGeometry(page: Page): Promise<{ bubble: Rect; scrollbar: number; clientRight: number; scroller: Rect; footer: Rect; blur: string; opacity: string; hit: boolean }> {
  return page.evaluate(() => {
    const bubbleEl = document.querySelector('[data-testid="versions-bubble"]') as HTMLElement;
    const anchor = document.querySelector('[data-testid="corner-anchor"]') as HTMLElement;
    const card = anchor.parentElement!;
    const scrollEl = card.querySelector('[data-testid="article-column"]')!.closest(".overflow-y-auto") as HTMLElement;
    const footerEl = anchor.nextElementSibling as HTMLElement;
    const r = (el: Element) => {
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height, right: b.right, bottom: b.bottom };
    };
    const sb = scrollEl.getBoundingClientRect();
    const scrollbar = scrollEl.offsetWidth - scrollEl.clientWidth;
    const clientRight = sb.x + scrollEl.clientLeft + scrollEl.clientWidth;
    const b = bubbleEl.getBoundingClientRect();
    const hitEl = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
    const cs = getComputedStyle(bubbleEl);
    return { bubble: r(bubbleEl), scrollbar, clientRight, scroller: r(scrollEl), footer: r(footerEl), blur: cs.backdropFilter || cs.getPropertyValue("-webkit-backdrop-filter"), opacity: getComputedStyle(anchor.firstElementChild!).opacity, hit: hitEl === bubbleEl || bubbleEl.contains(hitEl) };
  });
}

interface Rect { x: number; y: number; width: number; height: number; right: number; bottom: number }

function expectBubbleInNoteArea(g: Awaited<ReturnType<typeof bubbleGeometry>>, label: string): void {
  console.log(`MEASURE ${label} ${JSON.stringify(g)}`);
  expect(g.blur, `${label}：毛玻璃`).toMatch(/blur\(/);
  expect(g.bubble.right, `${label}：在內文區右緣內`).toBeLessThanOrEqual(g.scroller.right);
  expect(g.bubble.right, `${label}：離右緣有空隙（讓出捲軸）`).toBeLessThanOrEqual(g.scroller.right - 16);
  expect(g.bubble.bottom, `${label}：在內文區下緣內`).toBeLessThanOrEqual(g.scroller.bottom);
  expect(g.bubble.x).toBeGreaterThanOrEqual(g.scroller.x);
  expect(g.bubble.y).toBeGreaterThanOrEqual(g.scroller.y);
  expect(g.bubble.bottom, `${label}：不壓到提及列`).toBeLessThanOrEqual(g.footer.y + 0.5);
  const gapBottom = g.footer.y - g.bubble.bottom;
  // 右邊量到捲軸槽的左緣；捲動區固定預留捲軸槽，所以短筆記也有，兩邊空隙相等。
  const gapRight = g.clientRight - g.bubble.right;
  expect(g.scrollbar, `${label}：預留捲軸槽`).toBeGreaterThan(0);
  expect(Math.abs(gapRight - gapBottom), `${label}：右邊空隙 ${gapRight}、下邊 ${gapBottom}、槽寬 ${g.scrollbar}`).toBeLessThanOrEqual(1);
  expect(Math.abs(gapBottom - 24), `${label}：離提及列上緣 24px（實 ${gapBottom}）`).toBeLessThanOrEqual(1);
}

test("58-32 寬螢幕（1280、900、767、700 ×800）：歷史泡泡是毛玻璃、釘在內文區右下角（提及列之上）；捲動時不消失；三種寬度、短／長筆記、有／無提及都一樣；390 沒有泡泡", async ({ browser }) => {
  test.setTimeout(480_000);
  for (const width of [1280, 900, 767, 700]) {
    const columnLeft: Record<string, number> = {};
    for (const [key, backlinks] of [["long", false], ["short", false], ["mentioned", true]] as const) {
      const { context, page } = await open(browser, width, key, { touch: false, height: 800, backlinks });
      try {
        await expect(page.getByTestId("versions-bubble")).toBeVisible({ timeout: 15_000 });
        if (backlinks) await expect(page.getByText(/^Mentioned in 1 note$/)).toBeVisible();
        const widthButton = page.getByRole("button", { name: /^Width:/ });
        for (const mode of ["standard", "wide", "full"]) {
          if (mode !== "standard") {
            // 700 的頁首沒有寬度鈕（在 ⋮ 裡）：到 1280 換寬度，再回到原視窗；寬度設定是跨視窗保留的。
            if (width < 768) await page.setViewportSize({ width: 1280, height: 800 });
            await widthButton.click();
            if (width < 768) await page.setViewportSize({ width, height: 800 });
          }
          const label = `${width} ${key} ${mode}`;
          const g = await bubbleGeometry(page);
          expectBubbleInNoteArea(g, label);
          if (mode === "standard") columnLeft[key] = (await page.getByTestId("article-column").boundingBox())!.x;
          expect(g.hit, `${label}：點得到`).toBe(true);
          // 文章欄底部沒有為泡泡額外留白：下內距等於上內距。
          const pad = await page.getByTestId("article-column").evaluate((el) => ({ top: getComputedStyle(el).paddingTop, bottom: getComputedStyle(el).paddingBottom }));
          expect(pad.bottom, `${label}：欄的下內距等於上內距`).toBe(pad.top);
          if (key === "long" && mode === "standard") {
            const scroller = scrollerOf(page);
            await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
            await page.waitForTimeout(1_200);
            const after = await bubbleGeometry(page);
            expect(after.opacity, "捲動後沒有淡出").toBe("1");
            expect(after.hit, "捲動後仍點得到").toBe(true);
            expect(Math.abs(after.bubble.y - g.bubble.y), "泡泡不隨內文捲走").toBeLessThanOrEqual(0.5);
            await scroller.evaluate((el) => { el.scrollTop = 0; });
          }
        }
        if (key === "mentioned") {
          const g = await bubbleGeometry(page);
          expect(g.footer.height, "有提及列").toBeGreaterThan(20);
          expect(g.bubble.bottom).toBeLessThanOrEqual(g.footer.y + 0.5);
        }
      } finally {
        await context.close();
      }
    }
    // 捲軸槽固定預留：長筆記（有捲軸）與短筆記（沒有）的文章欄左緣在同一個位置。
    console.log(`MEASURE ${width} article column left ${JSON.stringify(columnLeft)}`);
    expect(Math.abs(columnLeft.long! - columnLeft.short!), `${width}：長短筆記的文章欄左緣不動`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(columnLeft.long! - columnLeft.mentioned!), `${width}：有提及時也不動`).toBeLessThanOrEqual(0.5);
  }
  const { context, page } = await open(browser, 390, "long");
  try {
    await expect(page.getByTestId("versions-bubble")).toHaveCount(0);
    await expect(page.getByTestId("corner-anchor")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("58-33 寬螢幕（1280×800）：歷史泡泡 hover 時底色是淺品牌色（淺色與深色，等於 bg-brand-soft）、游標是手指，移開後回到毛玻璃", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await open(browser, 1280, "long", { touch: false, height: 800 });
  try {
    const bubble = page.getByTestId("versions-bubble");
    await expect(bubble).toBeVisible({ timeout: 15_000 });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.mouse.move(5, 5);
      await page.waitForTimeout(400);
      const bg = () => bubble.evaluate((el) => getComputedStyle(el).backgroundColor);
      const rest = await bg();
      await bubble.hover();
      await page.waitForTimeout(400);
      const hover = await bg();
      console.log(`MEASURE bubble bg ${scheme} rest ${rest} hover ${hover}`);
      const soft = await page.evaluate(() => {
        const probe = document.createElement("div");
        probe.className = "bg-brand-soft";
        document.body.appendChild(probe);
        const c = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return c;
      });
      console.log(`MEASURE bubble bg-brand-soft ${scheme} ${soft}`);
      expect(hover, `${scheme}：hover 底色等於 bg-brand-soft`).toBe(soft);
      expect(hover, `${scheme}：hover 與平時不同`).not.toBe(rest);
      expect(await bubble.evaluate((el) => getComputedStyle(el).cursor), `${scheme}：游標是手指`).toBe("pointer");
      await page.mouse.move(5, 5);
      await page.waitForTimeout(400);
      expect(await bg(), `${scheme}：移開後回到平時`).toBe(rest);
    }
  } finally {
    await context.close();
  }
});

// ── 轉向跨過 640 時保住閱讀位置（58-27、58-29）────────────────────────────────

/** 筆記裡含 `text` 的那一段離「看得到的上緣」多遠：手機是頁首下緣，640 起是內文容器的上緣。 */
async function blockOffset(page: Page, text: string): Promise<number> {
  return page.evaluate((needle) => {
    const block = Array.from(document.querySelectorAll<HTMLElement>(".bn-block-content")).find((el) => el.textContent === needle)!;
    const scroller = document.querySelector('[data-testid="article-column"]')!.closest(".overflow-y-auto") as HTMLElement;
    const scrolls = getComputedStyle(scroller).overflowY !== "visible";
    const top = scrolls ? scroller.getBoundingClientRect().top : document.querySelector("[data-note-header-slot]")!.getBoundingClientRect().bottom;
    return block.getBoundingClientRect().top - top;
  }, text);
}

test("58-27 轉向（390×844 → 844×390 → 390×844）：長筆記停在同一段（手機捲文件、橫拿捲內文容器）", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await open(browser, 390, "long", { touch: false });
  try {
    const target = "paragraph number 20";
    await expect(editorLocator(page).getByText(target, { exact: true })).toBeAttached({ timeout: 15_000 });
    // 把那一段捲到頁首正下方
    await page.evaluate(async (needle) => {
      const block = Array.from(document.querySelectorAll<HTMLElement>(".bn-block-content")).find((el) => el.textContent === needle)!;
      const header = document.querySelector("[data-note-header-slot]")!.getBoundingClientRect().bottom;
      window.scrollTo(0, window.scrollY + block.getBoundingClientRect().top - header);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, target);
    expect(Math.abs(await blockOffset(page, target)), "那一段在頁首正下方附近").toBeLessThanOrEqual(8);
    expect(await pageScrollY(page)).toBeGreaterThan(300);

    await page.setViewportSize({ width: 844, height: 390 });
    await expect.poll(() => scrollerOf(page).evaluate((el) => getComputedStyle(el).overflowY)).toBe("auto");
    await expect.poll(() => blockOffset(page, target).then((d) => Math.abs(d) <= 40), { message: "橫拿：那一段在內文容器頂端附近" }).toBe(true);
    expect(await pageScrollY(page), "橫拿：文件不捲").toBe(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => scrollerOf(page).evaluate((el) => getComputedStyle(el).overflowY)).toBe("visible");
    await expect.poll(() => blockOffset(page, target).then((d) => Math.abs(d) <= 40), { message: "轉回直拿：那一段在頁首正下方附近" }).toBe(true);
    expect(await pageScrollY(page)).toBeGreaterThan(300);
  } finally {
    await context.close();
  }
});

test("58-29 轉向（390×844 → 844×390 → 390×844）：清單停在同一列（橫拿時清單收在抽屜裡）", async ({ browser }) => {
  test.setTimeout(180_000);
  const { context, page } = await openList(browser, 390, false);
  try {
    for (let i = 0; i < 24; i++) await createNoteVia(page, `E2E rotate row ${RUN} ${String(i).padStart(2, "0")}`);
    await page.reload();
    await showSidebarTab(page, "My notes");
    const list = page.locator("[data-sidebar-list]").first();
    await expect(list.locator('[data-node-kind="note"]').nth(23)).toBeAttached({ timeout: 15_000 });
    const rowOffset = (href: string) =>
      page.evaluate((h) => {
        const row = document.querySelector(`[data-sidebar-list] a[href="${h}"]`)!.closest("[data-node-kind]")!.firstElementChild!;
        return row.getBoundingClientRect().top - document.querySelector("[data-sidebar-header]")!.getBoundingClientRect().bottom;
      }, href);
    // 往下捲，取標題列下方的第一列，把它對齊標題列下緣
    await page.evaluate(() => window.scrollTo(0, 500));
    const href = await list.evaluate((el) => {
      const headerBottom = document.querySelector("[data-sidebar-header]")!.getBoundingClientRect().bottom;
      const link = Array.from(el.querySelectorAll<HTMLAnchorElement>("a[href^='/n/']")).find((a) => a.getBoundingClientRect().top >= headerBottom);
      return link!.getAttribute("href")!;
    });
    await page.evaluate(async (d) => {
      window.scrollTo(0, window.scrollY + d);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, await rowOffset(href));
    const offset = await rowOffset(href);
    expect(Math.abs(offset), "那一列在標題列正下方附近").toBeLessThanOrEqual(30);
    const before = await pageScrollY(page);

    await page.setViewportSize({ width: 844, height: 390 });
    await expect(page.getByRole("button", { name: "Open sidebar", exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("[data-phone-top-bar]")).toBeVisible();
    await expect(async () => {
      const d = await rowOffset(href);
      expect(Math.abs(d - offset), `轉回直拿：同一列回到原本的位置（原 ${offset}、現 ${d}、scrollY ${await pageScrollY(page)}／${before}）`).toBeLessThanOrEqual(2);
    }).toPass({ timeout: 5_000 });
    expect(Math.abs((await pageScrollY(page)) - before)).toBeLessThanOrEqual(2);
  } finally {
    await context.close();
  }
});

test("58-28 寬螢幕（1280）：管理面板的列、標題、卡與托盤維持原樣——列 36px／14px、目前的項次有品牌底、沒有「›」、托盤有毛玻璃", async ({ browser }) => {
  test.setTimeout(90_000);
  const { context, page } = await openList(browser, 1280, false);
  try {
    await page.goto("/settings/login");
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    const items = dialog.locator("[data-management-card='items']");
    await expect(items.getByRole("link", { name: "Sign-in", exact: true })).toBeVisible();
    const list = await listMetrics(dialog);
    expect(list.title.fontSize).toBe(15);
    expect(list.title.fontWeight).toBe(600);
    expect(list.headerBorder, "沒有列頭髮絲線").toBe(0);
    for (const [i, row] of list.rows.entries()) {
      expect(row.height, `列 ${i} 高`).toBe(36);
      expect(row.fontSize, `列 ${i} 字級`).toBe(14);
      expect(row.radius, `列 ${i} 圓角`).toBe(8);
      expect(row.chevronDisplay, `列 ${i} 沒有「›」`).toBe("none");
      if (i > 0) expect(row.top - (list.rows[i - 1].top + list.rows[i - 1].height), `列 ${i} 與上一列的間距`).toBe(4);
    }
    const current = await items.getByRole("link", { name: "Sign-in", exact: true }).evaluate((el) => ({ weight: parseInt(getComputedStyle(el).fontWeight, 10), bg: getComputedStyle(el).backgroundColor }));
    expect(current.weight, "目前的項次 500").toBe(500);
    expect(alphaOf(current.bg), "目前的項次有品牌底").toBeGreaterThan(0);
    const surface = await dialog.evaluate((el) => {
      const card = el.querySelector<HTMLElement>("[data-management-card='items']")!;
      const tray = getComputedStyle(card.parentElement!);
      return { cardBg: getComputedStyle(card).backgroundColor, cardRadius: getComputedStyle(card).borderTopLeftRadius, trayRadius: tray.borderTopLeftRadius, trayBlur: tray.backdropFilter, trayShadow: tray.boxShadow };
    });
    expect(surface.cardRadius).toBe("12px");
    expect(surface.trayRadius).toBe("16px");
    expect(surface.trayBlur).toMatch(/blur/);
    expect(surface.trayShadow).not.toBe("none");
    // 卡仍是 card 色（深色下比選單的 popover 暗；這裡只量不是透明）
    expect(alphaOf(surface.cardBg)).toBe(1);
    const h1 = dialog.getByRole("heading", { level: 1 });
    await expect(h1).toBeVisible();
    expect(await fontPx(h1), "第二層標題 20px").toBe(20);

    // ── 700（640～767，不是手機）：項次清單層仍是 ← 與 ✕、列 36px／14px、品牌色的目前項次、沒有「›」 ──
    await page.setViewportSize({ width: 700, height: 844 });
    await dialog.getByRole("button", { name: "Back to sections", exact: true }).click();
    await expect(dialog.getByRole("navigation", { name: "Settings" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Back to menu", exact: true })).toHaveCount(0);
    const mid = await listMetrics(dialog);
    expect(mid.title.fontSize).toBe(15);
    expect(mid.headerBorder, "700：沒有列頭髮絲線").toBe(0);
    for (const [i, row] of mid.rows.entries()) {
      expect(row.height, `700：列 ${i} 高`).toBe(36);
      expect(row.fontSize, `700：列 ${i} 字級`).toBe(14);
      expect(row.chevronDisplay, `700：列 ${i} 沒有「›」`).toBe("none");
    }
    const midCurrent = await items.getByRole("link", { name: "Sign-in", exact: true }).evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(alphaOf(midCurrent), "700：目前的項次有品牌底").toBeGreaterThan(0);
    await items.getByRole("link", { name: "Sign-in", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Back to sections", exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("58-30 手機（390）深色：表格卡的主欄格底色＝卡的底色（不是比表面更暗的 card 色）；「‹」底色＝卡底色", async ({ browser }) => {
  test.setTimeout(90_000);
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 }, colorScheme: "dark" });
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await page.goto("/admin/users");
    const dialog = page.getByRole("dialog", { name: "Site admin" });
    await expect(dialog.getByRole("button", { name: "Back to sections", exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    const row = dialog.getByRole("row").nth(1);
    await expect(row).toBeVisible({ timeout: 15_000 });
    const cell = row.getByRole("cell").first();
    const surface = await panelSurface(dialog);
    const cellBg = await cell.evaluate((el) => getComputedStyle(el).backgroundColor);
    console.log(`MEASURE table cell dark card ${surface.bg} cell ${cellBg}`);
    expect(alphaOf(cellBg) === 0 || cellBg === surface.bg, "主欄格透明或與卡同色").toBe(true);
    await expectPhoneContentHeading(dialog, dialog.getByRole("heading", { level: 1 }), "深色 Site admin Users");
  } finally {
    await context.close();
  }
});

test("58-31 矮的手機螢幕（568×320 橫拿）：設定的項次清單自己捲動，列頭不動，最後一列捲得到、點得到", async ({ browser }) => {
  test.setTimeout(90_000);
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 568, height: 320 } });
  try {
    const page = await context.newPage();
    await loginAs(page, alice.email, PASSWORD);
    await page.goto("/settings/login");
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog.getByRole("button", { name: "Back to sections", exact: true })).toBeVisible({ timeout: 15_000 });
    await dialog.getByRole("button", { name: "Back to sections", exact: true }).click();
    const nav = dialog.getByRole("navigation", { name: "Settings" });
    await expect(nav).toBeVisible();
    const scroll = await nav.evaluate((el) => ({ client: el.clientHeight, scrollHeight: el.scrollHeight, overflowY: getComputedStyle(el).overflowY, overflowX: el.scrollWidth - el.clientWidth }));
    console.log(`MEASURE short list ${JSON.stringify(scroll)}`);
    expect(scroll.overflowY).toBe("auto");
    expect(scroll.scrollHeight, "清單比可見高度高（要捲）").toBeGreaterThan(scroll.client);
    expect(scroll.overflowX, "沒有橫向捲動").toBeLessThanOrEqual(0);
    const headerTop = await dialog.getByRole("heading", { name: "Settings" }).evaluate((el) => el.getBoundingClientRect().top);
    const links = nav.getByRole("link");
    const last = links.last();
    await last.evaluate((el) => el.scrollIntoView({ block: "end" }));
    const after = await nav.evaluate((el, lastEl) => {
      const n = el.getBoundingClientRect();
      const r = (lastEl as HTMLElement).getBoundingClientRect();
      return { scrollTop: el.scrollTop, rowTop: r.top, rowBottom: r.bottom, navTop: n.top, navBottom: n.bottom, height: window.innerHeight };
    }, await last.elementHandle());
    console.log(`MEASURE short list after ${JSON.stringify(after)}`);
    expect(after.scrollTop, "清單捲過了").toBeGreaterThan(0);
    expect(after.rowBottom, "最後一列在清單可見範圍內").toBeLessThanOrEqual(after.navBottom + 1);
    expect(after.rowTop).toBeGreaterThanOrEqual(after.navTop - 1);
    expect(after.rowBottom, "最後一列在畫面內").toBeLessThanOrEqual(after.height);
    expect(await dialog.getByRole("heading", { name: "Settings" }).evaluate((el) => el.getBoundingClientRect().top), "列頭沒有跟著捲").toBe(headerTop);
    const name = (await last.innerText()).trim();
    await last.tap();
    await expect(dialog.getByRole("button", { name: "Back to sections", exact: true })).toBeVisible();
    await expect(nav).toBeHidden();
    expect(name.length).toBeGreaterThan(0);
  } finally {
    await context.close();
  }
});
