import { expect, test } from "@playwright/test";
import { ADMIN, createUserViaInvite, loginAs, randomEmail } from "./helpers.js";

/** Users have no delete API and stay (the email carries a random code, as in 26). */

const FIRST_PASSWORD = "e2e-t32-first-password";
const RESET_PASSWORD = "e2e-t32-reset-password";

test("32: admin generates a reset link -> the user sets a new password and signs in -> other browsers are logged out, the PAT keeps working", async ({ browser, baseURL }) => {
  const email = randomEmail();
  const adminContext = await browser.newContext();
  const userContext = await browser.newContext();
  const resetContext = await browser.newContext();
  const anonymous = await browser.newContext();
  try {
    const adminPage = await adminContext.newPage();
    await loginAs(adminPage, ADMIN.email, ADMIN.password);
    await expect(adminPage).toHaveURL(/\/$/);
    await createUserViaInvite(adminPage, { email, password: FIRST_PASSWORD, displayName: "E2E Reset User" });

    const userPage = await userContext.newPage();
    await loginAs(userPage, email, FIRST_PASSWORD);
    await expect(userPage).toHaveURL(/\/$/);
    const tokenRes = await userPage.request.post("/api/auth/tokens", { data: { name: `E2E t32 ${Date.now()}`, scope: "notes:read", expiresInDays: null } });
    expect(tokenRes.status()).toBe(201);
    const { token: pat } = (await tokenRes.json()) as { token: string };
    const bearer = { Authorization: `Bearer ${pat}` };
    expect((await anonymous.request.get(`${baseURL}/api/notes`, { headers: bearer })).status()).toBe(200);

    await adminPage.goto("/admin/users");
    await adminPage.getByRole("button", { name: `Reset password for ${email}`, exact: true }).click();
    const dialog = adminPage.getByRole("dialog", { name: "Reset password" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Create link" }).click();
    const result = adminPage.getByRole("dialog", { name: "Password reset link" });
    const linkField = result.getByLabel("Link", { exact: true });
    await expect(linkField).toBeVisible();
    const link = await linkField.inputValue();
    // origin is not hard-coded: same origin as the playwright config's baseURL, taken from the current page.
    const origin = new URL(adminPage.url()).origin;
    const prefix = `${origin}/reset-password#token=`;
    expect(link.startsWith(prefix)).toBe(true);
    expect(link.slice(prefix.length)).toMatch(/^knbp_[A-Za-z0-9_-]{43}$/);
    await result.getByRole("button", { name: "Done" }).click();
    await expect(result).toBeHidden();

    const resetPage = await resetContext.newPage();
    await resetPage.goto(link);
    await expect(resetPage).toHaveURL(/\/reset-password$/);
    await expect(resetPage.getByText(`For ${email}.`, { exact: false })).toBeVisible();
    await resetPage.getByLabel("New password", { exact: true }).fill(RESET_PASSWORD);
    await resetPage.getByLabel("Confirm new password", { exact: true }).fill(RESET_PASSWORD);
    await resetPage.getByRole("button", { name: "Set password" }).click();
    await expect(resetPage).toHaveURL(/\/$/, { timeout: 15_000 });

    expect((await userPage.request.get("/api/auth/me")).status()).toBe(401);
    await userPage.goto("/");
    await expect(userPage).toHaveURL(/\/login/);
    expect((await anonymous.request.get(`${baseURL}/api/notes`, { headers: bearer })).status()).toBe(200);
  } finally {
    await anonymous.close();
    await resetContext.close();
    await userContext.close();
    await adminContext.close();
  }
});
