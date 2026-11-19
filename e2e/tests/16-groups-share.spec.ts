import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { ADMIN, createNote, createUserViaInvite, editorLocator, loginAs, openGroupPanel, randomEmail, showSidebarTab } from "./helpers.js";

/**
 * A's role after the move is not asserted (a create-only role becomes viewer after moving; A is the group creator = built-in
 * admin; create-only is covered by `apps/server/test/groups-v2-move.test.ts`).
 * Cleanup deletes the group this test created in full-delete mode (`{ mode: "delete" }`; a group that still contains notes can
 * be deleted too, #175). If the body failed midway the cleanup's error is swallowed so it does not mask the original failure;
 * if the body passed, a cleanup failure turns the test red.
 */

const PASSWORD = "e2e-second-user-pw";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * With the more menu open: click the second-level trigger ("Move to..." / "Copy to...") and then an item in its submenu (the
 * desktop flyout form).
 *
 * `target.click()` directly will not work: Playwright's click teleports the mouse to the target centre in **one step**. Radix
 * decides whether the user is heading toward the submenu from the **horizontal pointer direction** (`pointerDirRef` is updated
 * only on pointermove inside the parent menu, and `lastPointerXRef` starts at 0, so the first move from the more button into
 * the parent menu is always recorded as `right`). In a 1280-wide viewport the more button hugs the right edge and the
 * submenu collides over to the **left** (`data-side="left"`); on teleporting away from the trigger the direction `right` !=
 * the submenu side `left`, Radix decides "not heading to the submenu", focus returns to the parent menu, the submenu's
 * `onFocusOutside` closes it and the item is unmounted, and click retries until the test times out (stuck for the full 180
 * seconds).
 * A human's mouse moves continuously, so the last few pointermoves before leaving the trigger are inside it with the right
 * direction and this almost never happens (unless one flicks out of the trigger extremely fast; at worst the submenu closes
 * and one more hover opens it).
 * So this moves in steps (`steps`) to imitate a human: the first step still lands inside the trigger and updates the
 * direction to the actual direction of the submenu, and only then leaves the trigger.
 */
async function pickFromSubmenu(page: Page, triggerName: string, itemName: string): Promise<void> {
  await page.getByRole("menuitem", { name: triggerName, exact: true }).click();
  const target = page.getByRole("menuitem", { name: itemName, exact: true });
  await expect(target).toBeVisible();
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2, { steps: 10 });
  await target.click();
}

async function createUser(adminPage: Page, email: string, displayName: string): Promise<void> {
  await createUserViaInvite(adminPage, { email, password: PASSWORD, displayName });
}

async function groupIdNamed(context: BrowserContext, name: string): Promise<string | null> {
  const list = await context.request.get("/api/groups");
  expect(list.status()).toBe(200);
  const group = ((await list.json()) as Array<{ id: string; name: string }>).find((g) => g.name === name);
  return group?.id ?? null;
}

/**
 * Deletes the group named `name`. Uses the API rather than 15's UI path (sidebar more menu -> Delete group): this runs in
 * `finally`, where the page may be in any state and UI steps are unreliable. Returns whether it was found and deleted.
 */
async function deleteGroupNamed(context: BrowserContext, name: string): Promise<boolean> {
  const id = await groupIdNamed(context, name);
  if (id === null) return false;
  const res = await context.request.delete(`/api/groups/${encodeURIComponent(id)}`, { data: { mode: "delete" } });
  expect(res.status()).toBe(204);
  return true;
}

async function firstLogin(browser: Browser, email: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await loginAs(page, email, PASSWORD);
  await expect(page).toHaveURL(/\/$/);
  return { page, close: () => context.close() };
}

async function expectImageLoaded(img: Locator): Promise<void> {
  await expect
    .poll(async () => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 15_000 })
    .toBeGreaterThan(0);
}

test("move into group (kicks per-person shares, closes the public link, old URL redirects) -> member copies to My notes -> the copy's image survives deleting the original", async ({ browser, request }) => {
  test.setTimeout(180_000);
  const adminContext = await browser.newContext();
  const closers: Array<() => Promise<void>> = [];
  const groupName = `E2E Move Group ${Date.now()}`;
  let passed = false;
  try {
    const adminPage = await adminContext.newPage();
    await loginAs(adminPage, ADMIN.email, ADMIN.password);
    await expect(adminPage).toHaveURL(/\/$/);

    const memberEmail = randomEmail();
    const guestEmail = randomEmail();
    const guestName = "E2E Share Guest";
    await createUser(adminPage, memberEmail, "E2E Group Member");
    await createUser(adminPage, guestEmail, guestName);

    const sidebar = adminPage.getByRole("complementary");
    await showSidebarTab(adminPage, "Groups");
    await sidebar.getByRole("button", { name: "New group", exact: true }).click();
    const groupDialog = adminPage.getByRole("dialog", { name: "New group" });
    await groupDialog.getByLabel("Group name").fill(groupName);
    await groupDialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(groupDialog).not.toBeVisible();
    await expect(sidebar.getByRole("button", { name: groupName, exact: true })).toBeVisible();
    const groupId = await groupIdNamed(adminContext, groupName);
    expect(groupId).toMatch(/^[0-9a-f-]{36}$/);

    await openGroupPanel(adminPage, groupName);
    await adminPage.getByLabel("Email address", { exact: true }).fill(memberEmail);
    await adminPage.getByRole("button", { name: "Add", exact: true }).click();
    await expect(adminPage.getByRole("button", { name: `Remove ${memberEmail}` })).toBeVisible();
    await adminPage.keyboard.press("Escape");
    await expect(adminPage).toHaveURL(/\/$/);

    const title = `E2E move note ${Date.now()}`;
    await createNote(adminPage, title);
    const personalUrl = adminPage.url();
    const personalPath = new URL(personalUrl).pathname;
    const slug = personalPath.slice(personalPath.lastIndexOf("/") + 1);
    const sentence = `moved content ${Date.now()}`;
    const editor = editorLocator(adminPage);
    await editor.click();
    await editor.pressSequentially(sentence);
    await adminPage.keyboard.press("Enter");
    await editor.pressSequentially("/image");
    await adminPage.getByText("Resizable image with caption").click();
    await adminPage.getByText("Add image", { exact: true }).click();
    await expect(adminPage.getByRole("tab", { name: "Upload" })).toBeVisible();
    await adminPage
      .getByLabel("Choose an image file to upload")
      .setInputFiles({ name: "e2e-move.png", mimeType: "image/png", buffer: PNG_1X1 });
    const originalImg = adminPage.locator('img[src*="/api/uploads/"]');
    await expect(originalImg).toBeVisible({ timeout: 15_000 });
    await expectImageLoaded(originalImg);
    const originalSrc = await originalImg.getAttribute("src");
    expect(originalSrc).toMatch(/^\/api\/uploads\/[0-9a-f-]{36}$/);

    await adminPage.getByRole("button", { name: "Share", exact: true }).click();
    const shareDialog = adminPage.getByRole("dialog", { name: "Share note" });
    await shareDialog.getByRole("radio", { name: /Members only/ }).click();
    await shareDialog.getByLabel("Email address").fill(guestEmail);
    await shareDialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(shareDialog.getByText(guestEmail)).toBeVisible();
    await shareDialog.getByRole("radio", { name: /^Public link/ }).click();
    const urlInput = shareDialog.getByLabel("Public link URL");
    await expect(urlInput).toBeVisible();
    const token = await urlInput.inputValue();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(async () => {
      expect((await request.get(`/api/public/notes/${token}`)).status()).toBe(200);
    }).toPass({ timeout: 10_000 });
    await adminPage.keyboard.press("Escape");
    await expect(shareDialog).not.toBeVisible();

    const guest = await firstLogin(browser, guestEmail);
    closers.push(guest.close);
    await guest.page.goto(personalUrl);
    await expect(guest.page.getByRole("heading", { name: title, level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(guest.page.getByRole("status").filter({ hasText: /^Read-only/ })).toBeVisible({ timeout: 15_000 });

    await adminPage.getByRole("button", { name: "More", exact: true }).click();
    await pickFromSubmenu(adminPage, "Move to…", groupName);
    const confirm = adminPage.getByRole("dialog").filter({ hasText: `Move this note into "${groupName}"?` });
    // The submit button is disabled until both the shares and public-link queries have arrived; the confirmation text is also complete only after they arrive.
    await expect(confirm).toContainText(
      `Per-person sharing with ${guestName} is removed; if they aren't in the group, they lose access.`,
    );
    await expect(confirm).toContainText("Its public link will be turned off.");
    await confirm.getByRole("button", { name: "Move into group", exact: true }).click();

    // The slug is kept because the new group has no name collision.
    await expect(adminPage).toHaveURL(new RegExp(`/g/${groupId}/${slug}$`), { timeout: 15_000 });
    await adminPage.getByRole("button", { name: "Share", exact: true }).click();
    await expect(shareDialog).toBeVisible();
    await expect(shareDialog.getByText(/every member whose role can read has access/)).toBeVisible();
    await expect(shareDialog.getByRole("radio")).toHaveCount(0);
    const groupUrl = adminPage.url();

    await expect(guest.page.getByText("You no longer have access to this note.", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(guest.page).toHaveURL(/\/$/, { timeout: 10_000 });
    await expect(async () => {
      expect((await request.get(`/api/public/notes/${token}`)).status()).toBe(404);
    }).toPass({ timeout: 10_000 });
    await adminPage.keyboard.press("Escape");
    await expect(shareDialog).not.toBeVisible();

    const member = await firstLogin(browser, memberEmail);
    closers.push(member.close);
    await member.page.goto(personalUrl);
    await expect(member.page).toHaveURL(groupUrl, { timeout: 15_000 });
    await expect(member.page.getByLabel("Note title")).toHaveValue(title, { timeout: 15_000 });
    await expect(member.page.locator('[data-testid="note-editor"]')).toContainText(sentence, { timeout: 15_000 });

    await member.page.getByRole("button", { name: "More", exact: true }).click();
    await pickFromSubmenu(member.page, "Copy to…", "My notes");
    await member.page.getByRole("dialog").getByRole("button", { name: "Copy to my notes", exact: true }).click();
    await expect(member.page.getByText("Copied to your notes", { exact: true })).toBeVisible({ timeout: 15_000 });
    await member.page.getByRole("button", { name: "Open copy", exact: true }).click();
    await member.page.waitForURL(
      (url) => url.pathname.startsWith("/n/") && url.pathname !== personalPath,
      { timeout: 15_000 },
    );
    const copyUrl = member.page.url();
    await expect(member.page.getByLabel("Note title")).toHaveValue(title, { timeout: 15_000 });
    await expect(member.page.locator('[data-testid="note-editor"]')).toContainText(sentence, { timeout: 15_000 });
    const copyImg = member.page.locator('img[src*="/api/uploads/"]');
    await expect(copyImg).toBeVisible({ timeout: 15_000 });
    const copySrc = await copyImg.getAttribute("src");
    expect(copySrc).toMatch(/^\/api\/uploads\/[0-9a-f-]{36}$/);
    expect(copySrc).not.toBe(originalSrc); // the attachment is copied under a new id and the URL is rewritten
    await expectImageLoaded(copyImg);

    // #181: the note goes to the trash and the attachment stays, so an upload that can no longer be seen is 403
    await adminPage.getByRole("button", { name: "More", exact: true }).click();
    await adminPage.getByRole("menuitem", { name: "Delete", exact: true }).click();
    await expect(adminPage).toHaveURL(/\/$/, { timeout: 15_000 });
    await expect(async () => {
      expect((await adminContext.request.get(originalSrc!)).status()).toBe(403);
    }).toPass({ timeout: 10_000 });

    await member.page.reload();
    await expect(member.page).toHaveURL(copyUrl);
    const copyImgAfter = member.page.locator(`img[src="${copySrc}"]`);
    await expect(copyImgAfter).toBeVisible({ timeout: 15_000 });
    await expectImageLoaded(copyImgAfter);
    passed = true;
  } finally {
    // Cleanup must not mask the real failure: if the body already failed, swallow the cleanup error (throwing in `finally` would
    // replace the original error); if the body passed, a cleanup failure turns the test red as usual - the group must be findable and deletable.
    try {
      const deleted = await deleteGroupNamed(adminContext, groupName);
      if (passed) expect(deleted).toBe(true);
    } catch (err) {
      if (passed) throw err;
    } finally {
      for (const close of closers) await close();
      await adminContext.close();
    }
  }
});
