import { test, expect } from "@playwright/test";
import { ADMIN, createNote, loginAs, openSiteAdmin, randomEmail } from "./helpers.js";

/**
 * The invitation goes through the site admin modal (`/admin/users`) from `UserMenu`'s "Site admin" item (the real entry
 * point, no `page.goto` deep link); Esc closes it back to `/`. The 10-second timeout is the revocation SLA.
 */
test("admin invites a second user -> shares a note -> revokes -> access is lost within the SLA", async ({ browser }) => {
  const adminContext = await browser.newContext();
  const userContext = await browser.newContext();
  try {
    const adminPage = await adminContext.newPage();
    await loginAs(adminPage, ADMIN.email, ADMIN.password);
    await expect(adminPage).toHaveURL(/\/$/);

    await openSiteAdmin(adminPage);

    const secondEmail = randomEmail();
    const secondPassword = "e2e-second-user-pw";

    await adminPage.getByRole("button", { name: "Create invitation" }).click();
    const createDialog = adminPage.getByRole("dialog", { name: "Create an invitation" });
    await createDialog.getByRole("button", { name: "Create link" }).click();

    // Result dialog: the read-only field (accessible name `Link`) holds the invitation link; the token appears only here.
    const resultDialog = adminPage.getByRole("dialog", { name: "Invitation link" });
    const inviteUrl = await resultDialog.getByRole("textbox", { name: "Link", exact: true }).inputValue();
    expect(inviteUrl.startsWith(`${new URL(adminPage.url()).origin}/register#invite=`)).toBe(true);
    expect(new URL(inviteUrl).hash).toMatch(/^#invite=knbi_[A-Za-z0-9_-]{43}$/);
    await resultDialog.getByRole("button", { name: "Done", exact: true }).click();
    await expect(resultDialog).not.toBeVisible();

    await adminPage.keyboard.press("Escape");
    await expect(adminPage).toHaveURL(/\/$/);

    const userPage = await userContext.newPage();
    await userPage.goto(inviteUrl);
    // The fragment is cleared from the address bar once read, so the URL has no `#`.
    await expect(userPage).toHaveURL(/\/register$/);
    await expect(userPage.getByText(/^This invitation works once/)).toBeVisible();
    await userPage.getByLabel("Email", { exact: true }).fill(secondEmail);
    await userPage.getByLabel("Display name (optional)").fill("E2E Second User");
    await userPage.getByLabel("Password", { exact: true }).fill(secondPassword);
    await userPage.getByLabel("Confirm password").fill(secondPassword);
    await userPage.getByRole("button", { name: "Create account", exact: true }).click();
    await expect(userPage).toHaveURL(/\/$/);

    // The invitee has an account now, which the email lookup needs when adding a member
    const title = `E2E share ${Date.now()}`;
    await createNote(adminPage, title);
    const noteUrl = adminPage.url();

    await adminPage.getByRole("button", { name: "Share", exact: true }).click();
    const shareDialog = adminPage.getByRole("dialog", { name: "Share note" });
    // The add-member form sits under the "Members only" panel and mounts only once that level is selected,
    // so switch to it before the Email address field exists.
    await shareDialog.getByRole("radio", { name: /Members only/ }).click();
    await shareDialog.getByLabel("Email address").fill(secondEmail);
    await shareDialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(shareDialog.getByText(secondEmail)).toBeVisible();

    // The share form's default role is viewer (dropdown untouched): `TitleInput` renders an `<h1>` for `readOnly`
    // (not the editable labeled `Note title` input; see the `if (readOnly)` branch in `TitleInput.tsx`), so "visible" is
    // asserted on that heading.
    await userPage.goto(noteUrl);
    await expect(userPage.getByRole("heading", { name: title, level: 1 })).toBeVisible({ timeout: 15_000 });

    // Barrier: wait until the Hocuspocus collab connection is really up before the SLA clock starts.
    // REST success (the `<h1>` above) only means `GET /api/notes/:ref` returned; the provider's WS handshake is a separate
    // async flow (`useCollab`) that starts after it. Revoking before that would also converge (a rejection before the
    // handshake arrives as `authenticationFailed`, which `useCollab` maps to the same two-strike handling; issue #6), but the
    // barrier makes this spec pin the main path, receiving the application-level CLOSE(REVOKED) while connected, instead of
    // landing randomly on either path.
    // `ConnectionBadge` (`role="status"`) is the real signal: wait for it to read "Read-only" (#335: a connected viewer's
    // badge says only that, which also pins the default role as viewer).
    // The regex is anchored at the start (same as the barrier in `createNote` in helpers.ts): a string matches as a
    // case-insensitive substring, so a future text such as "Disconnected" would match by mistake.
    const connectionBadge = userPage.getByRole("status").filter({ hasText: /^Read-only/ });
    await expect(connectionBadge).toBeVisible({ timeout: 15_000 });

    await shareDialog.getByRole("button", { name: `Remove ${secondEmail}` }).click();
    // #395: removal needs a confirmation first
    await shareDialog.getByRole("alert").getByRole("button", { name: "Remove", exact: true }).click();
    // Wait for that row's remove button to disappear (the confirmation row's text also contains the email, so getByText would double-match in strict mode)
    await expect(shareDialog.getByRole("button", { name: `Remove ${secondEmail}` })).toHaveCount(0);
    await expect(shareDialog.getByText(secondEmail, { exact: true })).not.toBeVisible();

    // Radix Toast also renders a `role="status"` live region announcing "Notification ..." that shares a substring with the
    // real toast text; `exact: true` matches only the actual ToastTitle node.
    await expect(userPage.getByText("You no longer have access to this note.", { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(userPage).toHaveURL(/\/$/, { timeout: 10_000 });
  } finally {
    await adminContext.close();
    await userContext.close();
  }
});
