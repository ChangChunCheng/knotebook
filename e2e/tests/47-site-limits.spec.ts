import { expect, test, type APIRequestContext } from "@playwright/test";
import { ADMIN, adminNav, loginAs, openSiteAdmin } from "./helpers.js";

/**
 * Site admin "Site limits" tab: change the parse timeout -> save -> it persists after reload, the newest change-log row is this change, the automatic value of
 * "max queue wait" follows -> "Restore defaults" returns to the default (still the default after reload).
 *
 * The parse timeout is a setting shared by the whole stack, so each case restores it through the API before and after (not through the UI): the first makes the start point the default,
 * the second leaves no 5 seconds behind however the case ends. The change log accumulates on the stack (a reused stack has earlier rows), so only the newest row is checked, not the total count.
 */

async function resetParseTimeout(request: APIRequestContext): Promise<void> {
  const login = await request.post("/api/auth/login", { data: { email: ADMIN.email, password: ADMIN.password } });
  expect(login.status(), `POST /api/auth/login → HTTP ${login.status()}`).toBe(200);
  const res = await request.patch("/api/admin/limits", { data: { set: { parseTimeoutMs: null } } });
  expect(res.status(), `PATCH /api/admin/limits → HTTP ${res.status()} ${await res.text()}`).toBe(200);
}

test.beforeEach(async ({ request }) => {
  await resetParseTimeout(request);
});

test.afterEach(async ({ request }) => {
  await resetParseTimeout(request);
});

test("47-1 parse timeout: changing to 5 seconds persists after reload, the newest log row is it, the automatic queue wait follows, and Restore defaults returns to 10", async ({ page }) => {
  await loginAs(page, ADMIN.email, ADMIN.password);
  await page.goto("/");
  const dialog = await openSiteAdmin(page);
  await adminNav(page, "Site limits");

  const row = dialog.getByRole("group", { name: "Parse time limit" });
  const input = row.getByRole("textbox", { name: "Parse time limit" });
  const queueRow = dialog.getByRole("group", { name: "Longest wait for a worker" });
  const parseGroup = dialog.getByRole("region", { name: "Parse workers" });

  await expect(input).toHaveValue("10");
  await expect(queueRow.getByText("Auto: 45 seconds")).toBeVisible();

  await input.fill("5");
  await parseGroup.getByRole("button", { name: "Save", exact: true }).click();
  // The "Saved" notice is a toast outside the section, so check the result inside the section: this row shows the "Adjusted" marker.
  await expect(row.getByText("Adjusted")).toBeVisible();

  await page.reload();
  await expect(input).toHaveValue("5");
  await expect(row.getByText("Adjusted")).toBeVisible();
  await expect(queueRow.getByText("Auto: 25 seconds")).toBeVisible();

  // The server lists newest first; row 0 is the header, so row 1 is the newest data row.
  const newest = dialog.getByRole("table", { name: "Recent changes" }).getByRole("row").nth(1);
  await expect(newest).toContainText("Parse time limit");
  await expect(newest).toHaveText(/→ 5 seconds$/);

  await row.getByRole("button", { name: "Restore default" }).click();
  await expect(input).toHaveValue("10");
  await expect(row.getByText("Adjusted")).toHaveCount(0);
  await expect(queueRow.getByText("Auto: 45 seconds")).toBeVisible();

  await page.reload();
  await expect(input).toHaveValue("10");
});
