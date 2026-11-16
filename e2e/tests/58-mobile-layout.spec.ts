import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { E2E_ORIGIN } from "../ports.js";
import { ADMIN, createUserViaInvite, editorLocator, loginAs, randomEmail, waitForEditorSelection } from "./helpers.js";

/**
 * 手機（< 640）版面：內容貼齊畫面邊緣、標題字級、提及列在內文捲動容器裡、寬表格的右緣提示。全部量瀏覽器算出來的值，不看 class 名稱。
 *
 * 58-1 標題字級（390）：內文 H1／H2／H3 的 computed font-size 是基準字級的 2／1.5／1.17 倍（基準 16px）；筆記標題框仍是 20px；
 *      800 寬仍是桌面的 3／2／1.3 倍。
 * 58-2 貼邊（390、800）：390 時內文卡的 x＝0、寬＝視窗寬，AppShell 外框的 padding 四邊都是 0；800 時外框仍是 12px、內文卡不貼邊。
 * 58-3 簡報（390）：投影片的 h1 > h2 > h3，h1 是它所在容器字級的 1.75 倍。
 * 58-4 短筆記沒有多餘的捲動範圍（390，鍵盤收起）：一行字的筆記，捲動容器 scrollHeight − clientHeight ＝ 0——沒有提及時沒有提及列；
 *      有提及時提及列在第一屏內、排在文章欄之後；編輯中（工具列在）時工具列的空白是捲動內容的最後一個子節點，範圍仍是 0。
 * 58-5 寬表格右緣提示（390）：表格還能往右捲時 `--kb-table-fade` 是 1.5rem（24px），捲到底變 0；沒有溢出的表格是 0。
 * 58-6 不支援捲動驅動動畫時的後備（390）：委派的捲動監聽在還能往右捲的表格上標 `data-kb-more-right`，捲到底拿掉，
 *      沒有溢出的表格不標；非手機寬度不標。
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
};

const HEADINGS_MD = ["# Heading one", "", "## Heading two", "", "### Heading three", "", "body text"].join("\n");
const DECK_MD = ["# Slide one", "", "## Slide two", "", "### Slide three", "", "slide text"].join("\n");
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
const paths: Record<keyof typeof TITLES, string> = { headings: "", short: "", mentioned: "", mentioner: "", wide: "", deck: "" };

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

test("58-1 標題字級：390 縮小、800 維持桌面", async ({ browser }) => {
  const phone = await open(browser, 390, "headings");
  try {
    const sizes = await headingSizes(phone.page);
    expect(sizes.base).toBe(BASE_FONT_PX);
    expect(sizes.h1).toBeCloseTo(BASE_FONT_PX * 2, 1);
    expect(sizes.h2).toBeCloseTo(BASE_FONT_PX * 1.5, 1);
    expect(sizes.h3).toBeCloseTo(BASE_FONT_PX * 1.17, 1);
    expect(await fontPx(phone.page.getByRole("textbox", { name: "Note title" }))).toBe(20);
  } finally {
    await phone.context.close();
  }
  const wide = await open(browser, 800, "headings", { touch: false });
  try {
    const sizes = await headingSizes(wide.page);
    expect(sizes.base).toBe(BASE_FONT_PX);
    expect(sizes.h1).toBeCloseTo(BASE_FONT_PX * 3, 1);
    expect(sizes.h2).toBeCloseTo(BASE_FONT_PX * 2, 1);
    expect(sizes.h3).toBeCloseTo(BASE_FONT_PX * 1.3, 1);
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
