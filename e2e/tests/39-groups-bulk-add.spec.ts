import { expect, test, type Page } from "@playwright/test";
import { ADMIN, chooseSelectOption, createUserViaInvite, loginAs, openGroupPanel, randomEmail } from "./helpers.js";

/** Groups are created through the API (`page.request` shares the page's session cookie) and people through invitations; the stack is reset by `stack:down -v` each time and is not cleaned. */

async function createGroup(page: Page, name: string): Promise<string> {
  const res = await page.request.post("/api/groups", { data: { name } });
  expect(res.ok(), `POST /api/groups → HTTP ${res.status()} ${await res.text()}`).toBe(true);
  return ((await res.json()) as { id: string }).id;
}

async function addMemberViaApi(page: Page, groupId: string, email: string): Promise<void> {
  const res = await page.request.put(`/api/groups/${groupId}/members`, { data: { email } });
  expect(res.ok(), `PUT /api/groups/${groupId}/members → HTTP ${res.status()} ${await res.text()}`).toBe(true);
}

test("group bulk add: paste three addresses (one without an account) -> adds 2 and lists the one without an account; import from another group -> member count is right", async ({ page }) => {
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);

  const password = "e2e-bulk-add-user-pw";
  const [first, second, third] = [randomEmail(), randomEmail(), randomEmail()];
  await createUserViaInvite(page, { email: first, password, displayName: "E2E Bulk One" });
  await createUserViaInvite(page, { email: second, password, displayName: "E2E Bulk Two" });
  await createUserViaInvite(page, { email: third, password, displayName: "E2E Bulk Three" });
  const ghost = randomEmail();

  const stamp = Date.now();
  const targetName = `E2E Bulk Target ${stamp}`;
  const sourceName = `E2E Bulk Source ${stamp}`;
  await createGroup(page, targetName);
  const sourceId = await createGroup(page, sourceName);
  await addMemberViaApi(page, sourceId, first);
  await addMemberViaApi(page, sourceId, third);
  await page.reload();

  await openGroupPanel(page, targetName);
  const dialog = page.getByRole("dialog", { name: targetName });
  await dialog.getByLabel("Email address", { exact: true }).fill(`${first}, ${ghost}; ${second}`);
  await dialog.getByRole("button", { name: "Add", exact: true }).click();

  const addDialog = page.getByRole("dialog", { name: "Add members" });
  await expect(addDialog.getByRole("button", { name: "Done" })).toBeVisible({ timeout: 15_000 });
  await expect(addDialog.locator('[data-outcome="added"]')).toContainText(first);
  await expect(addDialog.locator('[data-outcome="added"]')).toContainText(second);
  await expect(addDialog.locator('[data-outcome="notFound"]')).toContainText("No account with this email (1):");
  await expect(addDialog.locator('[data-outcome="notFound"] li')).toHaveText([ghost]);
  await addDialog.getByRole("button", { name: "Done" }).click();
  await expect(addDialog).not.toBeVisible();
  await expect(dialog.getByRole("button", { name: `Remove ${first}` })).toBeVisible();
  await expect(dialog.getByRole("button", { name: `Remove ${second}` })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /^Remove / })).toHaveCount(3); // admin + 2
  // The address with no account stays in the input (easy to fix)
  await expect(dialog.getByLabel("Email address", { exact: true })).toHaveValue(ghost);

  await dialog.getByRole("button", { name: "Import from another group…" }).click();
  const importDialog = page.getByRole("dialog", { name: "Import members from another group" });
  await expect(importDialog).toBeVisible();
  await chooseSelectOption(page, importDialog.getByLabel("Group to import from"), sourceName);
  const list = importDialog.getByRole("list", { name: "People to add" });
  // admin is yourself and first is already in the target group -> only third remains, ticked by default
  await expect(list.getByRole("checkbox")).toHaveCount(1);
  await expect(list.getByRole("checkbox", { name: third })).toBeChecked();
  await importDialog.getByRole("button", { name: "Add 1 person" }).click();

  await expect(importDialog.getByRole("button", { name: "Done" })).toBeVisible({ timeout: 15_000 });
  await expect(importDialog.locator('[data-outcome="added"]')).toContainText("Added (1):");
  await expect(importDialog.locator('[data-outcome="added"] li')).toHaveText([third]);
  await importDialog.getByRole("button", { name: "Done" }).click();
  await expect(importDialog).not.toBeVisible();
  await expect(dialog.getByRole("button", { name: `Remove ${third}` })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /^Remove / })).toHaveCount(4); // admin + first + second + third
});
