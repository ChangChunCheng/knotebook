import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { E2E_ORIGIN } from "../ports.js";
import { ADMIN, createUserViaInvite, editorLocator, loginAs, randomEmail, selectionAiBox, solidPng, waitForEditorSelection } from "./helpers.js";

/**
 * Phone (< 640) editing toolbar: tapping the body shows it above the keyboard position, replacing the bottom bar. Touch context (hasTouch + isMobile).
 *
 * 57-8 also applies a custom color code by touch and taps a recent one again. 57-11b: when the image is scrolled to the top of the body there is no room above for the floating toolbar, so it flips below the image and stays above the editing toolbar; the flip's bottom inset is not asserted.
 * 57-12: with a multi-cell selection the floating toolbar keeps an 8 margin on both sides and the overflowing part scrolls horizontally inside it.
 *
 * The on-screen keyboard is simulated with a fake `visualViewport` (see `emulateKeyboard`); the real keyboard animation, safe area, iOS focus behaviour and where a real finger lands can't be measured and are on the real-device list.
 *
 * Account and data: one account (alice) is created through an invite, and each case creates its own note via the API (each with different content, so they don't affect each other).
 */

// Playwright actions have no timeout by default: if something can't be clicked it waits until the whole case times out, and it isn't visible which step is stuck.
test.use({ actionTimeout: 15_000 });

const RUN = Date.now();
const PASSWORD = "e2e-mobile-toolbar-pw";
const ORIGIN = E2E_ORIGIN;
const TOOLBAR = "[data-mobile-edit-toolbar]";
const BROWSE_BAR = '[data-testid="note-browse-bar"]';

let alice: { email: string; displayName: string };

type Phone = { width: number; height: number };
const P390: Phone = { width: 390, height: 844 };
const P320: Phone = { width: 320, height: 640 };

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  alice = { email: randomEmail(), displayName: `alice ${RUN}` };
  const admin = await browser.newContext();
  try {
    const page = await admin.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await createUserViaInvite(page, { ...alice, password: PASSWORD });
  } finally {
    await admin.close();
  }
  // The `[[` menu must be tall enough to measure "bottom edge doesn't overlap the toolbar": prepare a few linkable notes first.
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    const page = await context.newPage();
    await loginAs(page, alice.email, PASSWORD);
    for (let i = 0; i < 10; i++) {
      const res = await page.request.post("/api/notes", { headers: { Origin: ORIGIN }, data: { title: `Link target ${i} ${RUN}` } });
      expect(res.status(), await res.text()).toBe(201);
    }
  } finally {
    await context.close();
  }
});

interface NoteRef {
  id: string;
  path: string;
}

async function createNoteVia(page: Page, title: string, content?: string): Promise<NoteRef> {
  const res = await page.request.post("/api/notes", { headers: { Origin: ORIGIN }, data: content === undefined ? { title } : { title, content } });
  expect(res.status(), await res.text()).toBe(201);
  const note = (await res.json()) as { id: string; slug: string; ownerHandle: string };
  return { id: note.id, path: `/n/${note.ownerHandle}/${note.slug}` };
}

async function phoneContext(browser: Browser, phone: Phone, withKeyboard = false): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: phone });
  const page = await context.newPage();
  if (withKeyboard) await emulateKeyboard(page);
  await loginAs(page, alice.email, PASSWORD);
  await expect(page).toHaveURL(/\/$/);
  return { context, page };
}

async function openPhoneNote(
  browser: Browser,
  phone: Phone,
  label: string,
  markdown: string,
  waitFor: string,
  withKeyboard = false,
): Promise<{ context: BrowserContext; page: Page; note: NoteRef }> {
  const { context, page } = await phoneContext(browser, phone, withKeyboard);
  const note = await createNoteVia(page, `E2E mobile toolbar ${label} ${RUN}`, markdown);
  await page.goto(note.path);
  await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible({ timeout: 15_000 });
  await expect(editorLocator(page).getByText(waitFor).first()).toBeVisible({ timeout: 15_000 });
  return { context, page, note };
}

const toolbarOf = (page: Page): Locator => page.locator(TOOLBAR);
const toolbarButton = (page: Page, name: string): Locator => toolbarOf(page).getByRole("button", { name, exact: true });
const blockText = (page: Page, text: string): Locator => editorLocator(page).locator(".bn-inline-content").filter({ hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }).first();

/**
 * Stand-in for the on-screen keyboard: Chromium can't simulate a keyboard, so `window.visualViewport` is replaced with a fake object whose height can be set (the layout viewport doesn't shrink, like iOS).
 * After that `setKeyboard(page, 300)` is like raising a 300px keyboard and `setKeyboard(page, 0)` lowers it. The toolbar's and menus' positioning read this object.
 */
async function emulateKeyboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const target = new EventTarget();
    const state = { keyboard: 0 };
    const fake = target;
    Object.defineProperties(fake, {
      height: { get: () => window.innerHeight - state.keyboard },
      width: { get: () => window.innerWidth },
      offsetTop: { value: 0 },
      offsetLeft: { value: 0 },
      pageTop: { value: 0 },
      pageLeft: { value: 0 },
      scale: { value: 1 },
    });
    Object.defineProperty(window, "visualViewport", { get: () => fake, configurable: true });
    (window as unknown as { __setKeyboard: (px: number) => void }).__setKeyboard = (px) => {
      state.keyboard = px;
      target.dispatchEvent(new Event("resize"));
    };
  });
}

async function setKeyboard(page: Page, px: number): Promise<void> {
  await page.evaluate((value) => (window as unknown as { __setKeyboard: (px: number) => void }).__setKeyboard(value), px);
  // Let the toolbar catch up (`useKeyboardInset` merges reads with requestAnimationFrame).
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function readMarkdown(page: Page, noteId: string): Promise<string> {
  const res = await page.request.get(`/api/notes/${noteId}/content`);
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { markdown: string }).markdown;
}

/**
 * The editor's current selection: when PM's anchor/head align with the DOM's anchor/focus and are in the same block, returns that block's text and the selection start/end (character positions within the block);
 * otherwise returns a diagnostic (`no-editor`, `focus-outside`, `{ pm, dom }`, `spans-blocks`). Only for plain-text paragraphs (a link is a mark, not an inline atom, so it is fine).
 */
async function blockSelection(page: Page): Promise<unknown> {
  return editorLocator(page).evaluate((el) => {
    type Resolved = { parentOffset: number; parent: { textContent: string } };
    type View = {
      state: { selection: { anchor: number; head: number; $from: Resolved; $to: Resolved } };
      posAtDOM(node: Node, offset: number): number;
    };
    const view = (el as Element & { editor?: { view?: View } }).editor?.view;
    if (!view) return "no-editor";
    const sel = window.getSelection();
    if (!sel?.anchorNode || !sel.focusNode || !el.contains(sel.anchorNode) || !el.contains(sel.focusNode) || !el.contains(document.activeElement)) return "focus-outside";
    const { anchor, head, $from, $to } = view.state.selection;
    let dom: [number, number] | string;
    try {
      dom = [view.posAtDOM(sel.anchorNode, sel.anchorOffset), view.posAtDOM(sel.focusNode, sel.focusOffset)];
    } catch (err) {
      dom = `posAtDOM threw: ${String(err)}`;
    }
    if (typeof dom === "string" || dom[0] !== anchor || dom[1] !== head) return { pm: [anchor, head], dom };
    if ($from.parent !== $to.parent) return "spans-blocks";
    return { text: $from.parent.textContent, from: $from.parentOffset, to: $to.parentOffset };
  });
}

/**
 * Touch-clicks into `block` and presses `keys` until the selection is exactly `from`-`to` of that paragraph (both PM and DOM); otherwise retries the whole sequence.
 * Why pressing keys right after the click and then waiting for PM and DOM to align isn't enough: when the editor had no focus, the click triggers ProseMirror's focus timer (20 ms), which writes PM's old selection
 * back to the DOM. If Home/arrow/Shift+End are pressed before the timer fires and PM hasn't read them, the caret is pulled back to where it was clicked (alignment still holds),
 * so the link dialog isn't prefilled and the text ends up not selected. The mechanism is in `clickEndOfParagraph` in helpers. On a retry the editor already has focus, so the timer is not scheduled.
 */
async function tapAndSelect(page: Page, block: Locator, keys: string[], from: number, to: number): Promise<void> {
  const text = (await block.textContent()) ?? "";
  await expect(async () => {
    await block.tap({ position: { x: 2, y: 4 } });
    await expect(toolbarOf(page)).toBeVisible({ timeout: 10_000 });
    for (const key of keys) await page.keyboard.press(key);
    await expect
      .poll(() => blockSelection(page), { timeout: 1_000, message: `選取要是「${text}」的 ${from}–${to}（PM 與 DOM 對齊）` })
      .toEqual({ text, from, to });
  }).toPass({ timeout: 20_000 });
}

async function placeCaret(page: Page, block: Locator, offset: number): Promise<void> {
  await tapAndSelect(page, block, ["Home", ...Array.from({ length: offset }, () => "ArrowRight")], offset, offset);
}

async function selectBlock(page: Page, block: Locator): Promise<void> {
  const length = ((await block.textContent()) ?? "").length;
  await tapAndSelect(page, block, ["Home", "Shift+End"], 0, length);
}

function rectOf(locator: Locator): Promise<{ x: number; y: number; width: number; height: number; bottom: number; right: number }> {
  return locator.first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right };
  });
}

async function toolbarTop(page: Page): Promise<number> {
  return (await toolbarOf(page).first().evaluate((el) => {
    // The frame is `pointer-events-none` and its height is the sum of its contents; the pill is the visible part, and the color panel is counted separately while open.
    const pill = el.firstElementChild as HTMLElement | null;
    return (pill ?? el).getBoundingClientRect().top;
  })) as number;
}

async function expectNoPageErrors(errors: string[]): Promise<void> {
  expect(errors.filter((m) => !m.includes("ResizeObserver loop")), "pageerror").toEqual([]);
}

for (const phone of [P390, P320]) {
  test(`57-1 ${phone.width} touch: tapping the body shows the toolbar and hides the bar; selecting text shows no floating toolbar; every button is inside the viewport; dismissing the keyboard brings the bar back`, async ({ browser }) => {
    test.setTimeout(120_000);
    const { context, page } = await openPhoneNote(browser, phone, `appear ${phone.width}`, "alpha bravo charlie\n\ndelta echo", "alpha bravo charlie");
    try {
      await expect(page.locator(`${BROWSE_BAR} [data-phone-fab=\"search\"]`)).toBeVisible();
      await expect(toolbarOf(page)).toHaveCount(0);

      await selectBlock(page, blockText(page, "alpha bravo charlie"));
      await expect(toolbarOf(page)).toBeVisible();
      await expect(page.locator(BROWSE_BAR)).toHaveCount(0);
      // While selecting text the desktop floating format toolbar must not appear (it opens on the tick after the selection, so wait a moment before asserting it is absent).
      await page.waitForTimeout(600);
      await expect(page.locator(".bn-formatting-toolbar")).toHaveCount(0);

      const buttons = toolbarOf(page).getByRole("button");
      const count = await buttons.count();
      expect(count, "主列按鈕數").toBeGreaterThanOrEqual(7);
      const lines: string[] = [];
      for (let i = 0; i < count; i++) {
        const button = buttons.nth(i);
        await button.scrollIntoViewIfNeeded();
        const box = (await button.boundingBox())!;
        const name = (await button.getAttribute("aria-label")) ?? `#${i}`;
        lines.push(`${name} ${box.x.toFixed(0)}-${(box.x + box.width).toFixed(0)}`);
        expect(box.x, `${name} 左緣`).toBeGreaterThanOrEqual(-0.5);
        expect(box.x + box.width, `${name} 右緣`).toBeLessThanOrEqual(phone.width + 0.5);
        expect(box.y + box.height, `${name} 下緣`).toBeLessThanOrEqual(phone.height + 0.5);
        expect(box.width, `${name} 寬`).toBeGreaterThanOrEqual(43.5);
      }
      console.log(`MEASURE 57-1 ${phone.width} ${lines.join(" | ")}`);
      const pill = await rectOf(toolbarOf(page).locator("> div").first());
      expect(pill.x).toBeGreaterThanOrEqual(0);
      expect(pill.right).toBeLessThanOrEqual(phone.width + 0.5);

      await toolbarButton(page, "Hide keyboard").tap();
      await expect(page.locator(`${BROWSE_BAR} [data-phone-fab=\"search\"]`)).toBeVisible();
      await expect(toolbarOf(page)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
}

test("57-2 Aa: select text -> Aa -> bold, the content gains `**`; back returns to the main row", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page, note } = await openPhoneNote(browser, P390, "bold", "alpha bravo charlie", "alpha bravo charlie");
  try {
    await selectBlock(page, blockText(page, "alpha bravo charlie"));
    await toolbarButton(page, "Text formatting").tap();
    await expect(toolbarOf(page)).toHaveAttribute("data-mobile-toolbar-mode", "format");
    for (const name of ["Bold", "Italic", "Create link", "Colors"]) await expect(toolbarButton(page, name)).toBeVisible();
    await expect(toolbarButton(page, "Undo")).toHaveCount(0);
    await toolbarButton(page, "Bold").tap();
    await expect(toolbarButton(page, "Bold")).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => readMarkdown(page, note.id), { timeout: 15_000 }).toContain("**alpha bravo charlie**");
    // The floating toolbar opens on the tick after the selection: wait before asserting it is absent.
    await page.waitForTimeout(600);
    await expect(page.locator(".bn-formatting-toolbar")).toHaveCount(0);
    await toolbarButton(page, "Back").tap();
    await expect(toolbarOf(page)).toHaveAttribute("data-mobile-toolbar-mode", "main");
    await expect(toolbarButton(page, "Undo")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("57-3 pilcrow: changes to Heading 2; with the caret in a table or code block the pilcrow is disabled and pressing it leaves the content unchanged", async ({ browser }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  {
    const { context, page, note } = await openPhoneNote(browser, P390, "heading", "alpha bravo charlie", "alpha bravo charlie");
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      await placeCaret(page, blockText(page, "alpha bravo charlie"), 3);
      await expect(toolbarButton(page, "Change block type")).not.toHaveAttribute("aria-disabled", "true");
      await toolbarButton(page, "Change block type").tap();
      await expect(toolbarOf(page)).toHaveAttribute("data-mobile-toolbar-mode", "blockType");
      await toolbarButton(page, "Heading 2").tap();
      await expect.poll(() => readMarkdown(page, note.id), { timeout: 15_000 }).toMatch(/^## alpha bravo charlie/m);
    } finally {
      await context.close();
    }
  }
  const table = "<table><tr><th>h1</th><th>h2</th></tr><tr><td>c1</td><td>c2</td></tr></table>";
  for (const [label, markdown, waitFor, target] of [
    ["table", `intro\n\n${table}\n\nouter`, "c1", "c1"],
    ["code", "intro\n\n```js\nconst a = 1;\n```\n\nouter", "const a = 1;", "const a = 1;"],
  ] as const) {
    const { context, page, note } = await openPhoneNote(browser, P390, label, markdown, waitFor);
    try {
      const before = await readMarkdown(page, note.id);
      const cell = editorLocator(page).getByText(target, { exact: true }).first();
      await cell.tap();
      await expect(toolbarOf(page)).toBeVisible({ timeout: 10_000 });
      const pilcrow = toolbarButton(page, "Change block type");
      await expect(pilcrow, `${label}：游標在這裡 ¶ 停用`).toHaveAttribute("aria-disabled", "true");
      await pilcrow.tap({ force: true });
      await expect(toolbarOf(page)).toHaveAttribute("data-mobile-toolbar-mode", "main");
      // A disabled button gives nothing to wait for: wait a moment, then check the content.
      await page.waitForTimeout(500);
      expect(await readMarkdown(page, note.id), `${label}：內容不變`).toBe(before);
    } finally {
      await context.close();
    }
  }
  await expectNoPageErrors(errors);
});

test("57-4 undo and redo: after typing, undo returns to the original text and redo brings it back", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await openPhoneNote(browser, P390, "undo", "alpha bravo", "alpha bravo");
  try {
    await placeCaret(page, blockText(page, "alpha bravo"), 0);
    await page.keyboard.press("End");
    await waitForEditorSelection(page);
    await page.keyboard.type(" zulu");
    await expect(blockText(page, "alpha bravo zulu")).toBeVisible();
    await toolbarButton(page, "Undo").tap();
    await expect(blockText(page, "alpha bravo")).toBeVisible({ timeout: 10_000 });
    await expect(editorLocator(page).getByText("zulu")).toHaveCount(0);
    // A mouse click sends mousedown first: if the button doesn't block it the editor loses focus (a touch tap in Chromium doesn't go through this step, so it can't be measured).
    await toolbarButton(page, "Redo").click();
    await expect(blockText(page, "alpha bravo zulu")).toBeVisible({ timeout: 10_000 });
    expect(await editorLocator(page).evaluate((el) => el.contains(document.activeElement))).toBe(true);
  } finally {
    await context.close();
  }
});

/** The site has a set of AI actions: admin creates a provider (pointing at ai-stub) and a default model via the API. */
async function ensureAiAction(browser: Browser): Promise<void> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    const provider = await page.request.post("/api/admin/ai/providers", {
      headers: { Origin: ORIGIN },
      data: { name: `E2E mobile toolbar provider ${RUN}`, type: "openai_compatible", baseUrl: "http://ai-stub:9500/fast" },
    });
    expect(provider.status(), await provider.text()).toBe(201);
    const { id } = (await provider.json()) as { id: string };
    const model = await page.request.post("/api/admin/ai/models", {
      headers: { Origin: ORIGIN },
      data: { providerId: id, modelId: "e2e-mobile-toolbar-model", displayName: `E2E mobile toolbar model ${RUN}`, isDefault: true },
    });
    expect(model.status(), await model.text()).toBe(201);
  } finally {
    await context.close();
  }
}

test("57-5 AI button: absent when the site has no AI action; with one it is disabled with no selection and pressable after selecting text, opening the AI box", async ({ browser }) => {
  test.setTimeout(150_000);
  // No AI action: intercept the action list (other specs on the site may already have created a provider, so the real state can't be relied on).
  {
    const { context, page } = await phoneContext(browser, P390);
    try {
      await page.route("**/api/ai/actions", (route) => route.fulfill({ json: { actions: [] } }));
      const note = await createNoteVia(page, `E2E mobile toolbar no-ai ${RUN}`, "alpha bravo");
      await page.goto(note.path);
      await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible({ timeout: 15_000 });
      await placeCaret(page, blockText(page, "alpha bravo"), 0);
      await expect(toolbarButton(page, "Insert block")).toBeVisible();
      await expect(toolbarButton(page, "AI")).toHaveCount(0);
    } finally {
      await context.close();
    }
  }
  await ensureAiAction(browser);
  const { context, page } = await openPhoneNote(browser, P390, "ai", "alpha bravo", "alpha bravo");
  try {
    await placeCaret(page, blockText(page, "alpha bravo"), 0);
    const ai = toolbarButton(page, "AI");
    await expect(ai).toBeVisible({ timeout: 10_000 });
    await expect(ai).toHaveAttribute("aria-disabled", "true");
    await ai.tap({ force: true });
    // Pressing a disabled button produces no state change to wait for; wait a moment, then assert the AI box is not open.
    await page.waitForTimeout(600);
    await expect(selectionAiBox(page)).toHaveCount(0);
    await selectBlock(page, blockText(page, "alpha bravo"));
    await expect(ai).not.toHaveAttribute("aria-disabled", "true");
    await ai.tap();
    await expect(selectionAiBox(page)).toBeVisible({ timeout: 10_000 });
  } finally {
    await context.close();
  }
});

const slashMenu = (page: Page): Locator => page.locator(".bn-suggestion-menu");

test("57-6 plus button: on a paragraph with text it opens a new empty paragraph after it and opens the slash menu without inserting `/`; an empty code block also opens the menu", async ({ browser }) => {
  test.setTimeout(150_000);
  {
    const { context, page } = await openPhoneNote(browser, P390, "plus", "alpha bravo\n\nomega", "alpha bravo");
    try {
      const blocks = editorLocator(page).locator(".bn-block-outer");
      const before = await blocks.count();
      await placeCaret(page, blockText(page, "alpha bravo"), 5);
      await toolbarButton(page, "Insert block").tap();
      await expect(slashMenu(page)).toBeVisible({ timeout: 10_000 });
      await expect(blocks).toHaveCount(before + 1);
      await expect(blockText(page, "alpha bravo")).toBeVisible();
      expect(await editorLocator(page).innerText()).not.toContain("/");
      const order = await blocks.evaluateAll((els) => els.map((el) => (el.textContent ?? "").trim()));
      expect(order.slice(0, 3), "區塊順序").toEqual(["alpha bravo", "", "omega"]);
    } finally {
      await context.close();
    }
  }
  const { context, page } = await openPhoneNote(browser, P390, "plus-code", "intro\n\n```js\n```\n\nouter", "intro");
  try {
    const code = editorLocator(page).locator('[data-content-type="codeBlock"]').first();
    await expect(code).toBeVisible();
    await code.tap();
    await expect(toolbarOf(page)).toBeVisible({ timeout: 10_000 });
    await toolbarButton(page, "Insert block").tap();
    await expect(slashMenu(page)).toBeVisible({ timeout: 10_000 });
    expect(await code.innerText()).not.toContain("/");
  } finally {
    await context.close();
  }
});

async function expectMenuAboveToolbar(page: Page, label: string, minRowHeight: number | null): Promise<{ rows: number; minRow: number; bottom: number; top: number }> {
  const menu = slashMenu(page);
  await expect(menu).toBeVisible({ timeout: 10_000 });
  // The position is measured once more after the menu appears (floating-ui places first, then computes); wait for it to settle.
  let last = -1;
  await expect
    .poll(async () => {
      const bottom = (await rectOf(menu)).bottom;
      const stable = Math.abs(bottom - last) < 0.5;
      last = bottom;
      return stable;
    })
    .toBe(true);
  const items = menu.locator(".bn-suggestion-menu-item");
  const rows = await items.count();
  expect(rows, `${label} 選單項數`).toBeGreaterThanOrEqual(3);
  const heights = await items.evaluateAll((els) => els.map((el) => `${(el.textContent ?? "").trim().slice(0, 20)}=${el.getBoundingClientRect().height.toFixed(1)}`));
  console.log(`MEASURE rows ${label} ${heights.join(" | ")}`);
  console.log(`MEASURE cls ${label} ${await items.first().evaluate((el) => `${el.className} min=${getComputedStyle(el).minHeight} h=${getComputedStyle(el).height}`)}`);
  const minRow = Math.min(...heights.map((h) => Number(h.split("=").pop())));
  const text = await menu.innerText();
  expect(text, `${label} 沒有快捷鍵字樣`).not.toMatch(/ctrl|alt/i);
  if (minRowHeight !== null) expect(minRow, `${label} 最矮的一列`).toBeGreaterThanOrEqual(minRowHeight);
  const menuRect = await rectOf(menu);
  const viewportHeight = page.viewportSize()!.height;
  expect(menuRect.height, `${label} 選單高度 ${menuRect.height.toFixed(1)} ≤ 視窗高的一半`).toBeLessThanOrEqual(viewportHeight / 2 + 1);
  const bottom = menuRect.bottom;
  const top = await toolbarTop(page);
  expect(bottom, `${label} 選單下緣 ${bottom.toFixed(1)} ≤ 工具列上緣 ${top.toFixed(1)}`).toBeLessThanOrEqual(top + 0.5);
  return { rows, minRow, bottom, top };
}

test("57-7 slash and [[ menus: no shortcut wording, row height >= 44, bottom edge doesn't overlap the toolbar", async ({ browser }) => {
  test.setTimeout(180_000);
  const lines: string[] = [];
  const filler = Array.from({ length: 30 }, (_, i) => `filler line ${i}`).join("\n\n");
  for (const [label, markdown, anchor] of [
    // Caret at the top of the document: the menu opens below, so its height must be limited by the toolbar.
    ["top", `alpha bravo\n\n${filler}`, "alpha bravo"],
    // Caret in the lower half of the document: not enough room below, so the menu opens above the caret.
    ["bottom", `${filler}\n\nlast words`, "last words"],
    // On-screen keyboard raised 300px: only the upper half of the viewport is left, and the menu's available height and flip up/down are based on the toolbar at the keyboard's top edge.
    ["keyboard", `${filler}\n\nlast words`, "last words"],
  ] as const) {
    const { context, page } = await openPhoneNote(browser, P390, `menus-${label}`, markdown, anchor, label === "keyboard");
    try {
      const target = blockText(page, anchor);
      await target.scrollIntoViewIfNeeded();
      await placeCaret(page, target, anchor.length);
      if (label === "keyboard") await setKeyboard(page, 300);
      await page.keyboard.press("Enter");
      await page.keyboard.type("/");
      const slash = await expectMenuAboveToolbar(page, `/ ${label}`, 44);
      lines.push(`/ ${label} rows ${slash.rows} minRow ${slash.minRow.toFixed(1)} bottom ${slash.bottom.toFixed(1)} toolbarTop ${slash.top.toFixed(1)}`);
      await page.keyboard.press("Escape");
      await expect(slashMenu(page)).toHaveCount(0);
      await page.keyboard.press("Backspace");

      await page.keyboard.type("[[");
      const link = await expectMenuAboveToolbar(page, `[[ ${label}`, 44);
      lines.push(`[[ ${label} rows ${link.rows} minRow ${link.minRow.toFixed(1)} bottom ${link.bottom.toFixed(1)} toolbarTop ${link.top.toFixed(1)}`);
    } finally {
      await context.close();
    }
  }
  console.log(`MEASURE 57-7 ${lines.join(" | ")}`);
});

const hexInput = (page: Page): Locator => page.getByRole("textbox", { name: "Hex color" });
const colorPanel = (page: Page): Locator => page.locator("[data-mobile-color-panel]");

test("57-8 color panel: Aa -> A -> swatch -> back chevron keeps the selection, returns focus to the editor and applies the text color; the toolbar stays while the panel is open and tapping the body collapses the panel", async ({ browser }) => {
  test.setTimeout(180_000);
  const { context, page } = await openPhoneNote(browser, P390, "colors", "alpha bravo charlie\n\nsecond words here", "alpha bravo charlie");
  try {
    await selectBlock(page, blockText(page, "alpha bravo charlie"));
    await toolbarButton(page, "Text formatting").tap();
    await toolbarButton(page, "Colors").tap();
    await expect(colorPanel(page)).toBeVisible();
    await expect(toolbarOf(page)).toBeVisible();
    await expect(toolbarOf(page)).toHaveAttribute("data-mobile-toolbar-mode", "color");
    await expect(toolbarButton(page, "Colors")).toHaveAttribute("aria-pressed", "true");
    const panelRect = await rectOf(colorPanel(page));
    expect(panelRect.bottom).toBeLessThanOrEqual(P390.height + 0.5);
    const selectedLine = await rectOf(blockText(page, "alpha bravo charlie"));
    expect(selectedLine.bottom, "選取的那一行在色盤之上").toBeLessThanOrEqual(panelRect.y + 0.5);

    const textRow = colorPanel(page).getByRole("group", { name: "Text", exact: true });
    await textRow.getByRole("button", { name: "Red", exact: true }).tap();
    await expect(editorLocator(page).locator('[data-style-type="textColor"][data-value="red"]')).toHaveText("alpha bravo charlie", { timeout: 10_000 });
    await expect(colorPanel(page)).toBeVisible();
    await expect(page.locator("[data-mobile-color-open]")).toHaveCount(1);

    await toolbarButton(page, "Back").tap();
    await expect(colorPanel(page)).toHaveCount(0);
    await expect(toolbarOf(page)).toHaveAttribute("data-mobile-toolbar-mode", "format");
    await expect.poll(() => editorLocator(page).evaluate((el) => el.contains(document.activeElement))).toBe(true);
    expect(await page.evaluate(() => document.getSelection()?.toString())).toBe("alpha bravo charlie");
    await expect(page.locator("[data-mobile-color-open]")).toHaveCount(0);

    await toolbarButton(page, "Colors").tap();
    await expect(colorPanel(page)).toBeVisible();
    await blockText(page, "second words here").tap({ position: { x: 2, y: 4 } });
    await expect(colorPanel(page)).toHaveCount(0);
    await expect(toolbarOf(page)).toBeVisible();
  } finally {
    await context.close();
  }
});

test("57-8b color panel (touch): a custom color code can be applied and a recent one tapped again; the code box doesn't take focus when the custom page opens", async ({ browser }) => {
  test.setTimeout(180_000);
  const { context, page } = await openPhoneNote(browser, P390, "colors-custom", "first words here\n\nsecond words here", "first words here");
  const custom = "#ff6600";
  try {
    await selectBlock(page, blockText(page, "first words here"));
    await toolbarButton(page, "Text formatting").tap();
    await toolbarButton(page, "Colors").tap();
    await colorPanel(page).getByRole("group", { name: "Text", exact: true }).getByRole("button", { name: "Custom…", exact: true }).tap();
    await expect(hexInput(page)).toBeVisible();
    // Touch: the code box stays unfocused so the on-screen keyboard doesn't open.
    await expect(hexInput(page)).not.toBeFocused();
    expect(await colorPanel(page).evaluate((el) => el.contains(document.activeElement)), "焦點留在色盤").toBe(true);
    await hexInput(page).tap();
    await hexInput(page).fill(custom);
    await page.getByRole("button", { name: "Apply", exact: true }).tap();
    await expect(editorLocator(page).locator(`[data-style-type="textColor"][data-value="${custom}"]`)).toHaveText("first words here", { timeout: 10_000 });
    await expect(editorLocator(page).locator(`[data-style-type="textColor"][data-value="${custom}"]`)).toHaveCSS("color", "rgb(255, 102, 0)");

    await toolbarButton(page, "Back").tap();
    await toolbarButton(page, "Back").tap();
    await selectBlock(page, blockText(page, "second words here"));
    await toolbarButton(page, "Text formatting").tap();
    await toolbarButton(page, "Colors").tap();
    await colorPanel(page).getByRole("group", { name: "Text", exact: true }).getByRole("button", { name: "Custom…", exact: true }).tap();
    await expect(colorPanel(page).getByText("Recent", { exact: true })).toBeVisible();
    await colorPanel(page).getByRole("button", { name: custom, exact: true }).tap();
    await expect(editorLocator(page).locator(`[data-style-type="textColor"][data-value="${custom}"]`).filter({ hasText: "second words here" })).toBeVisible({ timeout: 10_000 });
  } finally {
    await context.close();
  }
});

test("57-9 link: with the caret in a link, the link button opens the dialog prefilled with the URL; changing the URL only changes the href, and the text is unchanged and not duplicated", async ({ browser }) => {
  test.setTimeout(150_000);
  const { context, page, note } = await openPhoneNote(browser, P390, "link", "see [docs](https://example.com/old) end", "see docs end");
  try {
    // Caret in the middle of "docs" ("see " is 4 characters, plus 2).
    await placeCaret(page, blockText(page, "see docs end"), 6);
    await toolbarButton(page, "Text formatting").tap();
    await toolbarButton(page, "Create link").tap();
    const dialog = page.getByRole("dialog", { name: "Insert link" });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByLabel("URL", { exact: true })).toHaveValue("https://example.com/old");
    await expect(dialog.getByLabel("Display text", { exact: true })).toHaveValue("docs");
    await dialog.getByLabel("URL", { exact: true }).fill("https://example.com/new");
    await dialog.getByRole("button", { name: "Insert", exact: true }).tap();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => readMarkdown(page, note.id), { timeout: 15_000 }).toContain("see [docs](https://example.com/new) end");
    expect(await readMarkdown(page, note.id)).not.toContain("example.com/old");
    await expect(blockText(page, "see docs end")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("57-10 long document: tapping the last line and typing leaves that line's bottom edge above the toolbar's top edge", async ({ browser }) => {
  test.setTimeout(150_000);
  const lines = Array.from({ length: 50 }, (_, i) => `line number ${i}`);
  const { context, page } = await openPhoneNote(browser, P390, "long", lines.join("\n\n"), "line number 0", true);
  try {
    const last = blockText(page, "line number 49");
    await last.scrollIntoViewIfNeeded();
    await last.tap({ position: { x: 2, y: 4 } });
    await expect(toolbarOf(page)).toBeVisible({ timeout: 10_000 });
    await setKeyboard(page, 300);
    await page.keyboard.press("End");
    await waitForEditorSelection(page);
    await page.keyboard.type(" typed at the very end");
    const typed = blockText(page, "line number 49 typed at the very end");
    await expect(typed).toBeVisible();
    // Scrolling is done by ProseMirror after typing; wait for the position to settle before measuring.
    let previous = -1;
    await expect
      .poll(async () => {
        const bottom = (await rectOf(typed)).bottom;
        const stable = Math.abs(bottom - previous) < 0.5;
        previous = bottom;
        return stable;
      })
      .toBe(true);
    const bottom = (await rectOf(typed)).bottom;
    const top = await toolbarTop(page);
    console.log(`MEASURE 57-10 line bottom ${bottom.toFixed(1)} toolbarTop ${top.toFixed(1)}`);
    expect(top, "工具列浮在鍵盤上方").toBeLessThan(P390.height - 300);
    expect(bottom, "最後一行的下緣").toBeLessThanOrEqual(top + 0.5);
  } finally {
    await context.close();
  }
});

async function createNoteWithImageAndTable(page: Page, label: string, image = { width: 200, height: 120 }): Promise<NoteRef> {
  const note = await createNoteVia(page, `E2E mobile toolbar ${label} ${RUN}`);
  const upload = await page.request.post(`/api/notes/${note.id}/uploads`, {
    headers: { Origin: ORIGIN },
    multipart: { file: { name: "box.png", mimeType: "image/png", buffer: solidPng(image.width, image.height) } },
  });
  expect(upload.status(), await upload.text()).toBe(201);
  const { url } = (await upload.json()) as { url: string };
  const current = await page.request.get(`/api/notes/${note.id}/content`);
  const { fingerprint } = (await current.json()) as { fingerprint: string };
  const markdown = [
    "lead words",
    "",
    `<figure><img alt="box" src="${url}" width="${image.width}"></figure>`,
    "",
    "<table><tr><th>h1</th><th>h2</th></tr><tr><td>c1</td><td>c2</td></tr></table>",
    "",
    "tail words",
    "",
    // A long paragraph follows so the body can scroll (to test the position with the image scrolled to the very top).
    ...Array.from({ length: 30 }, (_, i) => `filler line ${i}\n`),
  ].join("\n");
  const written = await page.request.post(`/api/notes/${note.id}/edits`, { headers: { Origin: ORIGIN }, data: { op: "replace_all", markdown, if_match: fingerprint } });
  expect(written.status(), await written.text()).toBeLessThan(300);
  return note;
}

for (const phone of [P390, P320]) {
  test(`57-11 ${phone.width} image: tapping the image shows the floating toolbar with a delete button, inside the viewport and not covered by the editing toolbar`, async ({ browser }) => {
    test.setTimeout(150_000);
    const { context, page } = await phoneContext(browser, phone);
    try {
      const note = await createNoteWithImageAndTable(page, `image ${phone.width}`);
      await page.goto(note.path);
      await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible({ timeout: 15_000 });
      const image = editorLocator(page).locator('[data-content-type="image"]').first();
      await expect(image).toBeVisible({ timeout: 15_000 });
      await image.scrollIntoViewIfNeeded();
      await image.locator("img").tap();
      const floating = page.locator(".bn-formatting-toolbar");
      await expect(floating).toBeVisible({ timeout: 10_000 });
      await expect(floating.getByRole("button", { name: /delete/i })).toBeVisible();
      let previous = -1;
      await expect
        .poll(async () => {
          const x = (await rectOf(floating)).x;
          const stable = Math.abs(x - previous) < 0.5;
          previous = x;
          return stable;
        })
        .toBe(true);
      const rect = await rectOf(floating);
      console.log(`MEASURE 57-11 ${phone.width} floating x ${rect.x.toFixed(1)} right ${rect.right.toFixed(1)} y ${rect.y.toFixed(1)} bottom ${rect.bottom.toFixed(1)}`);
      expect(rect.x, "浮動工具列左緣").toBeGreaterThanOrEqual(-0.5);
      expect(rect.right, "浮動工具列右緣").toBeLessThanOrEqual(phone.width + 0.5);
      expect(rect.y, "浮動工具列上緣").toBeGreaterThanOrEqual(-0.5);
      await expect(toolbarOf(page)).toBeVisible();
      expect(rect.bottom, "浮動工具列下緣在編輯工具列上緣之上").toBeLessThanOrEqual((await toolbarTop(page)) + 0.5);
      expect(rect.bottom, "浮動工具列下緣").toBeLessThanOrEqual(phone.height);
    } finally {
      await context.close();
    }
  });
}

test("57-11b 390 tall image, keyboard raised: when there is no room above, the floating toolbar flips below the image and stays above the editing toolbar", async ({ browser }) => {
  test.setTimeout(150_000);
  const { context, page } = await phoneContext(browser, P390, true);
  try {
    // An image 200 wide and 300 high: scrolled to the top, there is no room above it for the floating toolbar.
    const note = await createNoteWithImageAndTable(page, "tall image", { width: 200, height: 300 });
    await page.goto(note.path);
    await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible({ timeout: 15_000 });
    const image = editorLocator(page).locator('[data-content-type="image"]').first();
    await expect(image).toBeVisible({ timeout: 15_000 });
    await setKeyboard(page, 300);
    await image.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await image.locator("img").tap();
    const floating = page.locator(".bn-formatting-toolbar");
    await expect(floating).toBeVisible({ timeout: 10_000 });
    await expect(toolbarOf(page)).toBeVisible();
    let previous = -1;
    await expect
      .poll(async () => {
        const y = (await rectOf(floating)).y;
        const stable = Math.abs(y - previous) < 0.5;
        previous = y;
        return stable;
      })
      .toBe(true);
    const rect = await rectOf(floating);
    const imageRect = await rectOf(image);
    const top = await toolbarTop(page);
    console.log(`MEASURE 57-11b floating y ${rect.y.toFixed(1)} bottom ${rect.bottom.toFixed(1)} image y ${imageRect.y.toFixed(1)} bottom ${imageRect.bottom.toFixed(1)} toolbarTop ${top.toFixed(1)}`);
    expect(rect.y, "浮動工具列翻到圖片下方").toBeGreaterThanOrEqual(imageRect.bottom - 0.5);
    expect(rect.bottom, "浮動工具列下緣在編輯工具列上緣之上").toBeLessThanOrEqual(top + 0.5);
  } finally {
    await context.close();
  }
});

async function selectTwoCells(page: Page): Promise<Locator> {
  const cell1 = editorLocator(page).getByText("c1", { exact: true }).first();
  const cell2 = editorLocator(page).getByText("c2", { exact: true }).first();
  await expect(cell1).toBeVisible({ timeout: 15_000 });
  await cell1.scrollIntoViewIfNeeded();
  const a = (await cell1.boundingBox())!;
  const b = (await cell2.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 });
  await page.mouse.up();
  const floating = page.locator(".bn-formatting-toolbar");
  await expect(floating).toBeVisible({ timeout: 10_000 });
  await expect(editorLocator(page).locator(".selectedCell")).not.toHaveCount(0);
  return floating;
}

/** The element's center is inside the viewport and the hit element at that point is the element itself (not covered by another element, nor clipped). */
async function expectReachable(target: Locator, viewport: Phone, label: string): Promise<void> {
  await expect(target, `${label} 可見`).toBeVisible({ timeout: 10_000 });
  const hit = await target.first().evaluate((el, size) => {
    const r = el.getBoundingClientRect();
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    const top = document.elementFromPoint(x, y);
    return { x, y, inside: x >= 0 && x <= size.width && y >= 0 && y <= size.height, hit: top !== null && (el === top || el.contains(top)) };
  }, viewport);
  expect(hit.inside, `${label} 中心 (${hit.x.toFixed(0)}, ${hit.y.toFixed(0)}) 在視窗內`).toBe(true);
  expect(hit.hit, `${label} 中心點命中它自己`).toBe(true);
}

test("57-12 320 cells: with a multi-cell selection the floating toolbar's right edge is inside the viewport", async ({ browser }) => {
  test.setTimeout(150_000);
  const { context, page } = await phoneContext(browser, P320);
  try {
    const note = await createNoteWithImageAndTable(page, "cells 320");
    await page.goto(note.path);
    await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible({ timeout: 15_000 });
    const floating = await selectTwoCells(page);
    let previous = -1;
    await expect
      .poll(async () => {
        const x = (await rectOf(floating)).x;
        const stable = Math.abs(x - previous) < 0.5;
        previous = x;
        return stable;
      })
      .toBe(true);
    const rect = await rectOf(floating);
    console.log(`MEASURE 57-12 320 floating x ${rect.x.toFixed(1)} right ${rect.right.toFixed(1)} y ${rect.y.toFixed(1)} bottom ${rect.bottom.toFixed(1)}`);
    expect(rect.x, "浮動工具列左緣").toBeGreaterThanOrEqual(8 - 0.5);
    expect(rect.right, "浮動工具列右緣").toBeLessThanOrEqual(320 - 8 + 0.5);
  } finally {
    await context.close();
  }
});

test("57-13 320 cells: the floating toolbar's Colors menu isn't clipped, a swatch can be tapped and the menu collapses after applying", async ({ browser }) => {
  test.setTimeout(150_000);
  const { context, page } = await phoneContext(browser, P320);
  try {
    const note = await createNoteWithImageAndTable(page, "cells colors");
    await page.goto(note.path);
    await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible({ timeout: 15_000 });
    const floating = await selectTwoCells(page);
    const colors = floating.locator('[data-test="colors"]');
    await colors.scrollIntoViewIfNeeded();
    await colors.tap();
    const swatch = page.locator('[data-test="text-color-red"]');
    await expectReachable(swatch, P320, "紅色色票");
    await swatch.tap();
    await expect(swatch).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("57-14 390 image: the floating toolbar's Replace panel isn't clipped and the tabs in it can be tapped", async ({ browser }) => {
  test.setTimeout(150_000);
  const { context, page } = await phoneContext(browser, P390);
  try {
    const note = await createNoteWithImageAndTable(page, "image replace");
    await page.goto(note.path);
    await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible({ timeout: 15_000 });
    const image = editorLocator(page).locator('[data-content-type="image"]').first();
    await expect(image).toBeVisible({ timeout: 15_000 });
    await image.locator("img").tap();
    const floating = page.locator(".bn-formatting-toolbar");
    await expect(floating).toBeVisible({ timeout: 10_000 });
    const replace = floating.getByRole("button", { name: /replace/i });
    await replace.scrollIntoViewIfNeeded();
    await replace.tap();
    const panel = page.locator(".bn-panel").first();
    await expect(panel).toBeVisible({ timeout: 10_000 });
    const tabs = panel.getByRole("tab");
    console.log(`MEASURE 57-14 panel ${JSON.stringify(await rectOf(panel))} tabs ${await tabs.count()}`);
    expect(await tabs.count(), "面板分頁數").toBeGreaterThanOrEqual(1);
    await expectReachable(tabs.first(), P390, "面板第一個分頁");
  } finally {
    await context.close();
  }
});
