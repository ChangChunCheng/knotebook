import { expect, test, type Locator, type Page } from "@playwright/test";
import { ADMIN, createNote, editorLocator, loginAs, waitForEditorSelection } from "./helpers.js";

/**
 * The code block's language dropdown lives in the top-right corner of the block and is invisible normally. Touch has no hover,
 * so the way to bring it up is "tap into the code" (`apps/web/src/collab/code-block-caret.ts` sets `data-caret-inside` and
 * `index.css` makes the dropdown appear).
 * Unit tests guard that the attribute is set and the CSS rule exists; this guards three things that exist only in a real browser:
 * (a) while invisible, `pointer-events:none` really lets the tap through (hit-test): tapping that corner is not swallowed by
 *     the unseen dropdown;
 * (b) after tapping into the code the dropdown really appears and is tappable, **not via hover**: Chromium's touch-emulated tap
 *     also puts `:hover` on the tapped element, so before asserting, the mouse position is moved away and the block is
 *     confirmed not to be `:hover`, so appearing can only come from the caret path;
 * (c) when tapping the dropdown focus passes from the editor to the select: the editor blurs -> the caret attribute is
 *     removed, and after the list opens focus moves into an option, so the dropdown itself must stay visible through
 *     `select:open` (in the `@supports (appearance: base-select)` block of `index.css`) and keep receiving taps, and must not
 *     fall back to `pointer-events:none` during the handover; finally a language is tapped in the open list to confirm it can
 *     really be changed.
 *     (This part holds only in browsers that support base-select; Playwright's Chromium does.)
 */

const codeBlock = (page: Page) => page.locator('[data-testid="note-editor"] [data-content-type="codeBlock"]');

async function center(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("元素沒有 bounding box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function tap(page: Page, locator: Locator): Promise<void> {
  const at = await center(locator);
  await page.touchscreen.tap(at.x, at.y);
}

function selectState(page: Page) {
  return codeBlock(page)
    .locator("select")
    .evaluate((el) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { opacity: s.opacity, pointerEvents: s.pointerEvents, hitIsSelect: hit === el, hit: hit?.tagName ?? null };
    });
}

test("30 touch: the language dropdown does not take taps when invisible; tapping into the code shows it and it is tappable; the focus handover on tapping it does not make it retract", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ hasTouch: true });
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await createNote(page, `E2E code block touch ${Date.now()}`);

    const editor = editorLocator(page);
    await editor.click();
    await editor.pressSequentially("intro");
    await waitForEditorSelection(page);
    await page.keyboard.press("Enter");
    await editor.pressSequentially("```ts ");
    await expect(codeBlock(page)).toHaveCount(1);
    await editor.pressSequentially("const answer = 42;");
    const select = codeBlock(page).locator("select");
    await expect(select).toHaveValue("typescript");

    await tap(page, editor.getByText("intro", { exact: true }));
    await page.mouse.move(1, 1);
    await expect.poll(() => codeBlock(page).evaluate((el) => el.matches(":hover"))).toBe(false);
    await expect.poll(async () => (await selectState(page)).opacity).toBe("0");
    // (a) With the caret outside the code and the mouse not on the block, the dropdown is invisible and a tap at its centre passes through it.
    const hidden = await selectState(page);
    expect(hidden.pointerEvents, "隱形時要 pointer-events:none").toBe("none");
    expect(hidden.hitIsSelect, `隱形的下拉不得吃掉那一角的點擊（命中 ${hidden.hit}）`).toBe(false);

    // (b) Tap into the code (the first line's left part, far from the dropdown at the top right) => it appears and is tappable; hover is moved away first, to prove it is not held up by :hover.
    const code = codeBlock(page).locator("code");
    const codeBox = await code.boundingBox();
    if (!codeBox) throw new Error("code 沒有 bounding box");
    await page.touchscreen.tap(codeBox.x + 12, codeBox.y + 10);
    await waitForEditorSelection(page);
    await page.mouse.move(1, 1);
    await expect.poll(() => codeBlock(page).evaluate((el) => el.matches(":hover"))).toBe(false);
    await expect(codeBlock(page)).toHaveAttribute("data-caret-inside", "true");
    await expect.poll(async () => (await selectState(page)).opacity).toBe("1");
    const shown = await selectState(page);
    expect(shown.pointerEvents, "現身時要點得到").toBe("auto");
    expect(shown.hitIsSelect, `現身的下拉中心點要命中它自己（命中 ${shown.hit}）`).toBe(true);

    // (c) Tap the dropdown: the list opens and focus goes to it (base-select then moves it into the selected option), the editor blurs => the caret attribute is removed.
    //     Once the finger leaves the block, the dropdown itself must stay through `select:open` and remain tappable (`:focus` cannot hold it: focus is on the option).
    await tap(page, select);
    await expect.poll(() => select.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await expect(codeBlock(page)).not.toHaveAttribute("data-caret-inside");
    await page.mouse.move(1, 1);
    await expect.poll(() => codeBlock(page).evaluate((el) => el.matches(":hover"))).toBe(false);
    await page.waitForTimeout(300); // wait out the 0.15s opacity transition: if it were going to retract, it would have by now
    const handedOver = await selectState(page);
    expect(handedOver.opacity, "清單開著時下拉本體不得淡出").toBe("1");
    expect(handedOver.pointerEvents, "焦點交接後不得縮回 pointer-events:none").toBe("auto");

    // In headless Chromium the base-select list is real DOM, so the option can be tapped.
    const python = select.locator('option[value="python"]');
    await expect(python).toBeInViewport();
    await tap(page, python);
    await expect(select).toHaveValue("python");
  } finally {
    await context.close();
  }
});
