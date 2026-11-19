import { devices, expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import {
  ADMIN,
  createNote,
  createUserViaInvite,
  expectWidePointer,
  loginAs,
  openListOnCompact,
  moveNoteToTrashFromSidebar,
  noteIdFromUrl,
  randomEmail,
  reEscape,
  showSidebarTab,
  startSidebarSelection,
  toastWithTitle,
  toggleSelectedNote,
} from "./helpers.js";

/**
 * Removing a favorite asks for confirmation (sidebar kebab, row star, header star, select-mode action bar); cancel keeps it and there is no Undo after confirming; a single-row removal moves focus to the adjacent row. Adding does not confirm. A favorite moved to the trash disappears from the sidebar and the toast's Undo restores it in place. Favorites are per user.
 * Row star: Tab order is link, kebab, star; a hollow star shows only on hover or keyboard focus; on touch devices rows not yet added have no star; select mode, folder rows and the trash have no star. The row star and the header star share the name (Favorite), so header lookups are scoped to `<header>`.
 *
 * Every test uses freshly created accounts (alice, bob, carol plus the RUN suffix), so the favorites list is not affected by other specs; groups and notes are left in place (the stack is reset by `stack:down -v` each time).
 * All button lookups use `exact: true`: Playwright's default is a case-insensitive substring match, so "Favorite" would also match "Add to favorites" and "Remove from favorites".
 */

const RUN = Date.now();
const PASSWORD = "e2e-favorites-user-pw";
const NOTE_TITLE = { name: "Note title" } as const;
const EMPTY_FAVORITES = "No favorites yet. Click the star at the top of a note, or choose Add to favorites in its ⋮ menu.";

interface Account {
  email: string;
  displayName: string;
}

async function createAccount(browser: Browser, name: string): Promise<Account> {
  const account: Account = { email: randomEmail(), displayName: `${name} ${RUN}` };
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await createUserViaInvite(page, { ...account, password: PASSWORD });
  } finally {
    await context.close();
  }
  return account;
}

async function openAs(browser: Browser, account: Account, viewport?: { width: number; height: number }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(viewport ? { viewport } : undefined);
  const page = await context.newPage();
  await loginAs(page, account.email, PASSWORD);
  return { context, page };
}

function noteLink(scope: Locator, title: string): Locator {
  return scope.getByRole("link", { name: new RegExp("^" + reEscape(title)) });
}

function favoriteRow(title: string, location: string): RegExp {
  return new RegExp("^" + reEscape(title) + "\\s*" + reEscape(location) + "$");
}

function star(page: Page): Locator {
  // The header star. Each sidebar row also has a star with the same name (Favorite), so scope to `<header>`.
  return page.locator("header").getByRole("button", { name: "Favorite", exact: true });
}

/** After a full page load of a note page, wait for the title box first: the lazy note page's fallback shell replaces the sidebar and resets the drawer. */
async function waitForNoteTitle(page: Page, title: string): Promise<void> {
  await expect(page.getByRole("textbox", NOTE_TITLE)).toHaveValue(title, { timeout: 15_000 });
}

async function openNoteFromSidebar(page: Page, tab: "My notes" | "Favorites", title: string): Promise<void> {
  const panel = await showSidebarTab(page, tab);
  await noteLink(panel, title).click();
  await waitForNoteTitle(page, title);
}

async function waitViewerConnected(page: Page, title: string): Promise<void> {
  await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("status").filter({ hasText: /^Read-only/ })).toBeVisible({ timeout: 15_000 });
}

test("header star and sidebar kebab: add, sort by time, remove after confirming, move to trash and restore", async ({ browser }) => {
  test.setTimeout(150_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice);
  try {
    const a = `E2E fav A ${RUN}`;
    const b = `E2E fav B ${RUN}`;
    await createNote(page, a);
    await createNote(page, b);

    await expect(star(page)).toBeEnabled();
    await expect(star(page)).toHaveAttribute("aria-pressed", "false");
    await star(page).click();
    await expect(star(page)).toHaveAttribute("aria-pressed", "true");
    await openNoteFromSidebar(page, "My notes", a);
    await expect(star(page)).toHaveAttribute("aria-pressed", "false");
    await star(page).click();
    await expect(star(page)).toHaveAttribute("aria-pressed", "true");

    const favorites = await showSidebarTab(page, "Favorites");
    await expect(favorites.getByRole("link")).toHaveText([favoriteRow(a, "My notes"), favoriteRow(b, "My notes")]);

    const actionsB = favorites.getByRole("button", { name: `Note actions for ${b}`, exact: true });
    await actionsB.locator("xpath=ancestor::li[1]").hover();
    await actionsB.click();
    await page.getByRole("menuitem", { name: "Remove from favorites", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(noteLink(favorites, b)).toBeVisible();

    await actionsB.locator("xpath=ancestor::li[1]").hover();
    await actionsB.click();
    await page.getByRole("menuitem", { name: "Remove from favorites", exact: true }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(noteLink(favorites, b)).toHaveCount(0, { timeout: 15_000 });
    await expect(noteLink(favorites, a)).toBeFocused();
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);

    await expect(star(page)).toHaveAttribute("aria-pressed", "true");
    await star(page).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(star(page)).toHaveAttribute("aria-pressed", "false");
    await expect(dialog).toBeHidden();
    await star(page).click();
    await expect(star(page)).toHaveAttribute("aria-pressed", "true");
    await expect(dialog).toHaveCount(0);

    // Keep B open (moving the open note to the trash from the sidebar navigates home, so don't stay on A), add B again; move A to the trash from the Favorites tab, and Undo returns it in place.
    await openNoteFromSidebar(page, "My notes", b);
    await expect(star(page)).toHaveAttribute("aria-pressed", "false");
    await star(page).click();
    await expect(star(page)).toHaveAttribute("aria-pressed", "true");
    await showSidebarTab(page, "Favorites");
    await expect(favorites.getByRole("link")).toHaveText([favoriteRow(b, "My notes"), favoriteRow(a, "My notes")]);

    const toast = await moveNoteToTrashFromSidebar(page, a);
    await expect(noteLink(favorites, a)).toHaveCount(0);
    await expect(favorites.getByRole("link")).toHaveText([favoriteRow(b, "My notes")]);
    await toast.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(favorites.getByRole("link")).toHaveText([favoriteRow(b, "My notes"), favoriteRow(a, "My notes")], { timeout: 15_000 });
  } finally {
    await context.close();
  }
});

test("favorites are per user: bob of the same group does not see a group note alice added", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const bob = await createAccount(browser, "bob");
  const a = await openAs(browser, alice);
  const b = await openAs(browser, bob);
  try {
    const groupRes = await a.page.request.post("/api/groups", { data: { name: `E2E fav group ${RUN}` } });
    expect(groupRes.status(), await groupRes.text()).toBe(201);
    const groupId = ((await groupRes.json()) as { id: string }).id;
    const added = await a.page.request.put(`/api/groups/${groupId}/members`, { data: { email: bob.email } });
    expect(added.status(), await added.text()).toBeLessThan(300);
    const title = `E2E fav C ${RUN}`;
    const created = await a.page.request.post("/api/notes", { data: { title, groupId } });
    expect(created.status(), await created.text()).toBe(201);
    const note = (await created.json()) as { id: string; slug: string };

    await a.page.goto(`/g/${groupId}/${note.slug}`);
    await waitForNoteTitle(a.page, title);
    await expect(star(a.page)).toBeEnabled();
    await star(a.page).click();
    await expect(star(a.page)).toHaveAttribute("aria-pressed", "true");
    const mine = await showSidebarTab(a.page, "Favorites");
    await expect(mine.getByRole("link")).toHaveText([favoriteRow(title, `Groups › E2E fav group ${RUN}`)]);

    const readable = await b.page.request.get(`/api/notes/${note.id}`);
    expect(readable.status()).toBe(200);
    const theirs = await showSidebarTab(b.page, "Favorites");
    await expect(theirs.getByText(EMPTY_FAVORITES)).toBeVisible({ timeout: 15_000 });
    await expect(noteLink(theirs, title)).toHaveCount(0);
    const list = await b.page.request.get("/api/favorites");
    expect(await list.json()).toEqual([]);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test("narrow widths: all six tabs fit in the 390 phone list and with the sidebar narrowed to its minimum", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice, { width: 390, height: 844 });
  try {
    const drawer = await openListOnCompact(page);
    const drawerTabs = drawer.getByRole("tablist", { name: "Sidebar sections" });
    await expect(drawerTabs.getByRole("tab")).toHaveCount(6);
    const overflow = await drawerTabs.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
    expect(overflow.scrollWidth, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.clientWidth);

    // The static sidebar needs a viewport >= 1280: switch to 1280x800 and drag the separator all the way to the narrowest.
    await page.setViewportSize({ width: 1280, height: 800 });
    const sidebar = page.getByRole("complementary");
    const handle = page.getByRole("separator", { name: "Resize sidebar" });
    await expect(handle).toBeVisible();
    const box = (await handle.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 100, y, { steps: 5 });
    await page.mouse.move(x - 300, y, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => (await sidebar.boundingBox())!.width, { timeout: 5_000 }).toBeLessThanOrEqual(201);

    const tablist = sidebar.getByRole("tablist", { name: "Sidebar sections" });
    const tabs = tablist.getByRole("tab");
    await expect(tabs).toHaveCount(6);
    const listBox = (await tablist.boundingBox())!;
    for (let i = 0; i < 6; i += 1) {
      const tabBox = (await tabs.nth(i).boundingBox())!;
      const name = await tabs.nth(i).innerText();
      expect(tabBox.x, `tab ${i} (${name}) left`).toBeGreaterThanOrEqual(listBox.x - 0.5);
      expect(tabBox.x + tabBox.width, `tab ${i} (${name}) right`).toBeLessThanOrEqual(listBox.x + listBox.width + 0.5);
    }
  } finally {
    await context.close();
  }
});

test("390 wide header: star, share and kebab are not clipped nor pushed into the right padding; keyboard toggling keeps focus; at 320 wide the star collapses and entry is through the kebab", async ({ browser }) => {
  test.setTimeout(150_000);
  const alice = await createAccount(browser, "alice");
  const bob = await createAccount(browser, "bob");
  const carol = await createAccount(browser, "carol");
  const a = await openAs(browser, alice);
  const others: BrowserContext[] = [];
  try {
    const title = `E2E fav header ${RUN}`;
    await createNote(a.page, title);
    const noteUrl = a.page.url();
    const noteId = await noteIdFromUrl(a.page);
    for (const who of [bob, carol]) {
      const shared = await a.page.request.put(`/api/notes/${noteId}/shares`, { data: { email: who.email, role: "viewer" } });
      expect(shared.status(), await shared.text()).toBe(200);
      const other = await openAs(browser, who);
      others.push(other.context);
      await other.page.goto(noteUrl);
      await waitViewerConnected(other.page, title);
    }

    const page = a.page;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(noteUrl);
    await waitForNoteTitle(page, title);
    // Two other viewers: at phone width presence collapses to a single "+2".
    await expect(page.getByRole("group", { name: "Also viewing this note" }).getByRole("button", { name: "2 more, show everyone" })).toHaveCount(1, { timeout: 15_000 });
    await expect(star(page)).toBeEnabled();

    const share = page.getByRole("button", { name: "Share", exact: true });
    const more = page.getByRole("button", { name: "More", exact: true });
    await expect(share).toBeVisible();
    await expect(more).toBeVisible();
    await expect(star(page)).toBeVisible();

    const frames = await star(page).evaluate((el) => {
      const header = el.closest("header")!;
      // The nearest ancestor that clips horizontally (from 640 up it is the content card; on a phone the card doesn't clip, the document scrolls, and the outer frame's overflow-x: clip does the clipping).
      let card: Element | null = header.parentElement;
      while (card && !["hidden", "clip"].includes(getComputedStyle(card).overflowX)) card = card.parentElement;
      const style = getComputedStyle(header);
      return {
        cardRight: card ? card.getBoundingClientRect().right : null,
        contentRight: header.getBoundingClientRect().right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth),
      };
    });
    expect(frames.cardRight, "沒有找到橫向會裁切的祖先").not.toBeNull();
    for (const [name, button] of [["Favorite", star(page)], ["Share", share], ["More", more]] as const) {
      const box = (await button.boundingBox())!;
      const right = box.x + box.width;
      const measured = JSON.stringify({ name, box, ...frames });
      expect(right, `${name} 被卡片裁掉 ${measured}`).toBeLessThanOrEqual(frames.cardRight! + 0.5);
      expect(right, `${name} 擠進頁首右內距 ${measured}`).toBeLessThanOrEqual(frames.contentRight + 0.5);
    }

    await page.getByRole("textbox", NOTE_TITLE).focus();
    const isFocused = () => star(page).evaluate((el) => el === document.activeElement);
    for (let i = 0; i < 12 && !(await isFocused()); i += 1) {
      await page.keyboard.press("Tab");
    }
    await expect(star(page)).toBeFocused();
    await expect(star(page)).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.press("Space");
    await expect(star(page)).toHaveAttribute("aria-pressed", "true");
    await expect(star(page)).toBeFocused();

    await page.setViewportSize({ width: 320, height: 700 });
    await expect(star(page)).toBeHidden();
    await more.click();
    await expect(page.getByRole("menuitem").first()).toHaveAccessibleName("Remove from favorites");
  } finally {
    await a.context.close();
    for (const context of others) await context.close();
  }
});

test("the public share page has no star", async ({ browser }) => {
  test.setTimeout(90_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice);
  const anonymous = await browser.newContext();
  try {
    const title = `E2E fav public ${RUN}`;
    await createNote(page, title);
    const noteId = await noteIdFromUrl(page);
    await expect(star(page)).toBeVisible();
    const published = await page.request.put(`/api/notes/${noteId}/public-link`);
    expect(published.status(), await published.text()).toBe(200);
    const { token } = (await published.json()) as { token: string };

    const publicPage = await anonymous.newPage();
    await publicPage.goto(`/p/${token}`);
    await expect(publicPage.getByRole("heading", { name: title, level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(star(publicPage)).toHaveCount(0);
  } finally {
    await anonymous.close();
    await context.close();
  }
});

/** Creates a note via the API and adds it to favorites (called in order, so later ones come first in the Favorites tab); returns the id. */
async function apiCreateFavorite(page: Page, title: string): Promise<string> {
  const created = await page.request.post("/api/notes", { data: { title } });
  expect(created.status(), await created.text()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  const added = await page.request.put(`/api/favorites/${id}`);
  expect(added.status(), await added.text()).toBe(200);
  return id;
}

function actionBar(scope: Locator): Locator {
  return scope.locator("[data-select-action-bar]");
}

test("Favorites tab select mode: check two notes and remove them (confirm first, no Undo, no Move to); after removing all, focus stays in the panel", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice);
  try {
    await expectWidePointer(page, true);
    const titles = [1, 2, 3].map((n) => `E2E fav select ${n} ${RUN}`);
    for (const title of titles) await apiCreateFavorite(page, title);
    await page.goto("/");

    const sidebar = page.getByRole("complementary");
    const panel = await showSidebarTab(page, "Favorites");
    await expect(panel.getByRole("link")).toHaveText([favoriteRow(titles[2]!, "My notes"), favoriteRow(titles[1]!, "My notes"), favoriteRow(titles[0]!, "My notes")]);

    await startSidebarSelection(page);
    await toggleSelectedNote(panel, titles[2]!);
    await toggleSelectedNote(panel, titles[0]!);
    await expect(panel.getByText("2 selected", { exact: true })).toBeVisible();
    const bar = actionBar(sidebar);
    await expect(bar.getByRole("button", { name: "Remove from favorites", exact: true })).toBeEnabled();
    await expect(bar.getByRole("button", { name: "Copy to", exact: true })).toBeVisible();
    await expect(bar.getByRole("button", { name: /^Move to/ })).toHaveCount(0);

    await bar.getByRole("button", { name: "Remove from favorites", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Remove 2 notes from favorites?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(toastWithTitle(page, "Removed 2 notes from favorites")).toBeVisible({ timeout: 15_000 });
    await expect(dialog).toBeHidden();
    await expect(panel.getByRole("link")).toHaveText([favoriteRow(titles[1]!, "My notes")]);
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);
    await expect(panel.getByRole("checkbox")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Select", exact: true })).toBeFocused();
    const afterFirst = await page.request.get("/api/favorites");
    expect(((await afterFirst.json()) as Array<{ noteId: string }>).length).toBe(1);

    await startSidebarSelection(page);
    await toggleSelectedNote(panel, titles[1]!);
    await bar.getByRole("button", { name: "Remove from favorites", exact: true }).click();
    await page.getByRole("dialog", { name: "Remove 1 note from favorites?" }).getByRole("button", { name: "Remove", exact: true }).click();
    await expect(panel.getByText(EMPTY_FAVORITES)).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByRole("button", { name: "Select", exact: true })).toBeDisabled();
    await expect(panel).toBeFocused();
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
    const afterAll = await page.request.get("/api/favorites");
    expect(await afterAll.json()).toEqual([]);
  } finally {
    await context.close();
  }
});

test("Favorites tab select mode: the 390 phone list's action bar confirms before removing", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice, { width: 390, height: 844 });
  try {
    await expectWidePointer(page, false);
    const titles = [1, 2].map((n) => `E2E fav drawer ${n} ${RUN}`);
    for (const title of titles) await apiCreateFavorite(page, title);
    await page.goto("/");

    const drawer = await openListOnCompact(page);
    const panel = await showSidebarTab(page, "Favorites", drawer);
    await expect(panel.getByRole("link")).toHaveCount(2);
    await startSidebarSelection(page, drawer);
    await toggleSelectedNote(panel, titles[0]!);

    const bar = actionBar(drawer);
    await expect(bar.getByRole("button", { name: "Copy to", exact: true })).toBeVisible();
    // The narrow buttons hold only icons: the accessible name is there, visible text is not.
    for (const name of ["Remove from favorites", "Copy to"]) await expect(bar.getByRole("button", { name, exact: true })).toHaveText("");
    await expect(bar.getByRole("button", { name: /^Move to/ })).toHaveCount(0);
    await bar.getByRole("button", { name: "Remove from favorites", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Remove 1 note from favorites?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(toastWithTitle(page, "Removed 1 note from favorites")).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByRole("link")).toHaveText([favoriteRow(titles[1]!, "My notes")]);
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("Recent tab select mode: after deleting the whole list, focus lands in the panel and not on body", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice);
  try {
    await expectWidePointer(page, true);
    for (const n of [1, 2]) {
      const created = await page.request.post("/api/notes", { data: { title: `E2E recent delete ${n} ${RUN}` } });
      expect(created.status(), await created.text()).toBe(201);
    }
    await page.goto("/");

    const panel = await showSidebarTab(page, "Recent");
    await startSidebarSelection(page);
    // The new account's Recent list holds only these two notes, so Select all empties it.
    await panel.getByRole("checkbox", { name: "Select all", exact: true }).click();
    await expect(panel.getByText("2 selected", { exact: true })).toBeVisible();
    await actionBar(page.getByRole("complementary")).getByRole("button", { name: "Delete 2 selected items", exact: true }).click();
    await expect(toastWithTitle(page, "Moved 2 notes to the trash")).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByRole("link")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Select", exact: true })).toBeDisabled();
    await expect(panel).toBeFocused();
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
  } finally {
    await context.close();
  }
});

async function apiCreateNote(page: Page, title: string): Promise<string> {
  const created = await page.request.post("/api/notes", { data: { title } });
  expect(created.status(), await created.text()).toBe(201);
  return ((await created.json()) as { id: string }).id;
}

function noteRowOf(panel: Locator, title: string): Locator {
  return panel.locator('li[data-node-kind="note"]').filter({ has: panel.page().getByRole("link", { name: new RegExp("^" + reEscape(title)) }) });
}

function rowStar(row: Locator): Locator {
  return row.getByRole("button", { name: "Favorite", exact: true });
}

test("row star (mouse): the hollow star appears only on hover and clicking adds it as a solid star; in the Favorites tab cancel keeps it and after confirming focus lands on a neighbouring row", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice);
  try {
    await expectWidePointer(page, true);
    const loose = `E2E row star loose ${RUN}`;
    await apiCreateNote(page, loose);
    const titles = [1, 2, 3].map((n) => `E2E row star ${n} ${RUN}`);
    for (const title of titles) await apiCreateFavorite(page, title);
    await page.goto("/");

    const mine = await showSidebarTab(page, "My notes");
    const looseRow = noteRowOf(mine, loose);
    const looseStar = rowStar(looseRow);
    await expect(looseStar).toHaveAttribute("aria-pressed", "false");
    await expect(looseStar).toHaveCSS("opacity", "0");
    await looseRow.hover();
    await expect(looseStar).toHaveCSS("opacity", "1");
    await looseStar.click();
    await expect(looseStar).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(looseStar).toHaveCSS("opacity", "1");
    const favorites = await showSidebarTab(page, "Favorites");
    await expect(noteLink(favorites, loose)).toBeVisible();

    const row2 = noteRowOf(favorites, titles[1]!);
    await rowStar(row2).click();
    const dialog = page.getByRole("dialog", { name: "Remove from favorites?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(noteLink(favorites, titles[1]!)).toBeVisible();
    await expect(rowStar(row2)).toBeFocused();

    await rowStar(row2).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(noteLink(favorites, titles[1]!)).toHaveCount(0, { timeout: 15_000 });
    await expect(noteLink(favorites, titles[0]!)).toBeFocused();
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);

    await rowStar(noteRowOf(favorites, titles[0]!)).click();
    await dialog.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(noteLink(favorites, titles[0]!)).toHaveCount(0, { timeout: 15_000 });
    await expect(noteLink(favorites, titles[2]!)).toBeFocused();

    await rowStar(noteRowOf(favorites, loose)).click();
    await dialog.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(noteLink(favorites, loose)).toHaveCount(0, { timeout: 15_000 });
    await rowStar(noteRowOf(favorites, titles[2]!)).click();
    await dialog.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(favorites.getByText(EMPTY_FAVORITES)).toBeVisible({ timeout: 15_000 });
    await expect(favorites).toBeFocused();
  } finally {
    await context.close();
  }
});

test("row star (keyboard): Tab order is link, kebab, star; the focused kebab and hollow star have opacity 1; after Enter adds, focus stays on the star", async ({ browser }) => {
  test.setTimeout(90_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice);
  try {
    await expectWidePointer(page, true);
    const title = `E2E row star kbd ${RUN}`;
    await apiCreateNote(page, title);
    await page.goto("/");

    const mine = await showSidebarTab(page, "My notes");
    const row = noteRowOf(mine, title);
    const star = rowStar(row);
    const actions = row.getByRole("button", { name: `Note actions for ${title}`, exact: true });
    await expect(star).toHaveCSS("opacity", "0");
    await noteLink(mine, title).focus();
    await page.keyboard.press("Tab");
    await expect(actions).toBeFocused();
    await expect(actions).toHaveCSS("opacity", "1");
    await page.keyboard.press("Tab");
    await expect(star).toBeFocused();
    await expect(star).toHaveCSS("opacity", "1");
    await page.keyboard.press("Shift+Tab");
    await expect(actions).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(star).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(star).toHaveAttribute("aria-pressed", "true");
    await expect(star).toBeFocused();
  } finally {
    await context.close();
  }
});

test("row star (touch): rows not yet added show no star; a favorite row shows a non-clickable Favorite marker (tapping opens nothing) and removal goes through the kebab, which still offers \"Add to favorites\" on other rows", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const context = await browser.newContext({ ...devices["Pixel 5"] });
  try {
    const page = await context.newPage();
    await loginAs(page, alice.email, PASSWORD);
    await expectWidePointer(page, false);
    // Precondition: the hollow star is hidden with hover: none / pointer: coarse; this context must really be in one of them.
    expect(await page.evaluate(() => window.matchMedia("(hover: none), (pointer: coarse)").matches)).toBe(true);
    const loose = `E2E row star touch loose ${RUN}`;
    const faved = `E2E row star touch faved ${RUN}`;
    await apiCreateNote(page, loose);
    await apiCreateFavorite(page, faved);
    await page.goto("/");

    const drawer = await openListOnCompact(page);
    const mine = await showSidebarTab(page, "My notes", drawer);
    await expect(noteLink(mine, loose)).toBeVisible();
    await expect(noteLink(mine, faved)).toBeVisible();
    await expect(rowStar(noteRowOf(mine, loose))).toHaveCount(0);

    // Touch: a favorite row has no star button, only a marker that can't be clicked (role=img, name Favorite) to the left of the kebab; clicking it does nothing, and removal goes through the kebab menu.
    const favedRow = noteRowOf(mine, faved);
    await expect(rowStar(favedRow)).toHaveCount(0);
    const marker = favedRow.getByRole("img", { name: "Favorite", exact: true });
    await expect(marker).toBeVisible();
    await expect(marker).toHaveCSS("pointer-events", "none");
    const markerBox = (await marker.boundingBox())!;
    await page.mouse.click(markerBox.x + markerBox.width / 2, markerBox.y + markerBox.height / 2);
    await expect(page.getByRole("dialog", { name: "Remove from favorites?" })).toHaveCount(0);
    await expect(page.getByRole("menu")).toHaveCount(0);
    await favedRow.getByRole("button", { name: `Note actions for ${faved}`, exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "Remove from favorites", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(noteRowOf(mine, loose).getByRole("img", { name: "Favorite", exact: true })).toHaveCount(0);

    await noteRowOf(mine, loose).getByRole("button", { name: `Note actions for ${loose}`, exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "Add to favorites", exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("row star: no star in select mode, on folder rows or in the Trash tab", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice);
  try {
    await expectWidePointer(page, true);
    const folderName = `E2E row star folder ${RUN}`;
    const folderRes = await page.request.post("/api/folders", { data: { name: folderName, space: { kind: "personal" } } });
    expect(folderRes.status(), await folderRes.text()).toBe(201);
    const title = `E2E row star plain ${RUN}`;
    const trashed = `E2E row star trashed ${RUN}`;
    await apiCreateFavorite(page, title);
    await apiCreateNote(page, trashed);
    await page.goto("/");

    const mine = await showSidebarTab(page, "My notes");
    await expect(rowStar(noteRowOf(mine, title))).toBeVisible();
    const folderRow = mine.locator('li[data-node-kind="folder"]').filter({ hasText: folderName });
    await expect(folderRow).toBeVisible();
    await expect(rowStar(folderRow)).toHaveCount(0);

    const panel = await startSidebarSelection(page);
    await expect(mine.getByRole("checkbox").first()).toBeVisible();
    await expect(mine.getByRole("button", { name: "Favorite", exact: true })).toHaveCount(0);
    // The wide select bar is exited with the X "Exit selection"; "Done" only appears in the narrow select bar.
    await panel.getByRole("button", { name: "Exit selection", exact: true }).click();
    await expect(rowStar(noteRowOf(mine, title))).toBeVisible();

    await moveNoteToTrashFromSidebar(page, trashed);
    const trash = await showSidebarTab(page, "Trash");
    await expect(trash.getByText(trashed)).toBeVisible({ timeout: 15_000 });
    await expect(trash.getByRole("button", { name: "Favorite", exact: true })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("row star: with the sidebar at its narrowest, a favorite row's link still has width and the right edges of the star and kebab are inside the row", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice, { width: 1280, height: 800 });
  try {
    await expectWidePointer(page, true);
    const title = `E2E row star narrow ${RUN}`;
    await apiCreateFavorite(page, title);
    await page.goto("/");

    const sidebar = page.getByRole("complementary");
    const handle = page.getByRole("separator", { name: "Resize sidebar" });
    await expect(handle).toBeVisible();
    const box = (await handle.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 100, y, { steps: 5 });
    await page.mouse.move(x - 300, y, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => (await sidebar.boundingBox())!.width, { timeout: 5_000 }).toBeLessThanOrEqual(201);

    const panel = await showSidebarTab(page, "Favorites");
    const row = noteRowOf(panel, title);
    await expect(row).toBeVisible();
    const link = noteLink(panel, title);
    const star = rowStar(row);
    const actions = row.getByRole("button", { name: `Note actions for ${title}`, exact: true });
    await row.hover();
    const rowBox = (await row.boundingBox())!;
    const linkBox = (await link.boundingBox())!;
    const starBox = (await star.boundingBox())!;
    const actionsBox = (await actions.boundingBox())!;
    const rowRight = rowBox.x + rowBox.width;
    expect(linkBox.width, JSON.stringify({ linkBox, rowBox })).toBeGreaterThan(0);
    expect(starBox.x + starBox.width, JSON.stringify({ starBox, rowBox })).toBeLessThanOrEqual(rowRight + 0.5);
    expect(actionsBox.x + actionsBox.width, JSON.stringify({ actionsBox, rowBox })).toBeLessThanOrEqual(rowRight + 0.5);
  } finally {
    await context.close();
  }
});
