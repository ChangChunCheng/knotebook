import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import {
  ADMIN,
  createUserViaInvite,
  expectWidePointer,
  loginAs,
  openListOnCompact,
  randomEmail,
  reEscape,
  showSidebarTab,
  startSidebarSelection,
  toastWithTitle,
  toggleSelectedNote,
} from "./helpers.js";

/**
 * The e2e default viewport 1280 is the wide form: the action bar (`[data-select-action-bar]`) is in the header row and the
 * buttons' accessible names are unchanged; the narrow-form variants are the 700-wide drawer and the 390 phone list.
 *
 * Each test creates the data it needs itself (after a Playwright failure the worker changes and `RUN` changes; `--grep` may also
 * run a single case). Data is created through the API (creating notes without content does not hit the write throttle; copying
 * hits the 30-per-minute write throttle, and this file copies one note), then `goto("/")` so the sidebar refetches. The stack is
 * shared: admin's list has other specs' notes and groups, so rows are always located by this file's titles (carrying RUN) and
 * totals are not asserted. Groups and notes are left in place (as in 36).
 */
const RUN = Date.now();
const PASSWORD = "e2e-select-user-pw";
const NOTE_TITLE = { name: "Note title" } as const;
const NO_UNDO_HINT = "Members of the group whose role can both edit and delete notes can restore it.";
/** The delete button is icon-only; its accessible name carries the count (`select.deleteSelected`). */
const DELETE_SELECTED = /^Delete \d+ selected items?$/;

function noteLink(scope: Locator, title: string): Locator {
  return scope.getByRole("link", { name: new RegExp("^" + reEscape(title)) });
}

function noteCheckbox(panel: Locator, title: string): Locator {
  return panel.getByRole("checkbox", { name: new RegExp("^" + reEscape(title)) });
}

/** The selection action bar (narrow form: at the bottom of the sidebar, outside the tabpanel; wide form: in the header row). `scope` defaults to the static sidebar. */
function actionBar(page: Page, scope?: Locator): Locator {
  return (scope ?? page.getByRole("complementary")).locator("[data-select-action-bar]");
}

async function expectSelectionEnded(panel: Locator): Promise<void> {
  await expect(panel.getByRole("button", { name: "Select", exact: true })).toBeVisible();
  await expect(panel.getByRole("checkbox")).toHaveCount(0);
}

/** Creates a note without content (avoids the write throttle), in the group if `groupId` is given. Returns the id. */
async function apiCreateNote(page: Page, title: string, groupId?: string): Promise<string> {
  const res = await page.request.post("/api/notes", { data: groupId === undefined ? { title } : { title, groupId } });
  expect(res.status(), `POST /api/notes → ${await res.text()}`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function apiCreateGroup(page: Page, name: string): Promise<string> {
  const res = await page.request.post("/api/groups", { data: { name } });
  expect(res.status(), `POST /api/groups → ${await res.text()}`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** Adds a member; without `roleId` the member gets the built-in regular role (read, create, edit; no delete). */
async function apiAddMember(page: Page, groupId: string, email: string, roleId?: string): Promise<void> {
  const res = await page.request.put(`/api/groups/${groupId}/members`, { data: roleId === undefined ? { email } : { email, roleId } });
  expect(res.ok(), `PUT /api/groups/${groupId}/members → ${res.status()} ${await res.text()}`).toBe(true);
}

/** Creates a custom role with only "delete" on (all six flags must be given); returns the role id. */
async function apiCreateDeleteOnlyRole(page: Page, groupId: string, name: string): Promise<string> {
  const permissions = { create: false, edit: false, delete: true, managePublicLink: false, manageMembers: false, manageGroup: false };
  const res = await page.request.post(`/api/groups/${groupId}/roles`, { data: { name, permissions } });
  expect(res.status(), `POST /api/groups/${groupId}/roles → ${await res.text()}`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function adminSession(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);
  return { context, page };
}

async function userSession(browser: Browser, email: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await loginAs(page, email, PASSWORD);
  await expect(page).toHaveURL(/\/$/);
  return { context, page };
}

/**
 * Clicks the blank bottom-left of the main content area (the home page's guide card; the toast is at the bottom right, so it is
 * avoided) so focus leaves the sidebar and lands on body - macOS Safari does not focus a checkbox on click, so focus is already
 * on body there; this reproduces that state in Chromium by "clicking somewhere unfocusable".
 */
async function clickMainBlank(page: Page): Promise<void> {
  const main = page.getByRole("main");
  const box = await main.boundingBox();
  expect(box).not.toBeNull();
  await main.click({ position: { x: 24, y: box!.height - 24 } });
}

async function activeIsBody(page: Page): Promise<boolean> {
  return page.evaluate(() => document.activeElement === document.body);
}

test("My notes: Shift range-select three notes -> move to a group; focus is in the confirmation dialog and returns to \"Select\" after submit", async ({ page }) => {
  test.setTimeout(120_000);
  const groupName = `E2E Sel G ${RUN}`;
  const [m1, m2, m3] = [1, 2, 3].map((i) => `E2E Sel M${i} ${RUN}`) as [string, string, string];
  const keep = `E2E Sel Keep1 ${RUN}`; // not moved: after the move "Select" can still be pressed, and it is the positive anchor for the negative assertions
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);
  const groupId = await apiCreateGroup(page, groupName);
  // Created in order: the list newest first is M3, M2, M1 (no other creation in between, so the three rows are adjacent); keep is created first and is not in the range.
  for (const title of [keep, m1, m2, m3]) await apiCreateNote(page, title);
  await page.goto("/");

  await showSidebarTab(page, "My notes");
  const panel = await startSidebarSelection(page);
  await toggleSelectedNote(panel, m1);
  await toggleSelectedNote(panel, m3, { shift: true });
  await expect(panel.getByText("3 selected", { exact: true })).toBeVisible();
  await expect(noteCheckbox(panel, m2)).toBeChecked();
  await expect(noteCheckbox(panel, keep)).not.toBeChecked();

  await actionBar(page).getByRole("button", { name: "Move to", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Move to" });
  await expect(picker).toBeVisible();
  await picker.getByRole("button", { name: groupName, exact: true }).click();
  await expect(picker).toHaveCount(0);

  // Destination dialog -> confirmation dialog: focus goes to the confirmation dialog's own autofocus (the first focusable is "Cancel"; the close button is last in the DOM) and is not pulled back to the "Move to" behind it.
  const confirm = page.getByRole("dialog", { name: "Move into group" });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await expect(confirm.getByText(`Move 3 notes into "${groupName}"?`, { exact: true })).toBeVisible();
  await confirm.getByRole("button", { name: "Move into group", exact: true }).click();
  await expect(toastWithTitle(page, `Moved 3 notes into "${groupName}"`)).toBeVisible({ timeout: 15_000 });
  await expect(confirm).toHaveCount(0);
  // After submit focus on body (Chromium / Firefox: the submit button is disabled) or on the confirmation dialog container (WebKit) both count as "did not move elsewhere" -> handed to this instance's "Select".
  // This assertion checks the final landing; the `confirmEl` branch of the guard is covered by the component tests.
  await expect(panel.locator("button[data-sidebar-select]")).toBeFocused();
  await expectSelectionEnded(panel);

  const workspace = await showSidebarTab(page, "Groups");
  const groupNode = workspace.locator(`li[data-node-kind="group"][data-node-id="${groupId}"]`);
  for (const title of [m1, m2, m3]) await expect(noteLink(groupNode, title)).toBeVisible({ timeout: 15_000 });
  const myNotes = await showSidebarTab(page, "My notes");
  await expect(noteLink(myNotes, keep)).toBeVisible({ timeout: 15_000 });
  for (const title of [m1, m2, m3]) await expect(noteLink(myNotes, title)).toHaveCount(0);
});

test("Groups tab: tick a group note -> \"Move to\" exists; copy to \"My notes\" (the destination is called My notes, confirmation first)", async ({ page }) => {
  test.setTimeout(120_000);
  const groupName = `E2E Sel C ${RUN}`;
  const title = `E2E Sel C1 ${RUN}`;
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);
  await apiCreateGroup(page, groupName);
  await page.goto("/");

  // The group row's "New note in ..." creates a group note (as in 36): the URL changes first and the screen later, so wait for the new note's title input (Untitled) before renaming.
  const sidebar = page.getByRole("complementary");
  await showSidebarTab(page, "Groups");
  await sidebar.getByRole("button", { name: `New note in ${groupName}`, exact: true }).click();
  await page.waitForURL(/\/g\/[0-9a-f-]{36}\/untitled-[0-9a-f]{8}$/, { timeout: 15_000 });
  const titleInput = page.getByRole("textbox", NOTE_TITLE);
  await expect(titleInput).toHaveValue("Untitled", { timeout: 15_000 });
  await titleInput.fill(title);
  await titleInput.blur();
  await page.waitForURL(
    (url) => /^\/g\/[0-9a-f-]{36}\/[^/]+$/.test(url.pathname) && !/\/untitled-[0-9a-f]{8}$/.test(url.pathname),
    { timeout: 15_000 },
  );

  const workspace = await showSidebarTab(page, "Groups");
  await expect(noteLink(workspace, title)).toBeVisible({ timeout: 15_000 });
  const panel = await startSidebarSelection(page);
  await toggleSelectedNote(panel, title);
  await expect(panel.getByText("1 selected", { exact: true })).toBeVisible();
  const copyTo = actionBar(page).getByRole("button", { name: "Copy to", exact: true });
  await expect(copyTo).toBeEnabled();
  // A group has "Move to" (only between this group's folders). This group has no folders and the note is at the root -> the first level is empty -> disabled.
  await expect(actionBar(page).getByRole("button", { name: "Move to", exact: true })).toBeDisabled();

  await copyTo.click();
  const picker = page.getByRole("dialog", { name: "Copy to" });
  const myNotesTarget = picker.getByRole("button", { name: "My notes", exact: true });
  await expect(myNotesTarget).toBeVisible();
  // The upper part (the current group) starts with "Make a copy"; the lower part after the divider starts with the personal destination, called "My notes" (naming unified; the old name no longer appears).
  const targets = picker.getByRole("list").getByRole("button");
  await expect(targets.first()).toHaveAccessibleName("Make a copy");
  await expect(targets.nth(1)).toHaveAccessibleName("My notes");
  await myNotesTarget.click();

  const confirm = page.getByRole("dialog", { name: "Copy to my notes" });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await confirm.getByRole("button", { name: "Copy to my notes", exact: true }).click();
  await expect(toastWithTitle(page, "Copied 1 note to My notes")).toBeVisible({ timeout: 15_000 });
  await expect(confirm).toHaveCount(0);
  await expectSelectionEnded(panel);

  const myNotes = await showSidebarTab(page, "My notes");
  await expect(noteLink(myNotes, title)).toHaveCount(1, { timeout: 15_000 });
  const workspaceAgain = await showSidebarTab(page, "Groups");
  await expect(noteLink(workspaceAgain, title)).toHaveCount(1);
});

test("tick two and delete -> no confirmation, toast \"Undo\" -> both return to My notes", async ({ page }) => {
  test.setTimeout(120_000);
  const [d1, d2] = [1, 2].map((i) => `E2E Sel D${i} ${RUN}`) as [string, string];
  const keep = `E2E Sel Keep3 ${RUN}`;
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);
  for (const title of [keep, d1, d2]) await apiCreateNote(page, title);
  await page.goto("/");

  await showSidebarTab(page, "My notes");
  const panel = await startSidebarSelection(page);
  await toggleSelectedNote(panel, d1);
  await toggleSelectedNote(panel, d2);
  await expect(panel.getByText("2 selected", { exact: true })).toBeVisible();
  await actionBar(page).getByRole("button", { name: "Delete 2 selected items", exact: true }).click();

  const trashed = toastWithTitle(page, "Moved 2 notes to the trash");
  await expect(trashed).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expectSelectionEnded(panel);
  await expect(noteLink(panel, keep)).toBeVisible();
  for (const title of [d1, d2]) await expect(noteLink(panel, title)).toHaveCount(0);

  await trashed.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(toastWithTitle(page, "Restored 2 notes")).toBeVisible({ timeout: 15_000 });
  const myNotes = await showSidebarTab(page, "My notes");
  for (const title of [d1, d2]) await expect(noteLink(myNotes, title)).toBeVisible({ timeout: 15_000 });
});

test("regular group member (no delete permission) ticks a group note -> delete button disabled, \"Copy to\" clickable", async ({ browser }) => {
  test.setTimeout(120_000);
  const groupName = `E2E Sel P ${RUN}`;
  const title = `E2E Sel P1 ${RUN}`;
  const member = { email: randomEmail(), password: PASSWORD, displayName: "E2E Sel Member" };
  const contexts: BrowserContext[] = [];
  try {
    const admin = await adminSession(browser);
    contexts.push(admin.context);
    await createUserViaInvite(admin.page, member);
    const groupId = await apiCreateGroup(admin.page, groupName);
    await apiAddMember(admin.page, groupId, member.email);
    await apiCreateNote(admin.page, title, groupId);

    const user = await userSession(browser, member.email);
    contexts.push(user.context);
    const workspace = await showSidebarTab(user.page, "Groups");
    await expect(noteLink(workspace, title)).toBeVisible({ timeout: 15_000 });
    const panel = await startSidebarSelection(user.page);
    await toggleSelectedNote(panel, title);
    await expect(panel.getByText("1 selected", { exact: true })).toBeVisible();
    const bar = actionBar(user.page);
    await expect(bar.getByRole("button", { name: "Copy to", exact: true })).toBeEnabled();
    await expect(bar.getByRole("button", { name: "Delete 1 selected item", exact: true })).toBeDisabled();
  } finally {
    for (const context of contexts) await context.close();
  }
});

test("multi-select: a role that can delete but not edit ticks two group notes and deletes -> the toast has no \"Undo\" and carries an explanatory sentence", async ({ browser }) => {
  test.setTimeout(120_000);
  const groupName = `E2E Sel X ${RUN}`;
  const [x1, x2] = [1, 2].map((i) => `E2E Sel X${i} ${RUN}`) as [string, string];
  const deleter = { email: randomEmail(), password: PASSWORD, displayName: "E2E Sel Deleter" };
  const contexts: BrowserContext[] = [];
  try {
    const admin = await adminSession(browser);
    contexts.push(admin.context);
    await createUserViaInvite(admin.page, deleter);
    const groupId = await apiCreateGroup(admin.page, groupName);
    const roleId = await apiCreateDeleteOnlyRole(admin.page, groupId, "DeleteOnly");
    await apiAddMember(admin.page, groupId, deleter.email, roleId);
    for (const title of [x1, x2]) await apiCreateNote(admin.page, title, groupId);

    const user = await userSession(browser, deleter.email);
    contexts.push(user.context);
    const workspace = await showSidebarTab(user.page, "Groups");
    for (const title of [x1, x2]) await expect(noteLink(workspace, title)).toBeVisible({ timeout: 15_000 });
    const panel = await startSidebarSelection(user.page);
    await toggleSelectedNote(panel, x1);
    await toggleSelectedNote(panel, x2);
    await actionBar(user.page).getByRole("button", { name: "Delete 2 selected items", exact: true }).click();

    const trashed = toastWithTitle(user.page, "Moved 2 notes to the trash");
    await expect(trashed).toBeVisible({ timeout: 15_000 });
    await expect(trashed.getByText(NO_UNDO_HINT, { exact: true })).toBeVisible();
    await expect(trashed.getByRole("button", { name: "Undo" })).toHaveCount(0);
  } finally {
    for (const context of contexts) await context.close();
  }
});

test("Recent tab's action bar has no \"Move to\"; the Shared with me tab has \"Copy to\" and \"Move to\" (no shared folder -> disabled) and no delete button", async ({ browser }) => {
  test.setTimeout(120_000);
  const recentTitle = `E2E Sel R ${RUN}`;
  const sharedTitle = `E2E Sel S ${RUN}`;
  const guest = { email: randomEmail(), password: PASSWORD, displayName: "E2E Sel Guest" };
  const contexts: BrowserContext[] = [];
  try {
    const admin = await adminSession(browser);
    contexts.push(admin.context);
    await createUserViaInvite(admin.page, guest);
    const sharedId = await apiCreateNote(admin.page, sharedTitle);
    const share = await admin.page.request.put(`/api/notes/${sharedId}/shares`, { data: { email: guest.email, role: "viewer" } });
    expect(share.ok(), `PUT /api/notes/${sharedId}/shares → ${share.status()} ${await share.text()}`).toBe(true);
    await apiCreateNote(admin.page, recentTitle); // created last, so it is the first note in the Recent tab
    await admin.page.goto("/");

    await showSidebarTab(admin.page, "Recent");
    const recentPanel = await startSidebarSelection(admin.page);
    await toggleSelectedNote(recentPanel, recentTitle);
    const adminBar = actionBar(admin.page);
    await expect(adminBar.getByRole("button", { name: "Copy to", exact: true })).toBeEnabled();
    await expect(adminBar.getByRole("button", { name: "Delete 1 selected item", exact: true })).toBeEnabled();
    await expect(adminBar.getByRole("button", { name: "Move to" })).toHaveCount(0);

    // B's Shared with me tab: copy to is clickable; move to (only between the user's own shared folders) - B has no shared folder and that note is at the root -> disabled; no delete button
    const user = await userSession(browser, guest.email);
    contexts.push(user.context);
    const shared = await showSidebarTab(user.page, "Shared with me");
    await expect(noteLink(shared, sharedTitle)).toBeVisible({ timeout: 15_000 });
    const sharedPanel = await startSidebarSelection(user.page);
    await toggleSelectedNote(sharedPanel, sharedTitle);
    const userBar = actionBar(user.page);
    await expect(userBar.getByRole("button", { name: "Copy to", exact: true })).toBeEnabled();
    await expect(userBar.getByRole("button", { name: "Move to", exact: true })).toBeDisabled();
    // The delete button of Shared with me renders only when everything selected is folders ("Remove selected folders"); with notes only selected -> none.
    await expect(userBar.getByRole("button", { name: DELETE_SELECTED })).toHaveCount(0);
    await expect(userBar.getByRole("button", { name: /^Remove \d+ selected folders?$/ })).toHaveCount(0);
  } finally {
    for (const context of contexts) await context.close();
  }
});

test("700-wide drawer - the action bar fits in the drawer; Esc only ends selection, the drawer stays open, focus returns to \"Select\" inside the drawer", async ({ page }) => {
  test.setTimeout(120_000);
  const title = `E2E Sel W ${RUN}`;
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);
  await apiCreateNote(page, title);
  await page.setViewportSize({ width: 700, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open sidebar" }).click();
  const drawer = page.getByRole("dialog", { name: "Navigation" });
  await expect(drawer).toBeVisible();
  const myNotes = await showSidebarTab(page, "My notes", drawer);
  await expect(noteLink(myNotes, title)).toBeVisible({ timeout: 15_000 });

  const panel = await startSidebarSelection(page, drawer);
  await toggleSelectedNote(panel, title);
  const bar = actionBar(page, drawer);
  await expect(bar).toBeVisible();
  // All three buttons are inside the drawer's box (the delete button was once squeezed out of the card); the page has no horizontal scroll.
  const drawerBox = await drawer.boundingBox();
  expect(drawerBox).not.toBeNull();
  for (const name of ["Move to", "Copy to", "Delete 1 selected item"]) {
    const button = bar.getByRole("button", { name, exact: true });
    await expect(button).toBeVisible();
    await expect(button).toHaveText("");
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x, name).toBeGreaterThanOrEqual(drawerBox!.x);
    expect(box!.x + box!.width, name).toBeLessThanOrEqual(drawerBox!.x + drawerBox!.width);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(700);

  await expect(noteCheckbox(panel, title)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeVisible();
  await expectSelectionEnded(panel);
  await expect(drawer.locator("button[data-sidebar-select]")).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 800 });
});

test("wide form (1280): entering select mode while the list is scrolled mid-way does not change the scroll position", async ({ page }) => {
  test.setTimeout(120_000);
  const titles = Array.from({ length: 30 }, (_, i) => `E2E Sel L${String(i + 1).padStart(2, "0")} ${RUN}`);
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);
  for (const title of titles) await apiCreateNote(page, title);
  // A shorter viewport: even when this case runs alone (admin has only these 30 notes) the list is certainly scrollable.
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto("/");
  await expectWidePointer(page, true);

  const sidebar = page.getByRole("complementary");
  const myNotes = await showSidebarTab(page, "My notes");
  await expect(noteLink(myNotes, titles[0]!)).toBeVisible({ timeout: 15_000 });
  const list = sidebar.locator("[data-sidebar-list]");
  // In the wide form, entering selection hides the bottom (New note) and the list's visible height grows by about one row, so the scrollable range shrinks:
  // scrolled to the very bottom it would be clamped back by the browser (a known trade-off), so the wide form checks "scrolled mid-way". The scrollable range must be much more than one row, so the middle does not fall into the shrunken part.
  await expect.poll(() => list.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(200);
  await list.evaluate((el) => {
    el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) / 2);
  });
  const before = await list.evaluate((el) => el.scrollTop);
  expect(before).toBeGreaterThan(100);

  await startSidebarSelection(page);
  await expect(list.getByRole("checkbox").first()).toBeAttached(); // the checkbox tree is swapped in once its chunk arrives (scoped to the list so the header select-all box does not count)
  await expect(sidebar.getByRole("button", { name: "New note", exact: true })).toHaveCount(0); // precondition: the bottom row ("New note") is no longer shown
  await expect(async () => {
    expect(await list.evaluate((el) => el.scrollTop)).toBe(before);
  }).toPass({ timeout: 5_000 });
});

test("narrow form (390 phone list): entering select mode while the list is scrolled to the bottom does not change the scroll position (the bottom row is replaced by an action bar of the same height)", async ({ page }) => {
  test.setTimeout(120_000);
  const titles = Array.from({ length: 30 }, (_, i) => `E2E Sel B${String(i + 1).padStart(2, "0")} ${RUN}`);
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);
  for (const title of titles) await apiCreateNote(page, title);
  // A short narrow viewport: even when this case runs alone (admin has only these 30 notes) the phone list is certainly scrollable.
  await page.setViewportSize({ width: 390, height: 600 });
  await page.goto("/");
  await expectWidePointer(page, false);
  const drawer = await openListOnCompact(page);
  const myNotes = await showSidebarTab(page, "My notes", drawer);
  await expect(noteLink(myNotes, titles[0]!)).toBeVisible({ timeout: 15_000 });
  const list = drawer.locator("[data-sidebar-list]");
  // On a phone the document scrolls (the list container does not scroll itself): scroll to the end of the document.
  const pageScrollY = () => page.evaluate(() => window.scrollY);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBeGreaterThan(100);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const before = await pageScrollY();
  expect(before).toBeGreaterThan(100);

  await startSidebarSelection(page, drawer);
  await expect(list.getByRole("checkbox").first()).toBeAttached(); // the checkbox tree is swapped in once its chunk arrives (scoped to the list so the header select-all box does not count)
  await expect(actionBar(page, drawer)).toBeVisible(); // the bottom action bar replaces a placeholder of the same height
  // On entering select mode the scroll position is exactly unchanged; the action bar is pinned to the viewport bottom and the last list row is still above it (the list's bottom padding is always there).
  await expect(async () => {
    expect(await pageScrollY()).toBe(before);
    const last = await list.locator('[data-node-kind="note"]').last().boundingBox();
    const bar = await actionBar(page, drawer).boundingBox();
    expect(last!.y + last!.height).toBeLessThanOrEqual(bar!.y);
  }).toPass({ timeout: 5_000 });
});

test("scope of Esc - with focus on body it ends selection; inside the title input it does not; with a toast open the first press only closes the toast", async ({ page }) => {
  test.setTimeout(150_000);
  const keep = `E2E Sel Esc K ${RUN}`;
  const opened = `E2E Sel Esc T ${RUN}`;
  const doomed = `E2E Sel Esc D ${RUN}`;
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);
  for (const title of [keep, opened, doomed]) await apiCreateNote(page, title);
  await page.goto("/");

  let myNotes = await showSidebarTab(page, "My notes");
  await expect(noteLink(myNotes, keep)).toBeVisible({ timeout: 15_000 });
  let panel = await startSidebarSelection(page);
  await toggleSelectedNote(panel, keep);
  await clickMainBlank(page);
  // Focus is on body here, not still in the sidebar: this is the code path under test.
  expect(await activeIsBody(page)).toBe(true);
  await expect(panel.getByText("1 selected", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expectSelectionEnded(panel);
  await expect(panel.locator("button[data-sidebar-select]")).toBeFocused();

  // The order is fixed because entering a note page makes AppShell swap shells and resets selection: open the note first, wait for the title input, then enter selection -> Esc inside the title input does not end selection
  await noteLink(myNotes, opened).click();
  const titleInput = page.getByRole("textbox", NOTE_TITLE);
  await expect(titleInput).toHaveValue(opened, { timeout: 15_000 });
  myNotes = await showSidebarTab(page, "My notes");
  panel = await startSidebarSelection(page);
  await toggleSelectedNote(panel, keep);
  await titleInput.click();
  await page.keyboard.type("x");
  await expect(titleInput).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(titleInput).toBeFocused();
  await expect(panel.getByText("1 selected", { exact: true })).toBeVisible();
  await expect(noteCheckbox(panel, keep)).toBeChecked();

  await page.goto("/");
  myNotes = await showSidebarTab(page, "My notes");
  await expect(noteLink(myNotes, doomed)).toBeVisible({ timeout: 15_000 });
  panel = await startSidebarSelection(page);
  await toggleSelectedNote(panel, doomed);
  await actionBar(page).getByRole("button", { name: "Delete 1 selected item", exact: true }).click();
  const toast = toastWithTitle(page, "Moved 1 note to the trash");
  await expect(toast).toBeVisible({ timeout: 15_000 });
  await expectSelectionEnded(panel);

  panel = await startSidebarSelection(page);
  await toggleSelectedNote(panel, keep);
  await clickMainBlank(page);
  expect(await activeIsBody(page)).toBe(true);
  // Precondition: the toast is still open (5 seconds; on a slow CI it fails here and is not misread as "left selection").
  await expect(toast).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(toast).toBeHidden();
  await expect(panel.getByText("1 selected", { exact: true })).toBeVisible();
  await expect(noteCheckbox(panel, keep)).toBeChecked();
  await page.keyboard.press("Escape");
  await expectSelectionEnded(panel);
});
