import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { E2E_ORIGIN } from "../ports.js";
import { ADMIN, clickEndOfParagraph, createUserViaInvite, editorLocator, loginAs, randomEmail, waitForEditorSelection } from "./helpers.js";

/**
 * 右側標題大綱（#465，桌機）：內文欄右側一排細線（每個 H1–H3 一條、目前那一節亮），滑上去展開成面板，點標題跳過去。
 * 全部在 1440×900、側欄 320（每個案例先寫 localStorage，不依賴側欄預設寬）。
 *
 * 60-1 跳轉：hover 細線 → 面板出現 5 項 → 點「Section D」→ 該標題的 `.bn-block-outer` 頂端與捲動容器頂端差在 [-2, 4] px；
 *      段落錨點的高亮浮層出現；網址（含 hash）不變；面板收起、細線仍在。
 * 60-2 目前位置：把「Usage」捲過容器頂端 → 細線亮的是 Usage 那條；展開面板時 `aria-current` 也在 Usage。
 * 60-6 打字新增標題：在最後一段後面 Enter、打 `## New section` → 2 秒內細線多一條，面板裡有「New section」。
 * 60-8 公開頁（未登入）：細線在；hover → 點「Usage」→ 該標題捲到容器頂端。
 * 60-9 切換標題（真的 BlockNote DOM）：用 `/` 選單建一個切換 H2「Folded」、裡面放一個 H3「Inner」；把 Inner 捲到頂端 → 亮 Inner；
 *      收合 Folded（不捲動、不按指標，只點開合鈕）→ 亮的換成 Folded；從面板點 Inner → Folded 展開、Inner 捲到頂端、亮 Inner。
 * 60-10 最後一個標題：點面板裡最後一個標題（捲不到頂端的那個）→ 捲到底後仍是它亮。
 *
 * 帳號與資料：用邀請建一個帳號（alice）；唯讀的筆記在 beforeAll 以 API 建一次（含一篇開了公開連結的），
 * 會被改到的筆記（60-6、60-9）每次在案例裡另建，`--repeat-each` 時互不干擾。每個案例開新 context。
 */

test.use({ actionTimeout: 15_000 });

const RUN = Date.now();
const PASSWORD = "e2e-heading-outline-pw";
const ORIGIN = E2E_ORIGIN;
const VIEWPORT = { width: 1440, height: 900 };

const filler = (tag: string, n = 40): string => Array.from({ length: n }, (_, i) => `${tag} filler paragraph ${i}`).join("\n\n");
const LONG_MD = [
  "# Intro",
  filler("intro"),
  "## Install",
  filler("install"),
  "### Linux",
  filler("linux"),
  "## Usage",
  filler("usage"),
  "## Section D",
  filler("section"),
].join("\n\n");
const TAIL_MD = ["# Alpha", filler("alpha"), "## Omega", "the only paragraph under omega"].join("\n\n");
const LONG_HEADINGS = ["Intro", "Install", "Linux", "Usage", "Section D"];

let alice: { email: string; displayName: string };
const notes = { long: "", tail: "", publicToken: "" };

async function createNoteVia(page: Page, title: string, content: string): Promise<{ id: string; path: string }> {
  const res = await page.request.post("/api/notes", { headers: { Origin: ORIGIN }, data: { title, content } });
  expect(res.status(), await res.text()).toBe(201);
  const note = (await res.json()) as { id: string; slug: string; ownerHandle: string };
  return { id: note.id, path: `/n/${note.ownerHandle}/${note.slug}` };
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  alice = { email: randomEmail(), displayName: `alice ${RUN}` };
  const admin = await browser.newContext();
  try {
    const page = await admin.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await createUserViaInvite(page, { ...alice, password: PASSWORD });
  } finally {
    await admin.close();
  }
  const context = await browser.newContext({ viewport: VIEWPORT });
  try {
    const page = await context.newPage();
    await loginAs(page, alice.email, PASSWORD);
    notes.long = (await createNoteVia(page, `Outline long ${RUN}`, LONG_MD)).path;
    notes.tail = (await createNoteVia(page, `Outline tail ${RUN}`, TAIL_MD)).path;
    const published = await createNoteVia(page, `Outline public ${RUN}`, LONG_MD);
    const res = await page.request.put(`/api/notes/${published.id}/public-link`, { headers: { Origin: ORIGIN } });
    expect(res.status(), await res.text()).toBe(200);
    notes.publicToken = ((await res.json()) as { token: string }).token;
  } finally {
    await context.close();
  }
});

async function newContext(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: VIEWPORT });
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem("sidebar.width", "320");
    } catch {
      // 讀不到 localStorage 時照預設寬跑。
    }
  });
  return { context, page: await context.newPage() };
}

/** 以 alice 登入、開 `path`，等標題框（筆記頁的 lazy 外殼換完）。 */
async function openNote(browser: Browser, path: string | ((page: Page) => Promise<string>)): Promise<{ context: BrowserContext; page: Page }> {
  const { context, page } = await newContext(browser);
  await loginAs(page, alice.email, PASSWORD);
  await expect(page).toHaveURL(/\/$/);
  await page.goto(typeof path === "string" ? path : await path(page));
  await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible({ timeout: 15_000 });
  return { context, page };
}

const rail = (page: Page): Locator => page.getByTestId("outline-rail");
const railLines = (page: Page): Locator => rail(page).locator(":scope > span");
const panel = (page: Page): Locator => page.getByTestId("outline-panel");
const panelItem = (page: Page, text: string): Locator => panel(page).locator("[data-outline-item]").filter({ hasText: new RegExp(`^${text}$`) });
const scrollerOf = (page: Page): Locator => page.getByTestId("article-column").locator("xpath=ancestor::div[contains(@class,'overflow-y-auto')][1]");

/** 滑上細線、等面板展開（展開有 150 ms 延遲）。 */
async function openPanel(page: Page): Promise<void> {
  await rail(page).hover();
  await expect(panel(page)).toBeVisible();
}

/** 內文裡文字恰為 `text` 的標題的區塊 id。 */
async function headingId(page: Page, text: string): Promise<string> {
  const id = await page.evaluate((text) => {
    const content = Array.from(document.querySelectorAll('[data-content-type="heading"]')).find((el) => el.textContent?.trim() === text);
    return content?.closest(".bn-block-outer")?.getAttribute("data-id") ?? null;
  }, text);
  expect(id, `heading "${text}"`).not.toBeNull();
  return id!;
}

/** 標題區塊頂端減捲動容器頂端（px）。 */
async function headingOffset(page: Page, id: string): Promise<number> {
  return scrollerOf(page).evaluate((scroller, id) => {
    const block = scroller.querySelector(`.bn-block-outer[data-id="${id}"]`)!;
    return block.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  }, id);
}

/** 捲到該標題頂端恰好超過容器頂端 `past` px。 */
async function scrollHeadingPastTop(page: Page, id: string, past = 2): Promise<void> {
  await scrollerOf(page).evaluate(
    (scroller, { id, past }) => {
      const block = scroller.querySelector(`.bn-block-outer[data-id="${id}"]`)!;
      scroller.scrollTop += block.getBoundingClientRect().top - scroller.getBoundingClientRect().top + past;
    },
    { id, past },
  );
}

async function expectLandedAtTop(page: Page, id: string): Promise<void> {
  await expect.poll(() => headingOffset(page, id), { timeout: 5_000, message: "標題頂端與捲動容器頂端的差（px）" }).toBeGreaterThanOrEqual(-2);
  await expect.poll(() => headingOffset(page, id), { timeout: 5_000, message: "標題頂端與捲動容器頂端的差（px）" }).toBeLessThanOrEqual(4);
}

/** 細線裡第 `index` 條是唯一亮著的那條。 */
async function expectActiveLine(page: Page, index: number): Promise<void> {
  await expect(rail(page).locator(":scope > span[data-active]")).toHaveCount(1);
  await expect(railLines(page).nth(index)).toHaveAttribute("data-active", "");
}

test("60-1 跳轉：hover 展開 5 項，點 Section D 捲到頂端並閃一下，網址不變，面板收起", async ({ browser }) => {
  const { context, page } = await openNote(browser, notes.long);
  try {
    await expect(railLines(page)).toHaveCount(5, { timeout: 15_000 });
    const urlBefore = page.url();
    await openPanel(page);
    await expect(panel(page).locator("[data-outline-item]")).toHaveText(LONG_HEADINGS);
    const id = await headingId(page, "Section D");
    await panelItem(page, "Section D").click();
    await expectLandedAtTop(page, id);
    await expect(page.locator(`.kn-anchor-flash[data-anchor-flash="${id}"]`)).toBeAttached({ timeout: 5_000 });
    expect(page.url()).toBe(urlBefore);
    await expect(panel(page)).toBeHidden();
    await expect(rail(page)).toBeVisible();
    await expectActiveLine(page, 4);
  } finally {
    await context.close();
  }
});

test("60-2 目前位置：Usage 捲過頂端後亮 Usage，面板的 aria-current 也在 Usage", async ({ browser }) => {
  const { context, page } = await openNote(browser, notes.long);
  try {
    await expect(railLines(page)).toHaveCount(5, { timeout: 15_000 });
    await expectActiveLine(page, 0);
    await scrollHeadingPastTop(page, await headingId(page, "Usage"));
    await expectActiveLine(page, 3);
    await openPanel(page);
    await expect(panelItem(page, "Usage")).toHaveAttribute("aria-current", "location");
    await expect(panel(page).locator('[aria-current="location"]')).toHaveCount(1);
  } finally {
    await context.close();
  }
});

test("60-6 打字新增 H2：2 秒內細線多一條、面板裡有 New section", async ({ browser }) => {
  const { context, page } = await openNote(browser, async (page) => (await createNoteVia(page, `Outline typing ${RUN} ${Date.now()}`, "# First\n\nfirst body\n\nlast line")).path);
  try {
    await expect(railLines(page)).toHaveCount(1, { timeout: 15_000 });
    await clickEndOfParagraph(page, editorLocator(page).locator('[data-content-type="paragraph"]').filter({ hasText: /^last line$/ }));
    await page.keyboard.press("Enter");
    await page.keyboard.type("## New section");
    await expect(railLines(page)).toHaveCount(2, { timeout: 2_000 });
    await openPanel(page);
    await expect(panelItem(page, "New section")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("60-8 公開頁（未登入）：細線在，hover 點 Usage 捲到頂端", async ({ browser }) => {
  const { context, page } = await newContext(browser);
  try {
    await page.goto(`/p/${notes.publicToken}`);
    await expect(page.locator('[data-testid="public-note-editor"]')).toBeVisible({ timeout: 15_000 });
    await expect(railLines(page)).toHaveCount(5, { timeout: 15_000 });
    await openPanel(page);
    const id = await headingId(page, "Usage");
    await panelItem(page, "Usage").click();
    await expectLandedAtTop(page, id);
    await expect(panel(page)).toBeHidden();
  } finally {
    await context.close();
  }
});

test("60-9 切換標題：收合後亮的換成切換標題；從面板點收起來的標題會展開並捲過去", async ({ browser }) => {
  test.setTimeout(90_000);
  const md = ["# Top", filler("top"), "toggle anchor", filler("tail")].join("\n\n");
  const { context, page } = await openNote(browser, async (page) => (await createNoteVia(page, `Outline toggle ${RUN} ${Date.now()}`, md)).path);
  try {
    await expect(railLines(page)).toHaveCount(1, { timeout: 15_000 });
    // 在「toggle anchor」之後用 `/` 選單建切換 H2，再按 Tab 把下一行縮進去、打成 H3。
    await clickEndOfParagraph(page, editorLocator(page).locator('[data-content-type="paragraph"]').filter({ hasText: /^toggle anchor$/ }));
    await page.keyboard.press("Enter");
    await page.keyboard.type("/toggle heading 2");
    const menu = page.locator(".bn-suggestion-menu");
    await expect(menu.getByText("Toggle Heading 2", { exact: true })).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Enter");
    await waitForEditorSelection(page);
    await page.keyboard.type("Folded");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await page.keyboard.type("### Inner");
    await expect(railLines(page)).toHaveCount(3, { timeout: 5_000 });

    const foldedId = await headingId(page, "Folded");
    const innerId = await headingId(page, "Inner");
    const folded = page.locator(`.bn-block-outer[data-id="${foldedId}"]`);
    const wrapper = folded.locator("> .bn-block > .bn-block-content .bn-toggle-wrapper");
    await expect(wrapper).toHaveAttribute("data-show-children", "true");
    expect(await folded.locator(`.bn-block-outer[data-id="${innerId}"]`).count(), "Inner 在 Folded 裡").toBe(1);

    await scrollHeadingPastTop(page, innerId);
    await expectActiveLine(page, 2);

    // 只點開合鈕（`click()`，沒有指標事件、也不捲動）：內容變矮，大綱靠尺寸變化重新量。
    await folded.locator("> .bn-block > .bn-block-content .bn-toggle-button").evaluate((el) => (el as HTMLElement).click());
    await expect(wrapper).toHaveAttribute("data-show-children", "false");
    await expect(page.locator(`.bn-block-outer[data-id="${innerId}"]`)).toBeHidden();
    await expectActiveLine(page, 1);

    await openPanel(page);
    await panelItem(page, "Inner").click();
    await expect(wrapper).toHaveAttribute("data-show-children", "true");
    await expectLandedAtTop(page, innerId);
    await expectActiveLine(page, 2);
  } finally {
    await context.close();
  }
});

test("60-10 點最後一個標題：捲不到頂端也仍是它亮", async ({ browser }) => {
  const { context, page } = await openNote(browser, notes.tail);
  try {
    await expect(railLines(page)).toHaveCount(2, { timeout: 15_000 });
    await openPanel(page);
    const id = await headingId(page, "Omega");
    await panelItem(page, "Omega").click();
    // 捲到底了，Omega 仍在容器頂端之下。
    const scroller = scrollerOf(page);
    await expect
      .poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop), { timeout: 5_000, message: "捲到底" })
      .toBeLessThanOrEqual(1);
    expect(await headingOffset(page, id)).toBeGreaterThan(50);
    await expectActiveLine(page, 1);
    // 等過幾個畫格（量測是逐畫格排程的），它不會被改回 Alpha。
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          let left = 5;
          const step = () => (--left === 0 ? resolve() : requestAnimationFrame(step));
          requestAnimationFrame(step);
        }),
    );
    await expectActiveLine(page, 1);
  } finally {
    await context.close();
  }
});
