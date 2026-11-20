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
 * Tap areas and input font sizes on touch devices (`pointer: coarse`); the mouse (`pointer: fine`) stays as before.
 *
 * 56-5: the search box and the code block language dropdown measure exactly 16px; the 1280 sidebar search box is 13px and keeps its Ctrl K hint.
 * 56-6: a press 1px inside the right edge of the input's text area still hits the input, not the clear button.
 * 56-7: the 390 kebab is a bottom sheet regardless of pointer type, so its items are 48 high; at 1280 menu items are 32.
 *
 * Out of scope (reason):
 * - Mantine/BlockNote built-in inputs and dropdowns (e.g. the link toolbar's URL box): the font size is decided by that package's styles, not our classes.
 * - Whether the avatar list's "+N" badge and the kebab overlap when several people are online on one note: it needs a real setup with several users connected at once.
 * - Where a real finger lands and iOS focus zoom: desktop Chromium can't verify them; only CSS and tap areas are measured, so they need a real device.
 *
 * The account and data are created once (alice) through the API in a wide viewport; each case then opens a new context to operate.
 */

const RUN = Date.now();
const PASSWORD = "e2e-touch-targets-pw";
const PHONES = [
  { width: 390, height: 844 },
  { width: 360, height: 780 },
] as const;
/** `tapAreaOf` samples every 0.5px and can under-count each side by up to 0.5px (1px in total), so 44 measured as 43.5 and 40 as 39.5 still count as enough; the tolerance is 1. */
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

/** The list scope holding the search box: from 1280 up it is the fixed sidebar, otherwise `openListOnCompact` (the phone's list, the drawer at 640-1279). */
async function listScope(page: Page, width: number): Promise<Locator> {
  if (width >= 1280) {
    // While searching the tab bar is replaced by results, so don't filter on the tab bar; the fixed sidebar is the first complementary on the page.
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

/** Among the visible input/select/textarea/Select trigger buttons, those with a font size under 16px (third-party components excluded; iOS zooms on focus only below 16px). Returns "how many in total, which are too small". */
async function fieldFontSizes(page: Page): Promise<{ count: number; bad: string[] }> {
  return page.evaluate(() => {
    const bad: string[] = [];
    let count = 0;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("input, select, textarea, [role=combobox]:not(input)"))) {
      // Radix Select renders an aria-hidden native select inside a form for form sync; it is not a field the user sees.
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
  test(`56-1 list ${phone.width} touch: tabs and rows 44 high, row button tap areas >= 44x44 with adjacent centers >= 44 apart`, async ({ browser }) => {
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
          // Touch: a favorite is a marker that can't be clicked (not a button, no tap area), one slot left of the kebab; the kebab is always the rightmost slot.
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

      // Press 8px outside the visual box: it still hits that button (measured only up and down; left and right may be the adjacent button).
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

  test(`56-2 menus ${phone.width} touch: every item of the kebab menu and the user menu >= 40 high; swatch tap area 44x44`, async ({ browser }) => {
    test.setTimeout(120_000);
    const { context, page } = await openAs(browser, phone, true);
    try {
      await page.goto("/");
      const sidebar = page.getByRole("complementary");
      await expect(sidebar).toBeVisible({ timeout: 15_000 });
      await showSidebarTab(page, "My notes", sidebar);

      await sidebar.getByRole("button", { name: `Note actions for ${TITLES.plain}`, exact: true }).click();
      await expect(page.getByRole("menu")).toBeVisible();
      const noteItems = await menuItemHeights(page);
      expect(noteItems.length, "筆記 ⋮ 選單項數").toBeGreaterThanOrEqual(5);
      for (const item of noteItems) expect(item.height, `⋮ 選單「${item.name}」高`).toBeGreaterThanOrEqual(40 - TOL);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);

      await page.locator("[data-phone-top-bar]").getByRole("button", { name: alice.displayName, exact: true }).click();
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      // On a phone the menu is a sheet rising from the bottom: measure after the entry animation (the part still off screen can't be hit by elementFromPoint).
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

  test(`56-3 note page header ${phone.width} touch: tap areas of the back chevron, star, share and kebab >= 40x44`, async ({ browser }) => {
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

test("56-4 select mode 390 touch: the header's \"Select all\" and \"Done\" have a tap area >= 44 high", async ({ browser }) => {
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

test("56-5 input font size (touch): every input on the login page, list, note page, share dialog and settings page is at least 16px", async ({ browser }) => {
  test.setTimeout(180_000);
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
    await sidebar.getByRole("button", { name: "Search notes", exact: true }).click();
    await expect(sidebar.getByRole("textbox", { name: "Search notes", exact: true })).toBeVisible();
    const list = await fieldFontSizes(page);
    expect(list.count, "清單輸入框數（搜尋框）").toBeGreaterThanOrEqual(1);
    expect(list.bad, "清單").toEqual([]);
    await sidebar.getByRole("button", { name: "Cancel", exact: true }).click();

    await openNote(page, sidebar, TITLES.code);
    const codeSelect = page.locator(".bn-editor .bn-block-content[data-content-type=codeBlock] select");
    await expect(codeSelect).toHaveCount(1, { timeout: 15_000 });
    expect(await codeSelect.evaluate((el) => getComputedStyle(el).fontSize), "程式碼區塊語言下拉").toBe("16px");
    const note = await fieldFontSizes(page);
    expect(note.count, "筆記頁輸入框數（標題框）").toBeGreaterThanOrEqual(1);
    expect(note.bad, "筆記頁").toEqual([]);

    await page.locator("header").getByRole("button", { name: "Share", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    // The add-share form only appears under "Members only", and it contains the shared Select's role trigger button.
    await dialog.getByRole("radio", { name: /^Members only/ }).click();
    await expect(dialog.getByRole("combobox", { name: "Role for new share", exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(dialog.locator("input, select, textarea").first()).toBeVisible({ timeout: 15_000 });
    const share = await fieldFontSizes(page);
    expect(share.count, "分享對話框輸入框數").toBeGreaterThanOrEqual(2);
    expect(share.bad, "分享對話框").toEqual([]);
    await page.keyboard.press("Escape");

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
  test(`56-6 search box ${width} touch: no Ctrl K hint; the clear button's tap area is 44x44 and doesn't steal presses on the text area`, async ({ browser }) => {
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

      // Press 1px inside the right edge of the text area: it hits the input itself, not the clear button.
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
  test(`56-7 mouse ${phone.width}: row 28, tab 36, menu item 32 (48 in the 390 bottom sheet), row button tap area is just 24x24; at 1280 the search box is 13px and Ctrl K is still there`, async ({ browser }) => {
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
      // No enlargement under a mouse: 24x24; sampling at 0.5px steps may over-count by 0.5px, so 24 to 25 is allowed.
      for (const side of area.tap) {
        expect(side, "⋮ 點擊範圍").toBeGreaterThanOrEqual(24);
        expect(side, "⋮ 點擊範圍").toBeLessThanOrEqual(25);
      }

      if (phone.width >= 1280) {
        // The phone layout's search box has its own style (16px, no Ctrl K hint), so only the search box in the sidebar is measured for these two.
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

/** Opens TITLES.plain's share dialog and returns the "Role for new share" trigger button. */
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

test("56-8 shared Select 390 touch: the share dialog's role trigger has font size 16px, is no shorter than the input in its row, and every option has a tap area >= 40 high", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await openAs(browser, PHONES[0], true);
  try {
    const trigger = await openShareRoleTrigger(page);
    expect(await trigger.evaluate((el) => getComputedStyle(el).fontSize), "觸發鈕字級").toBe("16px");
    const triggerArea = await tapAreaOf(trigger);
    // The field variant has the same height as the input in the row (inputs are also 32 under touch) and is not made taller; its tap surface must equal the input's, not be shorter.
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

test("56-8 shared Select 1280 mouse: the trigger's visual height is 32 and the options have the desktop height 32", async ({ browser }) => {
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
