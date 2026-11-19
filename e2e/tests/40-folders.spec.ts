import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  ADMIN,
  createFolder,
  createUserViaInvite,
  folderMenuButton,
  folderMenuItem,
  folderRow,
  loginAs,
  openGroupPanel,
  openListOnCompact,
  randomEmail,
  reEscape,
  showSidebarTab,
  submitFolderName,
  toastWithTitle,
} from "./helpers.js";

/**
 * Folders e2e.
 * Each test creates its own user with `createUserViaInvite` and logs in as it: folders sort before root notes and are expanded by
 * default, so staying on the shared ADMIN account would change other specs' visible rows. ADMIN is used only to send
 * invitations. After a full page load of a note page, wait for "Note title" before touching the sidebar (the lazy NotePage's
 * fallback swaps the shell); wait for the positive anchor before negative assertions; toast assertions anchor the whole text.
 */

const RUN = Date.now();
const PASSWORD = "e2e-folders-pw";

async function asNewUser(page: Page, displayName: string): Promise<string> {
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);
  const email = randomEmail();
  await createUserViaInvite(page, { email, password: PASSWORD, displayName });
  await page.context().clearCookies();
  await loginAs(page, email, PASSWORD);
  await expect(page).toHaveURL(/\/$/);
  return email;
}

/**
 * A note created from a folder's "+" or more menu "New note": wait for the first URL jump (untitled) and the new note's title
 * input (Untitled) -> rename -> wait for the second jump. Group notes use `/g/`, personal notes `/n/`.
 */
async function titleNewNote(page: Page, title: string, kind: "n" | "g"): Promise<void> {
  const first = kind === "n" ? /\/n\/[^/]+\/untitled-[0-9a-f]{8}$/ : /\/g\/[0-9a-f-]{36}\/untitled-[0-9a-f]{8}$/;
  await page.waitForURL(first, { timeout: 15_000 });
  const titleInput = page.getByLabel("Note title");
  await expect(titleInput).toHaveValue("Untitled", { timeout: 15_000 });
  await titleInput.fill(title);
  await titleInput.blur();
  await page.waitForURL((url) => !/\/untitled-[0-9a-f]{8}$/.test(url.pathname), { timeout: 15_000 });
}

function noteLink(scope: Locator, title: string): Locator {
  return scope.getByRole("link", { name: new RegExp("^" + reEscape(title)) });
}

test("40-1 personal folder full flow: create a folder and subfolder, create a note in the subfolder, path line, rename (focus returns to the more menu), name clash, delete and restore", async ({ page }) => {
  test.setTimeout(180_000);
  const F = `F ${RUN}`;
  const S = `S ${RUN}`;
  const T = `T ${RUN}`;
  const title = `E2E Fold N ${RUN}`;
  await asNewUser(page, "E2E Folders One");
  const sidebar = page.getByRole("complementary");
  let panel = await showSidebarTab(page, "My notes");

  await createFolder(page, panel.getByRole("button", { name: "New folder", exact: true }), F);
  await folderMenuItem(page, panel, F, "New subfolder");
  await submitFolderName(page, "New folder", S);
  await expect(folderRow(folderRow(panel, F), S)).toBeVisible();

  await folderMenuItem(page, panel, S, "New note");
  await titleNewNote(page, title, "n");
  panel = await showSidebarTab(page, "My notes");
  await expect(noteLink(folderRow(panel, S), title)).toBeVisible({ timeout: 15_000 });

  const search = sidebar.getByRole("textbox", { name: "Search notes" });
  await search.fill(title);
  const result = sidebar.getByTestId("sidebar-search").getByRole("link", { name: new RegExp("^" + reEscape(title)) });
  await expect(result).toContainText(`My notes › ${F} › ${S}`);
  await search.fill("");
  panel = await showSidebarTab(page, "My notes");

  // Rename: Esc to cancel first -> focus returns to S's more menu (long-term guard) -> then rename to T
  await folderMenuItem(page, panel, S, "Rename");
  const renameDialog = page.getByRole("dialog", { name: "Rename folder", exact: true });
  const renameInput = renameDialog.getByRole("textbox", { name: "Folder name", exact: true });
  await expect(renameInput).toBeFocused({ timeout: 15_000 });
  await expect(renameInput).toHaveValue(S);
  await page.keyboard.press("Escape");
  await expect(renameDialog).not.toBeVisible();
  await expect(folderMenuButton(panel, S)).toBeFocused();
  await folderMenuItem(page, panel, S, "Rename");
  await submitFolderName(page, "Rename folder", T);
  await expect(folderMenuButton(panel, T)).toBeFocused();
  await expect(noteLink(folderRow(panel, T), title)).toBeVisible();

  await folderMenuItem(page, panel, F, "New subfolder");
  const createDialog = page.getByRole("dialog", { name: "New folder", exact: true });
  const createInput = createDialog.getByRole("textbox", { name: "Folder name", exact: true });
  await expect(createInput).toBeFocused({ timeout: 15_000 });
  await createInput.fill(`t ${RUN}`);
  await createDialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(createDialog.getByRole("alert")).toHaveText("There's already a folder with this name here.");
  await expect(createDialog).toBeVisible();
  await createDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(createDialog).not.toBeVisible();

  await folderMenuItem(page, panel, F, "Delete folder");
  const deleteDialog = page.getByRole("dialog", { name: `Delete folder “${F}”?`, exact: true });
  await expect(deleteDialog).toBeVisible();
  await expect(deleteDialog).toContainText("The folder and its 1 subfolder will be deleted.");
  await expect(deleteDialog).toContainText("The 1 note in it will move to the trash.");
  await deleteDialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(toastWithTitle(page, "Folder deleted; 1 note moved to the trash")).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/\/$/);

  const trash = await showSidebarTab(page, "Trash");
  const row = trash.getByRole("listitem").filter({ hasText: title });
  await expect(row).toContainText(`${F} › ${T} · `, { timeout: 15_000 });
  await row.hover();
  await row.getByRole("button", { name: `Restore ${title}`, exact: true }).click();
  await expect(toastWithTitle(page, "Restored 1 note")).toBeVisible({ timeout: 15_000 });

  panel = await showSidebarTab(page, "My notes");
  await expect(folderRow(folderRow(panel, F), T)).toBeVisible({ timeout: 15_000 });
  await expect(noteLink(folderRow(panel, T), title)).toBeVisible();
});

test("40-2 depth: at level 5 of a 5-level chain, more menu \"New subfolder\" cannot run and explains the limit", async ({ page }) => {
  test.setTimeout(120_000);
  await asNewUser(page, "E2E Folders Depth");
  const panel = await showSidebarTab(page, "My notes");
  const names = [1, 2, 3, 4, 5].map((i) => `D${i} ${RUN}`);
  await createFolder(page, panel.getByRole("button", { name: "New folder", exact: true }), names[0]!);
  for (let i = 1; i < names.length; i++) {
    await folderMenuItem(page, panel, names[i - 1]!, "New subfolder");
    await submitFolderName(page, "New folder", names[i]!);
  }
  const trigger = folderMenuButton(panel, names[4]!);
  await trigger.hover();
  await trigger.click();
  const menu = page.getByRole("menu");
  const item = menu.getByRole("menuitem", { name: "New subfolder", exact: true });
  await expect(item).toHaveAttribute("aria-disabled", "true");
  await expect(menu.getByText("Folders can be nested up to 5 levels", { exact: true })).toBeVisible();
  // The blocked item stays in the focus order (aria-disabled, not Radix disabled); Enter does not open the box and the menu stays open.
  // Do not click: Playwright treats aria-disabled="true" as disabled and click would wait until timeout.
  await item.focus();
  await expect(item).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(menu).not.toBeVisible();
});

test("40-3 sort is kept: sorted by name within a folder, still by name after reload, and Name is selected in the more menu", async ({ page }) => {
  test.setTimeout(150_000);
  const F = `Sort ${RUN}`;
  // Created in order C, A, B: the default "recently modified" is B, A, C; by name it is A, B, C.
  const titles = { a: `E2E Sort A ${RUN}`, b: `E2E Sort B ${RUN}`, c: `E2E Sort C ${RUN}` };
  await asNewUser(page, "E2E Folders Sort");
  let panel = await showSidebarTab(page, "My notes");
  await createFolder(page, panel.getByRole("button", { name: "New folder", exact: true }), F);
  for (const title of [titles.c, titles.a, titles.b]) {
    panel = await showSidebarTab(page, "My notes");
    await folderMenuItem(page, panel, F, "New note");
    await titleNewNote(page, title, "n");
  }
  panel = await showSidebarTab(page, "My notes");
  const links = folderRow(panel, F).getByRole("link");
  await expect(links).toHaveText([titles.b, titles.a, titles.c], { timeout: 15_000 });

  const trigger = folderMenuButton(panel, F);
  await trigger.hover();
  await trigger.click();
  await page.getByRole("menu").getByRole("menuitemradio", { name: "Name", exact: true }).click();
  await expect(page.getByRole("menu").getByRole("menuitemradio", { name: "Name", exact: true })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(links).toHaveText([titles.a, titles.b, titles.c]);

  // Full page load of the home page (page.goto is a full document load, equal to a reload; no extra reload)
  await page.goto("/");
  panel = await showSidebarTab(page, "My notes");
  await expect(folderRow(panel, F).getByRole("link")).toHaveText([titles.a, titles.b, titles.c], { timeout: 15_000 });
  const again = folderMenuButton(panel, F);
  await again.hover();
  await again.click();
  await expect(page.getByRole("menu").getByRole("menuitemradio", { name: "Name", exact: true })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
});

test("40-4 group folders: create a folder from the group row and a note in it; a regular member's more menu \"Delete folder\" is blocked with an explanation", async ({ browser }) => {
  test.setTimeout(180_000);
  const groupName = `E2E Fold G ${RUN}`;
  const GF = `GF ${RUN}`;
  const title = `E2E Fold GN ${RUN}`;
  const aContext = await browser.newContext();
  const bContext = await browser.newContext();
  try {
    const aPage = await aContext.newPage();
    await loginAs(aPage, ADMIN.email, ADMIN.password);
    await expect(aPage).toHaveURL(/\/$/);
    const aEmail = randomEmail();
    const bEmail = randomEmail();
    await createUserViaInvite(aPage, { email: aEmail, password: PASSWORD, displayName: "E2E Folders A" });
    await createUserViaInvite(aPage, { email: bEmail, password: PASSWORD, displayName: "E2E Folders B" });
    await aContext.clearCookies();
    await loginAs(aPage, aEmail, PASSWORD);
    await expect(aPage).toHaveURL(/\/$/);

    const sidebar = aPage.getByRole("complementary");
    let workspace = await showSidebarTab(aPage, "Groups");
    await sidebar.getByRole("button", { name: "New group", exact: true }).click();
    const groupDialog = aPage.getByRole("dialog", { name: "New group" });
    await groupDialog.getByLabel("Group name").fill(groupName);
    await groupDialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(groupDialog).not.toBeVisible();
    await expect(workspace.getByRole("button", { name: groupName, exact: true })).toBeVisible();

    await createFolder(aPage, workspace.getByRole("button", { name: `New folder in ${groupName}`, exact: true }), GF);
    await folderMenuItem(aPage, workspace, GF, "New note");
    await titleNewNote(aPage, title, "g");
    workspace = await showSidebarTab(aPage, "Groups");
    await expect(noteLink(folderRow(workspace, GF), title)).toBeVisible({ timeout: 15_000 });

    // A adds B without a role, so B is the built-in regular member (can edit, cannot delete).
    await openGroupPanel(aPage, groupName);
    await aPage.getByLabel("Email address", { exact: true }).fill(bEmail);
    await aPage.getByRole("button", { name: "Add", exact: true }).click();
    await expect(aPage.getByRole("button", { name: `Remove ${bEmail}` })).toBeVisible();

    const bPage = await bContext.newPage();
    await loginAs(bPage, bEmail, PASSWORD);
    await expect(bPage).toHaveURL(/\/$/);
    const bWorkspace = await showSidebarTab(bPage, "Groups");
    await expect(noteLink(folderRow(bWorkspace, GF), title)).toBeVisible({ timeout: 15_000 });
    const trigger = folderMenuButton(bWorkspace, GF);
    await trigger.hover();
    await trigger.click();
    const menu = bPage.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: "Delete folder", exact: true })).toHaveAttribute("aria-disabled", "true");
    await expect(menu.getByText("This folder has notes you can't delete", { exact: true })).toBeVisible();
    await bPage.keyboard.press("Escape");
  } finally {
    await aContext.close();
    await bContext.close();
  }
});

test("40-5 390 phone list: a long-named folder, create a note with its \"+\", and no row in the list's inner wrapper overflows", async ({ page }) => {
  test.setTimeout(120_000);
  const longName = `F ${RUN} ${"Long folder name for the narrow drawer ".repeat(2).slice(0, 60)}`.trimEnd();
  const title = `E2E Fold Narrow ${RUN}`;
  await asNewUser(page, "E2E Folders Narrow");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const openDrawer = (): Promise<Locator> => openListOnCompact(page);

  let drawer = await openDrawer();
  let drawerPanel = await showSidebarTab(page, "My notes", drawer);
  await createFolder(page, drawerPanel.getByRole("button", { name: "New folder", exact: true }), longName);
  const plus = drawerPanel.getByRole("button", { name: `New note in ${longName}`, exact: true });
  await plus.hover();
  await plus.click();
  await titleNewNote(page, title, "n");

  await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible();
  drawer = await openDrawer();
  drawerPanel = await showSidebarTab(page, "My notes", drawer);
  await expect(noteLink(folderRow(drawerPanel, longName), title)).toBeVisible({ timeout: 15_000 });
  // The list's inner wrapper is overflow-x-clip (a safety net): the list itself never overflows, so measure the wrapper's content width. No row in the shallow levels of the phone list may overflow.
  const wrapper = drawerPanel.locator("[data-sidebar-list] > div");
  expect(await wrapper.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
