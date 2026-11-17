import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import {
  ADMIN,
  createUserViaInvite,
  loginAs,
  openListOnCompact,
  randomEmail,
  showSidebarTab,
  tapAreaOf,
} from "./helpers.js";

/**
 * 觸控裝置（`pointer: coarse`）的點擊範圍與輸入框字級；滑鼠（`pointer: fine`）維持原樣。
 *
 * 56-1 清單（390、360 觸控）：tab 與列 44 高；列內 ⋮、「＋」、最愛星號的點擊範圍 ≥ 44×44，同一列相鄰兩顆圓心距 ≥ 44。
 * 56-2 選單（390、360 觸控）：⋮ 選單與使用者選單每一項 ≥ 40 高；主題色票點擊範圍 44×44、相鄰圓心距 ≥ 44。
 * 56-3 筆記頁頁首（390、360 觸控）：‹、星號、分享、⋮ 的點擊範圍 ≥ 40×44。
 * 56-4 選取模式（390 觸控）：標題列的「Select all」「Done」（有框線）點擊範圍 ≥ 44 高。
 * 56-5 輸入框字級（觸控）：登入頁、清單搜尋框、筆記頁（標題框、程式碼區塊語言下拉）、分享對話框（含共用 Select 的角色觸發鈕）、設定頁，
 *      每個看得到的 input／select／textarea 的 computed font-size 都不小於 16px（搜尋框與程式碼區塊語言下拉量到剛好 16px）。
 * 56-6 搜尋框（800、1280 觸控）：沒有 Ctrl K 提示；清除 ✕ 的點擊範圍 44×44，但輸入框文字區右緣內 1px 點下去仍是輸入框。
 * 56-7 滑鼠不變（390、1280 滑鼠）：列 28、tab 36、列內鈕的點擊範圍就是 24×24；選單項 1280 是 32，390 的 ⋮ 是貼底的 sheet（不分指標）所以是 48；
 *      1280 的側欄搜尋框 13px、Ctrl K 提示還在。
 * 56-8 共用 Select（分享對話框的角色觸發鈕）：390 觸控字級 16px、點擊高不比同列輸入框矮、每個選項點擊範圍 ≥ 40 高；
 *      1280 滑鼠觸發鈕視覺高 32、選項高 32。
 *
 * 不在範圍內（原因）：
 * - Mantine／BlockNote 內建的輸入框與下拉（例如連結工具列的網址框）：字級由該套件的樣式決定，不是我們的 class。
 * - 同一篇筆記有好幾位在線時頭像列的「+N」徽章與 ⋮ 會不會重疊：要多個使用者同時連線的實機才看得出來。
 * - 真手指的落點偏差與 iOS 聚焦放大：桌面 Chromium 驗不到，只能量 CSS 與點擊範圍，要實機看。
 *
 * 帳號與資料建一次（alice），以 API 建在寬視窗，之後各案例開新 context 操作。
 */

const RUN = Date.now();
const PASSWORD = "e2e-touch-targets-pw";
const PHONES = [
  { width: 390, height: 844 },
  { width: 360, height: 780 },
] as const;
/** `tapAreaOf` 每 0.5px 取樣，每一側最多少算 0.5px（兩側合計 1px），所以 44 量到 43.5、40 量到 39.5 都算夠；容差取 1。 */
const TOL = 1;

const TITLES = {
  plain: `E2E touch plain ${RUN}`,
  fav: `E2E touch fav ${RUN}`,
  inFolder: `E2E touch in folder ${RUN}`,
  code: `E2E touch code ${RUN}`,
};
const FOLDER = `Touch Docs ${RUN}`;

let alice: { email: string; displayName: string };

interface Created {
  id: string;
}

async function adminContext(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await loginAs(page, ADMIN.email, ADMIN.password);
  return { context, page };
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  alice = { email: randomEmail(), displayName: `alice ${RUN}` };
  const admin = await adminContext(browser);
  try {
    await createUserViaInvite(admin.page, { ...alice, password: PASSWORD });
  } finally {
    await admin.context.close();
  }
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    const page = await context.newPage();
    await loginAs(page, alice.email, PASSWORD);
    const post = async (url: string, data: object): Promise<Created> => {
      const res = await page.request.post(url, { data });
      expect(res.status(), `POST ${url} → ${res.status()} ${await res.text()}`).toBe(201);
      return (await res.json()) as Created;
    };
    await post("/api/notes", { title: TITLES.plain });
    const fav = await post("/api/notes", { title: TITLES.fav });
    const put = await page.request.put(`/api/favorites/${fav.id}`);
    expect(put.ok(), `PUT favorite → ${put.status()}`).toBe(true);
    const folder = await post("/api/folders", { name: FOLDER, space: { kind: "personal" } });
    await post("/api/notes", { title: TITLES.inFolder, folderId: folder.id });
    await post("/api/notes", { title: TITLES.code, content: "intro\n\n```js\nconst a = 1;\n```\n" });
  } finally {
    await context.close();
  }
});

async function openAs(browser: Browser, viewport: { width: number; height: number }, touch: boolean): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(touch ? { hasTouch: true, isMobile: true, viewport } : { viewport });
  const page = await context.newPage();
  await loginAs(page, alice.email, PASSWORD);
  await expect(page).toHaveURL(/\/$/);
  return { context, page };
}

const titleBox = (page: Page): Locator => page.locator('[aria-label="Note title"]');
const noteLink = (scope: Locator, title: string): Locator => scope.getByRole("link", { name: new RegExp("^" + title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
const rowOf = (scope: Locator, title: string): Locator => scope.locator("li[data-node-kind='note']").filter({ hasText: title });

/** 搜尋框所在的清單範圍：1280 以上是固定側欄，其餘走 `openListOnCompact`（手機的清單、640–1279 的抽屜）。 */
async function listScope(page: Page, width: number): Promise<Locator> {
  if (width >= 1280) {
    // 搜尋時 tab 列換成結果，所以不用「含 tab 列」過濾；固定側欄是頁面上第一個 complementary。
    await expect(page.getByRole("tablist", { name: "Sidebar sections" })).toBeVisible({ timeout: 15_000 });
    return page.getByRole("complementary").first();
  }
  return openListOnCompact(page);
}

async function openNote(page: Page, sidebar: Locator, title: string): Promise<void> {
  await showSidebarTab(page, "My notes", sidebar);
  await noteLink(sidebar, title).click();
  await expect(titleBox(page)).toHaveValue(title, { timeout: 15_000 });
}

/** 看得見的 input／select／textarea／Select 觸發鈕裡，字級小於 16px 的（排除第三方元件；iOS 只在小於 16px 時聚焦放大）。回傳「共幾個、哪幾個太小」。 */
async function fieldFontSizes(page: Page): Promise<{ count: number; bad: string[] }> {
  return page.evaluate(() => {
    const bad: string[] = [];
    let count = 0;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("input, select, textarea, [role=combobox]:not(input)"))) {
      // Radix Select 在表單內渲染 aria-hidden 的原生 select 做表單同步，不是使用者看得到的欄位。
      if (el instanceof HTMLSelectElement && el.getAttribute("aria-hidden") === "true") continue;
      if (el instanceof HTMLInputElement && ["checkbox", "radio", "hidden", "file", "button", "submit", "range", "color"].includes(el.type)) continue;
      if (el.closest('[class*="mantine-"], .bn-toolbar, .bn-form-popover') !== null) continue;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || style.visibility === "hidden" || style.display === "none") continue;
      count += 1;
      if (parseFloat(style.fontSize) < 16) bad.push(`${el.tagName.toLowerCase()}[${el.getAttribute("aria-label") ?? el.id ?? el.className}] ${style.fontSize}`);
    }
    return { count, bad };
  });
}

/** 目前開著的選單裡每一項（含子選單觸發項、勾選項、單選項）的高度。 */
async function menuItemHeights(page: Page): Promise<Array<{ name: string; height: number }>> {
  return page.evaluate(() => {
    const menu = document.querySelector('[role="menu"]');
    if (menu === null) return [];
    return Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]')).map((el) => ({
      name: el.getAttribute("aria-label") ?? el.textContent?.trim() ?? "",
      height: el.getBoundingClientRect().height,
    }));
  });
}

for (const phone of PHONES) {
  test(`56-1 清單 ${phone.width} 觸控：tab 與列 44 高、列內鈕點擊範圍 ≥ 44×44 且相鄰圓心距 ≥ 44`, async ({ browser }) => {
    test.setTimeout(120_000);
    const { context, page } = await openAs(browser, phone, true);
    try {
      await page.goto("/");
      const sidebar = page.getByRole("complementary");
      await expect(sidebar).toBeVisible({ timeout: 15_000 });
      const lines: string[] = [];

      const tabs = sidebar.getByRole("tablist", { name: "Sidebar sections" }).getByRole("tab");
      await expect(tabs).toHaveCount(6);
      for (let i = 0; i < 6; i++) {
        const area = await tapAreaOf(tabs.nth(i));
        lines.push(`tab${i} ${area.visual[1].toFixed(1)}`);
        expect(area.visual[1], `tab ${i} 高`).toBeGreaterThanOrEqual(44 - TOL);
      }

      await showSidebarTab(page, "My notes", sidebar);
      await expect(noteLink(sidebar, TITLES.plain)).toBeVisible({ timeout: 15_000 });

      // 一般列與最愛列：列高、⋮、最愛星號（最愛列的星號與 ⋮ 相鄰）
      for (const title of [TITLES.plain, TITLES.fav]) {
        const link = noteLink(sidebar, title);
        const row = rowOf(sidebar, title);
        const rowBox = (await row.boundingBox({ timeout: 10_000 }))!;
        lines.push(`row ${title.slice(0, 16)} ${rowBox.height.toFixed(1)}`);
        expect(rowBox.height, `${title} 列高`).toBeGreaterThanOrEqual(44 - TOL);
        expect((await link.boundingBox({ timeout: 10_000 }))!.height, `${title} 連結高`).toBeGreaterThanOrEqual(44 - TOL);
        const more = await tapAreaOf(row.getByRole("button", { name: `Note actions for ${title}`, exact: true }));
        lines.push(`more ${more.visual.map((v) => v.toFixed(1)).join("x")} tap ${more.tap.map((v) => v.toFixed(1)).join("x")}`);
        expect(more.visual[0], "⋮ 視覺寬不變").toBeLessThanOrEqual(24.5);
        expect(more.tap[0], `${title} ⋮ 點擊寬`).toBeGreaterThanOrEqual(44 - TOL);
        expect(more.tap[1], `${title} ⋮ 點擊高`).toBeGreaterThanOrEqual(44 - TOL);
        if (title === TITLES.fav) {
          // 觸控：最愛是一顆不能點的標記（不是按鈕，沒有點擊範圍），在 ⋮ 左邊一格；⋮ 永遠是最右一格
          await expect(row.getByRole("button", { name: "Favorite", exact: true })).toHaveCount(0);
          const marker = row.getByRole("img", { name: "Favorite", exact: true });
          await expect(marker).toBeVisible();
          expect(await marker.evaluate((el) => getComputedStyle(el).pointerEvents), "標記不吃點擊").toBe("none");
          const markerBox = (await marker.boundingBox())!;
          lines.push(`marker ${markerBox.width.toFixed(1)}x${markerBox.height.toFixed(1)} gap ${(more.center[0] - (markerBox.x + markerBox.width / 2)).toFixed(1)}`);
          expect(more.center[0] - (markerBox.x + markerBox.width / 2), "標記在 ⋮ 左邊約一格").toBeGreaterThan(14);
          expect(more.center[0] - (markerBox.x + markerBox.width / 2), "標記與 ⋮ 相鄰").toBeLessThan(30);
        }
      }

      // 資料夾列：「＋」與資料夾 ⋮ 相鄰；列高 44
      const folderRow = sidebar.locator("li[data-node-kind='folder']").filter({ hasText: FOLDER }).first();
      await expect(folderRow).toBeVisible();
      const folderBox = (await folderRow.locator("> div").first().boundingBox({ timeout: 10_000 }))!;
      expect(folderBox.height, "資料夾列高").toBeGreaterThanOrEqual(44 - TOL);
      const plus = await tapAreaOf(folderRow.getByRole("button", { name: `New note in ${FOLDER}`, exact: true }));
      const folderMore = await tapAreaOf(folderRow.getByRole("button", { name: `Folder menu for ${FOLDER}`, exact: true }));
      lines.push(`plus tap ${plus.tap.map((v) => v.toFixed(1)).join("x")} more tap ${folderMore.tap.map((v) => v.toFixed(1)).join("x")} gap ${Math.abs(folderMore.center[0] - plus.center[0]).toFixed(1)}`);
      for (const [name, area] of [["＋", plus], ["資料夾 ⋮", folderMore]] as const) {
        expect(area.tap[0], `${name} 點擊寬`).toBeGreaterThanOrEqual(44 - TOL);
        expect(area.tap[1], `${name} 點擊高`).toBeGreaterThanOrEqual(44 - TOL);
      }
      expect(Math.abs(folderMore.center[0] - plus.center[0]), "＋ 與資料夾 ⋮ 圓心距").toBeGreaterThanOrEqual(44 - TOL);

      // 視覺框外 8px 點下去：命中的還是那顆鈕（只往上下量；左右可能是相鄰鈕）
      const moreButton = rowOf(sidebar, TITLES.plain).getByRole("button", { name: `Note actions for ${TITLES.plain}`, exact: true });
      const box = (await moreButton.boundingBox({ timeout: 10_000 }))!;
      for (const dy of [-(box.height / 2 + 8), box.height / 2 + 8]) {
        const hit = await page.evaluate(
          ([x, y]) => document.elementFromPoint(x!, y!)?.closest("button")?.getAttribute("aria-label") ?? null,
          [box.x + box.width / 2, box.y + box.height / 2 + dy] as const,
        );
        expect(hit, `⋮ 視覺框外 8px（dy=${dy.toFixed(0)}）`).toBe(`Note actions for ${TITLES.plain}`);
      }
      console.log(`MEASURE 56-1 ${phone.width} ${lines.join(" | ")}`);
    } finally {
      await context.close();
    }
  });

  test(`56-2 選單 ${phone.width} 觸控：⋮ 選單與使用者選單每項 ≥ 40 高；色票點擊範圍 44×44`, async ({ browser }) => {
    test.setTimeout(120_000);
    const { context, page } = await openAs(browser, phone, true);
    try {
      await page.goto("/");
      const sidebar = page.getByRole("complementary");
      await expect(sidebar).toBeVisible({ timeout: 15_000 });
      await showSidebarTab(page, "My notes", sidebar);

      // 列的 ⋮ 選單
      await sidebar.getByRole("button", { name: `Note actions for ${TITLES.plain}`, exact: true }).click();
      await expect(page.getByRole("menu")).toBeVisible();
      const noteItems = await menuItemHeights(page);
      expect(noteItems.length, "筆記 ⋮ 選單項數").toBeGreaterThanOrEqual(5);
      for (const item of noteItems) expect(item.height, `⋮ 選單「${item.name}」高`).toBeGreaterThanOrEqual(40 - TOL);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);

      // 使用者選單
      await page.locator("[data-phone-top-bar]").getByRole("button", { name: alice.displayName, exact: true }).click();
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      // 手機的選單是由下往上升起的 sheet：進場動畫跑完再量（還在畫面外的部分 elementFromPoint 打不到）
      await expect.poll(() => menu.evaluate((el) => el.getAnimations().length)).toBe(0);
      const userItems = await menuItemHeights(page);
      const swatchNames = await menu.evaluate((el) =>
        Array.from(el.querySelectorAll<HTMLElement>('[role="menuitemradio"]'))
          .filter((item) => item.getBoundingClientRect().width < 40)
          .map((item) => item.getAttribute("aria-label") ?? ""),
      );
      expect(swatchNames.length, "色票數").toBe(6);
      for (const item of userItems) {
        if (swatchNames.includes(item.name)) continue;
        expect(item.height, `使用者選單「${item.name}」高`).toBeGreaterThanOrEqual(40 - TOL);
      }
      expect(userItems.length - swatchNames.length, "使用者選單文字項數").toBeGreaterThanOrEqual(4);
      const areas = [];
      for (const name of swatchNames) areas.push(await tapAreaOf(menu.getByRole("menuitemradio", { name, exact: true })));
      for (const [i, area] of areas.entries()) {
        expect(area.tap[0], `色票 ${swatchNames[i]} 點擊寬`).toBeGreaterThanOrEqual(44 - TOL);
        expect(area.tap[1], `色票 ${swatchNames[i]} 點擊高`).toBeGreaterThanOrEqual(44 - TOL);
        if (i > 0) expect(area.center[0] - areas[i - 1]!.center[0], `色票 ${i - 1}、${i} 圓心距`).toBeGreaterThanOrEqual(44 - TOL);
      }
      console.log(
        `MEASURE 56-2 ${phone.width} note-menu min ${Math.min(...noteItems.map((i) => i.height)).toFixed(1)} user-menu min ${Math.min(
          ...userItems.filter((i) => !swatchNames.includes(i.name)).map((i) => i.height),
        ).toFixed(1)} swatch tap ${areas.map((a) => a.tap.map((v) => v.toFixed(0)).join("x")).join(",")}`,
      );
    } finally {
      await context.close();
    }
  });

  test(`56-3 筆記頁頁首 ${phone.width} 觸控：‹、星號、分享、⋮ 的點擊範圍 ≥ 40×44`, async ({ browser }) => {
    test.setTimeout(120_000);
    const { context, page } = await openAs(browser, phone, true);
    try {
      await page.goto("/");
      const sidebar = page.getByRole("complementary");
      await expect(sidebar).toBeVisible({ timeout: 15_000 });
      await openNote(page, sidebar, TITLES.plain);
      const header = page.locator("header").filter({ has: page.getByRole("button", { name: "More", exact: true }) }).first();
      const lines: string[] = [];
      const buttons: Array<[string, Locator]> = [
        ["back", page.getByRole("button", { name: "Back to notes", exact: true })],
        ["star", header.getByRole("button", { name: "Favorite", exact: true })],
        ["share", header.getByRole("button", { name: "Share", exact: true })],
        ["more", header.getByRole("button", { name: "More", exact: true })],
      ];
      for (const [name, locator] of buttons) {
        const area = await tapAreaOf(locator);
        lines.push(`${name} ${area.visual.map((v) => v.toFixed(1)).join("x")} tap ${area.tap.map((v) => v.toFixed(1)).join("x")}`);
        expect(area.visual[0], `${name} 視覺寬不變`).toBeLessThanOrEqual(32.5);
        expect(area.tap[0], `${name} 點擊寬`).toBeGreaterThanOrEqual(40 - TOL);
        expect(area.tap[1], `${name} 點擊高`).toBeGreaterThanOrEqual(44 - TOL);
      }
      console.log(`MEASURE 56-3 ${phone.width} ${lines.join(" | ")}`);
    } finally {
      await context.close();
    }
  });
}

test("56-4 選取模式 390 觸控：標題列的「Select all」「Done」點擊範圍 ≥ 44 高", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await openAs(browser, PHONES[0], true);
  try {
    await page.goto("/");
    const sidebar = page.getByRole("complementary");
    await expect(sidebar).toBeVisible({ timeout: 15_000 });
    await showSidebarTab(page, "My notes", sidebar);
    await sidebar.getByRole("button", { name: "Select", exact: true }).first().click();
    const lines: string[] = [];
    for (const name of ["Select all", "Done"]) {
      const area = await tapAreaOf(sidebar.getByRole("button", { name, exact: true }));
      lines.push(`${name} ${area.visual.map((v) => v.toFixed(1)).join("x")} tap ${area.tap.map((v) => v.toFixed(1)).join("x")}`);
      expect(area.visual[1], `${name} 視覺高不變`).toBeLessThanOrEqual(24.5);
      expect(area.tap[1], `${name} 點擊高`).toBeGreaterThanOrEqual(44 - TOL);
    }
    console.log(`MEASURE 56-4 ${lines.join(" | ")}`);
  } finally {
    await context.close();
  }
});

test("56-5 輸入框字級（觸控）：登入頁、清單、筆記頁、分享對話框、設定頁的每個輸入框都不小於 16px", async ({ browser }) => {
  test.setTimeout(180_000);
  // 登入頁（未登入）
  let login: { count: number; bad: string[] } = { count: 0, bad: [] };
  const anon = await browser.newContext({ hasTouch: true, isMobile: true, viewport: PHONES[0] });
  try {
    const page = await anon.newPage();
    await page.goto("/login");
    await expect(page.locator("#login-email")).toBeVisible({ timeout: 15_000 });
    login = await fieldFontSizes(page);
    expect(login.count, "登入頁輸入框數").toBeGreaterThanOrEqual(2);
    expect(login.bad, "登入頁").toEqual([]);
  } finally {
    await anon.close();
  }

  const { context, page } = await openAs(browser, PHONES[0], true);
  try {
    await page.goto("/");
    const sidebar = page.getByRole("complementary");
    await expect(sidebar).toBeVisible({ timeout: 15_000 });
    // 手機清單沒在搜尋時沒有搜尋框：先點 Search 開搜尋層。
    await sidebar.getByRole("button", { name: "Search notes", exact: true }).click();
    await expect(sidebar.getByRole("textbox", { name: "Search notes", exact: true })).toBeVisible();
    const list = await fieldFontSizes(page);
    expect(list.count, "清單輸入框數（搜尋框）").toBeGreaterThanOrEqual(1);
    expect(list.bad, "清單").toEqual([]);
    await sidebar.getByRole("button", { name: "Cancel", exact: true }).click();

    // 筆記頁：標題框與程式碼區塊語言下拉
    await openNote(page, sidebar, TITLES.code);
    const codeSelect = page.locator(".bn-editor .bn-block-content[data-content-type=codeBlock] select");
    await expect(codeSelect).toHaveCount(1, { timeout: 15_000 });
    expect(await codeSelect.evaluate((el) => getComputedStyle(el).fontSize), "程式碼區塊語言下拉").toBe("16px");
    const note = await fieldFontSizes(page);
    expect(note.count, "筆記頁輸入框數（標題框）").toBeGreaterThanOrEqual(1);
    expect(note.bad, "筆記頁").toEqual([]);

    // 分享對話框
    await page.locator("header").getByRole("button", { name: "Share", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    // 「Members only」才會出現新增分享表單，裡面有共用 Select 的角色觸發鈕。
    await dialog.getByRole("radio", { name: /^Members only/ }).click();
    await expect(dialog.getByRole("combobox", { name: "Role for new share", exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(dialog.locator("input, select, textarea").first()).toBeVisible({ timeout: 15_000 });
    const share = await fieldFontSizes(page);
    expect(share.count, "分享對話框輸入框數").toBeGreaterThanOrEqual(2);
    expect(share.bad, "分享對話框").toEqual([]);
    await page.keyboard.press("Escape");

    // 設定頁
    await page.goto("/settings/account");
    await expect(page.locator("input:visible, select:visible, textarea:visible").first()).toBeVisible({ timeout: 15_000 });
    const settings = await fieldFontSizes(page);
    expect(settings.count, "設定頁輸入框數").toBeGreaterThanOrEqual(1);
    expect(settings.bad, "設定頁").toEqual([]);
    console.log(`MEASURE 56-5 fields login ${login.count} list ${list.count} note ${note.count} share ${share.count} settings ${settings.count}`);
  } finally {
    await context.close();
  }
});

for (const width of [800, 1280] as const) {
  test(`56-6 搜尋框 ${width} 觸控：沒有 Ctrl K 提示；✕ 點擊範圍 44×44 且不搶文字區的點擊`, async ({ browser }) => {
    test.setTimeout(120_000);
    const { context, page } = await openAs(browser, { width, height: 900 }, true);
    try {
      await page.goto("/");
      const scope = await listScope(page, width);
      const search = scope.getByRole("textbox", { name: "Search notes", exact: true });
      await expect(search).toBeVisible({ timeout: 15_000 });
      await expect(scope.locator("kbd")).toHaveCount(1);
      await expect(scope.locator("kbd")).toBeHidden();
      expect(await search.evaluate((el) => getComputedStyle(el).fontSize), "搜尋框字級").toBe("16px");

      await search.fill("E2E touch");
      const clear = scope.getByRole("button", { name: "Clear search", exact: true });
      await expect(clear).toBeVisible();
      const area = await tapAreaOf(clear);
      expect(area.tap[0], "✕ 點擊寬").toBeGreaterThanOrEqual(44 - TOL);
      expect(area.tap[1], "✕ 點擊高").toBeGreaterThanOrEqual(44 - TOL);
      expect(area.visual[0], "✕ 視覺寬不變").toBeLessThanOrEqual(24.5);

      // 文字區右緣內 1px 點下去：命中輸入框本身，不是 ✕
      const probe = await search.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const x = box.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight) - 1;
        const y = box.top + box.height / 2;
        const hit = document.elementFromPoint(x, y);
        return { x, tag: hit?.tagName ?? null, label: hit?.closest("button")?.getAttribute("aria-label") ?? null };
      });
      expect(probe, `文字區右緣內 1px（x=${probe.x.toFixed(1)}）`).toMatchObject({ tag: "INPUT", label: null });
      console.log(`MEASURE 56-6 ${width} clear tap ${area.tap.map((v) => v.toFixed(1)).join("x")} probe ${probe.tag} x=${probe.x.toFixed(1)}`);
    } finally {
      await context.close();
    }
  });
}

for (const phone of [PHONES[0], { width: 1280, height: 900 }] as const) {
  test(`56-7 滑鼠 ${phone.width}：列 28、tab 36、選單項 32、列內鈕點擊範圍就是 24×24；1280 搜尋框 13px、Ctrl K 還在`, async ({ browser }) => {
    test.setTimeout(120_000);
    const { context, page } = await openAs(browser, phone, false);
    try {
      await page.goto("/");
      const scope = await listScope(page, phone.width);
      const tab = scope.getByRole("tablist", { name: "Sidebar sections" }).getByRole("tab").first();
      expect((await tab.boundingBox({ timeout: 10_000 }))!.height, "tab 高").toBeCloseTo(36, 0);
      await showSidebarTab(page, "My notes", scope);
      const row = rowOf(scope, TITLES.fav);
      await expect(row).toBeVisible({ timeout: 15_000 });
      expect((await noteLink(scope, TITLES.fav).boundingBox({ timeout: 10_000 }))!.height, "列高").toBeCloseTo(28, 0);
      const more = scope.getByRole("button", { name: `Note actions for ${TITLES.fav}`, exact: true });
      await row.hover();
      const area = await tapAreaOf(more);
      // 滑鼠下沒有擴張：24×24，取樣步進 0.5px 可能多算 0.5px，所以容許 24 到 25。
      for (const side of area.tap) {
        expect(side, "⋮ 點擊範圍").toBeGreaterThanOrEqual(24);
        expect(side, "⋮ 點擊範圍").toBeLessThanOrEqual(25);
      }

      if (phone.width >= 1280) {
        // 手機版面的搜尋框另有自己的樣式（16px、沒有 Ctrl K 提示），只有側欄裡的搜尋框量這兩項
        const search = scope.getByRole("textbox", { name: "Search notes", exact: true });
        expect(await search.evaluate((el) => getComputedStyle(el).fontSize), "搜尋框字級").toBe("13px");
        await expect(scope.locator("kbd")).toBeVisible();
      }

      await row.hover();
      await more.click();
      const items = await menuItemHeights(page);
      expect(items.length, "選單項數").toBeGreaterThanOrEqual(5);
      const rowHeight = phone.width < 640 ? 48 : 32;
      for (const item of items) expect(item.height, `選單「${item.name}」高`).toBeCloseTo(rowHeight, 0);
      console.log(`MEASURE 56-7 ${phone.width} tab 36 row 28 menu ${items.length} items tap ${area.tap.join("x")}`);
    } finally {
      await context.close();
    }
  });
}

/** 打開 TITLES.plain 的分享對話框，回傳「Role for new share」觸發鈕。 */
async function openShareRoleTrigger(page: Page): Promise<Locator> {
  await page.goto("/");
  const sidebar = await listScope(page, page.viewportSize()!.width);
  await openNote(page, sidebar, TITLES.plain);
  await page.locator("header").getByRole("button", { name: "Share", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole("radio", { name: /^Members only/ }).click();
  const trigger = dialog.getByRole("combobox", { name: "Role for new share", exact: true });
  await expect(trigger).toBeVisible({ timeout: 15_000 });
  return trigger;
}

test("56-8 共用 Select 390 觸控：分享對話框的角色觸發鈕字級 16px、不比同列輸入框矮，每個選項點擊範圍 ≥ 40 高", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await openAs(browser, PHONES[0], true);
  try {
    const trigger = await openShareRoleTrigger(page);
    expect(await trigger.evaluate((el) => getComputedStyle(el).fontSize), "觸發鈕字級").toBe("16px");
    const triggerArea = await tapAreaOf(trigger);
    // field 變體與同列輸入框同高（輸入框觸控下也是 32），不另外撐高；點擊面要等於輸入框，不能更矮。
    const emailArea = await tapAreaOf(page.getByRole("dialog").getByLabel("Email address", { exact: true }));
    expect(triggerArea.tap[1], "觸發鈕點擊高").toBeGreaterThanOrEqual(emailArea.tap[1] - TOL);
    await trigger.click();
    await expect(page.getByRole("listbox")).toBeVisible();
    const options = page.getByRole("option");
    const count = await options.count();
    expect(count, "選項數").toBeGreaterThanOrEqual(2);
    for (let i = 0; i < count; i++) {
      const option = options.nth(i);
      const area = await tapAreaOf(option);
      expect(area.tap[1], `選項「${await option.innerText()}」點擊高`).toBeGreaterThanOrEqual(40 - TOL);
    }
    console.log(`MEASURE 56-8 390 trigger tap ${triggerArea.tap.join("x")} options ${count}`);
  } finally {
    await context.close();
  }
});

test("56-8 共用 Select 1280 滑鼠：觸發鈕視覺高 32、選項高是桌面值 32", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await openAs(browser, { width: 1280, height: 900 }, false);
  try {
    const trigger = await openShareRoleTrigger(page);
    const triggerArea = await tapAreaOf(trigger);
    expect(triggerArea.visual[1], "觸發鈕視覺高").toBeCloseTo(32, 0);
    await trigger.click();
    await expect(page.getByRole("listbox")).toBeVisible();
    const options = page.getByRole("option");
    const count = await options.count();
    expect(count, "選項數").toBeGreaterThanOrEqual(2);
    for (let i = 0; i < count; i++) {
      const box = (await options.nth(i).boundingBox())!;
      expect(box.height, `選項 ${i} 高`).toBeCloseTo(32, 0);
    }
  } finally {
    await context.close();
  }
});
