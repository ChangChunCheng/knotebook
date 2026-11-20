import { test, expect, type Page } from "@playwright/test";
import { ADMIN, chooseSelectOption, adminNav, createNote, editorLocator, loginAs, openSelectionAiBox, openSiteAdmin, waitForEditorSelection } from "./helpers.js";

/**
 * The ai-stub base URL is given from the app container's point of view (`http://ai-stub:9500/...`); ai-stub ignores the
 * request content and always returns FINAL_CONTENT. `auto` model resolution takes the first entry in the ordering of
 * `apps/server/src/ai/resolve.ts`, so this file creates a single enabled chat model.
 * The three tests are `serial` and share one provider: the first creates it, the second reuses `/fast`, the third switches
 * it to `/slow`.
 * The built-in Rewrite defaults to preview (#263); tests two and three need direct auto-apply, so each sets it to direct
 * through the admin API (`setRewriteApplyMode`) and `afterAll` restores the recorded original value (not a hard-coded preview).
 */

// Module-level `RUN_ID`: the three serial tests share one provider/model, and a hard-coded name would collide when a failed run leaves the stack up and is re-run by hand.
const RUN_ID = Date.now();
const PROVIDER_NAME = `E2E AI Provider ${RUN_ID}`;
const MODEL_DISPLAY_NAME = `E2E AI Model ${RUN_ID}`;
const REWRITTEN_TEXT = "E2E rewritten text"; // must equal FINAL_CONTENT in e2e/stubs/ai-stub.mjs
const REASONING_MARKER = "internal reasoning"; // text ai-stub always puts in reasoning_content; the server must not forward it
const STALE_TEXT = "The original text has changed since this was opened.";
const GUARD_TOAST = "The original text changed since this result was generated, so it wasn't applied.";

async function openAiSettings(page: Page): Promise<void> {
  await openSiteAdmin(page);
  await adminNav(page, "AI agents");
}

async function leaveAdmin(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/$/);
}

/**
 * Providers table: a provider is a row named after it; key help, test results and the models sub-table sit in the details row
 * right after it ("<name> details"). Row names are always exact (Playwright's `name` defaults to substring, so "X" would match
 * "X details").
 */
function providerRowLocator(page: Page, name: string) {
  return page.getByRole("table", { name: "Providers", exact: true }).getByRole("row", { name, exact: true });
}
function providerDetailsLocator(page: Page, name: string) {
  return page.getByRole("row", { name: `${name} details`, exact: true });
}
function modelsTableLocator(page: Page, providerName: string) {
  return page.getByRole("table", { name: `Models – ${providerName}`, exact: true });
}

/**
 * The note page's scroll container = the nearest scrolling ancestor of the main editor (the note card's `overflow-y-auto`; the
 * page itself does not scroll, `window.scrollY` stays 0). If `to` is given, scroll there first (`"nearBottom"` = 40px from
 * the bottom, leaving slack for small changes in content height). Returns the resulting scrollTop, `window.scrollY`, and the
 * viewport coordinates of the box bottom and the container top (box bottom above container top = box scrolled out of view).
 */
async function noteScroll(page: Page, to?: "nearBottom") {
  return editorLocator(page).evaluate((el, target) => {
    let node: HTMLElement | null = el.parentElement;
    while (node && !(/(auto|scroll)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight)) node = node.parentElement;
    if (!node) throw new Error("找不到筆記的捲動容器");
    if (target === "nearBottom") node.scrollTop = node.scrollHeight - node.clientHeight - 40;
    const boxEl = document.querySelector('[data-testid="selection-ai-box"]');
    return {
      scrollTop: node.scrollTop,
      windowScrollY: window.scrollY,
      boxBottom: boxEl ? boxEl.getBoundingClientRect().bottom : null,
      scrollerTop: node.getBoundingClientRect().top,
    };
  }, to);
}

type ApplyMode = "direct" | "preview";
let originalRewriteMode: ApplyMode | undefined;

/**
 * Admin API call (`page.request` shares the page's session cookie); finds the id by name since e2e does not depend on the
 * shared package. The first call records the pre-change value in `originalRewriteMode`.
 */
async function setRewriteApplyMode(page: Page, applyMode: ApplyMode): Promise<void> {
  const listed = await page.request.get("/api/admin/ai/actions");
  expect(listed.status()).toBe(200);
  const { actions } = (await listed.json()) as { actions: { id: string; name: string; builtin: boolean; applyMode: ApplyMode }[] };
  const rewrite = actions.find((action) => action.builtin && action.name === "Rewrite");
  expect(rewrite, "內建 Rewrite 動作").toBeDefined();
  originalRewriteMode ??= rewrite!.applyMode;
  const res = await page.request.patch(`/api/admin/ai/actions/${rewrite!.id}`, { data: { applyMode } });
  expect(res.status()).toBe(200);
}

test.describe.configure({ mode: "serial" });

test.afterAll(async ({ browser }) => {
  if (originalRewriteMode === undefined) return;
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await setRewriteApplyMode(page, originalRewriteMode);
  } finally {
    await context.close();
  }
});

test("create provider/model -> select -> instruct -> stream does not leak reasoning -> diff preview -> apply (box closes) -> Ctrl+Z restores", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await expect(page).toHaveURL(/\/$/);

    await openAiSettings(page);
    await page.getByRole("button", { name: "Add provider", exact: true }).click();
    const createProviderDialog = page.getByRole("dialog", { name: "Add provider" });
    await createProviderDialog.locator("#ai-provider-name").fill(PROVIDER_NAME);
    await chooseSelectOption(page, createProviderDialog.locator("#ai-provider-type"), "OpenAI-compatible");
    await createProviderDialog.locator("#ai-provider-base-url").fill("http://ai-stub:9500/fast");
    await createProviderDialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(createProviderDialog).not.toBeVisible();
    await expect(providerRowLocator(page, PROVIDER_NAME)).toBeVisible();

    await providerDetailsLocator(page, PROVIDER_NAME).getByRole("button", { name: "Add model", exact: true }).click();
    const createModelDialog = page.getByRole("dialog", { name: "Add model" });
    await createModelDialog.getByLabel("Model ID", { exact: true }).fill("e2e-model");
    await createModelDialog.getByLabel("Display name", { exact: true }).fill(MODEL_DISPLAY_NAME);
    await createModelDialog.getByLabel("Default model", { exact: true }).check();
    await createModelDialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(createModelDialog).not.toBeVisible();
    await expect(modelsTableLocator(page, PROVIDER_NAME).getByRole("row", { name: MODEL_DISPLAY_NAME, exact: true })).toBeVisible();

    await leaveAdmin(page);
    await createNote(page, `E2E ai ${Date.now()}`);
    await expect(page).toHaveURL(/\/n\//);
    const original = "Selecting this phrase should trigger a rewrite action.";
    const editor = editorLocator(page);
    await editor.waitFor({ timeout: 15_000 });
    await editor.click();
    await editor.pressSequentially(original);

    const box = await openSelectionAiBox(page, original);
    const input = box.getByRole("textbox", { name: "Instruction for the selected text" });
    await expect(input).toBeFocused();
    await input.fill("Make it shorter");
    await input.press("Enter");

    // /fast finishes almost synchronously, so the intermediate "Generating..." is not pinned; the reasoning-leak check is made here.
    const preview = box.getByTestId("selection-ai-preview");
    await expect(preview).toContainText(REWRITTEN_TEXT, { timeout: 15_000 });
    await expect(box).not.toContainText(REASONING_MARKER);
    const apply = box.getByRole("button", { name: "Apply", exact: true });
    await expect(apply).toBeEnabled();
    await apply.click();

    await expect(box).toBeHidden();
    await expect(editor).toContainText(REWRITTEN_TEXT);
    await expect(editor).not.toContainText(original);
    // Ctrl+Z restores after a manual apply (undo, #97)
    await page.keyboard.press("Control+z");
    await expect(editor).toContainText(original);
    await expect(editor).not.toContainText(REWRITTEN_TEXT);
  } finally {
    await context.close();
  }
});

test("chip (direct Rewrite): auto-applies after the stream and the box stays with Revert; after Revert it shows Apply/Discard/Retry", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await expect(page).toHaveURL(/\/$/);
    await setRewriteApplyMode(page, "direct");
    await createNote(page, `E2E ai chip ${Date.now()}`);
    const original = "Chip rewrite paragraph that gets replaced automatically.";
    const editor = editorLocator(page);
    await editor.waitFor({ timeout: 15_000 });
    await editor.click();
    await editor.pressSequentially(original);

    const box = await openSelectionAiBox(page, original);
    await box.getByRole("button", { name: "Rewrite", exact: true }).click();
    const revert = box.getByRole("button", { name: "Revert", exact: true });
    await expect(revert).toBeVisible({ timeout: 15_000 });
    await expect(editor).toContainText(REWRITTEN_TEXT);
    await expect(editor).not.toContainText(original);
    const inserted = editor.locator(".bn-block-outer").filter({ hasText: REWRITTEN_TEXT });
    await expect(inserted).toHaveCount(1);
    await expect
      .poll(async () => {
        const [b, r] = [(await box.boundingBox())!, (await inserted.boundingBox())!];
        return Math.max(Math.abs(b.y - r.y), Math.abs(b.x - r.x));
      })
      .toBeLessThanOrEqual(1);

    await revert.click();
    await expect(editor).toContainText(original);
    await expect(editor).not.toContainText(REWRITTEN_TEXT);
    await expect(box).toBeVisible();
    await expect(revert).toHaveCount(0);
    for (const name of ["Apply", "Discard", "Retry"]) await expect(box.getByRole("button", { name, exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("guard: provider switched to /slow -> second context edits the anchor mid-stream -> box shows original changed with no Apply button; toast when direct auto-apply fails", async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const otherContext = await browser.newContext();
  try {
    const ownerPage = await ownerContext.newPage();
    await loginAs(ownerPage, ADMIN.email, ADMIN.password);
    await expect(ownerPage).toHaveURL(/\/$/);
    await setRewriteApplyMode(ownerPage, "direct"); // direct is needed to see the toast when auto-apply hits the guard

    await openAiSettings(ownerPage);
    // A data row holds only the provider's own Edit (models' Edit is in the sub-table of the details row), so no .first() is needed.
    const providerRow = providerRowLocator(ownerPage, PROVIDER_NAME);
    await expect(providerRow).toBeVisible();
    await providerRow.getByRole("button", { name: "Edit", exact: true }).click();
    const editProviderDialog = ownerPage.getByRole("dialog", { name: "Edit provider" });
    await editProviderDialog.getByLabel("Base URL", { exact: true }).fill("http://ai-stub:9500/slow");
    await editProviderDialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editProviderDialog).not.toBeVisible();
    await expect(providerRow).toContainText("http://ai-stub:9500/slow");
    await leaveAdmin(ownerPage);

    await createNote(ownerPage, `E2E ai guard ${Date.now()}`);
    const noteUrl = ownerPage.url();
    const original = "Guarded paragraph awaiting a concurrent edit mid stream.";
    const ownerEditor = editorLocator(ownerPage);
    await ownerEditor.click();
    await ownerEditor.pressSequentially(original);
    // Pad with 50 empty paragraphs so the note card can scroll (used below to check that moving focus into the box on completion does not scroll the page).
    for (let i = 0; i < 50; i += 1) await ownerPage.keyboard.press("Enter");

    const otherPage = await otherContext.newPage();
    await loginAs(otherPage, ADMIN.email, ADMIN.password);
    await otherPage.goto(noteUrl);
    const otherEditor = editorLocator(otherPage);
    await expect(otherEditor).toContainText(original, { timeout: 15_000 });

    // /slow gives a ~11s stream window
    const box = await openSelectionAiBox(ownerPage, original);
    await box.getByRole("button", { name: "Rewrite", exact: true }).click();
    await expect(box.getByText("Generating…", { exact: true })).toBeVisible();

    // Click the paragraph text itself, not blank container space, which would land on the trailing block
    const editedMarker = "EDITED BY SECOND CONTEXT";
    await otherEditor.getByText(original, { exact: true }).click();
    await waitForEditorSelection(otherPage); // otherwise typing lands at the old position (see the `waitForEditorSelection` comment in helpers.ts)
    await otherPage.keyboard.press("End");
    await otherPage.keyboard.type(` ${editedMarker}`);
    await expect(ownerEditor).toContainText(editedMarker, { timeout: 10_000 });

    await expect(box.getByText(STALE_TEXT, { exact: true })).toBeVisible();

    // On completion focus moves into the box container with preventScroll, so the scroll position must not change
    const scrolled = await noteScroll(ownerPage, "nearBottom");
    await expect(box.getByText("Generating…", { exact: true })).toBeVisible(); // precondition: the scroll happened before the stream finished
    expect(scrolled.boxBottom).not.toBeNull();
    expect(scrolled.boxBottom!).toBeLessThan(scrolled.scrollerTop);
    await expect(ownerPage.getByText(GUARD_TOAST, { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(box).toBeFocused(); // focus really moved into the box container (otherwise "no scroll" proves nothing)
    expect(await noteScroll(ownerPage)).toMatchObject({ scrollTop: scrolled.scrollTop, windowScrollY: scrolled.windowScrollY });
    await expect(box.getByRole("button", { name: "Apply", exact: true })).toHaveCount(0);
    await expect(box.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0); // the anchor changed, so Retry is removed too
    await expect(box.getByRole("button", { name: "Discard", exact: true })).toBeVisible();
    await expect(ownerEditor).toContainText(editedMarker);
    await expect(ownerEditor).not.toContainText(REWRITTEN_TEXT);
  } finally {
    await ownerContext.close();
    await otherContext.close();
  }
});
