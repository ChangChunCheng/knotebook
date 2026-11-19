import { test, expect } from "@playwright/test";
import { ADMIN, createNote, editorLocator, loginAs } from "./helpers.js";

/**
 * Forced password change has no e2e coverage (admin-created accounts were removed); see `auth/guards.test.tsx`,
 * `pages/ChangePasswordPage.test.tsx` and server tests.
 * `ADMIN.password` is the stack's only admin password; later specs log in with it.
 */
test("env admin first login skips forced password change -> creates a note -> content survives reload", async ({ page }) => {
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);

  // `toHaveURL(/\/$/)` alone is not enough: a flagged account also lands on `/` first and ChangePasswordGate then
  // `<Navigate replace>`s away at render, so the assertion can pass before the redirect. Wait for AppShell's "New note"
  // button (flagged accounts never reach AppShell), then check the URL is not `/change-password`; `createNote` clicks that
  // button next.
  await expect(page.getByRole("button", { name: "New note", exact: true })).toBeVisible();
  await expect(page).not.toHaveURL(/\/change-password/);

  const title = `E2E note ${Date.now()}`;
  await createNote(page, title);

  const editor = editorLocator(page);
  const bodyText = "Hello from Playwright";
  await editor.click();
  await editor.pressSequentially(bodyText);

  // Note body syncs over a Y.Doc; the server's `onStoreDocument` persists to Postgres only after a 2000ms debounce
  // (`STORE_DEBOUNCE_MS` in apps/server/src/collab/server.ts), so a reload has to wait for that window or it reads stale
  // content. A fixed `waitForTimeout(2_500)` would bet on the debounce firing on time and the write being fast enough, which
  // loses on slower CI runners; `expect(...).toPass()` retries "reload + assert" until the content is really persisted.
  //
  // No "client has no unsynced updates" barrier is needed before the reload (issue #33, suggestion b): `createNote`
  // guarantees typing starts after the connection is OPEN and the first sync is done (see helpers.ts), and
  // `@hocuspocus/provider` defaults to `flushDelay: false`, so y-prosemirror emits each Y update synchronously into the open
  // socket and every keystroke has been handed to the socket when `pressSequentially` returns. What remains is the
  // server-side persist delay that the toPass above waits for (and @hocuspocus/server runs onStoreDocument via executeNow
  // when the last connection closes, so a reload dropping the only client does not lose a pending debounced update).
  await expect(async () => {
    await page.reload();
    await expect(page.getByLabel("Note title")).toHaveValue(title);
    await expect(page.locator('[data-testid="note-editor"]')).toContainText(bodyText, { timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
});

/**
 * #99: `)` is the single-character trigger of that input rule, so `pressSequentially` typing one character at a time
 * exercises it.
 */
test("typing markdown link syntax [text](url) converts it to a real link", async ({ page }) => {
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);

  const title = `E2E markdown link ${Date.now()}`;
  await createNote(page, title);

  const editor = editorLocator(page);
  await editor.click();
  await editor.pressSequentially("[Anthropic](https://anthropic.com)");

  await expect(page.locator('[data-testid="note-editor"] a[href="https://anthropic.com"]')).toBeVisible();
});
