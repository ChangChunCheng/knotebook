import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  ADMIN,
  clickMenuItemByPointer,
  createFolder,
  createUserViaInvite,
  expectWidePointer,
  folderRow,
  loginAs,
  openListOnCompact,
  openedSubmenu,
  pickDestination,
  pickNoteMenuDestination,
  randomEmail,
  reEscape,
  showSidebarTab,
  startSidebarSelection,
  toastWithTitle,
  toggleSelectedNote,
} from "./helpers.js";

/**
 * Each test creates its own user via `createUserViaInvite` and logs in as it: folders sort before root notes and are expanded by default,
 * so using the shared ADMIN account would change the visible rows of other specs; ADMIN only issues invites. Data is created via API
 * (notes created without content avoid the write throttle) and then `goto("/")` makes the sidebar refetch. Negative assertions wait for a
 * positive anchor first; toast assertions anchor the full text. Focus after a submenu level change is not asserted, except keyboard
 * entry into a level in 41-2. 41-3 creates its group folder through the group row's "New folder in" button; 41-13 shrinks to 700 (< 48rem) to cross the wide/narrow query.
 *
 * Wide/narrow pointer query: see `expectWidePointer` in helpers. The default 1280 viewport is wide, where the kebab's "Move to.../Copy to..."
 * is a sideways-stacking Radix nested submenu (SubTrigger has no ", open", no "Back") and the selection toolbar is in the header;
 * 41-6 and 41-12 use 390 for the narrow form. Buttons that are `aria-disabled` are clicked with `click({ force: true })` because
 * Playwright's click waits for enabled and treats aria-disabled as disabled.
 */

const RUN = Date.now();
const PASSWORD = "e2e-folders-move-pw";
type FolderParent = { parentId: string } | { space: { kind: "personal" } | { kind: "shared" } | { kind: "group"; groupId: string } };

/** ADMIN issues an invite to create a new user, logged in on `page` (lands on `/`). Returns the email. */
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

/** POST /api/folders (`space` for root, `parentId` for subfolders); returns the id. */
async function apiCreateFolder(page: Page, name: string, parent: FolderParent): Promise<string> {
  const res = await page.request.post("/api/folders", { data: { name, ...parent } });
  expect(res.status(), `POST /api/folders → ${await res.text()}`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** Creates a note without content (avoids the write throttle); accepts `groupId` and `folderId`. Returns the id. */
async function apiCreateNote(page: Page, title: string, place: { groupId?: string; folderId?: string } = {}): Promise<string> {
  const res = await page.request.post("/api/notes", { data: { title, ...place } });
  expect(res.status(), `POST /api/notes → ${await res.text()}`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** Creates a group (creator = built-in admin); returns the id. */
async function apiCreateGroup(page: Page, name: string): Promise<string> {
  const res = await page.request.post("/api/groups", { data: { name } });
  expect(res.status(), `POST /api/groups → ${await res.text()}`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** Reads `GET /api/notes` as `page`'s user and returns that note's `folderId` (placement from the caller's view). */
async function folderIdOf(page: Page, noteId: string): Promise<string | null> {
  const res = await page.request.get("/api/notes");
  expect(res.status()).toBe(200);
  const note = ((await res.json()) as Array<{ id: string; folderId: string | null }>).find((n) => n.id === noteId);
  if (note === undefined) throw new Error(`GET /api/notes 裡沒有 ${noteId}`);
  return note.folderId;
}

/** Sidebar note link (accessible name starts with the title). */
function noteLink(scope: Locator, title: string): Locator {
  return scope.getByRole("link", { name: new RegExp("^" + reEscape(title)) });
}

/** Kebab of a sidebar note row (it only grows after the pointer has been over the row: hover the row first); takes the first of same-named notes. Waits for the menu. */
async function openNoteActions(page: Page, scope: Locator, title: string): Promise<void> {
  const button = scope.getByRole("button", { name: `Note actions for ${title}`, exact: true }).first();
  await button.locator("xpath=ancestor::li[1]").hover();
  await button.click();
  await expect(page.getByRole("menu")).toBeVisible();
}

/** Selection action bar (narrow: at the sidebar bottom, outside the tabpanel; wide: in the header). `scope` defaults to the static sidebar. */
function actionBar(page: Page, scope?: Locator): Locator {
  return (scope ?? page.getByRole("complementary")).locator("[data-select-action-bar]");
}

/** Checkbox in select mode (the row is a `<label>` whose accessible name starts with the title/folder name; same lookup as `toggleSelectedNote`). */
function selectionBox(panel: Locator, title: string): Locator {
  return panel.getByRole("checkbox", { name: new RegExp("^" + reEscape(title)) });
}

/** Wide form with the kebab open: opens the "Move to..." submenu and returns its first level. */
async function openMoveCascade(page: Page): Promise<Locator> {
  await pickNoteMenuDestination(page, "Move to…", []);
  return openedSubmenu(page, page.getByRole("menuitem", { name: "Move to…", exact: true }));
}

test("41-1 wide stacked move and undo (1280): first level has no Top level and F is a SubTrigger without \", open\"; second level has Move here / F1 and no Back; toast Undo returns to root", async ({ page }) => {
  test.setTimeout(150_000);
  const F = `F ${RUN}`;
  const F1 = `F1 ${RUN}`;
  const N = `E2E Mv One ${RUN}`;
  await asNewUser(page, "E2E Move One");
  const fId = await apiCreateFolder(page, F, { space: { kind: "personal" } });
  await apiCreateFolder(page, F1, { parentId: fId });
  const noteId = await apiCreateNote(page, N);
  await page.goto("/");
  await expectWidePointer(page, true);
  const panel = await showSidebarTab(page, "My notes");
  await expect(folderRow(folderRow(panel, F), F1)).toBeVisible({ timeout: 15_000 });
  await expect(noteLink(panel, N)).toBeVisible();

  await openNoteActions(page, panel, N);
  const first = await openMoveCascade(page);
  const fTrigger = first.getByRole("menuitem", { name: F, exact: true });
  await expect(fTrigger).toHaveAttribute("aria-haspopup", "menu");
  await expect(first.getByRole("menuitem", { name: "Top level", exact: true })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: /, open$/ })).toHaveCount(0);

  await clickMenuItemByPointer(page, F, first);
  const second = await openedSubmenu(page, fTrigger);
  await expect(second.getByRole("menuitem")).toHaveCount(2);
  for (const name of ["Move here", F1]) await expect(second.getByRole("menuitem", { name, exact: true })).toBeVisible();
  await expect(first).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Back", exact: true })).toHaveCount(0);

  await clickMenuItemByPointer(page, F1, second);
  const moved = toastWithTitle(page, `Moved to “${F1}”`);
  await expect(moved).toBeVisible({ timeout: 15_000 });
  // The pointer rests on the toast: this pauses Radix's 5 s timer so the toast doesn't dismiss between the sidebar assertion and Undo.
  await moved.hover();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(noteLink(folderRow(panel, F1), N)).toBeVisible({ timeout: 15_000 });
  await moved.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(() => folderIdOf(page, noteId), { timeout: 15_000 }).toBeNull();
  await expect(noteLink(panel, N)).toBeVisible();
  await expect(noteLink(folderRow(panel, F), N)).toHaveCount(0, { timeout: 15_000 });
});

test("41-2 wide stacked keyboard: ArrowRight opens a submenu level (Move here focused), ArrowLeft closes one level, Esc closes one level per press and the third closes the menu", async ({ page }) => {
  test.setTimeout(150_000);
  const F = `F ${RUN}`;
  const F1 = `F1 ${RUN}`;
  const N = `E2E Mv Keys ${RUN}`;
  await asNewUser(page, "E2E Move Keys");
  const fId = await apiCreateFolder(page, F, { space: { kind: "personal" } });
  await apiCreateFolder(page, F1, { parentId: fId });
  await apiCreateNote(page, N);
  await page.goto("/");
  await expectWidePointer(page, true);
  const panel = await showSidebarTab(page, "My notes");
  await expect(folderRow(folderRow(panel, F), F1)).toBeVisible({ timeout: 15_000 });

  const trigger = panel.getByRole("button", { name: `Note actions for ${N}`, exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const moveTo = page.getByRole("menuitem", { name: "Move to…", exact: true });
  await expect(moveTo).toBeVisible();
  // Radix moves focus with a setTimeout after keydown, so reading activeElement right after a key press returns the old value.
  // Wait for focus to reach the next item before each press, otherwise an extra press overshoots to "Copy to...".
  const mainItems = page.getByRole("menu").locator('[role="menuitem"]:not([data-disabled])');
  await expect(mainItems.first()).toBeFocused();
  const moveToIndex = await moveTo.evaluate((el) => {
    const menu = el.closest('[role="menu"]');
    return menu === null ? -1 : Array.from(menu.querySelectorAll('[role="menuitem"]:not([data-disabled])')).indexOf(el);
  });
  expect(moveToIndex).toBeGreaterThan(0);
  for (let i = 1; i <= moveToIndex; i++) {
    await page.keyboard.press("ArrowDown");
    await expect(mainItems.nth(i)).toBeFocused();
  }
  await expect(moveTo).toBeFocused();

  // With the keyboard Radix focuses the new level's first available item (not when opened by mouse hover).
  const fItem = page.getByRole("menuitem", { name: F, exact: true });
  const moveHere = page.getByRole("menuitem", { name: "Move here", exact: true });
  await page.keyboard.press("ArrowRight");
  await expect(fItem).toBeFocused();
  await expect(fItem).toHaveAttribute("aria-haspopup", "menu");
  await page.keyboard.press("ArrowRight");
  await expect(moveHere).toBeFocused();
  await expect(page.getByRole("menuitem", { name: F1, exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Back", exact: true })).toHaveCount(0);

  await page.keyboard.press("ArrowLeft");
  await expect(fItem).toBeFocused();
  await expect(moveHere).toHaveCount(0);

  await page.keyboard.press("ArrowRight");
  await expect(moveHere).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(moveHere).toHaveCount(0);
  await expect(fItem).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(fItem).toHaveCount(0);
  await expect(moveTo).toBeFocused();
  await expect(page.getByRole("menu")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("41-3 kebab copy: Make a copy lands in the same folder; Copy to... a group folder (confirm dialog shows the full path)", async ({ page }) => {
  test.setTimeout(180_000);
  const F = `F ${RUN}`;
  const G = `E2E Mv G3 ${RUN}`;
  const GF = `GF ${RUN}`;
  const N = `E2E Mv Copy ${RUN}`;
  await asNewUser(page, "E2E Move Copy");
  const fId = await apiCreateFolder(page, F, { space: { kind: "personal" } });
  await apiCreateNote(page, N, { folderId: fId });
  await apiCreateGroup(page, G);
  await page.goto("/");

  const workspace = await showSidebarTab(page, "Groups");
  await createFolder(page, workspace.getByRole("button", { name: `New folder in ${G}`, exact: true }), GF);

  let panel = await showSidebarTab(page, "My notes");
  await expect(noteLink(folderRow(panel, F), N)).toBeVisible({ timeout: 15_000 });
  await openNoteActions(page, panel, N);
  await pickNoteMenuDestination(page, "Copy to…", ["Make a copy"]);
  const makeCopy = page.getByRole("dialog", { name: "Make a copy" });
  await expect(makeCopy).toBeVisible();
  await makeCopy.getByRole("button", { name: "Make a copy", exact: true }).click();
  await expect(toastWithTitle(page, "Copied to your notes")).toBeVisible({ timeout: 15_000 });
  await expect(noteLink(folderRow(panel, F), N)).toHaveCount(2, { timeout: 15_000 });

  await openNoteActions(page, panel, N);
  await pickNoteMenuDestination(page, "Copy to…", [`${G}, open`, GF]);
  const copyInto = page.getByRole("dialog", { name: "Copy into group" });
  await expect(copyInto).toBeVisible();
  await expect(copyInto).toContainText(`This creates a copy in "${G} › ${GF}"; the original stays as it is.`);
  await copyInto.getByRole("button", { name: "Copy into group", exact: true }).click();
  await expect(toastWithTitle(page, `Copied into "${G}"`)).toBeVisible({ timeout: 15_000 });
  const workspaceAgain = await showSidebarTab(page, "Groups");
  await expect(noteLink(folderRow(workspaceAgain, GF), N)).toBeVisible({ timeout: 15_000 });
  panel = await showSidebarTab(page, "My notes");
  await expect(noteLink(folderRow(panel, F), N)).toHaveCount(2);
});

test("41-4 kebab move of a personal note into a group folder: confirm dialog shows the full path with focus on Cancel; URL becomes /g/... and the note is under G > GF", async ({ page }) => {
  test.setTimeout(150_000);
  const G = `E2E Mv G4 ${RUN}`;
  const GF = `GF ${RUN}`;
  const N = `E2E Mv Into ${RUN}`;
  await asNewUser(page, "E2E Move Into");
  const groupId = await apiCreateGroup(page, G);
  await apiCreateFolder(page, GF, { space: { kind: "group", groupId } });
  await apiCreateNote(page, N);
  await page.goto("/");

  const panel = await showSidebarTab(page, "My notes");
  await noteLink(panel, N).click();
  // Wait for the note's title box before touching the header: until the lazy NotePage mounts, only its fallback is on screen.
  const titleInput = page.getByRole("textbox", { name: "Note title" });
  await expect(titleInput).toHaveValue(N, { timeout: 15_000 });
  await page.getByRole("button", { name: "More", exact: true }).click();
  await pickNoteMenuDestination(page, "Move to…", [`${G}, open`, GF]);

  const confirm = page.getByRole("dialog", { name: "Move into group" });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText(`Move this note into "${G} › ${GF}"?`);
  await expect(confirm.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  // The submit button stays disabled until both the shares and public-link requests have arrived; click waits for it to be enabled.
  await confirm.getByRole("button", { name: "Move into group", exact: true }).click();
  await expect(toastWithTitle(page, `Moved into "${G} › ${GF}"`)).toBeVisible({ timeout: 15_000 });

  await expect(page).toHaveURL(new RegExp(`/g/${groupId}/[^/]+$`), { timeout: 15_000 });
  await expect(titleInput).toHaveValue(N, { timeout: 15_000 });
  const workspace = await showSidebarTab(page, "Groups");
  await expect(noteLink(folderRow(workspace, GF), N)).toBeVisible({ timeout: 15_000 });
});

test("41-5 select mode: check two notes -> Move to -> F -> Move here (no confirm) -> toast -> Undo returns to root; Copy to is disabled with a folder checked", async ({ page }) => {
  test.setTimeout(150_000);
  const F = `F ${RUN}`;
  const F1 = `F1 ${RUN}`;
  const [a, b] = [`E2E Mv Sel A ${RUN}`, `E2E Mv Sel B ${RUN}`];
  await asNewUser(page, "E2E Move Select");
  const fId = await apiCreateFolder(page, F, { space: { kind: "personal" } });
  await apiCreateFolder(page, F1, { parentId: fId });
  const aId = await apiCreateNote(page, a);
  const bId = await apiCreateNote(page, b);
  await page.goto("/");
  await showSidebarTab(page, "My notes");

  let panel = await startSidebarSelection(page);
  await toggleSelectedNote(panel, a);
  await toggleSelectedNote(panel, b);
  await expect(panel.getByText("2 selected", { exact: true })).toBeVisible();
  await actionBar(page).getByRole("button", { name: "Move to", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Move to" });
  await expect(picker).toBeVisible();
  await pickDestination(picker, [`${F}, open`, "Move here"]);
  const moved = toastWithTitle(page, `Moved 2 items to “${F}”`);
  await expect(moved).toBeVisible({ timeout: 15_000 });
  // The pointer rests on the toast: this pauses Radix's 5 s timer so the toast doesn't dismiss between the sidebar assertion and Undo.
  await moved.hover();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  for (const title of [a, b]) await expect(noteLink(folderRow(panel, F), title)).toBeVisible({ timeout: 15_000 });

  await moved.getByRole("button", { name: "Undo", exact: true }).click();
  for (const id of [aId, bId]) await expect.poll(() => folderIdOf(page, id), { timeout: 15_000 }).toBeNull();
  panel = await showSidebarTab(page, "My notes");
  for (const title of [a, b]) {
    await expect(noteLink(panel, title)).toBeVisible();
    await expect(noteLink(folderRow(panel, F), title)).toHaveCount(0, { timeout: 15_000 });
  }

  panel = await startSidebarSelection(page);
  await toggleSelectedNote(panel, F1);
  await expect(panel.getByText("1 selected", { exact: true })).toBeVisible();
  const copyTo = actionBar(page).getByRole("button", { name: "Copy to", exact: true });
  await expect(copyTo).toBeDisabled();
  await expect(copyTo).toHaveAttribute("title", "Folders can't be copied");
});

test("41-6 390 phone list: kebab Move to... goes level by level in the sheet (replaces the whole content, Back on top); click \"F, open\" then F1; select mode on the same list moves to F", async ({ page }) => {
  test.setTimeout(150_000);
  const F = `F ${RUN}`;
  const F1 = `F1 ${RUN}`;
  const N = `E2E Mv Narrow ${RUN}`;
  const M = `E2E Mv Narrow Sel ${RUN}`;
  await asNewUser(page, "E2E Move Narrow");
  const fId = await apiCreateFolder(page, F, { space: { kind: "personal" } });
  await apiCreateFolder(page, F1, { parentId: fId });
  await apiCreateNote(page, N);
  await apiCreateNote(page, M);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expectWidePointer(page, false);
  const drawer = await openListOnCompact(page);
  const drawerPanel = await showSidebarTab(page, "My notes", drawer);
  await expect(noteLink(drawerPanel, N)).toBeVisible({ timeout: 15_000 });

  await openNoteActions(page, drawerPanel, N);
  await expect(page.getByRole("menuitem", { name: "Move to…", exact: true })).not.toHaveAttribute("aria-haspopup", "menu");
  await pickNoteMenuDestination(page, "Move to…", [`${F}, open`]);
  await expect(page.getByRole("menuitem", { name: "Back", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Copy link", exact: true })).toHaveCount(0);
  await page.getByRole("menuitem", { name: F1, exact: true }).click();
  await expect(toastWithTitle(page, `Moved to “${F1}”`)).toBeVisible({ timeout: 15_000 });
  await expect(drawer).toBeVisible();
  await expect(noteLink(folderRow(drawerPanel, F1), N)).toBeVisible({ timeout: 15_000 });

  const panel = await startSidebarSelection(page, drawer);
  await toggleSelectedNote(panel, M);
  await actionBar(page, drawer).getByRole("button", { name: "Move to", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Move to" });
  await expect(picker).toBeVisible();
  await pickDestination(picker, [`${F}, open`, "Move here"]);
  await expect(toastWithTitle(page, `Moved 1 item to “${F}”`)).toBeVisible({ timeout: 15_000 });
  await expect(drawer).toBeVisible();
  await expect(noteLink(folderRow(drawerPanel, F), M)).toBeVisible({ timeout: 15_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("41-7 shared with me: B creates a shared folder SF and moves A's shared note into it; A still sees folderId null", async ({ browser }) => {
  test.setTimeout(150_000);
  const SF = `SF ${RUN}`;
  const title = `E2E Mv Shared ${RUN}`;
  const aContext = await browser.newContext();
  const bContext = await browser.newContext();
  try {
    const aPage = await aContext.newPage();
    await loginAs(aPage, ADMIN.email, ADMIN.password);
    await expect(aPage).toHaveURL(/\/$/);
    const aEmail = randomEmail();
    const bEmail = randomEmail();
    await createUserViaInvite(aPage, { email: aEmail, password: PASSWORD, displayName: "E2E Move Sharer" });
    await createUserViaInvite(aPage, { email: bEmail, password: PASSWORD, displayName: "E2E Move Guest" });
    await aContext.clearCookies();
    await loginAs(aPage, aEmail, PASSWORD);
    await expect(aPage).toHaveURL(/\/$/);

    const noteId = await apiCreateNote(aPage, title);
    const share = await aPage.request.put(`/api/notes/${noteId}/shares`, { data: { email: bEmail, role: "viewer" } });
    expect(share.ok(), `PUT /api/notes/${noteId}/shares → ${share.status()} ${await share.text()}`).toBe(true);

    const bPage = await bContext.newPage();
    await loginAs(bPage, bEmail, PASSWORD);
    await expect(bPage).toHaveURL(/\/$/);
    const shared = await showSidebarTab(bPage, "Shared with me");
    await expect(noteLink(shared, title)).toBeVisible({ timeout: 15_000 });
    await createFolder(bPage, shared.getByRole("button", { name: "New folder", exact: true }), SF);
    await openNoteActions(bPage, shared, title);
    await pickNoteMenuDestination(bPage, "Move to…", [SF]);
    await expect(toastWithTitle(bPage, `Moved to “${SF}”`)).toBeVisible({ timeout: 15_000 });
    await expect(noteLink(folderRow(shared, SF), title)).toBeVisible({ timeout: 15_000 });

    // Placement is only B's own classification: B sees the folderId (positive anchor) while A still sees null.
    await expect.poll(() => folderIdOf(bPage, noteId), { timeout: 15_000 }).not.toBeNull();
    expect(await folderIdOf(aPage, noteId)).toBeNull();
  } finally {
    await aContext.close();
    await bContext.close();
  }
});

test("41-8 groups tab across groups: checking one note each in G and H disables Move to, and the title explains different groups can't be moved together", async ({ page }) => {
  test.setTimeout(120_000);
  const G = `E2E Mv G8 ${RUN}`;
  const H = `E2E Mv H8 ${RUN}`;
  const [inG, inH] = [`E2E Mv InG ${RUN}`, `E2E Mv InH ${RUN}`];
  await asNewUser(page, "E2E Move Across");
  const gId = await apiCreateGroup(page, G);
  const hId = await apiCreateGroup(page, H);
  await apiCreateNote(page, inG, { groupId: gId });
  await apiCreateNote(page, inH, { groupId: hId });
  await page.goto("/");

  const workspace = await showSidebarTab(page, "Groups");
  for (const title of [inG, inH]) await expect(noteLink(workspace, title)).toBeVisible({ timeout: 15_000 });
  const panel = await startSidebarSelection(page);
  await toggleSelectedNote(panel, inG);
  await toggleSelectedNote(panel, inH);
  await expect(panel.getByText("2 selected", { exact: true })).toBeVisible();
  const bar = actionBar(page);
  await expect(bar.getByRole("button", { name: "Copy to", exact: true })).toBeEnabled();
  const moveTo = bar.getByRole("button", { name: "Move to", exact: true });
  await expect(moveTo).toBeDisabled();
  await expect(moveTo).toHaveAttribute("title", "The selected notes are in different groups and can't be moved together");
});

test("41-9 delete-group notice: a group with folders -> Delete group -> transfer mode says the folders move to the successor's notes", async ({ page }) => {
  test.setTimeout(120_000);
  const displayName = "E2E Move Owner";
  const G = `E2E Mv G9 ${RUN}`;
  const GF = `GF ${RUN}`;
  await asNewUser(page, displayName);
  const groupId = await apiCreateGroup(page, G);
  await apiCreateFolder(page, GF, { space: { kind: "group", groupId } });
  await page.goto("/");

  const workspace = await showSidebarTab(page, "Groups");
  await expect(folderRow(workspace, GF)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("complementary").getByRole("button", { name: `Group actions for ${G}` }).click();
  await page.getByRole("menuitem", { name: "Delete group" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete group?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("radio", { name: "Give them to an admin" })).toBeChecked();
  await expect(
    dialog.getByText(`The group's folders move into ${displayName}'s notes, under a folder named after the group.`, { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).not.toBeVisible();
});

test("41-10 wide stack disabled state and group root: N in F1 -> Move here is disabled at the F1 level and F2 is enabled; the group G level has Top level first, then GF", async ({ page }) => {
  test.setTimeout(150_000);
  const F = `F ${RUN}`;
  const F1 = `F1 ${RUN}`;
  const F2 = `F2 ${RUN}`;
  const G = `E2E Mv G10 ${RUN}`;
  const GF = `GF ${RUN}`;
  const N = `E2E Mv Cascade ${RUN}`;
  await asNewUser(page, "E2E Move Cascade");
  const fId = await apiCreateFolder(page, F, { space: { kind: "personal" } });
  const f1Id = await apiCreateFolder(page, F1, { parentId: fId });
  await apiCreateFolder(page, F2, { parentId: f1Id });
  await apiCreateNote(page, N, { folderId: f1Id });
  const groupId = await apiCreateGroup(page, G);
  await apiCreateFolder(page, GF, { space: { kind: "group", groupId } });
  await page.goto("/");
  await expectWidePointer(page, true);
  const panel = await showSidebarTab(page, "My notes");
  await expect(noteLink(folderRow(panel, F1), N)).toBeVisible({ timeout: 15_000 });

  await openNoteActions(page, panel, N);
  const first = await openMoveCascade(page);
  const fTrigger = first.getByRole("menuitem", { name: F, exact: true });
  await clickMenuItemByPointer(page, F, first);
  const fLevel = await openedSubmenu(page, fTrigger);
  await expect(fLevel.getByRole("menuitem", { name: "Move here", exact: true })).toBeEnabled();
  const f1Trigger = fLevel.getByRole("menuitem", { name: F1, exact: true });
  await expect(f1Trigger).toHaveAttribute("aria-haspopup", "menu");
  await expect(f1Trigger).toBeEnabled();

  await clickMenuItemByPointer(page, F1, fLevel);
  const f1Level = await openedSubmenu(page, f1Trigger);
  await expect(f1Level.getByRole("menuitem", { name: F2, exact: true })).toBeEnabled();
  await expect(f1Level.getByRole("menuitem", { name: "Move here", exact: true })).toBeDisabled();

  await page.keyboard.press("Escape");
  await expect(f1Level).toHaveCount(0);
  await expect(fLevel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(fLevel).toHaveCount(0);
  await expect(first).toBeVisible();

  const gTrigger = first.getByRole("menuitem", { name: G, exact: true });
  await expect(gTrigger).toHaveAttribute("aria-haspopup", "menu");
  await clickMenuItemByPointer(page, G, first);
  const gLevel = await openedSubmenu(page, gTrigger);
  const gItems = gLevel.getByRole("menuitem");
  await expect(gItems.nth(0)).toHaveAccessibleName("Top level");
  await expect(gItems.nth(1)).toHaveAccessibleName(GF);
});

test("41-11 wide selection toolbar (1280): X is focused, tri-state select-all, no New note at the bottom; header Move to moves in bulk and focus returns to Select; Esc on X exits", async ({ page }) => {
  test.setTimeout(150_000);
  const F = `F ${RUN}`;
  const F1 = `F1 ${RUN}`;
  const [n1, n2] = [`E2E Mv Tb N1 ${RUN}`, `E2E Mv Tb N2 ${RUN}`];
  await asNewUser(page, "E2E Move Toolbar");
  const fId = await apiCreateFolder(page, F, { space: { kind: "personal" } });
  await apiCreateFolder(page, F1, { parentId: fId });
  await apiCreateNote(page, n1);
  await apiCreateNote(page, n2);
  await page.goto("/");
  await expectWidePointer(page, true);
  const sidebar = page.getByRole("complementary");
  const newNote = sidebar.getByRole("button", { name: "New note", exact: true });
  const myNotes = await showSidebarTab(page, "My notes");
  await expect(folderRow(folderRow(myNotes, F), F1)).toBeVisible({ timeout: 15_000 });
  for (const title of [n1, n2]) await expect(noteLink(myNotes, title)).toBeVisible();
  await expect(newNote).toBeVisible();

  let panel = await startSidebarSelection(page);
  const exit = panel.getByRole("button", { name: "Exit selection", exact: true });
  const selectButton = panel.locator("button[data-sidebar-select]");
  const selectAll = panel.getByRole("checkbox", { name: "Select all", exact: true });
  await expect(exit).toBeFocused();
  await expect(panel.getByRole("button", { name: "Done", exact: true })).toHaveCount(0);
  await expect(selectAll).not.toBeChecked();
  await expect(selectAll).toHaveJSProperty("indeterminate", false);
  await expect(newNote).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(selectButton).toBeFocused();
  await expect(selectAll).toHaveCount(0);
  await expect(newNote).toBeVisible();

  panel = await startSidebarSelection(page);
  await expect(exit).toBeFocused();
  await toggleSelectedNote(panel, n1);
  await expect(selectAll).toBeChecked({ indeterminate: true });
  await selectAll.click();
  for (const name of [F, F1, n1, n2]) await expect(selectionBox(panel, name)).toBeChecked();
  await expect(selectAll).toBeChecked();
  await expect(panel.getByText("4 selected", { exact: true })).toBeVisible();
  await selectAll.click();
  await expect(panel.getByText("0 selected", { exact: true })).toBeVisible();
  for (const name of [F, F1, n1, n2]) await expect(selectionBox(panel, name)).not.toBeChecked();
  await expect(selectAll).not.toBeChecked();
  await expect(selectAll).toHaveJSProperty("indeterminate", false);

  await toggleSelectedNote(panel, n1);
  await toggleSelectedNote(panel, n2);
  await expect(panel.getByText("2 selected", { exact: true })).toBeVisible();
  const toolbar = panel.locator("[data-sidebar-header] [data-select-action-bar]");
  await toolbar.getByRole("button", { name: "Move to", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Move to" });
  await expect(picker).toBeVisible();
  await pickDestination(picker, [`${F}, open`, "Move here"]);
  await expect(toastWithTitle(page, `Moved 2 items to “${F}”`)).toBeVisible({ timeout: 15_000 });
  await expect(selectButton).toBeFocused();
  await expect(newNote).toBeVisible();
  for (const title of [n1, n2]) await expect(noteLink(folderRow(myNotes, F), title)).toBeVisible({ timeout: 15_000 });
});

test("41-12 390 narrow: with a folder checked the bottom Copy to is dimmed (aria-disabled, title explains), clicking it shows the same toast without opening the destination dialog; Move to and Copy to are both outline buttons", async ({ page }) => {
  test.setTimeout(150_000);
  const F = `F ${RUN}`;
  const N = `E2E Mv Soft ${RUN}`;
  const reason = "Folders can't be copied";
  await asNewUser(page, "E2E Move Soft");
  await apiCreateFolder(page, F, { space: { kind: "personal" } });
  await apiCreateNote(page, N);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expectWidePointer(page, false);
  const drawer = await openListOnCompact(page);
  const drawerPanel = await showSidebarTab(page, "My notes", drawer);
  await expect(folderRow(drawerPanel, F)).toBeVisible({ timeout: 15_000 });

  const panel = await startSidebarSelection(page, drawer);
  await expect(panel.getByRole("button", { name: "Done", exact: true })).toBeVisible();
  await toggleSelectedNote(panel, F);
  await expect(panel.getByText("1 selected", { exact: true })).toBeVisible();
  const bar = actionBar(page, drawer);
  const copyTo = bar.getByRole("button", { name: "Copy to", exact: true });
  const moveTo = bar.getByRole("button", { name: "Move to", exact: true });
  await expect(moveTo).toBeVisible();
  await expect(copyTo).toBeDisabled();
  await expect(copyTo).toHaveAttribute("aria-disabled", "true");
  await expect(copyTo).toHaveAttribute("title", reason);

  await copyTo.click({ force: true });
  await expect(toastWithTitle(page, reason)).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Copy to" })).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await expect(panel.getByText("1 selected", { exact: true })).toBeVisible();

  // Colors are not asserted, only that the class strings match (the dimmed look is the `aria-disabled:` variant, which both buttons carry).
  expect(await moveTo.getAttribute("class")).toBe(await copyTo.getAttribute("class"));
});

test("41-13 across the wide/narrow query: shrinking to 700 with the stacked kebab menu open closes the menu; shrinking to 390 while selecting shows the narrow form in the phone list (1 selected, Done, bottom action bar)", async ({ page }) => {
  test.setTimeout(150_000);
  const F = `F ${RUN}`;
  const N = `E2E Mv Flip ${RUN}`;
  await asNewUser(page, "E2E Move Flip");
  await apiCreateFolder(page, F, { space: { kind: "personal" } });
  await apiCreateNote(page, N);
  await page.goto("/");
  await expectWidePointer(page, true);
  const panel = await showSidebarTab(page, "My notes");
  await expect(noteLink(panel, N)).toBeVisible({ timeout: 15_000 });
  await expect(folderRow(panel, F)).toBeVisible();

  await openNoteActions(page, panel, N);
  const first = await openMoveCascade(page);
  await expect(first.getByRole("menuitem", { name: F, exact: true })).toBeVisible();
  await page.setViewportSize({ width: 700, height: 720 });
  await expectWidePointer(page, false);
  await expect(page.getByRole("menu")).toHaveCount(0);

  await page.setViewportSize({ width: 1280, height: 720 });
  await expectWidePointer(page, true);
  const selecting = await startSidebarSelection(page);
  await toggleSelectedNote(selecting, N);
  await expect(selecting.getByText("1 selected", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expectWidePointer(page, false);
  const drawer = await openListOnCompact(page);
  const drawerPanel = drawer.getByRole("tabpanel");
  await expect(drawerPanel.getByText("1 selected", { exact: true })).toBeVisible();
  await expect(drawerPanel.getByRole("button", { name: "Done", exact: true })).toBeVisible();
  await expect(drawerPanel.getByRole("button", { name: "Exit selection", exact: true })).toHaveCount(0);
  await expect(selectionBox(drawerPanel, N)).toBeChecked();
  const bar = actionBar(page, drawer);
  await expect(bar.getByRole("button", { name: "Move to", exact: true })).toBeVisible();
  await expect(drawerPanel.locator("[data-sidebar-header] [data-select-action-bar]")).toHaveCount(0);
});
