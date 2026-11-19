import { expect, test } from "@playwright/test";
import { ADMIN, createNote, createUserViaInvite, editorLocator, loginAs, openGroupPanel, randomEmail, showSidebarTab } from "./helpers.js";

/** Groups and notes are left in place: the e2e stack is reset by `stack:down -v` each time. */
test("groups: create -> create a note in the group (/g/ URL) -> add a member in settings -> member co-edits -> removal kicks -> delete dialog defaults to transfer and the group survives cancel", async ({ browser }) => {
  const adminContext = await browser.newContext();
  const userContext = await browser.newContext();
  try {
    const adminPage = await adminContext.newPage();
    await loginAs(adminPage, ADMIN.email, ADMIN.password);
    await expect(adminPage).toHaveURL(/\/$/);

    const secondEmail = randomEmail();
    const password = "e2e-second-user-pw";
    await createUserViaInvite(adminPage, { email: secondEmail, password, displayName: "E2E Group Member" });

    const groupName = `E2E Group ${Date.now()}`;
    const sidebar = adminPage.getByRole("complementary");
    await showSidebarTab(adminPage, "Groups");
    await sidebar.getByRole("button", { name: "New group", exact: true }).click();
    const groupDialog = adminPage.getByRole("dialog", { name: "New group" });
    await groupDialog.getByLabel("Group name").fill(groupName);
    await groupDialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(groupDialog).not.toBeVisible();
    const groupHeader = sidebar.getByRole("button", { name: groupName, exact: true });
    await expect(groupHeader).toBeVisible();
    await expect(groupHeader).toHaveAttribute("aria-expanded", "true");

    // The section "+" is opacity-0 by default; Playwright still treats it as visible
    await sidebar.getByRole("button", { name: `New note in ${groupName}` }).click();
    await adminPage.waitForURL(/\/g\/[0-9a-f-]{36}\/untitled-[0-9a-f]{8}$/, { timeout: 15_000 });
    const title = `E2E group note ${Date.now()}`;
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
    const groupSection = sidebar.locator(`[data-node-kind="group"]`).filter({ has: adminPage.getByRole("button", { name: groupName, exact: true }) });
    await expect(groupSection.getByRole("link", { name: title })).toBeVisible();

    await adminPage.getByRole("button", { name: "Share", exact: true }).click();
    const shareDialog = adminPage.getByRole("dialog", { name: "Share note" });
    await expect(shareDialog.getByText(/every member whose role can read has access/)).toBeVisible();
    await expect(shareDialog.getByRole("radio")).toHaveCount(0);
    await adminPage.keyboard.press("Escape");
    await expect(shareDialog).not.toBeVisible();

    await openGroupPanel(adminPage, groupName);
    await adminPage.getByLabel("Email address", { exact: true }).fill(secondEmail);
    await adminPage.getByRole("button", { name: "Add", exact: true }).click();
    await expect(adminPage.getByRole("button", { name: `Remove ${secondEmail}` })).toBeVisible();
    await adminPage.keyboard.press("Escape");
    // #179: renaming the title changes the URL through router navigate, so the backgroundLocation recorded when the group panel
    // opened is already the renamed URL; closing the group panel must return to the canonical URL (not fall back to the pre-rename untitled-...).
    await expect(adminPage).toHaveURL(noteUrl);
    await expect(adminPage.getByRole("button", { name: `Remove ${secondEmail}` })).toHaveCount(0);

    const userPage = await userContext.newPage();
    await loginAs(userPage, secondEmail, password);
    await expect(userPage).toHaveURL(/\/$/);

    const userSidebar = userPage.getByRole("complementary");
    const userWorkspace = await showSidebarTab(userPage, "Groups", userSidebar);
    await expect(userWorkspace.getByRole("button", { name: groupName, exact: true })).toBeVisible({ timeout: 15_000 });

    // B: create their own group with a name that sorts later: groups sort by my role (admin first, then regular member), not by name
    const ownGroupName = `Zz E2E own group ${Date.now()}`;
    await userSidebar.getByRole("button", { name: "New group", exact: true }).click();
    const ownGroupDialog = userPage.getByRole("dialog", { name: "New group" });
    await ownGroupDialog.getByLabel("Group name").fill(ownGroupName);
    await ownGroupDialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(ownGroupDialog).not.toBeVisible();
    const userGroupNodes = userWorkspace.locator(`[data-node-kind="group"]`);
    await expect(userGroupNodes).toHaveCount(2);
    await expect(userGroupNodes.nth(0).getByRole("button", { name: ownGroupName, exact: true })).toBeVisible();
    await expect(userGroupNodes.nth(1).getByRole("button", { name: groupName, exact: true })).toBeVisible();
    await userWorkspace.getByRole("link", { name: title }).click();
    await expect(userPage).toHaveURL(noteUrl);
    const userBadge = userPage.getByRole("status").filter({ hasText: /^Connected/ });
    await expect(userBadge).toBeVisible({ timeout: 15_000 });
    await expect(userBadge).toHaveText("Connected"); // built-in regular member -> editor: since #335 the badge says only "Connected", without the role
    await expect(userPage.getByRole("button", { name: "Share", exact: true })).toBeVisible();

    const sentence = `typed by member ${Date.now()}`;
    await editorLocator(userPage).click();
    await userPage.keyboard.type(sentence);
    await expect(editorLocator(adminPage)).toContainText(sentence, { timeout: 15_000 });

    await openGroupPanel(adminPage, groupName);
    await adminPage.getByRole("button", { name: `Remove ${secondEmail}` }).click();
    // #395: removal asks for confirmation in a dialog first
    await adminPage.getByRole("dialog", { name: "Remove member?" }).getByRole("button", { name: "Remove", exact: true }).click();
    // While the confirmation dialog is open the outer panel is aria-hidden, so toHaveCount(0) would pass early: wait for the dialog to close first.
    await expect(adminPage.getByRole("dialog", { name: "Remove member?" })).toHaveCount(0);
    // Wait for that remove button to disappear = the row is gone. Since #183 the remove button is an icon button whose email is
    // only in its aria-label ("Remove <email>"), not in visible text; finding it by accessible name targets that row's action.
    await expect(adminPage.getByRole("button", { name: `Remove ${secondEmail}` })).toHaveCount(0);

    await expect(userPage.getByText("You no longer have access to this note.", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(userPage).toHaveURL(/\/$/, { timeout: 10_000 });
    await showSidebarTab(userPage, "Recent", userSidebar);
    await expect(userSidebar.getByRole("link", { name: title })).toHaveCount(0, { timeout: 10_000 });
    await showSidebarTab(userPage, "Groups", userSidebar);
    await expect(userSidebar.getByRole("button", { name: groupName, exact: true })).toHaveCount(0, { timeout: 10_000 });

    await adminPage.keyboard.press("Escape");
    // #179: backgroundLocation is already the canonical URL (renaming goes through router navigate), so closing the group panel returns straight to it.
    await expect(adminPage).toHaveURL(noteUrl);
    await showSidebarTab(adminPage, "Groups");
    await sidebar.getByRole("button", { name: `Group actions for ${groupName}` }).click();
    await adminPage.getByRole("menuitem", { name: "Delete group" }).click();
    // Only cancels here: the actual deletion is covered by 18-groups-delete.
    const deleteDialog = adminPage.getByRole("dialog", { name: "Delete group?" });
    await expect(deleteDialog.getByRole("radio", { name: "Give them to an admin" })).toBeChecked();
    await expect(deleteDialog.getByRole("radio", { name: "Delete everything" })).not.toBeChecked();
    await deleteDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(deleteDialog).not.toBeVisible();
    await expect(sidebar.getByRole("button", { name: groupName, exact: true })).toBeVisible();
    await expect(groupSection.getByRole("link", { name: title })).toBeVisible();
  } finally {
    await adminContext.close();
    await userContext.close();
  }
});

/**
 * "People you know" suggestions (`GET /api/users/suggest`): after A adds B to a group by full email, typing just a short
 * fragment of B's email in the share panel of a personal note lets A pick B from the suggestion list (down arrow + Enter) and
 * share; C, who has no relation to A, does not appear for a fragment of the same length (it is not a site-wide directory).
 */
test("suggestions: someone in the same group can be picked after a few characters; a stranger does not appear", async ({ browser }) => {
  const adminContext = await browser.newContext();
  try {
    const adminPage = await adminContext.newPage();
    await loginAs(adminPage, ADMIN.email, ADMIN.password);
    await expect(adminPage).toHaveURL(/\/$/);

    const memberEmail = randomEmail();
    const strangerEmail = randomEmail();
    await createUserViaInvite(adminPage, { email: memberEmail, password: "e2e-suggest-member-pw", displayName: "E2E Suggest Member" });
    await createUserViaInvite(adminPage, { email: strangerEmail, password: "e2e-suggest-stranger-pw", displayName: "E2E Suggest Stranger" });
    // randomEmail = `e2e-<uuid>@e2e.local`: take a slice at the start of the uuid, distinctive enough yet not the full email.
    const memberFragment = memberEmail.slice(4, 14);
    const strangerFragment = strangerEmail.slice(4, 14);

    const groupName = `E2E Suggest ${Date.now()}`;
    const sidebar = adminPage.getByRole("complementary");
    await showSidebarTab(adminPage, "Groups");
    await sidebar.getByRole("button", { name: "New group", exact: true }).click();
    const groupDialog = adminPage.getByRole("dialog", { name: "New group" });
    await groupDialog.getByLabel("Group name").fill(groupName);
    await groupDialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(groupDialog).not.toBeVisible();
    await openGroupPanel(adminPage, groupName);
    await adminPage.getByLabel("Email address", { exact: true }).fill(memberEmail);
    await adminPage.getByRole("button", { name: "Add", exact: true }).click();
    await expect(adminPage.getByRole("button", { name: `Remove ${memberEmail}` })).toBeVisible();
    await adminPage.keyboard.press("Escape");
    await expect(adminPage.getByRole("button", { name: `Remove ${memberEmail}` })).toHaveCount(0);

    await createNote(adminPage, `E2E suggest note ${Date.now()}`);
    await adminPage.getByRole("button", { name: "Share", exact: true }).click();
    const shareDialog = adminPage.getByRole("dialog", { name: "Share note" });
    await shareDialog.getByRole("radio", { name: /Members only/ }).click();
    const box = shareDialog.getByRole("combobox", { name: "Email address" });
    const list = shareDialog.getByRole("listbox", { name: "People you know" });

    // Stranger: wait out the debounce and that one round trip; the list still does not appear.
    const strangerLookup = adminPage.waitForResponse((res) => res.url().includes("/api/users/suggest?") && res.url().includes(strangerFragment));
    await box.fill(strangerFragment);
    expect((await strangerLookup).status()).toBe(200);
    await expect(list).toHaveCount(0);

    await box.fill(memberFragment);
    await expect(list.getByRole("option", { name: /E2E Suggest Member/ })).toBeVisible();
    await expect(list.getByRole("option")).toHaveCount(1);
    await box.press("ArrowDown");
    await box.press("Enter");
    await expect(box).toHaveValue(memberEmail);
    await expect(list).toHaveCount(0);
    await shareDialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(shareDialog.getByRole("button", { name: `Remove ${memberEmail}` })).toBeVisible();
  } finally {
    await adminContext.close();
  }
});
