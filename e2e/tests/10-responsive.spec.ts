import { test, expect, type Page } from "@playwright/test";
import { ADMIN, chooseSelectOption, adminNav, createNote, editorLocator, loginAs, openListOnCompact, openSelectionAiBox, openSiteAdmin } from "./helpers.js";

/**
 * Creating the provider and typing the note content happen at the default 1280 viewport (the site admin modal's form is
 * cramped at 390), then `setViewportSize(390x844)`. The AI provider is created here (as in 04-ai's setup) with "Default model"
 * ticked: auto resolution must pick the model that points at `/fast` (in a full run the provider 04 leaves behind has been
 * switched to `/slow`, same as in 25).
 * Layouts: below 640 the list is its own screen ("Back to notes", no sidebar button); 640-1279 is a drawer (the sidebar button
 * opens it, Esc closes it).
 * Geometry: the selection AI box width <= viewport width - 16 (block width + border, capped at calc(100vw - 16px)) and it
 * stays inside the viewport on both sides, in the result state too.
 */

const RUN_ID = Date.now();
const PROVIDER_NAME = `E2E RWD Provider ${RUN_ID}`;
const MODEL_DISPLAY_NAME = `E2E RWD Model ${RUN_ID}`;

async function openAiSettings(page: Page): Promise<void> {
  await openSiteAdmin(page);
  await adminNav(page, "AI agents");
}

function providerDetailsLocator(page: Page, name: string) {
  return page.getByRole("row", { name: `${name} details`, exact: true });
}

test("narrow viewport: static sidebar hidden, drawer navigation, selection AI box stays inside the viewport", async ({ browser }) => {
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

    const providerDetails = providerDetailsLocator(page, PROVIDER_NAME);
    await expect(providerDetails).toBeVisible();
    await providerDetails.getByRole("button", { name: "Add model", exact: true }).click();
    const createModelDialog = page.getByRole("dialog", { name: "Add model" });
    await createModelDialog.getByLabel("Model ID", { exact: true }).fill("e2e-rwd-model");
    await createModelDialog.getByLabel("Display name", { exact: true }).fill(MODEL_DISPLAY_NAME);
    await createModelDialog.getByLabel("Default model", { exact: true }).check();
    await createModelDialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(createModelDialog).not.toBeVisible();
    // The site admin modal covers the home page and createNote needs it closed first: pin that we really returned to /.
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/$/);

    const title = `E2E rwd ${RUN_ID}`;
    await createNote(page, title);
    const original = "Narrow viewport paragraph for the AI box.";
    const editor = editorLocator(page);
    await editor.click();
    await editor.pressSequentially(original);

    await page.setViewportSize({ width: 390, height: 844 });

    await expect(page.getByRole("button", { name: "Open sidebar" })).toHaveCount(0);
    const list = await openListOnCompact(page);
    await expect(page).toHaveURL(/\/$/);
    await expect(list.getByRole("button", { name: "New note", exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Note title" })).toHaveCount(0);
    // `.first()` is a safeguard; after the revamp the sidebar renders just the current tab.
    await list.getByRole("link", { name: title }).first().click();
    await page.waitForURL(/\/n\//, { timeout: 15_000 });
    await expect(list).toBeHidden();
    await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible({ timeout: 15_000 });

    await page.setViewportSize({ width: 768, height: 844 });
    const drawer = page.getByRole("dialog", { name: "Navigation" });
    const hamburger = page.getByRole("button", { name: "Open sidebar" });
    await expect(page.getByRole("button", { name: "New note", exact: true })).toBeHidden();
    await hamburger.click();
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("button", { name: "New note", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).not.toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });

    const box = await openSelectionAiBox(page, original);
    const boxRect = (await box.boundingBox())!;
    expect(boxRect.width).toBeLessThanOrEqual(390 - 16);
    // Width = anchor block `.bn-block-outer` width + 2px border on each side (at viewport width 390 the block is 324, the box
    // 326, x=33). The <= 374 check above is too loose to notice broken width logic; this exact comparison does.
    const anchorWidth = (await editor.locator(".bn-block-outer").filter({ hasText: original }).boundingBox())!.width;
    expect(Math.abs(boxRect.width - (anchorWidth + 2))).toBeLessThanOrEqual(1);
    expect(boxRect.x).toBeGreaterThanOrEqual(0);
    expect(boxRect.x + boxRect.width).toBeLessThanOrEqual(390);

    const input = box.getByRole("textbox", { name: "Instruction for the selected text" });
    await input.fill("Shorten it");
    await input.press("Enter");
    await expect(box.getByTestId("selection-ai-preview")).toContainText("E2E rewritten text", { timeout: 15_000 });
    const doneRect = (await box.boundingBox())!;
    expect(doneRect.x).toBeGreaterThanOrEqual(-1);
    expect(doneRect.x + doneRect.width).toBeLessThanOrEqual(390 + 1);
    await box.press("Escape");
    await expect(box).toBeHidden();
  } finally {
    await context.close();
  }
});
