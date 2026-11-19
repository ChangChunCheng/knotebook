import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { ADMIN, chooseSelectOption, createUserViaInvite, editorLocator, loginAs, openGroupPanel, randomEmail, showSidebarTab } from "./helpers.js";

/**
 * Screenshots for visual inspection: taken only when `PR3_SCREENSHOT_DIR` is set, otherwise skipped; this file writes no
 * absolute path.
 */
test("group roles: add a custom role -> changing a member's role makes them read-only immediately -> changing back makes them editable immediately", async ({ browser }) => {
  const shotDir = process.env.PR3_SCREENSHOT_DIR;
  const shot = async (page: Page, name: string): Promise<void> => {
    if (shotDir) await page.screenshot({ path: path.join(shotDir, name) });
  };
  const adminContext = await browser.newContext();
  const userContext = await browser.newContext();
  try {
    const adminPage = await adminContext.newPage();
    await loginAs(adminPage, ADMIN.email, ADMIN.password);
    await expect(adminPage).toHaveURL(/\/$/);

    const secondEmail = randomEmail();
    const password = "e2e-role-user-pw";
    await createUserViaInvite(adminPage, { email: secondEmail, password, displayName: "E2E Role Member" });

    const groupName = `E2E Roles ${Date.now()}`;
    const sidebar = adminPage.getByRole("complementary");
    await showSidebarTab(adminPage, "Groups");
    await sidebar.getByRole("button", { name: "New group", exact: true }).click();
    const groupDialog = adminPage.getByRole("dialog", { name: "New group" });
    await groupDialog.getByLabel("Group name").fill(groupName);
    await groupDialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(groupDialog).not.toBeVisible();
    await expect(sidebar.getByRole("button", { name: groupName, exact: true })).toBeVisible();

    await sidebar.getByRole("button", { name: `New note in ${groupName}` }).click();
    await adminPage.waitForURL(/\/g\/[0-9a-f-]{36}\/untitled-[0-9a-f]{8}$/, { timeout: 15_000 });
    const title = `E2E role note ${Date.now()}`;
    const titleInput = adminPage.getByLabel("Note title");
    await titleInput.fill(title);
    await titleInput.blur();
    await adminPage.waitForURL(
      (url) => /^\/g\/[0-9a-f-]{36}\/[^/]+$/.test(url.pathname) && !/\/untitled-[0-9a-f]{8}$/.test(url.pathname),
      { timeout: 15_000 },
    );
    const noteUrl = adminPage.url();
    await expect(adminPage.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible({ timeout: 15_000 });
    await editorLocator(adminPage).waitFor({ timeout: 15_000 });

    const groupId = await openGroupPanel(adminPage, groupName);
    const membersUrl = adminPage.url();
    await adminPage.getByLabel("Email address", { exact: true }).fill(secondEmail);
    await adminPage.getByRole("button", { name: "Add", exact: true }).click();
    await expect(adminPage.getByRole("button", { name: `Remove ${secondEmail}` })).toBeVisible();

    const userPage = await userContext.newPage();
    await loginAs(userPage, secondEmail, password);
    await expect(userPage).toHaveURL(/\/$/);

    const userSidebar = userPage.getByRole("complementary");
    const userWorkspace = await showSidebarTab(userPage, "Groups", userSidebar);
    await expect(userWorkspace.getByRole("button", { name: groupName, exact: true })).toBeVisible({ timeout: 15_000 });
    await userWorkspace.getByRole("link", { name: title }).click();
    await expect(userPage).toHaveURL(noteUrl);
    const userBadge = userPage.getByRole("status").filter({ hasText: /^Connected/ });
    await expect(userBadge).toBeVisible({ timeout: 15_000 });
    await expect(userBadge).toHaveText("Connected");
    const userEditable = userPage.locator('[data-testid="note-editor"] [contenteditable="true"]');
    await expect(userEditable).toHaveCount(1, { timeout: 15_000 });
    // Screenshot for visual inspection: the group row of the built-in regular member (can create and edit) has a "+".
    if (shotDir) {
      await userWorkspace.getByRole("button", { name: groupName, exact: true }).hover();
      await shot(userPage, "pr3-sidebar-member-hover.png");
    }

    // The nav of the group panel's left card has the panel title (the group name) as its accessible name.
    const tabs = adminPage.getByRole("navigation", { name: groupName, exact: true });
    await tabs.getByRole("link", { name: "Roles", exact: true }).click();
    await expect(adminPage).toHaveURL(new RegExp(`/groups/${groupId}/roles$`));
    await adminPage.getByRole("button", { name: "New role", exact: true }).click();
    const newRoleDialog = adminPage.getByRole("dialog", { name: "New role" });
    // The new-role dialog has no Read switch and all six flags default to off, so a role created untouched can only read.
    await newRoleDialog.getByLabel("Role name", { exact: true }).fill("Reader");
    await expect(newRoleDialog.getByRole("switch", { name: "Read", exact: true })).toHaveCount(0);
    const dialogSwitches = newRoleDialog.getByRole("switch");
    await expect(dialogSwitches).toHaveCount(6);
    for (let i = 0; i < 6; i += 1) await expect(dialogSwitches.nth(i)).not.toBeChecked();
    await newRoleDialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(newRoleDialog).not.toBeVisible();
    await expect(adminPage.getByRole("region", { name: "Reader", exact: true })).toBeVisible();

    await tabs.getByRole("link", { name: "Members", exact: true }).click();
    await expect(adminPage).toHaveURL(membersUrl);
    const roleSelect = adminPage.getByLabel(`Role for ${secondEmail}`, { exact: true });
    await chooseSelectOption(adminPage, roleSelect, "Reader");

    await expect(userPage.getByRole("status").filter({ hasText: /^Read-only/ })).toBeVisible({ timeout: 10_000 });
    await expect(userEditable).toHaveCount(0, { timeout: 10_000 });
    // This check has no discriminating power: the built-in regular member never had the delete flag, so B's more menu already
    // had no Delete at the editor stage (since #181 the menu item is Delete); it is identical before and after Reader. Kept as is.
    await userPage.getByRole("button", { name: "More", exact: true }).click();
    await expect(userPage.getByRole("menuitem", { name: "Delete" })).toHaveCount(0);
    await userPage.keyboard.press("Escape");
    await expect(userPage.getByRole("button", { name: "Share", exact: true })).toBeVisible();

    // Screenshot for visual inspection: the delete-confirmation dialog (Reader has 1 person here, so the count text uses description_one).
    if (shotDir) {
      await tabs.getByRole("link", { name: "Roles", exact: true }).click();
      await adminPage.getByRole("button", { name: "Delete Reader", exact: true }).click();
      await shot(adminPage, "pr3-delete-role-dialog.png");
      await adminPage.getByRole("dialog", { name: "Delete role?" }).getByRole("button", { name: "Cancel", exact: true }).click();
      await tabs.getByRole("link", { name: "Members", exact: true }).click();
    }

    await chooseSelectOption(adminPage, roleSelect, "Member");

    await expect(userBadge).toHaveText("Connected", { timeout: 10_000 });
    await expect(userEditable).toHaveCount(1, { timeout: 10_000 });
    const sentence = `typed by restored member ${Date.now()}`;
    await editorLocator(userPage).click();
    await userPage.keyboard.type(sentence);
    await expect(editorLocator(adminPage)).toContainText(sentence, { timeout: 15_000 });

    await tabs.getByRole("link", { name: "Roles", exact: true }).click();
    await expect(adminPage.getByRole("region", { name: "Reader", exact: true })).toBeVisible();
    await shot(adminPage, "pr3-roles-page.png");
  } finally {
    await adminContext.close();
    await userContext.close();
  }
});
