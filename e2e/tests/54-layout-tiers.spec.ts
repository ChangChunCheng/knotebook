import { test, expect, type Locator, type Page } from "@playwright/test";
import { ADMIN, createNote, editorLocator, loginAs, waitForEditorSelection } from "./helpers.js";

/**
 * The three layout tiers of the sidebar and version panel (real-browser measurement):
 * - Viewport >= 1280: the sidebar is fixed on the left and the version panel is the third column to the right of the note (`position: relative`).
 * - Viewport 640-1279: no fixed sidebar; the header's sidebar button (Open sidebar) opens a drawer; the version panel floats over the note (`position: absolute`), its top edge at the header's bottom edge,
 *   and the header's share and kebab are not covered; the drawer width follows sidebar.width, leaving at least 4rem.
 * - Viewport < 640: version history opens as a full page from the kebab.
 * One measurement on each side of the boundaries (1279/1280, 639/640); the floating panel's collapse rules: with only the list open, clicking the note collapses it; clicking the note during a diff view does not; Esc inside the panel collapses it.
 * Finer header and width measurements are in 52-header-policy.
 *
 * Cases are numbered L1-L9 in their titles. L2: the drawer width follows sidebar.width, 400 at both 768 and 640 (the viewport-width-minus-4rem cap is not reached from 640 up, it is only a safeguard).
 */

const RUN = Date.now();
const SIDEBAR_KEY = "sidebar.width";

const headerOf = (page: Page): Locator => page.locator("header").filter({ has: page.getByRole("button", { name: "More", exact: true }) }).first();
const panelOf = (page: Page): Locator => page.getByTestId("versions-panel");
const drawerOf = (page: Page): Locator => page.getByRole("dialog", { name: "Navigation" });
const openSidebar = (page: Page): Locator => page.getByRole("button", { name: "Open sidebar" });
/** Fixed sidebar: the complementary containing the "New note" button (the version panel is also an aside, so counting complementary alone is not enough). */
const dockedSidebarOf = (page: Page): Locator => page.getByRole("complementary").filter({ has: page.getByRole("button", { name: "New note", exact: true }) });

async function setViewport(page: Page, width: number, height = 900): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))));
}

async function waitForNoteTitle(page: Page, title: string): Promise<void> {
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue(title, { timeout: 15_000 });
}

async function typeAtEnd(page: Page, text: string): Promise<void> {
  const editor = editorLocator(page);
  await editor.click();
  await page.keyboard.press("Control+End");
  await waitForEditorSelection(page);
  await page.keyboard.press("Enter");
  await page.keyboard.type(text);
}

async function saveVersion(page: Page, name: string): Promise<void> {
  await page.keyboard.press("Control+s");
  const dialog = page.getByRole("dialog", { name: "Save current version" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Version name (optional)").fill(name);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

/** Clicks the note body (the text itself: the editor's top-left is often covered by a block's drag handle). */
const clickNoteText = (page: Page): Promise<void> => editorLocator(page).getByText("paragraph 2", { exact: true }).click();

const positionOf = (el: Locator): Promise<string> => el.evaluate((node) => getComputedStyle(node).position);

async function openPanel(page: Page): Promise<Locator> {
  await page.getByTestId("versions-bubble").click();
  const panel = panelOf(page);
  await expect(panel).toBeVisible();
  return panel;
}

/** With the floating panel open: its top edge sits at the header's bottom edge (frame lines overlap within 1 px) and the right edges of the header's share and kebab are not covered by the panel. */
async function expectPanelBelowHeader(page: Page, tag: string): Promise<void> {
  const header = headerOf(page);
  const headerBox = (await header.boundingBox())!;
  const panelBox = (await panelOf(page).boundingBox())!;
  const detail = JSON.stringify({ tag, headerBottom: headerBox.y + headerBox.height, panelTop: panelBox.y });
  expect(panelBox.y, `面板上緣應在頁首下緣之下 ${detail}`).toBeGreaterThanOrEqual(headerBox.y + headerBox.height - 1);
  for (const name of ["Share", "More"]) {
    const box = (await header.getByRole("button", { name, exact: true }).boundingBox())!;
    expect(box.y + box.height, `${name} 不該在面板底下 ${detail}`).toBeLessThanOrEqual(panelBox.y + 1);
  }
}

let page: Page;
let noteUrl: string;
let otherTitle: string;
let title: string;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await context.newPage();
  await loginAs(page, ADMIN.email, ADMIN.password);
  otherTitle = `E2E tiers other ${RUN}`;
  await createNote(page, otherTitle);
  title = `E2E tiers ${RUN}`;
  await createNote(page, title);
  noteUrl = page.url();
  // A dozen versions: the list must be long enough to scroll (the scroll position must be kept across 1280).
  for (let i = 1; i <= 14; i += 1) {
    await typeAtEnd(page, `paragraph ${i}`);
    await saveVersion(page, `v-${String(i).padStart(2, "0")}`);
  }
  await typeAtEnd(page, "unsaved tail");
  // While the "Saved as ..." toast is open, Esc closes the toast first; wait for it to go away so later Esc presses land on the drawer and panel.
  await expect(page.getByText(/^Saved as /)).toHaveCount(0, { timeout: 20_000 });
});

test.afterAll(async () => {
  await page.context().close();
});

test.beforeEach(async () => {
  await page.evaluate((k) => window.localStorage.removeItem(k), SIDEBAR_KEY);
  await setViewport(page, 1440);
});

test("L1 768 and 1024: no fixed sidebar; the sidebar button opens the drawer, and clicking the backdrop, Esc and choosing a note all close it with focus back on the sidebar button", async () => {
  test.setTimeout(120_000);
  for (const vw of [768, 1024]) {
    await setViewport(page, vw);
    await expect(dockedSidebarOf(page), `${vw}：固定側欄不顯示`).toHaveCount(0);
    const opener = openSidebar(page);
    await expect(opener).toBeVisible();

    await opener.click();
    await expect(drawerOf(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawerOf(page)).toBeHidden();
    await expect(opener, `${vw}：Esc 關閉後焦點回側欄鈕`).toBeFocused();

    await opener.click();
    await expect(drawerOf(page)).toBeVisible();
    await page.mouse.click(vw - 10, 450); // the backdrop showing to the right of the drawer
    await expect(drawerOf(page)).toBeHidden();
    await expect(opener, `${vw}：點遮罩關閉後焦點回側欄鈕`).toBeFocused();

    await opener.click();
    await drawerOf(page).getByRole("link", { name: otherTitle }).first().click();
    await expect(drawerOf(page)).toBeHidden();
    await waitForNoteTitle(page, otherTitle);
    await page.goto(noteUrl);
    await waitForNoteTitle(page, title);
  }
});

test("L2 drawer width follows sidebar.width: 768 and 640 (the narrowest drawer) are both 400", async () => {
  test.setTimeout(90_000);
  await page.evaluate((k) => window.localStorage.setItem(k, "400"), SIDEBAR_KEY);
  await page.reload();
  await waitForNoteTitle(page, title);
  await setViewport(page, 768);
  await openSidebar(page).click();
  const wide = (await drawerOf(page).boundingBox())!;
  expect(Math.abs(wide.width - 400), `768 寬的抽屜寬 ${wide.width}`).toBeLessThanOrEqual(1);
  await page.keyboard.press("Escape");
  await expect(drawerOf(page)).toBeHidden();

  await setViewport(page, 640, 844);
  await openSidebar(page).click();
  const narrow = (await drawerOf(page).boundingBox())!;
  expect(Math.abs(narrow.width - 400), `640 寬的抽屜寬 ${narrow.width}`).toBeLessThanOrEqual(1);
  await page.keyboard.press("Escape");
  await expect(drawerOf(page)).toBeHidden();
  // Restore: the in-memory sidebar width only returns to the localStorage default after a reload, so later cases must not run with 400.
  await page.evaluate((k) => window.localStorage.removeItem(k), SIDEBAR_KEY);
  await page.reload();
  await waitForNoteTitle(page, title);
});

test("L3 version panel at 768 and 1024: below the header; with only the list open clicking the note collapses it; clicking the note during a diff view does not; Esc inside the panel collapses it", async () => {
  test.setTimeout(120_000);
  for (const vw of [768, 1024]) {
    await setViewport(page, vw);
    const panel = await openPanel(page);
    await expectPanelBelowHeader(page, `L3 ${vw}`);

    await clickNoteText(page);
    await expect(panel, `${vw}：只開清單時點筆記要收起`).toBeHidden();

    await openPanel(page);
    await panel.getByRole("button", { name: /^v-03 \(/ }).click();
    await expect(page.getByTestId("preview-banner")).toBeVisible();
    await page.getByTestId("preview-slot").getByText("paragraph 2").first().click();
    await expect(panel, `${vw}：差異檢視中點筆記不收`).toBeVisible();

    await panel.getByRole("button", { name: /^v-03 \(/ }).focus();
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(page.getByTestId("preview-banner")).toBeHidden();
    await expect(page.getByTestId("versions-bubble")).toBeFocused();
  }
});

test("L4 1279 floating, 1280 fixed: one measurement of the sidebar's and version panel's form on each side", async () => {
  test.setTimeout(90_000);
  await setViewport(page, 1279);
  await expect(dockedSidebarOf(page)).toHaveCount(0);
  await expect(openSidebar(page)).toBeVisible();
  const floating = await openPanel(page);
  expect(await positionOf(floating), "1279：面板浮在筆記上").toBe("absolute");
  await page.getByRole("button", { name: "Close version history", exact: true }).click();
  await expect(floating).toBeHidden();

  await setViewport(page, 1280);
  await expect(dockedSidebarOf(page)).toBeVisible();
  await expect(openSidebar(page)).toBeHidden();
  const docked = await openPanel(page);
  expect(await positionOf(docked), "1280：面板是第三欄").toBe("relative");
  const headerBox = (await headerOf(page).boundingBox())!;
  for (const name of ["Share", "More"]) {
    const box = (await headerOf(page).getByRole("button", { name, exact: true }).boundingBox())!;
    expect(box.x + box.width, `1280：${name} 超出頁首`).toBeLessThanOrEqual(headerBox.x + headerBox.width + 0.5);
  }
  await page.getByRole("button", { name: "Close version history", exact: true }).click();
});

test("L5 640: the history bubble opens the floating panel (the kebab has no Version history); 639 opens a full page from the kebab", async () => {
  test.setTimeout(90_000);
  await setViewport(page, 640);
  await page.getByRole("button", { name: "More", exact: true }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Width", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Version history" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  const floating = await openPanel(page);
  expect(await positionOf(floating)).toBe("absolute");
  await expectPanelBelowHeader(page, "L5 640");

  await setViewport(page, 639, 800);
  await expect(page.getByTestId("versions-panel")).toHaveCount(0);
  await expect(page.getByTestId("versions-bubble")).toHaveCount(0);
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Version history" }).click();
  const sheet = page.getByRole("dialog", { name: "Version history" });
  await expect(sheet).toBeVisible();
  const box = (await sheet.boundingBox())!;
  expect(box.width, `639 寬整頁 ${box.width}`).toBeGreaterThanOrEqual(639 - 1);
  expect(box.height, `整頁高 ${box.height}`).toBeGreaterThanOrEqual(800 - 1);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
});

test("L6 1024 with the panel open widened to 1400: the panel stays and the list's scroll position is unchanged", async () => {
  test.setTimeout(90_000);
  await setViewport(page, 1024, 600);
  const panel = await openPanel(page);
  const list = panel.locator("ul").first();
  await list.evaluate((el) => {
    el.scrollTop = 150; // below the maximum scroll of both layouts, so it isn't clamped and mistaken for a position change
  });
  const before = await list.evaluate((el) => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }));
  expect(before.max, "清單要夠長才捲得動").toBeGreaterThan(200);
  expect(before.top).toBe(150);
  await setViewport(page, 1400, 600);
  await expect(panelOf(page)).toBeVisible();
  expect(await positionOf(panelOf(page)), "1400 面板是第三欄").toBe("relative");
  const after = await panelOf(page).locator("ul").first().evaluate((el) => el.scrollTop);
  expect(Math.abs(after - before.top), `捲動位置 ${before.top} → ${after}`).toBeLessThanOrEqual(2);
  await page.getByRole("button", { name: "Close version history", exact: true }).click();
});

test("L7 during preview space on the right is left for the panel width: the 1024 preview area's right edge doesn't pass the panel; at 1270 it is wide enough for side by side and the right column isn't covered either", async () => {
  test.setTimeout(90_000);
  for (const vw of [1024, 1270]) {
    await setViewport(page, vw, 900);
    const panel = await openPanel(page);
    await panel.getByRole("button", { name: /^v-05 \(/ }).click();
    await expect(page.getByTestId("preview-banner")).toBeVisible();
    const panelBox = (await panel.boundingBox())!;
    const slotBox = (await page.getByTestId("preview-slot").boundingBox())!;
    expect(slotBox.x + slotBox.width, `${vw}：預覽區右緣 ${slotBox.x + slotBox.width} 應 ≤ 面板左緣 ${panelBox.x} + 1`).toBeLessThanOrEqual(panelBox.x + 1);
    if (vw === 1270) {
      const split = page.getByTestId("diff-split");
      await expect(split, "1270 的預覽區夠寬，預設並排").toBeVisible();
      const splitBox = (await split.boundingBox())!;
      expect(splitBox.x + splitBox.width, `並排右緣 ${splitBox.x + splitBox.width} 應 ≤ 面板左緣 ${panelBox.x} + 1`).toBeLessThanOrEqual(panelBox.x + 1);
    }
    await page.getByRole("button", { name: "Close version history", exact: true }).click();
    await expect(panel).toBeHidden();
  }
});

test("L8 the error frame when the panel fails to load: the retry button isn't blocked and can be pressed", async () => {
  test.setTimeout(90_000);
  await setViewport(page, 1024, 900);
  await page.route(/\/assets\/VersionsLazy-[^/]*\.js/, (route) => route.abort());
  try {
    await page.reload();
    await waitForNoteTitle(page, title);
    // The first failed load triggers one automatic reload (a sessionStorage flag prevents a loop, and after the reload the panel is closed); hold the request so the second open stops at "Try again".
    const retry = page.getByRole("button", { name: "Try again" });
    await expect(async () => {
      await waitForNoteTitle(page, title);
      if ((await retry.count()) === 0) await page.getByTestId("versions-bubble").click({ timeout: 3_000 });
      await expect(retry).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 30_000 });
    await retry.click({ trial: true });
  } finally {
    await page.unroute(/\/assets\/VersionsLazy-[^/]*\.js/);
    await page.evaluate(() => window.sessionStorage.removeItem("knotebook:chunk-reload:versions"));
  }
  await page.reload();
  await waitForNoteTitle(page, title);
});

test("L9 with the panel open, Ctrl+K opens the drawer and clicking the backdrop closes only the drawer, leaving the panel in place", async () => {
  test.setTimeout(90_000);
  await setViewport(page, 1024, 900);
  const panel = await openPanel(page);
  await page.keyboard.press("Control+k");
  await expect(drawerOf(page)).toBeVisible();
  await page.mouse.click(1024 - 10, 450);
  await expect(drawerOf(page)).toBeHidden();
  await expect(panel).toBeVisible();
  await page.getByRole("button", { name: "Close version history", exact: true }).click();
});
