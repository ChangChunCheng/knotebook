import { randomUUID } from "node:crypto";
import { test, expect, type Browser, type APIRequestContext } from "@playwright/test";
import { E2E_ORIGIN, IDP_CONTROL_ORIGIN } from "../ports.js";
import { ADMIN, chooseSelectOption, adminNav, loginAs, openSiteAdmin, randomEmail, reEscape } from "./helpers.js";

/**
 * The second provider points at fake-idp's path-form issuer `http://fake-idp:9400/b` (own keys, shared client).
 * Identity values (display name, sub, email) are randomised: a failed run leaves the stack up and a re-run would otherwise
 * hit dirty data.
 * The control endpoint is `/b/control/next-login` under `IDP_CONTROL_ORIGIN` (`e2e/ports.ts`; the `request` fixture ignores
 * the browser's host-resolver-rules).
 */

const SECOND_ISSUER = "http://fake-idp:9400/b";
const SECOND_CONTROL_URL = `${IDP_CONTROL_ORIGIN}/b/control/next-login`;
const SECOND_NAME = `Second IdP ${randomUUID().slice(0, 8)}`;
const ROOT_CONTROL_URL = `${IDP_CONTROL_ORIGIN}/control/next-login`;
const NEW_PASSWORD = "e2e-accounts-password-123";

async function nextLogin(request: APIRequestContext, url: string, claims: { sub: string; email: string; name?: string }) {
  const res = await request.put(url, { data: { name: "E2E Accounts User", ...claims } });
  expect(res.ok()).toBe(true);
}

async function adminOnSignInPage(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);
  await openSiteAdmin(page);
  await adminNav(page, "Sign-in");
  return { context, page };
}

test.describe.serial("19 Accounts and sign-in providers (#187)", () => {
  test("19-1: admin creates a second sign-in provider at /admin/login -> callback URL -> fill secret -> test -> enable -> turn on auto-create; the sign-in page shows the button and a first login creates the account", async ({ browser, request }) => {
    const { context, page } = await adminOnSignInPage(browser);
    try {
      await page.getByRole("button", { name: "Add sign-in service" }).click();
      const dialog = page.getByRole("dialog", { name: "Add sign-in service" });
      await chooseSelectOption(page, dialog.getByLabel("Template"), "Custom OIDC");
      await dialog.getByLabel("Display name").fill(SECOND_NAME);
      await dialog.getByLabel("Issuer URL").fill(SECOND_ISSUER);
      await dialog.getByRole("button", { name: "Check issuer" }).click();
      await expect(dialog.getByText(`Found issuer ${SECOND_ISSUER}.`)).toBeVisible();
      await dialog.getByLabel("Client ID").fill("knotebook-e2e");
      await dialog.getByRole("button", { name: "Add", exact: true }).click();

      const steps = page.getByRole("dialog", { name: "Finish setting it up" });
      await expect(steps.getByText(new RegExp(`^${reEscape(E2E_ORIGIN)}/api/auth/oidc/callback/[0-9a-f-]{36}$`))).toBeVisible();
      await steps.getByRole("button", { name: "Done" }).click();
      await expect(steps).not.toBeVisible();

      const card = page.getByRole("row", { name: SECOND_NAME, exact: true });
      const details = page.getByRole("row", { name: `${SECOND_NAME} details`, exact: true });
      await expect(details.getByText(/No client secret yet/)).toBeVisible();
      await card.getByRole("button", { name: "Edit" }).click();
      const edit = page.getByRole("dialog", { name: "Edit sign-in service" });
      await edit.getByLabel("Client secret").fill("e2e-oidc-secret");
      await edit.getByRole("button", { name: "Save" }).click();
      await expect(edit).not.toBeVisible();
      await expect(details.getByText("Client secret saved.")).toBeVisible();

      await card.getByRole("button", { name: "Test connection" }).click();
      await expect(details.getByText(`Connection OK. The identity provider reports issuer ${SECOND_ISSUER}.`)).toBeVisible();
      await expect(details.getByText("The issuer uses plain http.")).toBeVisible();
      // #247: the enable switch's accessible name = the "Enabled" column header + the provider's display name (aria-labelledby).
      await card.getByRole("switch", { name: `Enabled ${SECOND_NAME}`, exact: true }).click();
      await expect(card.getByRole("switch", { name: `Enabled ${SECOND_NAME}`, exact: true })).toHaveAttribute("aria-checked", "true");
      const autoCreate = card.getByRole("switch", { name: `Create accounts on first sign-in with ${SECOND_NAME}`, exact: true });
      await expect(autoCreate).toHaveAttribute("aria-checked", "false");
      await autoCreate.click();
      await expect(autoCreate).toHaveAttribute("aria-checked", "true");
    } finally {
      await context.close();
    }

    const email = randomEmail();
    const control = await request.put(SECOND_CONTROL_URL, { data: { sub: `e2e-second-${randomUUID()}`, email, name: "E2E Second User" } });
    expect(control.ok()).toBe(true);
    const userContext = await browser.newContext();
    try {
      const page = await userContext.newPage();
      await page.goto("/login");
      await page.getByRole("link", { name: `Sign in with ${SECOND_NAME}` }).click();
      await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
      await expect(page.getByRole("button", { name: "E2E Second User", exact: true })).toBeVisible();
    } finally {
      await userContext.close();
    }
  });

  test("19-2: a signed-in account links the second provider on the settings page -> linked -> another browser signs in to the same account with it", async ({ browser, request }) => {
    const email = randomEmail();
    const sub = `e2e-19-2-${randomUUID()}`;
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      const reg = await page.request.post("/api/auth/register", { data: { email, password: NEW_PASSWORD, displayName: "E2E Linker" } });
      expect(reg.status()).toBe(201);
      await page.goto("/settings/login");
      await nextLogin(request, SECOND_CONTROL_URL, { sub, email: `other-${randomUUID()}@e2e.local` });
      await page.getByRole("button", { name: `Link ${SECOND_NAME}` }).click();
      // The settings page is reached only after the whole OIDC round trip (waiting on the URL has no effect: we are on /settings/login before leaving).
      // The toast text also has a copy in a `role="status"` "Notification ..." screen-reader node: without exact there would be two matches in strict mode (see 03).
      await expect(page.getByText("Sign-in service linked.", { exact: true })).toBeVisible({ timeout: 20_000 });
      // #247: the return lands on the settings "Sign-in" page (the server redirects to `/settings/login?linked=...` and the param
      // is cleared after the toast); assert only after the toast, when this is already the return page and not the one we left.
      await expect(page).toHaveURL(/\/settings\/login(\?.*)?$/);
      await expect(page.getByRole("table", { name: "Sign-in methods", exact: true }).getByRole("row", { name: new RegExp(SECOND_NAME) })).toBeVisible();
    } finally {
      await ctx.close();
    }
    const other = await browser.newContext();
    try {
      const page = await other.newPage();
      await nextLogin(request, SECOND_CONTROL_URL, { sub, email: `ignored-${randomUUID()}@e2e.local` });
      await page.goto("/login");
      await page.getByRole("link", { name: `Sign in with ${SECOND_NAME}` }).click();
      await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
      await expect(page.getByRole("button", { name: "E2E Linker", exact: true })).toBeVisible();
    } finally {
      await other.close();
    }
  });

  test("19-3: password registration -> another browser goes through SSO with the same email -> /link-account asks for the password -> linked and signed in", async ({ browser, request }) => {
    const email = randomEmail();
    const reg = await browser.newContext();
    try {
      const page = await reg.newPage();
      await page.goto("/register");
      await page.getByLabel("Email").fill(email);
      await page.getByLabel("Display name (optional)").fill("E2E Registered");
      await page.getByLabel("Password", { exact: true }).fill(NEW_PASSWORD);
      await page.getByLabel("Confirm password").fill(NEW_PASSWORD);
      await page.getByRole("button", { name: "Create account" }).click();
      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByRole("button", { name: "E2E Registered", exact: true })).toBeVisible();
    } finally {
      await reg.close();
    }
    const sso = await browser.newContext();
    try {
      const page = await sso.newPage();
      await nextLogin(request, SECOND_CONTROL_URL, { sub: `e2e-19-3-${randomUUID()}`, email });
      await page.goto("/login");
      await page.getByRole("link", { name: `Sign in with ${SECOND_NAME}` }).click();
      await expect(page).toHaveURL(/\/link-account$/, { timeout: 20_000 });
      await page.getByLabel("Password for this account").fill(NEW_PASSWORD);
      await page.getByRole("button", { name: "Confirm with password and link" }).click();
      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByRole("button", { name: "E2E Registered", exact: true })).toBeVisible();
    } finally {
      await sso.close();
    }
  });

  // Depends on 19-1: the second provider has auto-create on, so the sign-in page SSO button creates the account.
  test("19-4 + 19-5: first login via the sign-in page SSO button creates an SSO-only account -> unlink button of the only sign-in method is disabled -> add a password -> another browser signs in with the password", async ({ browser, request }) => {
    const email = randomEmail();
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await nextLogin(request, SECOND_CONTROL_URL, { sub: `e2e-19-4-${randomUUID()}`, email, name: "E2E SSO Only" });
      await page.goto("/login");
      await page.getByRole("link", { name: `Sign in with ${SECOND_NAME}` }).click();
      await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
      await page.goto("/settings/login");
      const row = page.getByRole("table", { name: "Sign-in methods", exact: true }).getByRole("row", { name: new RegExp(SECOND_NAME) });
      await expect(row.getByRole("button", { name: "Unlink" })).toHaveAttribute("aria-disabled", "true");
      await expect(row.getByText("This is your only way to sign in, so it can't be unlinked.")).toBeVisible();
      // Locate by id: Playwright's getByLabel defaults to substring matching, so "New password" would also match "Confirm new password" (a strict mode error).
      await page.locator("#set-password-new").fill(NEW_PASSWORD);
      await page.locator("#set-password-confirm").fill(NEW_PASSWORD);
      await page.getByRole("button", { name: "Add password" }).click();
      await expect(page.getByText("Password added.", { exact: true })).toBeVisible();
      await expect(row.getByRole("button", { name: "Unlink" })).not.toHaveAttribute("aria-disabled");
      await expect(row.getByRole("button", { name: "Unlink" })).toBeEnabled();
    } finally {
      await ctx.close();
    }
    const pw = await browser.newContext();
    try {
      const page = await pw.newPage();
      await loginAs(page, email, NEW_PASSWORD);
      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByRole("button", { name: "E2E SSO Only", exact: true })).toBeVisible();
    } finally {
      await pw.close();
    }
  });

  test("19-6: turning off self-registration -> sign-in page has no register button, /register redirects to login, API 403; then turn off auto-create on all providers -> a new email's first SSO login is rejected; finally restore each", async ({ browser, request }) => {
    const { context, page } = await adminOnSignInPage(browser);
    type ProviderRow = { id: string; displayName: string; autoCreateEnabled: boolean };
    const listProviders = async (): Promise<ProviderRow[]> => {
      const res = await page.request.get("/api/admin/auth/providers");
      expect(res.ok()).toBe(true);
      return ((await res.json()) as { providers: ProviderRow[] }).providers;
    };
    // The original values are captured inside the try: if capturing fails, `original` stays null and the finally falls back to fixed values.
    let original: { registrationEnabled: boolean; providers: Array<{ id: string; autoCreateEnabled: boolean }> } | null = null;
    try {
      const settingsRes = await page.request.get("/api/admin/auth/settings");
      expect(settingsRes.ok()).toBe(true);
      const registrationEnabled = ((await settingsRes.json()) as { registrationEnabled: boolean }).registrationEnabled;
      const before = await listProviders();
      original = { registrationEnabled, providers: before.map(({ id, autoCreateEnabled }) => ({ id, autoCreateEnabled })) };

      const sw = page.getByRole("switch", { name: "Allow self-registration with a password" });
      if ((await sw.getAttribute("aria-checked")) === "true") await sw.click();
      await expect(sw).toHaveAttribute("aria-checked", "false");

      const anon = await browser.newContext();
      try {
        const p = await anon.newPage();
        await p.goto("/register");
        // Wait point = the URL landing on /login: it leaves only after the config has landed (the form shows first while loading).
        await expect(p).toHaveURL(/\/login$/);
        await expect(p.getByRole("link", { name: `Sign in with ${SECOND_NAME}` })).toBeVisible();
        await expect(p.getByRole("link", { name: "Create an account" })).toHaveCount(0);
        const api = await p.request.post("/api/auth/register", { data: { email: randomEmail(), password: NEW_PASSWORD } });
        expect(api.status()).toBe(403);
        expect((await api.json()).error.code).toBe("registration_disabled");
      } finally {
        await anon.close();
      }

      // This run's two rows go through the UI; leftovers from earlier runs go through the API.
      for (const name of [SECOND_NAME, "SSO"]) {
        const autoCreate = page.getByRole("switch", { name: `Create accounts on first sign-in with ${name}`, exact: true });
        if ((await autoCreate.count()) === 0) continue;
        if ((await autoCreate.getAttribute("aria-checked")) === "true") await autoCreate.click();
        await expect(autoCreate).toHaveAttribute("aria-checked", "false");
      }
      for (const row of await listProviders()) {
        if (!row.autoCreateEnabled) continue;
        const res = await page.request.patch(`/api/admin/auth/providers/${row.id}`, { data: { autoCreateEnabled: false } });
        expect(res.ok()).toBe(true);
      }

      const anon2 = await browser.newContext();
      try {
        const p = await anon2.newPage();
        await p.goto("/login");
        await expect(p.getByRole("link", { name: `Sign in with ${SECOND_NAME}` })).toBeVisible();
        await expect(p.getByRole("link", { name: "Create an account" })).toHaveCount(0);
        await p.goto("/register");
        await expect(p).toHaveURL(/\/login$/);
        await nextLogin(request, SECOND_CONTROL_URL, { sub: `e2e-19-6-${randomUUID()}`, email: randomEmail() });
        await p.goto("/login");
        await p.getByRole("link", { name: `Sign in with ${SECOND_NAME}` }).click();
        await expect(p.getByRole("alert")).toHaveText("New accounts can't be created this way right now. Please contact the site administrator.", { timeout: 20_000 });
      } finally {
        await anon2.close();
      }
    } finally {
      try {
        if (original !== null) {
          const results = [];
          for (const row of original.providers) {
            results.push(await page.request.patch(`/api/admin/auth/providers/${row.id}`, { data: { autoCreateEnabled: row.autoCreateEnabled } }));
          }
          results.push(await page.request.patch("/api/admin/auth/settings", { data: { registrationEnabled: original.registrationEnabled } }));
          expect(results.map((r) => r.ok())).not.toContain(false);
        } else {
          // Original values were not captured (failed at the start): fall back to "self-registration on, second provider and SSO create accounts"; 05, 19-4, 19-6a and 26 depend on them.
          const results = [];
          for (const row of await listProviders()) {
            if (row.displayName !== SECOND_NAME && row.displayName !== "SSO") continue;
            results.push(await page.request.patch(`/api/admin/auth/providers/${row.id}`, { data: { autoCreateEnabled: true } }));
          }
          results.push(await page.request.patch("/api/admin/auth/settings", { data: { registrationEnabled: true } }));
          expect(results.map((r) => r.ok())).not.toContain(false);
        }
      } finally {
        await context.close();
      }
    }
  });

  test("19-6a: an SSO-only account (first provider SSO) + the same email signing in through the second provider -> /link-account allows proving only via SSO -> signed in, settings shows two identities", async ({ browser, request }) => {
    const email = randomEmail();
    const firstSub = `e2e-19-6a-${randomUUID()}`;
    const reg = await browser.newContext();
    try {
      const page = await reg.newPage();
      await nextLogin(request, ROOT_CONTROL_URL, { sub: firstSub, email, name: "E2E Prover" });
      await page.goto("/login");
      await page.getByRole("link", { name: "Sign in with SSO" }).click();
      await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
    } finally {
      await reg.close();
    }
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      await nextLogin(request, SECOND_CONTROL_URL, { sub: `e2e-19-6a-b-${randomUUID()}`, email });
      await page.goto("/login");
      await page.getByRole("link", { name: `Sign in with ${SECOND_NAME}` }).click();
      await expect(page).toHaveURL(/\/link-account$/, { timeout: 20_000 });
      // Tolerate leftovers: assert only that the one needed this run is present. Seeing it means pending has landed, after which
      // the password field can be asserted absent (before that it shows "Loading..." and the password field is absent anyway,
      // so asserting count 0 first would be a false green before the data arrives).
      const prove = page.getByRole("button", { name: "Confirm by signing in with SSO", exact: true });
      await expect(prove).toBeVisible();
      await expect(page.getByLabel("Password for this account")).toHaveCount(0);
      await nextLogin(request, ROOT_CONTROL_URL, { sub: firstSub, email });
      await prove.click();
      await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
      await expect(page.getByRole("button", { name: "E2E Prover", exact: true })).toBeVisible();
      await page.goto("/settings/login");
      const methods = page.getByRole("table", { name: "Sign-in methods", exact: true });
      await expect(methods.getByRole("row", { name: /^SSO/ })).toBeVisible();
      await expect(methods.getByRole("row", { name: new RegExp(SECOND_NAME) })).toBeVisible();
    } finally {
      await ctx.close();
    }
  });

  test("19-8: admin links the second provider -> turns off password login, self-registration and the second provider's auto-create -> the create-invitation dialog says password is off and submit is disabled -> a newcomer's first SSO login is rejected -> temporarily turn on the second provider's auto-create -> newcomer's first SSO login creates the account and signs in -> turn it back off; the admin's session is still valid", async ({ browser, request }) => {
    const { context, page } = await adminOnSignInPage(browser);
    const memberEmail = randomEmail();
    const memberSub = `e2e-19-8-member-${randomUUID()}`;
    type ProviderRow = { id: string; displayName: string; autoCreateEnabled: boolean };
    const listProviders = async (): Promise<ProviderRow[]> => {
      const res = await page.request.get("/api/admin/auth/providers");
      expect(res.ok()).toBe(true);
      return ((await res.json()) as { providers: ProviderRow[] }).providers;
    };
    // The original values are captured inside the try (as in 19-6): if capturing fails, `original` stays null and the finally falls back to fixed values.
    let original: { registrationEnabled: boolean; secondProvider: { id: string; autoCreateEnabled: boolean } } | null = null;
    try {
      const settingsRes = await page.request.get("/api/admin/auth/settings");
      expect(settingsRes.ok()).toBe(true);
      const registrationEnabled = ((await settingsRes.json()) as { registrationEnabled: boolean }).registrationEnabled;
      const second = (await listProviders()).find((row) => row.displayName === SECOND_NAME);
      expect(second, `provider ${SECOND_NAME} not found`).toBeDefined();
      original = { registrationEnabled, secondProvider: { id: second!.id, autoCreateEnabled: second!.autoCreateEnabled } };
      const secondId = original.secondProvider.id;

      // Leftover from earlier runs: if the admin already has an identity on /b, the "Link" button does not appear, so clear it first (password login is on and the admin has a password, so unlinking is always allowed).
      const ids = await (await page.request.get("/api/auth/identities")).json();
      for (const identity of ids.identities as Array<{ id: string; issuer: string }>) {
        if (identity.issuer === SECOND_ISSUER) expect((await page.request.delete(`/api/auth/identities/${identity.id}`)).status()).toBe(204);
      }
      await page.goto("/settings/login");
      await nextLogin(request, SECOND_CONTROL_URL, { sub: `e2e-19-8-admin-${randomUUID()}`, email: ADMIN.email });
      await page.getByRole("button", { name: `Link ${SECOND_NAME}` }).click();
      await expect(page.getByText("Sign-in service linked.", { exact: true })).toBeVisible({ timeout: 20_000 });

      await page.goto("/admin/login");
      await page.getByRole("switch", { name: "Allow password sign-in" }).click();
      const confirm = page.getByRole("dialog", { name: "Turn off password sign-in?" });
      await expect(confirm.getByText(/^Accounts with no usable sign-in service: \d+$/)).toBeVisible();
      await confirm.getByRole("button", { name: "Turn off" }).click();
      await expect(page.getByRole("switch", { name: "Allow password sign-in" })).toHaveAttribute("aria-checked", "false");

      const closeReg = await page.request.patch("/api/admin/auth/settings", { data: { registrationEnabled: false } });
      expect(closeReg.ok()).toBe(true);
      const closeAuto = await page.request.patch(`/api/admin/auth/providers/${secondId}`, { data: { autoCreateEnabled: false } });
      expect(closeAuto.ok()).toBe(true);

      await page.goto("/admin/users");
      await page.getByRole("button", { name: "Create invitation" }).click();
      const inviteDialog = page.getByRole("dialog", { name: "Create an invitation" });
      await expect(inviteDialog.getByText("Password sign-in is off on this site, so invitations can't be created or used.")).toBeVisible();
      await expect(inviteDialog.getByRole("button", { name: "Create link" })).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(inviteDialog).not.toBeVisible();

      const member = await browser.newContext();
      try {
        const p = await member.newPage();
        await p.goto("/login");
        // Wait point for the "does not exist" assertion: the SSO button being visible means `/api/auth/config` has landed (the password form shows as usual before it lands).
        await expect(p.getByRole("link", { name: `Sign in with ${SECOND_NAME}` })).toBeVisible();
        await expect(p.locator("#login-email")).toHaveCount(0);
        const api = await p.request.post("/api/auth/login", { data: { email: ADMIN.email, password: ADMIN.password } });
        expect(api.status()).toBe(403);
        expect((await api.json()).error.code).toBe("password_login_disabled");

        await nextLogin(request, SECOND_CONTROL_URL, { sub: memberSub, email: memberEmail, name: "E2E Closed Member" });
        await p.getByRole("link", { name: `Sign in with ${SECOND_NAME}` }).click();
        await expect(p.getByRole("alert")).toHaveText("New accounts can't be created this way right now. Please contact the site administrator.", { timeout: 20_000 });

        const openAuto = await page.request.patch(`/api/admin/auth/providers/${secondId}`, { data: { autoCreateEnabled: true } });
        expect(openAuto.ok()).toBe(true);
        await nextLogin(request, SECOND_CONTROL_URL, { sub: memberSub, email: memberEmail, name: "E2E Closed Member" });
        await p.goto("/login");
        await p.getByRole("link", { name: `Sign in with ${SECOND_NAME}` }).click();
        await expect(p).toHaveURL(/\/$/, { timeout: 20_000 });
        await expect(p.getByRole("button", { name: "E2E Closed Member", exact: true })).toBeVisible();
        const closeAutoAgain = await page.request.patch(`/api/admin/auth/providers/${secondId}`, { data: { autoCreateEnabled: false } });
        expect(closeAutoAgain.ok()).toBe(true);
      } finally {
        await member.close();
      }

      expect((await page.request.get("/api/auth/me")).status()).toBe(200);
    } finally {
      try {
        // Collect first, assert later: do not assert one by one, so a failure on an earlier call does not skip the later restores (as in 19-6).
        const results = [];
        // Always turn it back on (otherwise on a dirty-stack re-run password logins in 01 / 05 etc. all fail; if it cannot be restored, run stack:down).
        results.push(await page.request.patch("/api/admin/auth/settings", { data: { passwordLoginEnabled: true } }));
        if (original !== null) {
          results.push(await page.request.patch(`/api/admin/auth/providers/${original.secondProvider.id}`, { data: { autoCreateEnabled: original.secondProvider.autoCreateEnabled } }));
          results.push(await page.request.patch("/api/admin/auth/settings", { data: { registrationEnabled: original.registrationEnabled } }));
        } else {
          // Original values were not captured (failed at the start): fall back to fixed values - the second provider creates accounts (the value 19-1 turns on, which 19-4 depends on) and self-registration on (the default).
          for (const row of await listProviders()) {
            if (row.displayName !== SECOND_NAME) continue;
            results.push(await page.request.patch(`/api/admin/auth/providers/${row.id}`, { data: { autoCreateEnabled: true } }));
          }
          results.push(await page.request.patch("/api/admin/auth/settings", { data: { registrationEnabled: true } }));
        }
        expect(results.map((r) => r.ok())).not.toContain(false);
      } finally {
        await context.close();
      }
    }
  });

  test("19-7: disabling (dialog shows the count) -> sign-in page button disappears -> delete", async ({ browser }) => {
    const { context, page } = await adminOnSignInPage(browser);
    try {
      const card = page.getByRole("row", { name: SECOND_NAME, exact: true });
      await card.getByRole("switch", { name: `Enabled ${SECOND_NAME}`, exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Turn this sign-in service off?" });
      // The count is not pinned: identities are keyed by issuer and kept after a provider is deleted, so on a dirty-stack re-run
      // `/b` may already hold identities from earlier runs; if an earlier run failed before deleting, a leftover enabled provider
      // with the same issuer would make lockedOut 0. Assert only "at least the one from this run's 19-1" and the number's shape.
      await expect(dialog.getByText(/^Linked accounts: [1-9]\d*$/)).toBeVisible();
      await expect(dialog.getByText(/^Of those, with no other way to sign in: \d+$/)).toBeVisible();
      await dialog.getByRole("button", { name: "Turn off" }).click();
      await expect(card.getByRole("switch", { name: `Enabled ${SECOND_NAME}`, exact: true })).toHaveAttribute("aria-checked", "false");

      const anon = await browser.newContext();
      try {
        const loginPage = await anon.newPage();
        await loginPage.goto("/login");
        await expect(loginPage.getByRole("link", { name: "Sign in with SSO" })).toBeVisible();
        await expect(loginPage.getByRole("link", { name: `Sign in with ${SECOND_NAME}` })).toHaveCount(0);
      } finally {
        await anon.close();
      }

      await card.getByRole("button", { name: "Delete" }).click();
      const confirm = page.getByRole("dialog", { name: "Delete this sign-in service?" });
      await confirm.getByRole("button", { name: "Delete" }).click();
      await expect(page.getByRole("row", { name: SECOND_NAME, exact: true })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
