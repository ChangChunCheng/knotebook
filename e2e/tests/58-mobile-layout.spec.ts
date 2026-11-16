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
 * 58-4 短筆記沒有多餘的捲動範圍（390，鍵盤收起）：一行字的筆記，捲動容器 scrollHeight − clientHeight ＝ 0——沒有提及時沒有提及列；
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
 * 58-11～58-15 手機清單（390）：兩顆 56px 浮動鈕的位置、最後一列捲得到鈕上方、搜尋中／選取／垃圾桶的顯示；桌面星號與 ⋮ 的位置；
 *      列的左右內距相等、星號與 ⋮ 的點擊範圍不重疊、字級 15／12、頂列標題與頭像對齊；筆記頁首位置在標題正下方、「‹」置中於區塊。
 *
 * 量不到、列在實機清單：iOS Safari 的瀏覽器工具列伸縮時 `dvh` 的實際行為與底部不被蓋住、瀏海與 Home 指示條的 safe area、
 * 真實螢幕鍵盤升起時的捲動範圍。
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

async function scrollRange(page: Page): Promise<number> {
  return scrollerOf(page).evaluate((el) => el.scrollHeight - el.clientHeight);
}

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
      const s = scroller.getBoundingClientRect();
      const f = footer.getBoundingClientRect();
      return { footerText: footer.textContent ?? "", footerBottom: f.bottom, footerTop: f.top, scrollerBottom: s.bottom, columnBottom: column.getBoundingClientRect().bottom };
    });
    expect(geometry.footerText).toContain("Mentioned in 1 note");
    expect(geometry.footerBottom).toBeLessThanOrEqual(geometry.scrollerBottom + 0.5);
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
    await list.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
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
    await trashList.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
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

test("58-16 手機（390）管理面板是整頁：Close 在畫面內、兩層（內容、項次清單）都關得掉；視窗變矮時仍在畫面內", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await openList(browser, 390, true);
  try {
    const openSettings = async (): Promise<Locator> => {
      await page.locator("[data-phone-top-bar]").getByRole("button", { name: alice.displayName, exact: true }).click();
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

    let dialog = await openSettings();
    // 整頁：貼齊視窗四邊、高度＝innerHeight（dvh）
    const full = await box(dialog);
    expect(full.x).toBe(0);
    expect(full.y).toBe(0);
    expect(full.width).toBe(390);
    expect(Math.abs(full.height - 844)).toBeLessThanOrEqual(1);

    // 內容層：Close 在畫面內、點擊範圍 ≥ 44；視窗變矮（模擬工具列佔掉高度）後仍在畫面內
    const close = dialog.getByRole("button", { name: "Close", exact: true });
    await expect(close).toBeVisible();
    await insideViewport(close, "內容層 Close");
    const contentCloseBox = await box(close);
    await page.setViewportSize({ width: 390, height: 740 });
    await expect(async () => {
      expect(Math.abs((await box(dialog)).height - 740)).toBeLessThanOrEqual(1);
    }).toPass({ timeout: 5_000 });
    await insideViewport(close, "矮視窗 Close");
    await page.setViewportSize({ width: 390, height: 844 });

    // 回項次清單：左卡有 Close
    await dialog.getByRole("button", { name: "Back to sections", exact: true }).click();
    const listClose = dialog.getByRole("button", { name: "Close", exact: true });
    await expect(listClose).toHaveCount(1);
    await expect(listClose).toBeVisible();
    await insideViewport(listClose, "項次層 Close");
    const listCloseBox = await box(listClose);
    expect(Math.abs(listCloseBox.x - contentCloseBox.x), "兩層 Close 的 x").toBeLessThanOrEqual(1);
    expect(Math.abs(listCloseBox.y - contentCloseBox.y), "兩層 Close 的 y").toBeLessThanOrEqual(1);
    await listClose.click();
    await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);

    // 內容層也關得掉
    dialog = await openSettings();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
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
      expect(alphaOf(st.bg), `背景 ${st.bg} 的 alpha`).toBeGreaterThan(0.3);
      expect(alphaOf(st.bg), `背景 ${st.bg} 的 alpha`).toBeLessThan(0.5);
      expect(st.border).toBe("1px");
      expect(st.shadow).not.toBe("none");
    }
    expect(cStyle.bg, "兩顆同一款底").toBe(sStyle.bg);
    expect(cStyle.color, "New note 的圖示是 brand 色、與 Search 不同").not.toBe(sStyle.color);
    await expect(create.locator("svg")).toHaveAttribute("data-icon", "pen-line");

    // 長筆記：最後一段捲得到鈕上方
    const scroller = scrollerOf(page);
    await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const last = editorLocator(page).getByText(LONG_LAST, { exact: true });
    await expect(async () => {
      const lastBox = await box(last);
      const top = Math.min((await box(search)).y, (await box(create)).y);
      expect(lastBox.y + lastBox.height, "最後一段的下緣在浮動鈕上緣之上").toBeLessThanOrEqual(top);
    }).toPass({ timeout: 5_000 });
    await scroller.evaluate((el) => {
      el.scrollTop = 0;
    });

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
