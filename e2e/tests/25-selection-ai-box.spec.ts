import { test, expect, type Locator, type Page } from "@playwright/test";
import { E2E_ORIGIN } from "../ports.js";
import { ADMIN, chooseSelectOption, adminNav, createNote, editorLocator, loginAs, openSelectionAiBox, openSiteAdmin, waitForEditorSelection } from "./helpers.js";

/**
 * The provider is created here (steps as in 10-responsive); ticking "Default model" is load-bearing: in a full run the
 * provider 04 leaves behind has been switched to `/slow`, and without the tick auto resolution would pick it.
 * After scrolling there is no fixed wait: expect.poll waits for the box position to catch up (floating-ui's ancestorScroll
 * callback is dispatched on the next frame). The scroll container is the grandparent of note-editor (same node chain as
 * 14-table-hover).
 * Position (#263): the input / streaming / error states float above the first block (may flip below); the result state covers
 * the first block - box top = the first block's `.bn-block-outer` top, left edges aligned, no flip, and clamped to the
 * container's top when the block's top scrolls above it.
 */

const RUN_ID = Date.now();
const PROVIDER_NAME = `E2E Box Provider ${RUN_ID}`;
const MODEL_DISPLAY_NAME = `E2E Box Model ${RUN_ID}`;
const REWRITTEN_TEXT = "E2E rewritten text"; // must equal FINAL_CONTENT in e2e/stubs/ai-stub.mjs

test.describe.configure({ mode: "serial" });

const para = (n: number) => `Paragraph number ${n} of the selection box geometry note.`;

async function writeParagraphs(page: Page, paragraphs: string[]): Promise<void> {
  const editor = editorLocator(page);
  await editor.waitFor({ timeout: 15_000 });
  await editor.click();
  for (let i = 0; i < paragraphs.length; i += 1) {
    await editor.pressSequentially(paragraphs[i]!);
    if (i < paragraphs.length - 1) {
      await waitForEditorSelection(page);
      await page.keyboard.press("Enter");
    }
  }
}

async function scrollContainerTop(page: Page): Promise<number> {
  return page.evaluate(() => {
    const scroller = document.querySelector('[data-testid="note-editor"]')?.closest(".overflow-y-auto");
    return scroller ? scroller.getBoundingClientRect().top : Number.NaN;
  });
}

async function scrollContainerBy(page: Page, dy: number): Promise<void> {
  await page.evaluate((delta) => {
    const scroller = document.querySelector('[data-testid="note-editor"]')?.closest(".overflow-y-auto") as HTMLElement | null | undefined;
    if (scroller) scroller.scrollTop += delta;
  }, dy);
}

async function scrollContainerRect(page: Page): Promise<{ top: number; bottom: number }> {
  return page.evaluate(() => {
    const scroller = document.querySelector('[data-testid="note-editor"]')?.closest(".overflow-y-auto");
    const r = scroller?.getBoundingClientRect();
    return r ? { top: r.top, bottom: r.bottom } : { top: Number.NaN, bottom: Number.NaN };
  });
}

/** The `.bn-block-outer` in the main editor that contains that text (the notes in this file are all flat paragraphs, so a nested outer cannot match too). */
function mainBlock(page: Page, text: string): Locator {
  return editorLocator(page).locator(".bn-block-outer").filter({ hasText: text });
}

/** Offsets of the box from the block in viewport coordinates: box top - block top (dy), box left - block left (dx). */
async function boxVsBlock(box: Locator, block: Locator): Promise<{ dy: number; dx: number }> {
  const [b, r] = [(await box.boundingBox())!, (await block.boundingBox())!];
  return { dy: b.y - r.y, dx: b.x - r.x };
}

async function runInstruction(box: Locator): Promise<void> {
  const input = box.getByRole("textbox", { name: "Instruction for the selected text" });
  await input.fill("Shorten it");
  await input.press("Enter");
  await expect(box.getByTestId("selection-ai-preview")).toContainText(REWRITTEN_TEXT, { timeout: 15_000 });
}

async function scrollContainerScrollTop(page: Page): Promise<number> {
  return page.evaluate(() => {
    const scroller = document.querySelector('[data-testid="note-editor"]')?.closest(".overflow-y-auto");
    return scroller ? scroller.scrollTop : Number.NaN;
  });
}

async function noPageScrollbar(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollHeight <= document.documentElement.clientHeight);
}

/** The box's content fits entirely (no scrolling inside the box). The box's `size()` clamps the max height to the available height, so "does not fit" shows up as a squashed box, not as top going out of bounds. */
async function boxContentFits(box: Locator): Promise<boolean> {
  return box.evaluate((el) => el.scrollHeight <= el.clientHeight);
}

test("create provider (/fast, Default model ticked)", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await openSiteAdmin(page);
    await adminNav(page, "AI agents");
    await page.getByRole("button", { name: "Add provider", exact: true }).click();
    const providerDialog = page.getByRole("dialog", { name: "Add provider" });
    await providerDialog.locator("#ai-provider-name").fill(PROVIDER_NAME);
    await chooseSelectOption(page, providerDialog.locator("#ai-provider-type"), "OpenAI-compatible");
    await providerDialog.locator("#ai-provider-base-url").fill("http://ai-stub:9500/fast");
    await providerDialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(providerDialog).not.toBeVisible();
    await page.getByRole("row", { name: `${PROVIDER_NAME} details`, exact: true }).getByRole("button", { name: "Add model", exact: true }).click();
    const modelDialog = page.getByRole("dialog", { name: "Add model" });
    await modelDialog.getByLabel("Model ID", { exact: true }).fill("e2e-box-model");
    await modelDialog.getByLabel("Display name", { exact: true }).fill(MODEL_DISPLAY_NAME);
    await modelDialog.getByLabel("Default model", { exact: true }).check();
    await modelDialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(modelDialog).not.toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/$/);
  } finally {
    await context.close();
  }
});

test("opening the box adds no page-wide scrollbar; clicking body text (empty selection) keeps the box; drag-selecting in another paragraph closes it", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await createNote(page, `E2E box geometry ${RUN_ID}`);
    const paragraphs = Array.from({ length: 9 }, (_, i) => para(i));
    await writeParagraphs(page, paragraphs);

    const box = await openSelectionAiBox(page, paragraphs[4]!);
    expect(await noPageScrollbar(page)).toBe(true);

    await editorLocator(page).getByText(paragraphs[7]!, { exact: true }).click();
    await waitForEditorSelection(page); // wait until PM's selection really lands on paragraph 7 (the decision has run) before asserting
    // Asserting only toBeVisible cannot tell that the box was closed: on close BlockNote's GenericPopover runs a fade-out
    // transition and during it shows a copy of the box's last innerHTML (the input is in it too), and the DOM is unmounted a bit
    // later (the box is still in the DOM 50 ms after closing and gone by 500 ms; with only a visibility assertion, a regression
    // that closes the box on an empty selection stays green).
    // So wait two frames for the update queued by React committing the selection change, then look at the outer popover's
    // inline opacity: the closing transition sets it to "0" (the floating-ui useTransitionStyles default, which GenericPopover
    // does not change).
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(box).toBeVisible();
    expect(await box.evaluate((el) => (el.parentElement as HTMLElement).style.opacity)).not.toBe("0");

    // The store is false throughout pointerdown, so this guards the onSelectionChange decision
    const target = editorLocator(page).getByText(paragraphs[8]!, { exact: true });
    const r = (await target.boundingBox())!;
    await page.mouse.move(r.x + 2, r.y + r.height / 2);
    await page.mouse.down();
    await page.mouse.move(r.x + r.width - 2, r.y + r.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect(box).toBeHidden();
  } finally {
    await context.close();
  }
});

test("scrolling the body moves the box's top with it (pinned beside the selected block)", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await createNote(page, `E2E box scroll ${RUN_ID}`);
    const paragraphs = Array.from({ length: 30 }, (_, i) => para(i));
    await writeParagraphs(page, paragraphs);
    await scrollContainerBy(page, -100_000);

    const box = await openSelectionAiBox(page, paragraphs[8]!);
    const before = (await box.boundingBox())!.y;
    await scrollContainerBy(page, 120);
    await expect.poll(async () => Math.abs(before - (await box.boundingBox())!.y - 120)).toBeLessThanOrEqual(2);
  } finally {
    await context.close();
  }
});

test("box opened after Ctrl+A, and box opened with only the first block selected: box top >= scroll container top and the content fits; with select-all the built-in toolbar is suppressed", async ({ browser }) => {
  // Only 24px above the first block (scroll container top 70, first block top 94 at 1280x720), so the box (about 50px in the
  // input state) must flip below the block. Without flip() the box would not cross the container top (size() clamps the max
  // height to the available 14px and top lands exactly on 70), so besides top the test also asserts that the box is not
  // squashed (boxContentFits).
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await createNote(page, `E2E box select-all ${RUN_ID}`);
    const paragraphs = Array.from({ length: 6 }, (_, i) => para(i));
    await writeParagraphs(page, paragraphs);
    const containerTop = await scrollContainerTop(page);

    await editorLocator(page).getByText(paragraphs[2]!, { exact: true }).click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.getByRole("button", { name: "AI", exact: true }).click();
    const box = page.getByTestId("selection-ai-box");
    await expect(box).toBeVisible();
    expect((await box.boundingBox())!.y).toBeGreaterThanOrEqual(containerTop);
    expect(await boxContentFits(box)).toBe(true);
    // Select-all also counts as a box selection target -> the built-in toolbar is suppressed and does not overlap the box
    // (toHaveCount waits for the toolbar's collapse transition to finish). Note: after a real Ctrl+A in Chromium PM's selection
    // is a TextSelection (anchor 3, head 347, doc size 350), not an AllSelection (from 0), so selectionInsideAnchor's clamp of
    // `from` is not load-bearing on this path (removing it keeps this case green); the AllSelection half is covered by unit
    // tests, and this line guards the suppression formula itself.
    await expect(page.locator(".bn-formatting-toolbar")).toHaveCount(0);
    await expect(box).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(box).toBeHidden();

    const firstOnly = await openSelectionAiBox(page, paragraphs[0]!);
    expect((await firstOnly.boundingBox())!.y).toBeGreaterThanOrEqual(containerTop);
    expect(await boxContentFits(firstOnly)).toBe(true);
    await runInstruction(firstOnly);
    await expect.poll(async () => Math.abs((await boxVsBlock(firstOnly, mainBlock(page, paragraphs[0]!))).dy)).toBeLessThanOrEqual(1);
    expect((await firstOnly.boundingBox())!.y).toBeGreaterThanOrEqual(containerTop);
  } finally {
    await context.close();
  }
});

test("consistent wrapping: the same long paragraph renders within 1px of the same height in the preview box and in the body", async ({ browser }) => {
  // Viewport raised to 1000: the box's max height is min(40vh, available height) = 400px, and the preview (the original as one
  // block of 126px + one added line + the button row, 205px for the whole box) fits without a scrollbar. With a scrollbar its
  // width eats into the text column and wrapping differs from the body (listed in known-limitations); that is not what this
  // case checks, so the box is first asserted not to scroll (precondition).
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await createNote(page, `E2E box wrap ${RUN_ID}`);
    const long = Array.from({ length: 6 }, (_, i) => `Sentence ${i} keeps this paragraph long enough to wrap over several lines.`).join(" ");
    await writeParagraphs(page, [long]);

    const box = await openSelectionAiBox(page, long);
    await runInstruction(box);
    const preview = box.getByTestId("selection-ai-preview");
    expect(await boxContentFits(box)).toBe(true); // precondition: no scrolling inside the box

    // The original and the stub output do not pair up (low similarity) -> in the preview the original is one whole deleted block whose content equals the body verbatim
    const previewBlock = preview.locator('[data-diff="deleted"] .bn-block-content').first();
    await expect(previewBlock).toContainText(long.slice(0, 40));
    const mainBlock = editorLocator(page).locator(".bn-block-content").filter({ hasText: long.slice(0, 40) }).first();
    const [mainHeight, previewHeight] = await Promise.all([
      mainBlock.evaluate((el) => el.getBoundingClientRect().height),
      previewBlock.evaluate((el) => el.getBoundingClientRect().height),
    ]);
    expect(mainHeight).toBeGreaterThan(40); // the paragraph really wraps; with a single line the height comparison would prove nothing
    expect(Math.abs(mainHeight - previewHeight)).toBeLessThanOrEqual(1);
  } finally {
    await context.close();
  }
});

test("result state covers the changed block: box top = first block top within 1px, left edges aligned, extends down over following paragraphs; a block near the container bottom does not flip and the box height is clamped to the available height below the box top", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await createNote(page, `E2E box overlay ${RUN_ID}`);
    const paragraphs = Array.from({ length: 30 }, (_, i) => para(i));
    await writeParagraphs(page, paragraphs);
    await scrollContainerBy(page, -100_000);

    const box = await openSelectionAiBox(page, paragraphs[4]!);
    const block = mainBlock(page, paragraphs[4]!);
    expect((await boxVsBlock(box, block)).dy).toBeLessThan(-10); // precondition: the input state floats above the block (position unchanged)
    await runInstruction(box);
    await expect.poll(async () => Math.abs((await boxVsBlock(box, block)).dy)).toBeLessThanOrEqual(1);
    expect(Math.abs((await boxVsBlock(box, block)).dx)).toBeLessThanOrEqual(1);
    const boxRect = (await box.boundingBox())!;
    const nextRect = (await mainBlock(page, paragraphs[5]!).boundingBox())!;
    expect(boxRect.y + boxRect.height).toBeGreaterThan(nextRect.y + 1);
    await box.press("Escape");
    await expect(box).toBeHidden();

    // Near the container bottom: the block top is only 60px from the container bottom, so the whole result does not fit - no flip above the block, the box top still = the block top, scrolling inside the box
    const target = mainBlock(page, paragraphs[20]!);
    const container = await scrollContainerRect(page);
    await scrollContainerBy(page, (await target.boundingBox())!.y - (container.bottom - 60));
    await expect.poll(async () => Math.abs((await target.boundingBox())!.y - (container.bottom - 60))).toBeLessThanOrEqual(1);
    const low = await openSelectionAiBox(page, paragraphs[20]!);
    await runInstruction(low);
    await expect.poll(async () => Math.abs((await target.boundingBox())!.y - (container.bottom - 60))).toBeLessThanOrEqual(1); // open / submit / completion all did not scroll
    await expect.poll(async () => Math.abs((await boxVsBlock(low, target)).dy)).toBeLessThanOrEqual(1);
    const lowRect = (await low.boundingBox())!;
    expect(lowRect.y + lowRect.height).toBeLessThanOrEqual(container.bottom + 1);
    expect(await boxContentFits(low)).toBe(false); // precondition: it really does not fit (otherwise flip would not trigger and "no flip" proves nothing)
  } finally {
    await context.close();
  }
});

test("result state follows the block when scrolling; when the block top scrolls above the container top the box top is clamped to the container top", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await createNote(page, `E2E box overlay scroll ${RUN_ID}`);
    const paragraphs = Array.from({ length: 30 }, (_, i) => para(i));
    await writeParagraphs(page, paragraphs);
    await scrollContainerBy(page, -100_000);

    const box = await openSelectionAiBox(page, paragraphs[8]!);
    const block = mainBlock(page, paragraphs[8]!);
    await runInstruction(box);
    await expect.poll(async () => Math.abs((await boxVsBlock(box, block)).dy)).toBeLessThanOrEqual(1);

    const startY = (await block.boundingBox())!.y;
    await scrollContainerBy(page, 50);
    await expect.poll(async () => (await block.boundingBox())!.y).toBeLessThan(startY - 40);
    await expect.poll(async () => Math.abs((await boxVsBlock(box, block)).dy)).toBeLessThanOrEqual(1);

    const containerTop = await scrollContainerTop(page);
    await scrollContainerBy(page, (await block.boundingBox())!.y - containerTop + 40);
    await expect.poll(async () => (await block.boundingBox())!.y).toBeLessThan(containerTop - 30);
    await expect.poll(async () => Math.abs((await box.boundingBox())!.y - containerTop)).toBeLessThanOrEqual(1);
    expect((await box.boundingBox())!.y).toBeGreaterThanOrEqual(containerTop - 0.5);
  } finally {
    await context.close();
  }
});

test("opening, submitting and completing do not change the note's scroll position (focus moves inside the box always use preventScroll)", async ({ browser }) => {
  // When the box opens it has not yet been positioned by floating-ui (still at the portal origin), so textarea.focus() without
  // preventScroll would scroll the note: removing preventScroll from the open-box focus makes scrollTop go 150 -> 0 at the open
  // step (1280x720, 30 paragraphs, paragraph 12). Paragraph 12 is within the visible range before and after opening, so
  // Playwright's click / fill / press need no scrolling of their own; measure at three moments: open, submit, complete.
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await createNote(page, `E2E box no-scroll ${RUN_ID}`);
    const paragraphs = Array.from({ length: 30 }, (_, i) => para(i));
    await writeParagraphs(page, paragraphs);
    await scrollContainerBy(page, -100_000);
    await scrollContainerBy(page, 150);
    await expect.poll(() => scrollContainerScrollTop(page)).toBe(150); // precondition: really scrolled to a non-zero position
    const scrolled = await scrollContainerScrollTop(page);
    const stays = async () => expect.poll(async () => Math.abs((await scrollContainerScrollTop(page)) - scrolled)).toBeLessThanOrEqual(1);

    const box = await openSelectionAiBox(page, paragraphs[12]!);
    const input = box.getByRole("textbox", { name: "Instruction for the selected text" });
    await expect(input).toBeFocused();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await stays();
    await input.fill("Shorten it");
    await input.press("Enter");
    await stays();
    await expect(box.getByTestId("selection-ai-preview")).toContainText(REWRITTEN_TEXT, { timeout: 15_000 });
    await expect(box).toBeFocused();
    await stays();
  } finally {
    await context.close();
  }
});

// #464: block type menu of the formatting toolbar
test("block type menu: Heading 1 on a multi-block selection changes only paragraphs and keeps table content; one undo restores everything", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: E2E_ORIGIN });
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 720 });
    await loginAs(page, ADMIN.email, ADMIN.password);
    await createNote(page, `E2E block type select ${RUN_ID}`);
    const editor = editorLocator(page);
    await editor.waitFor({ timeout: 15_000 });
    await editor.click();
    await editor.pressSequentially("alice paragraph");
    await waitForEditorSelection(page);
    await page.keyboard.press("Enter");
    await editor.pressSequentially("bob paragraph");
    await waitForEditorSelection(page);
    await page.keyboard.press("Enter");
    await page.evaluate((text) => navigator.clipboard.writeText(text), "| Col1 | Col2 |\n| --- | --- |\n| r1c1 | r1c2 |\n");
    await page.keyboard.press("ControlOrMeta+v");
    await expect(editor.locator("table")).toBeVisible({ timeout: 10_000 });
    await expect(editor.getByText("r1c2", { exact: true })).toBeVisible();

    await editor.getByText("alice paragraph", { exact: true }).click();
    await page.keyboard.press("ControlOrMeta+a");
    const toolbar = page.locator(".bn-formatting-toolbar");
    await toolbar.getByRole("button", { name: "Paragraph" }).click();
    await page.getByRole("menuitem", { name: "Heading 1", exact: true }).click();

    await expect(editor.locator("h1", { hasText: "alice paragraph" })).toBeVisible();
    await expect(editor.locator("h1", { hasText: "bob paragraph" })).toBeVisible();
    await expect(editor.locator("table")).toBeVisible();
    await expect(editor.getByText("r1c1", { exact: true })).toBeVisible();
    await expect(editor.getByText("r1c2", { exact: true })).toBeVisible();

    await page.keyboard.press("ControlOrMeta+z");
    await expect(editor.locator("h1")).toHaveCount(0);
    await expect(editor.getByText("alice paragraph", { exact: true })).toBeVisible();
    await expect(editor.getByText("bob paragraph", { exact: true })).toBeVisible();
    await expect(editor.getByText("r1c1", { exact: true })).toBeVisible();
    await expect(editor.getByText("r1c2", { exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});
