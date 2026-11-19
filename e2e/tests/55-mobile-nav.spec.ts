import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import {
  ADMIN,
  createUserViaInvite,
  editorLocator,
  folderRow,
  loginAs,
  randomEmail,
  reEscape,
  showSidebarTab,
  tapAreaOf,
  waitForEditorSelection,
} from "./helpers.js";

/**
 * Phone navigation (viewport narrower than 640): the list is home and a note is a layer on top of it.
 *
 * Cases are numbered 55-1 to 55-12 in their titles. 55-5: 639 is a phone (chevron, no sidebar button), 640 and 1279 have the floating sidebar and 1280 the fixed one; crossing 640 closes the search layer and the drawer respectively.
 * 55-7: owners and group members have the bottom bar; group viewers and notes shared with me do not, and clicking the body of a read-only note does not affect it. 55-10: tap areas are also printed as MEASURE lines.
 *
 * Not verifiable in desktop Chromium: the on-screen keyboard pushing the bottom bar up (visualViewport), the notch and home-indicator safe area (only class and CSS text can be checked, see unit tests),
 * the actual look of slide-in transitions, and the tap area of a real finger. These need a real device.
 *
 * Every test uses fresh accounts (alice, bob plus the RUN suffix); data is created via the API and only then is the viewport shrunk to phone width (create data in a wide viewport, operate in a narrow one).
 */

const RUN = Date.now();
const PASSWORD = "e2e-mobile-nav-pw";
const PHONE = { width: 390, height: 844 } as const;

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

async function openAs(browser: Browser, account: Account, viewport: { width: number; height: number } = PHONE): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await loginAs(page, account.email, PASSWORD);
  await expect(page).toHaveURL(/\/$/);
  return { context, page };
}

async function openTouchAs(browser: Browser, account: Account): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: PHONE });
  const page = await context.newPage();
  await loginAs(page, account.email, PASSWORD);
  await expect(page).toHaveURL(/\/$/);
  return { context, page };
}

interface Created {
  id: string;
  slug: string;
  ownerHandle: string | null;
}

async function apiNote(page: Page, title: string, place: { groupId?: string; folderId?: string; content?: string } = {}): Promise<Created> {
  const res = await page.request.post("/api/notes", { data: { title, ...place } });
  expect(res.status(), `POST /api/notes → ${res.status()} ${await res.text()}`).toBe(201);
  return (await res.json()) as Created;
}

async function apiFolder(page: Page, name: string, parent: { parentId: string } | { space: { kind: "personal" } | { kind: "group"; groupId: string } }): Promise<string> {
  const res = await page.request.post("/api/folders", { data: { name, ...parent } });
  expect(res.status(), `POST /api/folders → ${res.status()} ${await res.text()}`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function apiGroup(page: Page, name: string): Promise<string> {
  const res = await page.request.post("/api/groups", { data: { name } });
  expect(res.status(), `POST /api/groups → ${res.status()} ${await res.text()}`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

const pathOf = (note: Created, groupId?: string): string => (groupId === undefined ? `/n/${note.ownerHandle}/${note.slug}` : `/g/${groupId}/${note.slug}`);

/** The title box uses an attribute selector: while the drawer (Radix modal) is open the background is aria-hidden and a role query can't find it. */
const titleBox = (page: Page): Locator => page.locator('[aria-label="Note title"]');
const backButton = (page: Page): Locator => page.getByRole("button", { name: "Back to notes", exact: true });
const openSidebar = (page: Page): Locator => page.getByRole("button", { name: "Open sidebar", exact: true });
const listBar = (page: Page): Locator => page.locator("[data-phone-list-bar]");
const fabs = (page: Page): Locator => page.locator("[data-phone-list-fabs]");
const searchFab = (page: Page): Locator => fabs(page).getByRole("button", { name: "Search notes", exact: true });
const newNoteFab = (page: Page): Locator => fabs(page).getByRole("button", { name: "New note", exact: true });
const browseBar = (page: Page): Locator => page.getByTestId("note-browse-bar");
/** The floating Search button at the bottom of the note page (its outer container is display: contents and has no layout of its own, so visibility is judged on the button). */
const browseSearch = (page: Page): Locator => browseBar(page).getByRole("button", { name: "Search notes", exact: true });
const searchBox = (page: Page): Locator => page.getByRole("textbox", { name: "Search notes", exact: true });
const sidebarOf = (page: Page): Locator => page.getByRole("complementary").filter({ has: page.getByRole("tablist", { name: "Sidebar sections" }) });
const drawerOf = (page: Page): Locator => page.getByRole("dialog", { name: "Navigation" });
const noteLink = (scope: Locator, title: string): Locator => scope.getByRole("link", { name: new RegExp("^" + reEscape(title)) });
const historyIdx = (page: Page): Promise<number | null> => page.evaluate(() => (history.state as { idx?: number } | null)?.idx ?? null);

/** After opening a note, wait for the title box: until the lazy NotePage's fallback shell is replaced by the real one, everything on the page can still be swapped out. */
async function waitForTitle(page: Page, title: string): Promise<void> {
  await expect(titleBox(page)).toHaveValue(title, { timeout: 15_000 });
}

test("55-1 list screen: top bar, six icon tabs in one row, two floating buttons at the bottom edge, no sidebar button; the note screen hides them", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice, { width: 1280, height: 800 });
  try {
    const title = `E2E mn list ${RUN}`;
    await apiNote(page, title);
    await page.setViewportSize(PHONE);
    await page.goto("/");

    const sidebar = sidebarOf(page);
    await expect(sidebar).toBeVisible({ timeout: 15_000 });
    await expect(openSidebar(page)).toHaveCount(0);
    await expect(titleBox(page)).toHaveCount(0);

    const top = page.locator("[data-phone-top-bar]");
    await expect(top.getByRole("button", { name: alice.displayName, exact: true })).toBeVisible();

    const tabs = sidebar.getByRole("tablist", { name: "Sidebar sections" }).getByRole("tab");
    await expect(tabs).toHaveCount(6);
    const tops = new Set<number>();
    for (let i = 0; i < 6; i++) {
      const box = (await tabs.nth(i).boundingBox())!;
      expect(box).not.toBeNull();
      tops.add(Math.round(box.y));
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width + 0.5);
    }
    expect(tops.size, `六顆 tab 的上緣 ${[...tops].join(",")}`).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);

    // Not searching: no search bar and no search box at the bottom of the list; Search at bottom left, New note at bottom right, 16px from the viewport's bottom edge (desktop Chromium has no safe area).
    await expect(listBar(page)).toHaveCount(0);
    await expect(searchBox(page)).toHaveCount(0);
    for (const fab of [searchFab(page), newNoteFab(page)]) {
      const box = (await fab.boundingBox())!;
      expect(Math.abs(PHONE.height - (box.y + box.height) - 16), "浮動鈕離下緣").toBeLessThanOrEqual(1);
    }

    await showSidebarTab(page, "My notes");
    await noteLink(sidebar, title).click();
    await waitForTitle(page, title);
    await expect(sidebarOf(page)).toHaveCount(0);
    await expect(backButton(page)).toBeVisible();
    await expect(openSidebar(page)).toHaveCount(0);
    await backButton(page).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(sidebarOf(page)).toBeVisible();
    await expect(titleBox(page)).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("55-2 full-screen search: Cancel, Esc, clicking a result and system back all close the layer; results and hint", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice);
  try {
    const title = `E2E mn search ${RUN}`;
    await apiNote(page, title);
    await page.goto("/");
    // The search layer has no tab bar, so `sidebarOf` (which requires the tab bar) can't be used.
    const sidebar = page.getByRole("complementary");
    const tablist = sidebar.getByRole("tablist", { name: "Sidebar sections" });
    const newNote = newNoteFab(page);
    const cancel = listBar(page).getByRole("button", { name: "Cancel", exact: true });
    await expect(tablist).toBeVisible({ timeout: 15_000 });

    await searchFab(page).click();
    await expect(cancel).toBeVisible();
    await expect(newNote).toHaveCount(0);
    await expect(tablist).toHaveCount(0);
    await expect(page.getByTestId("phone-search-hint")).toBeVisible();

    await searchBox(page).fill(title);
    await expect(noteLink(sidebar, title)).toBeVisible({ timeout: 15_000 });
    await cancel.click();
    await expect(searchBox(page)).toHaveCount(0);
    await expect(cancel).toHaveCount(0);
    await expect(newNote).toBeVisible();
    await expect(tablist).toBeVisible();

    await searchFab(page).click();
    await searchBox(page).fill(title);
    await expect(noteLink(sidebar, title)).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Escape");
    await expect(searchBox(page)).toHaveCount(0);
    await expect(cancel).toHaveCount(0);
    await expect(tablist).toBeVisible();

    await searchFab(page).click();
    await searchBox(page).fill(title);
    await noteLink(sidebar, title).click();
    await waitForTitle(page, title);
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(sidebarOf(page)).toBeVisible();
    await expect(cancel).toHaveCount(0);
    await expect(newNote).toBeVisible();
  } finally {
    await context.close();
  }
});

test("55-3 the back chevron returns to the list: scroll position, search text and focus are kept; system back and the chevron share one history", async ({ browser }) => {
  test.setTimeout(180_000);
  const alice = await createAccount(browser, "alice");
  // Notes are created in a desktop context; list scrolling and clicking are done in the touch phone context (row height 44, whereas a mouse's narrow viewport row is only 28).
  const titles = Array.from({ length: 30 }, (_, i) => `E2E mn scroll ${String(i + 1).padStart(2, "0")} ${RUN}`);
  const desktop = await openAs(browser, alice, { width: 1280, height: 800 });
  try {
    for (const t of titles) await apiNote(desktop.page, t);
  } finally {
    await desktop.context.close();
  }
  const { context, page } = await openTouchAs(browser, alice);
  try {
    await page.goto("/");
    const sidebar = sidebarOf(page);
    await showSidebarTab(page, "My notes");
    await expect(noteLink(sidebar, titles[0]!)).toBeVisible({ timeout: 15_000 });
    const list = sidebar.locator("[data-sidebar-list]");
    // On a phone the document scrolls, not the list container.
    const pageScrollY = () => page.evaluate(() => window.scrollY);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBeGreaterThan(300);
    await page.evaluate(() => window.scrollTo(0, Math.round((document.documentElement.scrollHeight - window.innerHeight) / 2)));
    const before = await pageScrollY();
    expect(before).toBeGreaterThan(100);

    // Click a note currently on screen (the first one visible after scrolling: below the pinned top bar and title row, above the floating buttons).
    const target = await list.evaluate((el) => {
      const header = document.querySelector("[data-sidebar-header]")!.getBoundingClientRect();
      const link = Array.from(el.querySelectorAll<HTMLAnchorElement>("a[href^='/n/']")).find((a) => {
        const r = a.getBoundingClientRect();
        return r.top >= header.bottom + 4 && r.bottom <= window.innerHeight - 100;
      });
      return { href: link?.getAttribute("href") ?? null, text: link?.textContent ?? "" };
    });
    expect(target.href).not.toBeNull();
    const listIdx = await historyIdx(page);
    const historyBefore = await page.evaluate(() => history.length);
    await sidebar.locator(`a[href="${target.href}"]`).click();
    await expect(titleBox(page)).toBeVisible({ timeout: 15_000 });
    expect(await historyIdx(page)).toBe((listIdx ?? 0) + 1);

    await backButton(page).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(sidebarOf(page)).toBeVisible();
    expect(await historyIdx(page)).toBe(listIdx);
    expect(await page.evaluate(() => history.length)).toBe(historyBefore + 1);
    await expect.poll(pageScrollY).toBe(before);
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("href") ?? null)).toBe(target.href);

    await sidebar.locator(`a[href="${target.href}"]`).click();
    await expect(titleBox(page)).toBeVisible({ timeout: 15_000 });
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(sidebarOf(page)).toBeVisible();
    expect(await historyIdx(page)).toBe(listIdx);
    await expect.poll(pageScrollY).toBe(before);

    const query = titles[4]!;
    await searchFab(page).click();
    await searchBox(page).fill(query);
    await noteLink(page.getByRole("complementary"), query).click();
    await waitForTitle(page, query);
    await backButton(page).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(searchBox(page)).toHaveCount(0);
    await searchFab(page).click();
    await expect(searchBox(page)).toHaveValue(query);
  } finally {
    await context.close();
  }
});

test("55-4 deep link and link chain: the chevron of a deep link replaces its entry (no new history); list -> A -> B, then one chevron press goes back to the list", async ({ browser }) => {
  test.setTimeout(150_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice, { width: 1280, height: 800 });
  try {
    const stamp = Date.now();
    const a = await apiNote(page, `E2E mn chain A ${stamp}`);
    await apiNote(page, `E2E mn chain B ${stamp}`);
    await page.setViewportSize(PHONE);

    await page.goto(pathOf(a));
    await waitForTitle(page, `E2E mn chain A ${stamp}`);
    const lengthBefore = await page.evaluate(() => history.length);
    const idxBefore = await historyIdx(page);
    await backButton(page).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(sidebarOf(page)).toBeVisible();
    expect(await page.evaluate(() => history.length)).toBe(lengthBefore);
    expect(await historyIdx(page)).toBe(idxBefore);
    await page.goBack();
    expect(new URL(page.url()).pathname).not.toBe(pathOf(a));

    await page.goto("/");
    await expect(sidebarOf(page)).toBeVisible({ timeout: 15_000 });
    const listIdx = await historyIdx(page);
    await showSidebarTab(page, "My notes");
    await noteLink(sidebarOf(page), `E2E mn chain A ${stamp}`).click();
    await waitForTitle(page, `E2E mn chain A ${stamp}`);
    const editor = editorLocator(page);
    await editor.click();
    await waitForEditorSelection(page);
    await page.keyboard.type("see [[");
    await page.keyboard.type(`chain B ${stamp}`);
    const menu = page.locator(".bn-suggestion-menu");
    await expect(menu.getByText(`E2E mn chain B ${stamp}`, { exact: true })).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Enter");
    const wikilink = editor.locator('[data-inline-content-type="wikilink"]');
    await expect(wikilink).toHaveCount(1, { timeout: 10_000 });
    await wikilink.click();
    await waitForTitle(page, `E2E mn chain B ${stamp}`);
    expect(await historyIdx(page)).toBe((listIdx ?? 0) + 2);

    await backButton(page).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(sidebarOf(page)).toBeVisible();
    expect(await historyIdx(page)).toBe(listIdx);
  } finally {
    await context.close();
  }
});

test("55-5 three tiers: 639 phone, 640 and 1279 floating sidebar, 1280 fixed sidebar; crossing 640 closes the search layer and the drawer respectively", async ({ browser }) => {
  test.setTimeout(150_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice, { width: 1280, height: 800 });
  try {
    const title = `E2E mn tiers ${RUN}`;
    const note = await apiNote(page, title);
    await page.goto(pathOf(note));
    await waitForTitle(page, title);

    const setWidth = async (width: number): Promise<void> => {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))));
    };

    await expect(page.getByRole("complementary").getByRole("button", { name: "New note", exact: true })).toBeVisible();
    await expect(openSidebar(page)).toHaveCount(0);
    await expect(backButton(page)).toHaveCount(0);

    for (const width of [1279, 640]) {
      await setWidth(width);
      await expect(openSidebar(page), `${width}`).toBeVisible();
      await expect(backButton(page), `${width}`).toHaveCount(0);
      await expect(page.getByRole("complementary").getByRole("button", { name: "New note", exact: true }), `${width}`).toHaveCount(0);
      await expect(browseBar(page), `${width}`).toHaveCount(0);
    }

    await setWidth(639);
    await expect(backButton(page)).toBeVisible();
    await expect(openSidebar(page)).toHaveCount(0);
    await expect(browseSearch(page)).toBeVisible();

    await browseBar(page).getByRole("button", { name: "Search notes", exact: true }).click();
    await expect(listBar(page).getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
    await setWidth(640);
    await expect(listBar(page)).toHaveCount(0);
    await expect(openSidebar(page)).toBeVisible();
    await expect(titleBox(page)).toBeVisible();

    await openSidebar(page).click();
    await expect(drawerOf(page)).toBeVisible();
    await setWidth(639);
    await expect(drawerOf(page)).toHaveCount(0);
    await expect(titleBox(page)).toBeVisible();
    await expect(sidebarOf(page)).toHaveCount(0);
    await setWidth(640);
    await expect(drawerOf(page)).toHaveCount(0);

    await backToHome(page, setWidth);
  } finally {
    await context.close();
  }
});

async function backToHome(page: Page, setWidth: (width: number) => Promise<void>): Promise<void> {
  await setWidth(639);
  await backButton(page).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(sidebarOf(page)).toBeVisible();
  await setWidth(640);
  await expect(sidebarOf(page)).toHaveCount(0);
  await expect(openSidebar(page)).toBeVisible();
  await openSidebar(page).click();
  await expect(drawerOf(page)).toBeVisible();
  await setWidth(639);
  await expect(drawerOf(page)).toHaveCount(0);
  await expect(sidebarOf(page)).toBeVisible();
}

test("55-6 three location subtitle forms: personal folder, group folder, shared; clicking returns to the list, switches to the matching tab, expands the folder and the row is in view", async ({ browser }) => {
  test.setTimeout(180_000);
  const alice = await createAccount(browser, "alice");
  const bob = await createAccount(browser, "bob");
  const a = await openAs(browser, alice, { width: 1280, height: 800 });
  const b = await openAs(browser, bob);
  try {
    const group = `E2E mn Grp ${RUN}`;
    const groupId = await apiGroup(a.page, group);
    const added = await a.page.request.put(`/api/groups/${groupId}/members`, { data: { email: bob.email } });
    expect(added.ok(), await added.text()).toBe(true);

    const folder = `E2E mn Fold ${RUN}`;
    const personalFolder = await apiFolder(a.page, folder, { space: { kind: "personal" } });
    const personal = await apiNote(a.page, `E2E mn personal ${RUN}`, { folderId: personalFolder });
    const groupFolder = await apiFolder(a.page, folder, { space: { kind: "group", groupId } });
    const inGroup = await apiNote(a.page, `E2E mn group ${RUN}`, { groupId, folderId: groupFolder });
    const shared = await apiNote(a.page, `E2E mn shared ${RUN}`);
    const share = await a.page.request.put(`/api/notes/${shared.id}/shares`, { data: { email: bob.email, role: "viewer" } });
    expect(share.ok(), await share.text()).toBe(true);

    const location = (page: Page): Locator => page.getByTestId("note-header-subline").getByRole("button", { name: /^Show in list: / });

    await a.page.setViewportSize(PHONE);
    await a.page.goto(pathOf(personal));
    await waitForTitle(a.page, `E2E mn personal ${RUN}`);
    await expect(location(a.page)).toHaveAccessibleName(`Show in list: My notes › ${folder}`);
    await expect(location(a.page)).toContainText(`My notes › ${folder}`);
    await location(a.page).click();
    await expect(a.page).toHaveURL(/\/$/);
    const sidebarA = sidebarOf(a.page);
    await expect(sidebarA.getByRole("tab", { name: "My notes", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(folderRow(sidebarA, folder).getByRole("button", { name: folder, exact: true })).toHaveAttribute("aria-expanded", "true");
    await expect(noteLink(sidebarA, `E2E mn personal ${RUN}`)).toBeInViewport({ timeout: 10_000 });

    // Clicking the subtitle after the folder was collapsed expands it again: go back to the list and collapse the folder, go forward to the note, click the subtitle again.
    const folderButton = folderRow(sidebarA, folder).getByRole("button", { name: folder, exact: true });
    await noteLink(sidebarA, `E2E mn personal ${RUN}`).click();
    await waitForTitle(a.page, `E2E mn personal ${RUN}`);
    await backButton(a.page).click();
    await expect(sidebarOf(a.page)).toBeVisible();
    await folderButton.click();
    await expect(folderButton).toHaveAttribute("aria-expanded", "false");
    await a.page.goForward();
    await waitForTitle(a.page, `E2E mn personal ${RUN}`);
    await location(a.page).click();
    await expect(a.page).toHaveURL(/\/$/);
    await expect(folderButton).toHaveAttribute("aria-expanded", "true");
    await expect(noteLink(sidebarOf(a.page), `E2E mn personal ${RUN}`)).toBeInViewport({ timeout: 10_000 });

    await a.page.goto(pathOf(inGroup, groupId));
    await waitForTitle(a.page, `E2E mn group ${RUN}`);
    await expect(location(a.page)).toHaveAccessibleName(`Show in list: ${group} › ${folder}`);
    await location(a.page).click();
    await expect(a.page).toHaveURL(/\/$/);
    await expect(sidebarOf(a.page).getByRole("tab", { name: "Groups", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(noteLink(sidebarOf(a.page), `E2E mn group ${RUN}`)).toBeInViewport({ timeout: 10_000 });

    await b.page.goto(pathOf(shared));
    await expect(b.page.getByRole("heading", { name: `E2E mn shared ${RUN}`, level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(location(b.page)).toHaveAccessibleName(`Show in list: Shared with me · @${shared.ownerHandle}`);
    await expect(location(b.page)).toContainText(`Shared with me · @${shared.ownerHandle}`);
    await location(b.page).click();
    await expect(b.page).toHaveURL(/\/$/);
    await expect(sidebarOf(b.page).getByRole("tab", { name: "Shared with me", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(noteLink(sidebarOf(b.page), `E2E mn shared ${RUN}`)).toBeInViewport({ timeout: 10_000 });
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test("55-7 note page bottom bar: search opens the layer and Cancel returns to this note; New note is created next to this note; display matrix (owners and group members have it; group viewers and shared-with-me notes do not)", async ({ browser }) => {
  test.setTimeout(240_000);
  const alice = await createAccount(browser, "alice");
  const bob = await createAccount(browser, "bob");
  const carol = await createAccount(browser, "carol");
  const a = await openAs(browser, alice, { width: 1280, height: 800 });
  const b = await openAs(browser, bob);
  const c = await openAs(browser, carol);
  try {
    const group = `E2E mn BGrp ${RUN}`;
    const groupId = await apiGroup(a.page, group);
    const memberAdd = await a.page.request.put(`/api/groups/${groupId}/members`, { data: { email: bob.email } });
    expect(memberAdd.ok(), await memberAdd.text()).toBe(true);
    const roleRes = await a.page.request.post(`/api/groups/${groupId}/roles`, {
      data: { name: "Reader", permissions: { create: false, edit: false, delete: false, managePublicLink: false, manageMembers: false, manageGroup: false } },
    });
    expect(roleRes.status(), await roleRes.text()).toBe(201);
    const readerRole = ((await roleRes.json()) as { id: string }).id;
    const viewerAdd = await a.page.request.put(`/api/groups/${groupId}/members`, { data: { email: carol.email, roleId: readerRole } });
    expect(viewerAdd.ok(), await viewerAdd.text()).toBe(true);

    const folder = `E2E mn BFold ${RUN}`;
    const folderId = await apiFolder(a.page, folder, { space: { kind: "personal" } });
    const owned = await apiNote(a.page, `E2E mn owned ${RUN}`, { folderId });
    const groupNote = await apiNote(a.page, `E2E mn gnote ${RUN}`, { groupId });
    const sharedNote = await apiNote(a.page, `E2E mn bshared ${RUN}`);
    const share = await a.page.request.put(`/api/notes/${sharedNote.id}/shares`, { data: { email: bob.email, role: "editor" } });
    expect(share.ok(), await share.text()).toBe(true);

    const newNote = (page: Page): Locator => browseBar(page).getByRole("button", { name: "New note", exact: true });
    const searchButton = (page: Page): Locator => browseBar(page).getByRole("button", { name: "Search notes", exact: true });

    await a.page.setViewportSize(PHONE);
    await a.page.goto(pathOf(owned));
    await waitForTitle(a.page, `E2E mn owned ${RUN}`);
    await expect(browseSearch(a.page)).toBeVisible();
    await expect(newNote(a.page)).toBeVisible();
    await searchButton(a.page).click();
    await expect(searchBox(a.page)).toBeFocused();
    await expect(listBar(a.page).getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
    await searchBox(a.page).fill(`E2E mn gnote ${RUN}`);
    await expect(noteLink(a.page.getByRole("complementary"), `E2E mn gnote ${RUN}`)).toBeVisible({ timeout: 15_000 });
    await listBar(a.page).getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(a.page).toHaveURL(new RegExp(reEscape(pathOf(owned)) + "$"));
    await expect(titleBox(a.page)).toHaveValue(`E2E mn owned ${RUN}`);
    await expect(sidebarOf(a.page)).toHaveCount(0);
    await expect(searchButton(a.page)).toBeFocused();

    await newNote(a.page).click();
    await a.page.waitForURL(/\/n\/[^/]+\/untitled-[0-9a-f]{8}$/, { timeout: 15_000 });
    await expect(titleBox(a.page)).toHaveValue("Untitled", { timeout: 15_000 });
    await backButton(a.page).click();
    await expect(a.page).toHaveURL(/\/$/);
    const sidebarA = sidebarOf(a.page);
    await showSidebarTab(a.page, "My notes");
    await expect(folderRow(sidebarA, folder).getByRole("link", { name: /^Untitled/ })).toHaveCount(1, { timeout: 15_000 });

    await b.page.goto(pathOf(groupNote, groupId));
    await waitForTitle(b.page, `E2E mn gnote ${RUN}`);
    await expect(newNote(b.page)).toBeVisible({ timeout: 15_000 });
    await newNote(b.page).click();
    await b.page.waitForURL(/\/g\/[0-9a-f-]{36}\/untitled-[0-9a-f]{8}$/, { timeout: 15_000 });
    expect(new URL(b.page.url()).pathname.split("/")[2]).toBe(groupId);

    await b.page.goto(pathOf(sharedNote));
    await waitForTitle(b.page, `E2E mn bshared ${RUN}`);
    await expect(browseSearch(b.page)).toBeVisible();
    await expect(searchButton(b.page)).toBeVisible();
    await expect(newNote(b.page)).toHaveCount(0);

    await c.page.goto(pathOf(groupNote, groupId));
    await expect(c.page.getByRole("heading", { name: `E2E mn gnote ${RUN}`, level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(browseSearch(c.page)).toBeVisible();
    await expect(newNote(c.page)).toHaveCount(0);
    // A read-only note has no editable body node: click the coordinates of the body area directly (below the header, above the bar).
    await c.page.mouse.click(PHONE.width / 2, 400);
    await expect(browseSearch(c.page)).toBeVisible();
    await expect(newNote(c.page)).toHaveCount(0);
  } finally {
    await a.context.close();
    await b.context.close();
    await c.context.close();
  }
});

test("55-8 the bar yields while editing: the whole bar is absent while the editor has focus and comes back after clicking the top bar title", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice);
  try {
    const title = `E2E mn edit ${RUN}`;
    const note = await apiNote(page, title);
    await page.goto(pathOf(note));
    await waitForTitle(page, title);
    await expect(browseSearch(page)).toBeVisible();

    await expect(editorLocator(page)).toBeVisible({ timeout: 15_000 });
    // Click only once editable (a click while read-only doesn't count as editing).
    await editorLocator(page).click();
    await waitForEditorSelection(page);
    await expect(browseBar(page)).toHaveCount(0);

    await titleBox(page).click();
    await expect(browseSearch(page)).toBeVisible();
  } finally {
    await context.close();
  }
});

test("55-9 #313: a drawer opened while NotePage's code is still loading does not close by itself after loading finishes", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice, { width: 1280, height: 800 });
  try {
    const title = `E2E mn slow ${RUN}`;
    const note = await apiNote(page, title);
    await page.setViewportSize({ width: 768, height: 800 });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = 0;
    await page.route(/\/assets\/NotePage-[^/]+\.js(\?.*)?$/, async (route) => {
      held += 1;
      await gate;
      await route.continue();
    });
    await page.goto(pathOf(note), { waitUntil: "commit" });

    // The chunk is held: there is no title box yet and the page only shows the loading placeholder; open the drawer now.
    await expect(openSidebar(page)).toBeVisible({ timeout: 15_000 });
    await expect(titleBox(page)).toHaveCount(0);
    expect(held, "NotePage 的 chunk 請求必須真的被攔到，否則這案沒有測到任何事").toBeGreaterThan(0);
    await openSidebar(page).click();
    await expect(drawerOf(page)).toBeVisible();

    release();
    await waitForTitle(page, title);
    await expect(drawerOf(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawerOf(page)).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("55-10 touch size: the main controls of the list and note screens have a large enough tappable area on a touch device", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openTouchAs(browser, alice);
  try {
    const title = `E2E mn measure ${RUN}`;
    await apiNote(page, title);
    await page.goto("/");
    const sidebar = sidebarOf(page);
    await expect(sidebar).toBeVisible({ timeout: 15_000 });
    const lines: string[] = [];
    /** The tap area (`tapAreaOf`) is at least `minWidth` x `minHeight` (sampling can under-count each side by up to 0.5px, so a difference of 1 is allowed); the measured values are also printed as MEASURE lines. */
    const expectTap = async (screen: string, name: string, target: Locator, minWidth: number, minHeight: number): Promise<void> => {
      const area = await tapAreaOf(target);
      const fmt = (v: number[]): string => `${v[0]!.toFixed(1)}x${v[1]!.toFixed(1)}`;
      lines.push(`MEASURE ${screen} ${name} visual ${fmt(area.visual)} tap ${fmt(area.tap)}`);
      expect(area.tap[0], `${screen} ${name} 點擊寬`).toBeGreaterThanOrEqual(minWidth - 1);
      expect(area.tap[1], `${screen} ${name} 點擊高`).toBeGreaterThanOrEqual(minHeight - 1);
    };
    const tabs = sidebar.getByRole("tablist", { name: "Sidebar sections" }).getByRole("tab");
    await expectTap("list", "tab", tabs, 44, 44);
    await expectTap("list", "avatar", page.locator("[data-phone-top-bar]").getByRole("button"), 44, 44);
    await expectTap("list", "search", searchFab(page), 44, 44);
    await expectTap("list", "new-note", newNoteFab(page), 44, 44);
    await showSidebarTab(page, "My notes", sidebar);
    await noteLink(sidebar, title).click();
    await waitForTitle(page, title);
    // Header icon buttons draw a 32px box; the tap area is enlarged to 40x44.
    await expectTap("note", "back", backButton(page), 40, 44);
    await expectTap("note", "star", page.locator("header").getByRole("button", { name: "Favorite", exact: true }), 40, 44);
    await expectTap("note", "share", page.locator("header").getByRole("button", { name: "Share", exact: true }), 40, 44);
    await expectTap("note", "more", page.locator("header").getByRole("button", { name: "More", exact: true }), 40, 44);
    // The location subtitle is a one-line text button (32 high, full width) under the title box.
    const locationButton = page.getByTestId("note-header-subline").getByRole("button", { name: /^Show in list: / });
    await expectTap("note", "location", locationButton, 44, 32);
    await expectTap("note", "browse-search", browseBar(page).getByRole("button", { name: "Search notes", exact: true }), 44, 44);
    await expectTap("note", "browse-new-note", browseBar(page).getByRole("button", { name: "New note", exact: true }), 44, 44);
    const titleRect = (await titleBox(page).boundingBox())!;
    const locationRect = (await locationButton.boundingBox())!;
    // Title box and location subtitle together: they are adjacent vertically and each opens its own thing.
    const union = { width: Math.max(titleRect.x + titleRect.width, locationRect.x + locationRect.width) - Math.min(titleRect.x, locationRect.x), height: locationRect.y + locationRect.height - titleRect.y };
    lines.push(`MEASURE note title+location visual ${union.width.toFixed(1)}x${union.height.toFixed(1)}`);
    expect(union.height, "note title+location 合起來的高").toBeGreaterThanOrEqual(44);
    for (const line of lines) console.log(line);
  } finally {
    await context.close();
  }
});

test("55-11 list -> note -> reload -> back chevron: still returns to the list's entry (index one less, history length unchanged)", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice, { width: 1280, height: 800 });
  try {
    const title = `E2E mn reload ${RUN}`;
    await apiNote(page, title);
    await page.setViewportSize(PHONE);
    await page.goto("/");
    await expect(sidebarOf(page)).toBeVisible({ timeout: 15_000 });
    const listIdx = await historyIdx(page);
    await showSidebarTab(page, "My notes");
    await noteLink(sidebarOf(page), title).click();
    await waitForTitle(page, title);
    expect(await historyIdx(page)).toBe((listIdx ?? 0) + 1);

    await page.reload();
    await waitForTitle(page, title);
    const lengthBefore = await page.evaluate(() => history.length);
    expect(await historyIdx(page)).toBe((listIdx ?? 0) + 1);
    await backButton(page).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(sidebarOf(page)).toBeVisible();
    expect(await historyIdx(page)).toBe(listIdx);
    expect(await page.evaluate(() => history.length)).toBe(lengthBefore);
  } finally {
    await context.close();
  }
});

test("55-12 system back while the full-screen search layer is open on a note: returns to the list with the layer closed and the search box not focused", async ({ browser }) => {
  test.setTimeout(120_000);
  const alice = await createAccount(browser, "alice");
  const { context, page } = await openAs(browser, alice, { width: 1280, height: 800 });
  try {
    const title = `E2E mn backsearch ${RUN}`;
    await apiNote(page, title);
    await page.setViewportSize(PHONE);
    await page.goto("/");
    await expect(sidebarOf(page)).toBeVisible({ timeout: 15_000 });
    await showSidebarTab(page, "My notes");
    await noteLink(sidebarOf(page), title).click();
    await waitForTitle(page, title);
    await browseBar(page).getByRole("button", { name: "Search notes", exact: true }).click();
    await expect(searchBox(page)).toBeFocused();
    await expect(listBar(page).getByRole("button", { name: "Cancel", exact: true })).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(sidebarOf(page)).toBeVisible();
    await expect(listBar(page).getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
    await expect(newNoteFab(page)).toBeVisible();
    await expect(searchBox(page)).toHaveCount(0);
  } finally {
    await context.close();
  }
});
