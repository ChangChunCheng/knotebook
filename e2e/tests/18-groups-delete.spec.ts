import { expect, test, type Page } from "@playwright/test";
import { ADMIN, createUserViaInvite, editorLocator, loginAs, openGroupPanel, randomEmail, showSidebarTab } from "./helpers.js";

/** Groups and notes are left in place: the e2e stack is reset by `stack:down -v` each time. */

const PASSWORD = "e2e-delete-user-pw";

async function createGroup(adminPage: Page, name: string): Promise<void> {
  await showSidebarTab(adminPage, "Groups");
  const sidebar = adminPage.getByRole("complementary");
  await sidebar.getByRole("button", { name: "New group", exact: true }).click();
  const groupDialog = adminPage.getByRole("dialog", { name: "New group" });
  await groupDialog.getByLabel("Group name").fill(name);
  await groupDialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(groupDialog).not.toBeVisible();
  await expect(sidebar.getByRole("button", { name, exact: true })).toBeVisible();
}

async function createGroupNote(adminPage: Page, groupName: string, title: string): Promise<string> {
  const sidebar = adminPage.getByRole("complementary");
  await sidebar.getByRole("button", { name: `New note in ${groupName}` }).click();
  await adminPage.waitForURL(/\/g\/[0-9a-f-]{36}\/untitled-[0-9a-f]{8}$/, { timeout: 15_000 });
  const titleInput = adminPage.getByLabel("Note title");
  await titleInput.fill(title);
  await titleInput.blur();
  await adminPage.waitForURL(
    (url) => /^\/g\/[0-9a-f-]{36}\/[^/]+$/.test(url.pathname) && !/\/untitled-[0-9a-f]{8}$/.test(url.pathname),
    { timeout: 15_000 },
  );
  await expect(adminPage.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible({ timeout: 15_000 });
  await editorLocator(adminPage).waitFor({ timeout: 15_000 });
  return adminPage.url();
}

async function addMember(adminPage: Page, groupName: string, email: string): Promise<void> {
  await openGroupPanel(adminPage, groupName);
  await adminPage.getByLabel("Email address", { exact: true }).fill(email);
  await adminPage.getByRole("button", { name: "Add", exact: true }).click();
  await expect(adminPage.getByRole("button", { name: `Remove ${email}` })).toBeVisible();
  await adminPage.keyboard.press("Escape");
  await expect(adminPage.getByRole("button", { name: `Remove ${email}` })).toHaveCount(0);
}

async function openDeleteGroupDialog(adminPage: Page, groupName: string) {
  await showSidebarTab(adminPage, "Groups");
  const sidebar = adminPage.getByRole("complementary");
  await sidebar.getByRole("button", { name: `Group actions for ${groupName}` }).click();
  await adminPage.getByRole("menuitem", { name: "Delete group" }).click();
  const dialog = adminPage.getByRole("dialog", { name: "Delete group?" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("delete group: transfer to admin (members kicked, old URL redirects, public link closed) -> delete everything (tick required, members see it deleted)", async ({ browser }) => {
  test.setTimeout(180_000);
  const adminContext = await browser.newContext();
  const userContext = await browser.newContext();
  const anonContext = await browser.newContext();
  try {
    const adminPage = await adminContext.newPage();
    await loginAs(adminPage, ADMIN.email, ADMIN.password);
    await expect(adminPage).toHaveURL(/\/$/);
    const sidebar = adminPage.getByRole("complementary");

    const secondEmail = randomEmail();
    await createUserViaInvite(adminPage, { email: secondEmail, password: PASSWORD, displayName: "E2E Delete Member" });

    const g1 = `E2E Transfer ${Date.now()}`;
    await createGroup(adminPage, g1);
    const titleX = `E2E transfer note ${Date.now()}`;
    const groupUrlX = await createGroupNote(adminPage, g1, titleX);
    const slugX = new URL(groupUrlX).pathname.split("/").pop()!;
    const sentenceX = `transferred content ${Date.now()}`;
    await editorLocator(adminPage).click();
    await adminPage.keyboard.type(sentenceX);
    await expect(editorLocator(adminPage)).toContainText(sentenceX);

    await adminPage.getByRole("button", { name: "Share", exact: true }).click();
    const shareDialog = adminPage.getByRole("dialog", { name: "Share note" });
    await expect(shareDialog.getByText(/every member whose role can read has access/)).toBeVisible();
    await shareDialog.getByRole("switch", { name: "Public link", exact: true }).click();
    const urlInput = shareDialog.getByLabel("Public link URL");
    await expect(urlInput).toBeVisible({ timeout: 10_000 });
    const token = await urlInput.inputValue();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const publicPath = `/p/${token}`;
    await adminPage.keyboard.press("Escape");
    await expect(shareDialog).not.toBeVisible();
    // Before the transfer the public URL is alive (otherwise the later "dead" check has no discriminating power)
    const anonPage = await anonContext.newPage();
    await anonPage.goto(publicPath);
    await expect(anonPage.getByRole("heading", { name: titleX })).toBeVisible({ timeout: 15_000 });

    await addMember(adminPage, g1, secondEmail);
    const userPage = await userContext.newPage();
    await loginAs(userPage, secondEmail, PASSWORD);
    await expect(userPage).toHaveURL(/\/$/);

    const userSidebar = userPage.getByRole("complementary");
    const userWorkspace = await showSidebarTab(userPage, "Groups", userSidebar);
    await expect(userWorkspace.getByRole("button", { name: g1, exact: true })).toBeVisible({ timeout: 15_000 });
    await userWorkspace.getByRole("link", { name: titleX }).click();
    await expect(userPage).toHaveURL(groupUrlX);
    const userBadge = userPage.getByRole("status").filter({ hasText: /^Connected/ });
    await expect(userBadge).toBeVisible({ timeout: 15_000 });
    await expect(userBadge).toHaveText("Connected");
    await expect(userPage.locator('[data-testid="note-editor"] [contenteditable="true"]')).toHaveCount(1, { timeout: 15_000 });

    const deleteG1 = await openDeleteGroupDialog(adminPage, g1);
    await expect(deleteG1.getByRole("radio", { name: "Give them to an admin" })).toBeChecked();
    const adminSelect = deleteG1.getByLabel("Admin who gets the notes");
    await expect(adminSelect).toBeEnabled();
    await expect(adminSelect.locator("[data-select-text]")).toHaveText(`admin (${ADMIN.email})`);
    await deleteG1.getByRole("button", { name: "Delete group", exact: true }).click();
    await expect(deleteG1).not.toBeVisible({ timeout: 15_000 });

    await expect(userPage.getByText("You no longer have access to this note.", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(userPage).toHaveURL(/\/$/, { timeout: 10_000 });
    await showSidebarTab(userPage, "Recent", userSidebar);
    await expect(userSidebar.getByRole("link", { name: titleX })).toHaveCount(0, { timeout: 10_000 });
    await showSidebarTab(userPage, "Groups", userSidebar);
    await expect(userSidebar.getByRole("button", { name: g1, exact: true })).toHaveCount(0, { timeout: 10_000 });

    await showSidebarTab(adminPage, "Groups");
    await expect(sidebar.getByRole("button", { name: g1, exact: true })).toHaveCount(0, { timeout: 10_000 });
    await expect((await showSidebarTab(adminPage, "My notes")).getByRole("link", { name: titleX })).toBeVisible({ timeout: 10_000 });
    await adminPage.goto(groupUrlX);
    await expect(adminPage).toHaveURL(new RegExp(`/n/[^/]+/${slugX}$`), { timeout: 15_000 });
    await expect(adminPage.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible({ timeout: 15_000 });
    await expect(editorLocator(adminPage)).toContainText(sentenceX, { timeout: 15_000 });

    await adminPage.getByRole("button", { name: "Share", exact: true }).click();
    await expect(shareDialog).toBeVisible();
    const accessGroup = shareDialog.getByRole("radiogroup", { name: "Access" });
    await expect(accessGroup).not.toHaveAttribute("aria-busy", "true", { timeout: 10_000 });
    await expect(shareDialog.getByRole("radio", { name: /^Private/ })).toBeChecked();
    await expect(shareDialog.getByRole("radio", { name: /^Public link/ })).not.toBeChecked();
    await adminPage.keyboard.press("Escape");
    await expect(shareDialog).not.toBeVisible();
    await anonPage.goto(publicPath);
    await expect(anonPage.getByText("This link doesn't exist or is no longer active.", { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    const g2 = `E2E Purge ${Date.now()}`;
    await createGroup(adminPage, g2);
    const titleY = `E2E purge note ${Date.now()}`;
    const groupUrlY = await createGroupNote(adminPage, g2, titleY);
    await addMember(adminPage, g2, secondEmail);
    // B opens the URL directly: B's sidebar list may not have refetched the new group yet, and this part tests deletion, not the sidebar.
    await userPage.goto(groupUrlY);
    await expect(userPage).toHaveURL(groupUrlY);
    await expect(userBadge).toBeVisible({ timeout: 15_000 });
    await expect(userBadge).toHaveText("Connected");
    await expect(userPage.locator('[data-testid="note-editor"] [contenteditable="true"]')).toHaveCount(1, { timeout: 15_000 });

    const deleteG2 = await openDeleteGroupDialog(adminPage, g2);
    await deleteG2.getByRole("radio", { name: "Delete everything" }).check();
    const confirmG2 = deleteG2.getByRole("button", { name: "Delete group", exact: true });
    await expect(confirmG2).toBeDisabled();
    await deleteG2.getByRole("checkbox", { name: "I understand the notes will be permanently deleted" }).click();
    await expect(confirmG2).toBeEnabled();
    await confirmG2.click();
    await expect(deleteG2).not.toBeVisible({ timeout: 15_000 });

    await expect(userPage.getByText("This note has been deleted.", { exact: true })).toBeVisible({ timeout: 10_000 });

    await showSidebarTab(adminPage, "Groups");
    await expect(sidebar.getByRole("button", { name: g2, exact: true })).toHaveCount(0, { timeout: 10_000 });
    await adminPage.goto(groupUrlY);
    await expect(adminPage.getByText("This link is invalid or the note doesn't exist.", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await adminContext.close();
    await userContext.close();
    await anonContext.close();
  }
});
