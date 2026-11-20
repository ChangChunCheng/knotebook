import { expect, test } from "@playwright/test";
import { ADMIN, createNote, loginAs, openListOnCompact, reEscape, showSidebarTab } from "./helpers.js";

/** This file does not assert that the query string is kept after clicking a search result (AppShell remounts, and the query is dropped anyway), so the search part always runs on a note page. */
const RUN = Date.now();

test("sidebar tabs: roles, persistence, keyboard, search view, phone list and narrow drawer", async ({ page }) => {
  const title = `E2E Tabs ${RUN}`;
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);
  // A long title with no spaces (without RUN, so searching RUN does not return an extra hit): the 390-wide drawer's list must not overflow horizontally.
  const longTitle = `E2E${Math.random().toString(36).replace(/[0-9]/g, "").slice(0, 6)}${"x".repeat(120)}`;
  await createNote(page, longTitle);
  await createNote(page, title);
  const noteUrl = page.url();

  const sidebar = page.getByRole("complementary");
  const tablist = sidebar.getByRole("tablist", { name: "Sidebar sections" });
  const tabs = tablist.getByRole("tab");
  await expect(tabs).toHaveCount(6);
  const names = ["Recent", "Favorites", "My notes", "Groups", "Shared with me", "Trash"];
  for (const [i, name] of names.entries()) await expect(tabs.nth(i)).toHaveAttribute("aria-label", name);
  await expect(tablist.getByRole("tab", { name: "My notes", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(sidebar.getByRole("tabpanel").getByRole("link", { name: new RegExp("^" + reEscape(title)) })).toBeVisible();

  await showSidebarTab(page, "Groups");
  await page.reload();
  // Wait for the lazy NotePage to mount: the fallback's own AppShell is replaced (drawerOpen resets with it; since #369 the query lives at the App level and is not reset).
  await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible();
  await expect(tablist.getByRole("tab", { name: "Groups", exact: true })).toHaveAttribute("aria-selected", "true");

  const workspaceTab = tablist.getByRole("tab", { name: "Groups", exact: true });
  const sharedTab = tablist.getByRole("tab", { name: "Shared with me", exact: true });
  const recentTab = tablist.getByRole("tab", { name: "Recent", exact: true });
  const favoritesTab = tablist.getByRole("tab", { name: "Favorites", exact: true });
  const trashTab = tablist.getByRole("tab", { name: "Trash", exact: true });
  await workspaceTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(sharedTab).toHaveAttribute("aria-selected", "true");
  await expect(sharedTab).toBeFocused();
  await page.keyboard.press("Home");
  await expect(recentTab).toHaveAttribute("aria-selected", "true");
  await expect(recentTab).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(trashTab).toHaveAttribute("aria-selected", "true");
  await expect(trashTab).toBeFocused();
  await page.keyboard.press("Home");
  await expect(recentTab).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(favoritesTab).toHaveAttribute("aria-selected", "true");
  await expect(favoritesTab).toBeFocused();
  await page.keyboard.press("End");
  await expect(trashTab).toHaveAttribute("aria-selected", "true");
  await expect(trashTab).toBeFocused();
  await showSidebarTab(page, "Groups");

  const search = sidebar.getByRole("textbox", { name: "Search notes" });
  await search.fill(String(RUN));
  await expect(tablist).toHaveCount(0);
  // Scoped to the sidebar: the note page's ConnectionBadge is also role="status".
  await expect(sidebar.getByRole("status")).toHaveText(/^1 (title match|result)$/);
  const hit = sidebar.getByRole("link", { name: new RegExp("^" + reEscape(title)) });
  await expect(hit).toHaveCount(1);
  await expect(hit).toContainText("My notes");
  await expect(hit.locator("mark")).toHaveText(String(RUN));
  await search.press("Escape");
  await expect(tablist).toBeVisible();
  await expect(workspaceTab).toHaveAttribute("aria-selected", "true");
  await search.fill(String(RUN));
  await expect(tablist).toHaveCount(0);
  await sidebar.getByRole("button", { name: "Clear search" }).click();
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  await expect(tablist).toBeVisible();
  await search.fill(`zz-no-match-${RUN}`);
  await expect(sidebar.getByText("No notes match your search.", { exact: true })).toBeVisible();
  await search.fill("");
  await expect(tablist).toBeVisible();

  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(noteUrl);
    // Wait for the lazy NotePage to mount before touching the sidebar (the fallback and the real page share one sidebar, but the title input appearing means loading is done).
    await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open sidebar" })).toHaveCount(0);
    const list = await openListOnCompact(page);
    const phoneTabs = list.getByRole("tablist", { name: "Sidebar sections" }).getByRole("tab");
    await expect(phoneTabs).toHaveCount(6);
    // Consistent with the desktop sidebar: Groups is still selected (the tab is kept in localStorage, the same sidebar)
    // The first round keeps the Groups chosen above; at the end of the round it switches to My notes, so the second round starts from My notes.
    await expect(list.getByRole("tab", { name: width === 390 ? "Groups" : "My notes", exact: true })).toHaveAttribute("aria-selected", "true");
    const tablistBox = (await list.getByRole("tablist", { name: "Sidebar sections" }).boundingBox())!;
    for (let i = 0; i < 6; i++) {
      const box = await phoneTabs.nth(i).boundingBox();
      expect(box, `${width} 寬第 ${i} 顆 tab`).not.toBeNull();
      // This is a mouse context (fine pointer): the tab at narrow viewports is as tall as on desktop, 36; the touch device's 44 is measured in the touch context's size tests.
      expect(box!.height).toBeGreaterThanOrEqual(35.5);
      expect(box!.height).toBeLessThanOrEqual(36.5);
      expect(box!.x, `${width} 寬第 ${i} 顆 tab 的左緣`).toBeGreaterThanOrEqual(tablistBox.x - 0.5);
      expect(box!.x + box!.width, `${width} 寬第 ${i} 顆 tab 的右緣`).toBeLessThanOrEqual(tablistBox.x + tablistBox.width + 0.5);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const phonePanel = await showSidebarTab(page, "My notes", list);
    await expect(list.getByRole("tab", { name: "My notes", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(phonePanel.getByRole("link", { name: new RegExp("^" + reEscape(title)) })).toBeVisible();
    await expect(phonePanel.getByRole("link", { name: new RegExp("^" + reEscape(longTitle)) })).toBeVisible();
    // The list's inner wrapper is `overflow-x-clip` (a safety net), so the list itself never overflows; measure the wrapper's (`[data-sidebar-list] > div`) content width instead.
    const wrapper = phonePanel.locator("[data-sidebar-list] > div");
    expect(await wrapper.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect(page).toHaveURL(/\/$/);
  }

  // 700-wide drawer: the six tabs are 36 high with a fine pointer (the 44 touch height is measured in the touch-context tests), no horizontal scroll, Esc closes
  await page.setViewportSize({ width: 700, height: 844 });
  await page.goto(noteUrl);
  await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible();
  await page.getByRole("button", { name: "Open sidebar" }).click();
  const drawer = page.getByRole("dialog", { name: "Navigation" });
  await expect(drawer).toBeVisible();
  const drawerTabs = drawer.getByRole("tablist", { name: "Sidebar sections" }).getByRole("tab");
  await expect(drawerTabs).toHaveCount(6);
  await expect(drawer.getByRole("tab", { name: "My notes", exact: true })).toHaveAttribute("aria-selected", "true");
  for (let i = 0; i < 6; i++) {
    const box = await drawerTabs.nth(i).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(35.5);
    expect(box!.height).toBeLessThanOrEqual(36.5);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(700);
  const drawerPanel = await showSidebarTab(page, "My notes", drawer);
  const list = drawerPanel.locator("[data-sidebar-list] > div");
  expect(await list.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(drawer).not.toBeVisible();

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole("complementary").getByRole("tab", { name: "My notes", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});
