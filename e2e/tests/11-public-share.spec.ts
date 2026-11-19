import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN, createNote, editorLocator, loginAs } from "./helpers.js";

/**
 * Closing the owner tab is a scenario step, not behaviour under test: persistence may come from the 2-second debounce flush or
 * from the flush when the last connection closes, and this test does not distinguish them. That the content (including the
 * image URL) persisted is guarded by the polling assertion below (the decoded ydoc contains the upload URL).
 *
 * - The image must go through the FilePanel Upload tab's `setInputFiles` real upload; do not use Embed as a shortcut: Embed
 *   forces an absolute URL, which falls on publicMediaUrl's known limitation "same-origin absolute URLs are not mapped", so
 *   the anonymous image assertion would always fail.
 * - Flush is asynchronous (collab store debounce 2s, flush when the last connection closes): content assertions on the public
 *   endpoints poll with `expect(...).toPass()`.
 * - Admin logs in with `ADMIN.password` (convention in the helpers.ts header).
 */

/** 1x1 red PNG: small, yet a real file, exercising the whole multipart upload and disk path. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const INVALID_LINK_TEXT = "This link doesn't exist or is no longer active.";

/** Opens ShareDialog; the caller must already be on the note page. */
async function openShareDialog(page: Page) {
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Share note" });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Reads the public link from ShareDialog (when the radio is already in the "public" state).
 *
 * After the UI revamp the anonymous-state input holds **only the token**; the `/p/` prefix is a separate text next to it (both
 * modes share the "prefix + input" shape, see `PublicLinkPanel` in `ShareDialog.tsx`). So this reads a bare token and the URL
 * has to be rebuilt; before the revamp the whole URL was read, and that assumption no longer holds. */
async function readPublicUrl(dialog: ReturnType<Page["getByRole"]>, page: Page): Promise<string> {
  const input = dialog.getByLabel("Public link URL");
  await expect(input).toBeVisible();
  const token = await input.inputValue();
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return `${new URL(page.url()).origin}/p/${token}`;
}

function tokenOf(publicUrl: string): string {
  const token = publicUrl.slice(publicUrl.lastIndexOf("/p/") + 3);
  // The shape is checked in the helper itself: this file has two-part alias URLs, and feeding one here would slice out
  // "<handle>/<slug>"; do not let that flow silently into later requests.
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return token;
}

/** Reads the public alias path from ShareDialog (anonymous OFF state, radio already in the "public" state).
 *
 * In the OFF state the input holds the slug (editable) and the prefix `/p/<handle>/` is a separate text next to it; this is
 * a different mode from `readPublicUrl` (ON state, input holds a bare token), so it is a separate helper rather than squeezed
 * into `readPublicUrl`.
 * Returns the **path** (no origin): callers only feed it to `page.goto` and slice the `<handle>/<slug>` API ref out of it,
 * and, unlike `readPublicUrl`'s callers, do not need a full URL. */
async function readAliasPath(dialog: ReturnType<Page["getByRole"]>): Promise<string> {
  const prefix = await dialog.locator("#share-public-slug-prefix").innerText();
  expect(prefix).toMatch(/^\/p\/[a-z0-9-]+\/$/);
  const slug = await dialog.getByLabel("Custom public link", { exact: true }).inputValue();
  return `${prefix}${slug}`;
}

/** The single place that builds public content endpoint paths (#122: this file had two hard-coded strings, now centralized;
 * `ref` can be a token or the two-part `<handle>/<slug>`; the alias section's image src goes through here too).
 * e2e deliberately does not share the web package's builder (`lib/public-note-ref.ts`; the e2e package has no workspace
 * dependency and rsync does not carry dist, same reason), so it builds its own. */
function publicNoteApi(ref: string): string {
  return `/api/public/notes/${ref}`;
}

/** The public endpoint's throttle bucket key includes the ip; a single worker running serially does not hit 429, so there is no backoff here. */
async function fetchPublicNote(request: APIRequestContext, token: string) {
  return request.get(publicNoteApi(token));
}

test("owner turns on public -> logged-out visitor sees content and image -> regenerating kills the old link -> after revoke the dead-link card", async ({ browser, request }) => {
  // The nominal sum of per-step waits is far above any reasonable limit (each 15s wait actually passes in milliseconds); 150s
  // is a practical budget so that a stuck step surfaces as that step's honest assertion message, not the arithmetic worst
  // case (after #122's alias part added four waits the nominal sum is meaningless).
  test.setTimeout(150_000);
  const ownerContext = await browser.newContext();
  const anonContext = await browser.newContext();
  try {
    const ownerPage = await ownerContext.newPage();
    await loginAs(ownerPage, ADMIN.email, ADMIN.password);
    await expect(ownerPage).toHaveURL(/\/$/);

    const title = `E2E public share ${Date.now()}`;
    await createNote(ownerPage, title);
    const noteUrl = ownerPage.url();

    const editor = editorLocator(ownerPage);
    await editor.click();
    await editor.pressSequentially("Anon-visible content line.");
    await ownerPage.keyboard.press("Enter");
    await editor.pressSequentially("/image");
    // As in 06-mermaid: click by the slash item's subtext (the title text is too generic).
    await ownerPage.getByText("Resizable image with caption").click();
    await ownerPage.getByText("Add image", { exact: true }).click();
    await expect(ownerPage.getByRole("tab", { name: "Upload" })).toBeVisible();
    await ownerPage
      .getByLabel("Choose an image file to upload")
      .setInputFiles({ name: "e2e-public.png", mimeType: "image/png", buffer: PNG_1X1 });
    const ownerImg = ownerPage.locator('img[src*="/api/uploads/"]');
    await expect(ownerImg).toBeVisible({ timeout: 15_000 });

    let dialog = await openShareDialog(ownerPage);
    const publicRadio = dialog.getByRole("radio", { name: /^Public link/ });
    await expect(publicRadio).toBeEnabled(); // clickable only once the latch is done (both queries have arrived)
    await publicRadio.check();
    const publicUrl = await readPublicUrl(dialog, ownerPage);
    const token = tokenOf(publicUrl);
    await ownerPage.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();

    await ownerPage.close();
    await expect(async () => {
      const res = await fetchPublicNote(request, token);
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { title: string; ydoc: string };
      expect(body.title).toBe(title);
      // Discriminating guard: Yjs encodes XML attribute strings **verbatim** into the update, so "the decoded content contains
      // the upload URL" means the image URL really persisted. Asserting length alone could let the polling pass early when the
      // upload round trip exceeds 2 seconds and the intermediate debounce flush (image block without a url yet) is enough, so
      // the anonymous page gets a stale snapshot and the image assertion goes red by mistake.
      expect(Buffer.from(body.ydoc, "base64").toString("utf8")).toContain("/api/uploads/");
    }).toPass({ timeout: 20_000 });

    const anonPage = await anonContext.newPage();
    await anonPage.goto(publicUrl);
    await expect(anonPage.getByRole("heading", { name: title })).toBeVisible({ timeout: 15_000 });
    await expect(anonPage.getByText("Read-only")).toBeVisible();
    await expect(anonPage.getByText("Anon-visible content line.")).toBeVisible();
    // Image: resolveFileUrl maps /api/uploads/:id to /api/public/notes/:token/uploads/:id
    const anonImg = anonPage.locator(`img[src*="${publicNoteApi(token)}/uploads/"]`);
    await expect(anonImg).toBeVisible({ timeout: 15_000 });
    // naturalWidth > 0 means the browser really fetched and decoded the blob (0 on a 404 / broken image).
    await expect
      .poll(async () => anonImg.evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    expect(new URL(anonPage.url()).pathname).toBe(`/p/${token}`);

    const ownerPage2 = await ownerContext.newPage();
    await ownerPage2.goto(noteUrl);
    await expect(ownerPage2.getByLabel("Note title")).toHaveValue(title, { timeout: 15_000 });
    dialog = await openShareDialog(ownerPage2);
    await expect(dialog.getByRole("radio", { name: /^Public link/ })).toBeChecked();

    // Anonymous toggle (Radix Switch, role="switch", accessible name "Anonymous link"). A newly opened public link defaults to
    // anonymous ON (`public_slug` is null); turning it off makes the frontend generate a 16-hex random slug and submit it
    // (`PublicLinkPanel.applyRandomSlug`), and the input switches from the read-only "Public link URL" to the editable
    // "Custom public link".
    const anonymousToggle = dialog.getByRole("switch", { name: "Anonymous link" });
    await expect(anonymousToggle).toBeChecked();
    await anonymousToggle.click();
    const aliasInput = dialog.getByLabel("Custom public link", { exact: true });
    await expect(aliasInput).toBeVisible({ timeout: 10_000 });
    // Wait for the random slug to land (mutateAsync done, input from empty to the candidate value); do not overwrite it with
    // the custom name while the input is still empty, which would overwrite an unsent intermediate state.
    await expect.poll(async () => aliasInput.inputValue()).not.toBe("");

    const alias = `e2e-alias-${Date.now()}`;
    await aliasInput.fill(alias);
    const saveButton = dialog.getByRole("button", { name: "Save custom URL" });
    await expect(saveButton).toBeEnabled();
    await saveButton.click();
    // Save success = `dirty` back to false (`useSetPublicSlug` onSuccess writes the cache directly and the `slug` prop catches
    // up with the saved value); the button returning to disabled is the completion signal, no separate API polling needed.
    await expect(saveButton).toBeDisabled({ timeout: 10_000 });

    // The alias URL is **read from the UI** (do not import shared's publicAliasPath, do not hand-build the handle):
    // `readAliasPath` reads the prefix span + the input's current value.
    const aliasPath = await readAliasPath(dialog);
    const aliasRef = aliasPath.slice("/p/".length);

    await anonPage.goto(aliasPath);
    await expect(anonPage.getByRole("heading", { name: title })).toBeVisible({ timeout: 15_000 });
    await expect(anonPage.getByText("Anon-visible content line.")).toBeVisible();
    const anonAliasImg = anonPage.locator(`img[src*="${publicNoteApi(aliasRef)}/uploads/"]`);
    await expect(anonAliasImg).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => anonAliasImg.evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    expect(new URL(anonPage.url()).pathname).toBe(aliasPath);

    // Remove the alias (turn the anonymous toggle back on; the old "Remove custom URL" button is gone) -> alias 404, token
    // link **still alive** (clearing the slug leaves the token alone: the two coexist).
    // The token side gets a page-level assertion (not just the API): if the two-part route swallowed the one-part form, an API
    // probe would not see it.
    await anonymousToggle.click();
    await expect(dialog.getByLabel("Public link URL")).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByLabel("Public link URL")).toHaveValue(token, { timeout: 10_000 });
    await anonPage.goto(aliasPath);
    await expect(anonPage.getByText(INVALID_LINK_TEXT)).toBeVisible({ timeout: 15_000 });
    await anonPage.goto(publicUrl);
    await expect(anonPage.getByRole("heading", { name: title })).toBeVisible({ timeout: 15_000 });
    expect((await fetchPublicNote(request, token)).status()).toBe(200);

    // owner: regenerate (anonymous is ON here, so this changes the token, not the slug) -> old link 404, new link alive
    await dialog.getByRole("button", { name: "Regenerate link" }).click();
    await expect(dialog.getByLabel("Public link URL")).not.toHaveValue(token);
    const newPublicUrl = await readPublicUrl(dialog, ownerPage2);
    const newToken = tokenOf(newPublicUrl);
    expect(newToken).not.toBe(token);

    const oldRes = await fetchPublicNote(request, token);
    expect(oldRes.status()).toBe(404);
    const newRes = await fetchPublicNote(request, newToken);
    expect(newRes.status()).toBe(200);

    await anonPage.goto(publicUrl);
    await expect(anonPage.getByText(INVALID_LINK_TEXT)).toBeVisible({ timeout: 15_000 });

    await dialog.getByRole("radio", { name: /^Members only/ }).check();
    await expect(dialog.getByLabel("Public link URL")).not.toBeVisible();
    await ownerPage2.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();

    await expect(async () => {
      const res = await fetchPublicNote(request, newToken);
      expect(res.status()).toBe(404);
    }).toPass({ timeout: 10_000 });

    await anonPage.goto(newPublicUrl);
    await expect(anonPage.getByText(INVALID_LINK_TEXT)).toBeVisible({ timeout: 15_000 });
  } finally {
    await ownerContext.close();
    await anonContext.close();
  }
});
