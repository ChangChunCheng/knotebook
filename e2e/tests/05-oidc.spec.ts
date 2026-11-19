import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { IDP_CONTROL_ORIGIN } from "../ports.js";
import { ADMIN, createNote, createUserViaInvite, loginAs, randomEmail } from "./helpers.js";

/**
 * The stack's `global-setup.ts` creates the enabled "SSO" provider (auto-create on, fake-idp root issuer), hence the button
 * "Sign in with SSO". The control endpoint `/control/next-login` is under `IDP_CONTROL_ORIGIN` (`e2e/ports.ts`; the `request`
 * fixture ignores the browser's host-resolver-rules). Identity values (sub, email) are randomised: a failed run leaves the
 * stack up and a re-run would otherwise hit dirty data.
 * A legacy callback URL cannot be created through the admin API and is covered by server integration tests.
 * The login-page height test (44px) lives here because jsdom applies no CSS, so it borrows this file's SSO button in a real
 * browser.
 */

const CONTROL_URL = `${IDP_CONTROL_ORIGIN}/control/next-login`;
const SSO_BUTTON = "Sign in with SSO";

test("scenario 1: SSO login with an unknown email -> account is auto-created and signed in", async ({ request, browser }) => {
  const email = randomEmail();
  const controlResponse = await request.put(CONTROL_URL, {
    data: { sub: `e2e-new-${randomUUID()}`, email, email_verified: true, name: "E2E New User" },
  });
  expect(controlResponse.ok()).toBe(true);

  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto("/login");
    await page.getByRole("link", { name: SSO_BUTTON }).click();
    await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
    await expect(page.getByRole("button", { name: "E2E New User", exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

/**
 * fake-idp's `name` claim deliberately differs from the display name given at invitation: whichever one UserMenu shows tells
 * "linked to the existing account" apart from "wrongly created a new account".
 */
test("scenario 2: SSO first login with an email matching an invited account -> enter that account's password to link -> straight in -> later both SSO and password work", async ({ request, browser }) => {
  const linkedEmail = randomEmail();
  const password = "e2e-oidc-linked-user-pw";
  const displayName = "E2E OIDC Linked User";
  const idpNameClaim = "IdP Claimed Name (must not appear)";
  const sub = `e2e-linked-${randomUUID()}`;

  const adminContext = await browser.newContext();
  try {
    const adminPage = await adminContext.newPage();
    await loginAs(adminPage, ADMIN.email, ADMIN.password);
    await expect(adminPage).toHaveURL(/\/$/);
    await createUserViaInvite(adminPage, { email: linkedEmail, password, displayName });
  } finally {
    await adminContext.close();
  }

  const putLogin = async () => {
    const res = await request.put(CONTROL_URL, { data: { sub, email: linkedEmail, email_verified: true, name: idpNameClaim } });
    expect(res.ok()).toBe(true);
  };

  await putLogin();
  const ssoContext = await browser.newContext();
  try {
    const page = await ssoContext.newPage();
    await page.goto("/login");
    await page.getByRole("link", { name: SSO_BUTTON }).click();
    await expect(page).toHaveURL(/\/link-account$/, { timeout: 20_000 });
    await expect(page.getByText(`This email (${linkedEmail}) already has an account.`, { exact: false })).toBeVisible();
    await page.getByLabel("Password for this account").fill(password);
    await page.getByRole("button", { name: "Confirm with password and link" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("button", { name: displayName, exact: true })).toBeVisible();
    await expect(page.getByText(idpNameClaim)).toHaveCount(0);
  } finally {
    await ssoContext.close();
  }

  await putLogin();
  const againContext = await browser.newContext();
  try {
    const page = await againContext.newPage();
    await page.goto("/login");
    await page.getByRole("link", { name: SSO_BUTTON }).click();
    await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
    await expect(page.getByRole("button", { name: displayName, exact: true })).toBeVisible();
  } finally {
    await againContext.close();
  }

  const passwordContext = await browser.newContext();
  try {
    const page = await passwordContext.newPage();
    await loginAs(page, linkedEmail, password);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("button", { name: displayName, exact: true })).toBeVisible();
  } finally {
    await passwordContext.close();
  }
});

/**
 * The image is served from fake-idp's own `/avatar.png` (same hostname and port as the issuer), so the downloader's address
 * check lets it through without any e2e-only bypass.
 */
test("scenario 3: SSO first login with a picture -> auto candidate and selected -> sidebar image once the display image is generated; a deleted picture is not restored, manual \"Use my SSO picture\" retrieves it", async ({ request, browser }) => {
  test.setTimeout(180_000);
  const email = randomEmail();
  const sub = `e2e-picture-${randomUUID()}`;
  const displayName = "E2E Picture User";
  const picture = "http://fake-idp:9400/avatar.png";

  const putLogin = async () => {
    const res = await request.put(CONTROL_URL, { data: { sub, email, email_verified: true, name: displayName, picture } });
    expect(res.ok()).toBe(true);
  };
  const ssoLogin = async (page: Page) => {
    await putLogin();
    await page.goto("/login");
    await page.getByRole("link", { name: SSO_BUTTON }).click();
    await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
  };
  type Candidate = { id: string; source: string; providerName: string | null; pending: boolean; current: boolean };
  type AvatarList = { candidates: Candidate[]; auto: boolean; refreshable: { identityId: string; providerName: string }[] };
  const readList = async (page: Page) => (await (await page.request.get("/api/auth/avatars")).json()) as AvatarList;

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    const page = await context.newPage();
    await ssoLogin(page);
    const accountButton = page.getByRole("button", { name: displayName, exact: true });
    await expect(accountButton).toBeVisible({ timeout: 15_000 });

    // Background download: the candidate appears and is the current one (the login response does not wait for it, hence the polling).
    await expect.poll(async () => (await readList(page)).candidates.length, { timeout: 35_000 }).toBe(1);
    const first = (await readList(page)).candidates[0]!;
    expect(first.source).toBe("oidc");
    expect(first.providerName).toBe("SSO");
    expect(first.current).toBe(true);

    // The picture may arrive after the home page read /me; a reload reopens Knotebook so the display-image generator can see pending.
    await page.reload();
    await expect(accountButton).toBeVisible({ timeout: 15_000 });

    // The display image is generated by the user's own browser (mounted in AppShell, so staying on the home page triggers it; the settings page would too, so do not go there yet): pending becomes false.
    await expect.poll(async () => (await readList(page)).candidates[0]?.pending, { timeout: 35_000 }).toBe(false);

    await page.goto("/settings/account");
    const group = page.getByRole("radiogroup", { name: "Picture options" });
    await expect(group.getByRole("radio", { name: "Picture from SSO", exact: true })).toHaveAttribute("aria-checked", "true", { timeout: 15_000 });

    // The sidebar account button holds a loaded <img> (check from the note page; wait for the title box first so the lazy page has swapped its shell before touching the sidebar).
    await page.goto("/");
    await createNote(page, `E2E OIDC avatar ${Date.now()}`);
    await expect(page.getByLabel("Note title")).toBeVisible({ timeout: 15_000 });
    const accountImg = accountButton.locator("img");
    await expect(accountImg).toHaveCount(1, { timeout: 15_000 });
    await expect.poll(() => accountImg.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 15_000 }).toBeGreaterThan(0);

    const del = await page.request.delete(`/api/auth/avatars/${first.id}`);
    expect(del.status(), await del.text()).toBeLessThan(300);
    await page.request.post("/api/auth/logout");
    await ssoLogin(page);
    await expect(accountButton).toBeVisible({ timeout: 15_000 });
    // There is no "restored" event to wait for, so give the background job a full window and then confirm there are still no candidates.
    await page.waitForTimeout(3_000);
    expect((await readList(page)).candidates).toHaveLength(0);

    await page.goto("/settings/account");
    await page.getByRole("button", { name: "Use my SSO picture", exact: true }).click({ timeout: 15_000 });
    await expect(group.getByRole("radio", { name: "Picture from SSO", exact: true })).toHaveAttribute("aria-checked", "true", { timeout: 20_000 });
    const after = await readList(page);
    expect(after.candidates).toHaveLength(1);
    expect(after.candidates[0]!.current).toBe(true);
    expect(after.refreshable).toHaveLength(0);
  } finally {
    await context.close();
  }
});

/**
 * Card-style pages are an exception to the default 32px control height: on the login page "Sign in" and the SSO button are
 * 44px (`size="lg"`) and the inputs follow (convention in `apps/web/src/components/ui/button.tsx`). jsdom applies no CSS and
 * cannot compute heights, so this is measured here.
 */
test("login page: Sign in button, SSO button and both inputs are 44px high", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto("/login");
    const targets = [
      { label: "Sign in", locator: page.getByRole("button", { name: "Sign in", exact: true }) },
      { label: SSO_BUTTON, locator: page.getByRole("link", { name: SSO_BUTTON }) },
      { label: "#login-email", locator: page.locator("#login-email") },
      { label: "#login-password", locator: page.locator("#login-password") },
    ];
    for (const { label, locator } of targets) {
      await expect(locator).toBeVisible();
      const box = await locator.boundingBox();
      expect(box, `${label} 應有 bounding box`).not.toBeNull();
      expect(Math.round(box!.height), `${label} 高度`).toBe(44);
    }
  } finally {
    await context.close();
  }
});
