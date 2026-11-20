import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { E2E_ORIGIN } from "../ports.js";
import { ADMIN, clickEndOfParagraph, createUserViaInvite, editorLocator, loginAs, randomEmail, waitForEditorSelection } from "./helpers.js";

/**
 * Heading outline on the right (#465, desktop): a row of thin lines at the right of the body column (one per H1-H3, the current section lit) that expands into a panel on hover, and clicking a heading jumps to it;
 * a standard-width note can pin the panel.
 * Desktop cases run at 1440x900 except 60-5 (1280x800) and 60-12 (700x900); 60-7a to 60-7f use the phone context (390x844); the sidebar is always 320 (each case first writes localStorage, not relying on the sidebar's default width).
 *
 * Cases are numbered 60-1 to 60-13 in their titles; 60-7a to 60-7f are the phone cases.
 * - 60-1: the heading's `.bn-block-outer` top differs from the scroll container top by [-2, 4] px; the highlight overlay lasts only about 2 seconds; the URL (including the hash) is unchanged.
 * - 60-3: pinned text width = min(clamp(680, 85%W, 1056), W - 286) - 140 (W = the scroll container's visible width, tolerance +-1) and within 4 of 646 at 1440 wide with the sidebar at 320; the panel's left edge is >= 16 from the column's right edge; `outline.pinned` is "1" after reload.
 * - 60-5: with the sidebar at 320 a 640 column doesn't fit at 1280x800, so it falls back to the lines; widening to 1440x900 pins automatically.
 * - 60-7a: after jumping, the heading top differs from the pinned header's bottom edge by [-2, 4] px. 60-7b: the bubble text contains "/5" and disappears within 3 seconds.
 * - 60-9: collapsing is done by clicking the toggle button only (no scrolling, no pointer events); the outline re-measures from the size change.
 * - 60-11: the outline is outside the scroll container; with the wheel over the lines, or over a panel whose list fits (doesn't scroll itself), the body scrolls.
 *
 * Account and data: one account (alice) is created through an invite; read-only notes are created once in beforeAll via the API (including one with a public link),
 * and notes that get modified (60-6, 60-9) are created fresh inside each case so that `--repeat-each` runs don't interfere. Every case opens a new context.
 */

test.use({ actionTimeout: 15_000 });

const RUN = Date.now();
const PASSWORD = "e2e-heading-outline-pw";
const ORIGIN = E2E_ORIGIN;
const VIEWPORT = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const filler = (tag: string, n = 40): string => Array.from({ length: n }, (_, i) => `${tag} filler paragraph ${i}`).join("\n\n");
const LONG_MD = [
  "# Intro",
  filler("intro"),
  "## Install",
  filler("install"),
  "### Linux",
  filler("linux"),
  "## Usage",
  filler("usage"),
  "## Section D",
  filler("section"),
].join("\n\n");
const TAIL_MD = ["# Alpha", filler("alpha"), "## Omega", "the only paragraph under omega"].join("\n\n");
const LONG_HEADINGS = ["Intro", "Install", "Linux", "Usage", "Section D"];

let alice: { email: string; displayName: string };
const notes = { long: "", longId: "", tail: "", publicToken: "" };

async function createNoteVia(page: Page, title: string, content: string): Promise<{ id: string; path: string }> {
  const res = await page.request.post("/api/notes", { headers: { Origin: ORIGIN }, data: { title, content } });
  expect(res.status(), await res.text()).toBe(201);
  const note = (await res.json()) as { id: string; slug: string; ownerHandle: string };
  return { id: note.id, path: `/n/${note.ownerHandle}/${note.slug}` };
}

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
  const context = await browser.newContext({ viewport: VIEWPORT });
  try {
    const page = await context.newPage();
    await loginAs(page, alice.email, PASSWORD);
    const long = await createNoteVia(page, `Outline long ${RUN}`, LONG_MD);
    notes.long = long.path;
    notes.longId = long.id;
    notes.tail = (await createNoteVia(page, `Outline tail ${RUN}`, TAIL_MD)).path;
    const published = await createNoteVia(page, `Outline public ${RUN}`, LONG_MD);
    const res = await page.request.put(`/api/notes/${published.id}/public-link`, { headers: { Origin: ORIGIN } });
    expect(res.status(), await res.text()).toBe(200);
    notes.publicToken = ((await res.json()) as { token: string }).token;
  } finally {
    await context.close();
  }
});

interface ContextOptions {
  viewport?: { width: number; height: number };
  /** Phone: 390x844, touch (`viewport` is not used). */
  phone?: boolean;
  /** Key/value pairs written to localStorage before each load (the sidebar width is always written as 320). */
  storage?: Record<string, string>;
}

async function newContext(browser: Browser, options: ContextOptions = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(options.phone ? { hasTouch: true, isMobile: true, viewport: PHONE } : { viewport: options.viewport ?? VIEWPORT });
  await context.addInitScript((entries) => {
    try {
      for (const [key, value] of Object.entries(entries)) window.localStorage.setItem(key, value);
    } catch {
      // When localStorage can't be read, run with the default width.
    }
  }, { "sidebar.width": "320", ...options.storage });
  return { context, page: await context.newPage() };
}

async function openNote(
  browser: Browser,
  path: string | ((page: Page) => Promise<string>),
  options: ContextOptions = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const { context, page } = await newContext(browser, options);
  await loginAs(page, alice.email, PASSWORD);
  await expect(page).toHaveURL(/\/$/);
  await page.goto(typeof path === "string" ? path : await path(page));
  await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible({ timeout: 15_000 });
  return { context, page };
}

const rail = (page: Page): Locator => page.getByTestId("outline-rail");
const railLines = (page: Page): Locator => rail(page).locator(":scope > span");
const panel = (page: Page): Locator => page.getByTestId("outline-panel");
const panelItem = (page: Page, text: string): Locator => panel(page).locator("[data-outline-item]").filter({ hasText: new RegExp(`^${text}$`) });
const scrollerOf = (page: Page): Locator => page.getByTestId("article-column").locator("xpath=ancestor::div[contains(@class,'overflow-y-auto')][1]");

/** Hovers the lines and waits for the panel to expand (it opens after a 150 ms delay). */
async function openPanel(page: Page): Promise<void> {
  await rail(page).hover();
  await expect(panel(page)).toBeVisible();
}

async function headingId(page: Page, text: string): Promise<string> {
  const id = await page.evaluate((text) => {
    const content = Array.from(document.querySelectorAll('[data-content-type="heading"]')).find((el) => el.textContent?.trim() === text);
    return content?.closest(".bn-block-outer")?.getAttribute("data-id") ?? null;
  }, text);
  expect(id, `heading "${text}"`).not.toBeNull();
  return id!;
}

async function headingOffset(page: Page, id: string): Promise<number> {
  return scrollerOf(page).evaluate((scroller, id) => {
    const block = scroller.querySelector(`.bn-block-outer[data-id="${id}"]`)!;
    return block.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  }, id);
}

/** Scrolls until the heading top is just `past` px beyond the container top. */
async function scrollHeadingPastTop(page: Page, id: string, past = 2): Promise<void> {
  await scrollerOf(page).evaluate(
    (scroller, { id, past }) => {
      const block = scroller.querySelector(`.bn-block-outer[data-id="${id}"]`)!;
      scroller.scrollTop += block.getBoundingClientRect().top - scroller.getBoundingClientRect().top + past;
    },
    { id, past },
  );
}

async function expectLandedAtTop(page: Page, id: string): Promise<void> {
  await expect.poll(() => headingOffset(page, id), { timeout: 5_000, message: "標題頂端與捲動容器頂端的差（px）" }).toBeGreaterThanOrEqual(-2);
  await expect.poll(() => headingOffset(page, id), { timeout: 5_000, message: "標題頂端與捲動容器頂端的差（px）" }).toBeLessThanOrEqual(4);
}

async function expectActiveLine(page: Page, index: number): Promise<void> {
  await expect(rail(page).locator(":scope > span[data-active]")).toHaveCount(1);
  await expect(railLines(page).nth(index)).toHaveAttribute("data-active", "");
}

test("60-1 jump: hover expands 5 items, clicking Section D scrolls to the top and flashes once, the URL is unchanged and the panel collapses", async ({ browser }) => {
  const { context, page } = await openNote(browser, notes.long);
  try {
    await expect(railLines(page)).toHaveCount(5, { timeout: 15_000 });
    const urlBefore = page.url();
    await openPanel(page);
    await expect(panel(page).locator("[data-outline-item]")).toHaveText(LONG_HEADINGS);
    const id = await headingId(page, "Section D");
    await panelItem(page, "Section D").click();
    // The highlight lasts only about 2 seconds: look right after the click, then wait for scrolling to stop.
    await expect(page.locator(`.kn-anchor-flash[data-anchor-flash="${id}"]`)).toBeAttached({ timeout: 1_500 });
    await expectLandedAtTop(page, id);
    expect(page.url()).toBe(urlBefore);
    await expect(panel(page)).toBeHidden();
    await expect(rail(page)).toBeVisible();
    await expectActiveLine(page, 4);
  } finally {
    await context.close();
  }
});

test("60-2 current position: after Usage scrolls past the top Usage is lit, and the panel's aria-current is also on Usage", async ({ browser }) => {
  const { context, page } = await openNote(browser, notes.long);
  try {
    await expect(railLines(page)).toHaveCount(5, { timeout: 15_000 });
    await expectActiveLine(page, 0);
    await scrollHeadingPastTop(page, await headingId(page, "Usage"));
    await expectActiveLine(page, 3);
    await openPanel(page);
    await expect(panelItem(page, "Usage")).toHaveAttribute("aria-current", "location");
    await expect(panel(page).locator('[aria-current="location"]')).toHaveCount(1);
  } finally {
    await context.close();
  }
});

const PINNED = "outline.pinned";
const pinButton = (page: Page): Locator => panel(page).getByRole("button", { name: "Pin outline", exact: true });
const unpinButton = (page: Page): Locator => panel(page).getByRole("button", { name: "Unpin outline", exact: true });

async function expectPinnedPanel(page: Page): Promise<void> {
  await expect(panel(page)).toBeVisible({ timeout: 15_000 });
  await expect(rail(page)).toHaveCount(0);
  await expect(unpinButton(page)).toHaveAttribute("aria-pressed", "true");
}

async function expectRailOnly(page: Page): Promise<void> {
  await expect(rail(page)).toBeVisible({ timeout: 15_000 });
  await expect(panel(page)).toHaveCount(0);
}

async function textAndContainerWidth(page: Page): Promise<{ text: number; container: number }> {
  const text = await page
    .getByTestId("article-column")
    .locator(".bn-editor")
    .evaluate((el) => {
      const cs = getComputedStyle(el);
      return el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    });
  const container = await scrollerOf(page).evaluate((el) => el.clientWidth);
  return { text, container };
}

/** When pinned, column width = min(standard column width, container - 286); text width is that minus the column padding 16x2 and the editor padding 54x2. */
const pinnedTextWidth = (container: number): number => Math.min(Math.min(Math.max(680, 0.85 * container), 1056), container - 286) - 140;

test("60-3 pin: the panel stays and the lines are gone, the body column yields to the panel on the left, and it is still pinned after reload", async ({ browser }) => {
  const { context, page } = await openNote(browser, notes.long);
  try {
    await expect(railLines(page)).toHaveCount(5, { timeout: 15_000 });
    await openPanel(page);
    const floatingBox = (await panel(page).boundingBox())!;
    await pinButton(page).click();
    // Mouse over the sidebar: a floating panel closes after the collapse delay, a pinned one does not.
    await page.mouse.move(10, 450);
    await expectPinnedPanel(page);
    // The pinned panel sits exactly where the floating one did.
    const pinnedBox = (await panel(page).boundingBox())!;
    for (const key of ["x", "y", "width"] as const) expect(Math.abs(pinnedBox[key] - floatingBox[key]), `釘住前後面板的 ${key}`).toBeLessThanOrEqual(1);

    await expect
      .poll(
        async () => {
          const { text, container } = await textAndContainerWidth(page);
          return Math.abs(text - pinnedTextWidth(container));
        },
        { timeout: 5_000, message: "文字寬與 min(clamp(680, 85%, 1056), 容器 − 286) − 140 的差（px）" },
      )
      .toBeLessThanOrEqual(1);
    const { text } = await textAndContainerWidth(page);
    expect(Math.abs(text - 646), `1440 寬、側欄 320 時文字寬約 646（實際 ${text}）`).toBeLessThanOrEqual(4);
    await expect
      .poll(
        async () => {
          const column = await page.getByTestId("article-column").evaluate((el) => el.getBoundingClientRect().right);
          const left = await panel(page).evaluate((el) => el.getBoundingClientRect().left);
          return left - column;
        },
        { timeout: 5_000, message: "面板左緣 − 內文欄右緣（px）" },
      )
      .toBeGreaterThanOrEqual(15);
    const gap = await page.evaluate(() => document.querySelector('[data-testid="outline-panel"]')!.getBoundingClientRect().left - document.querySelector('[data-testid="article-column"]')!.getBoundingClientRect().right);
    expect(gap).toBeLessThanOrEqual(17);

    await page.reload();
    await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible({ timeout: 15_000 });
    await expectPinnedPanel(page);
    expect(await page.evaluate((key) => window.localStorage.getItem(key), PINNED)).toBe("1");
  } finally {
    await context.close();
  }
});

test("60-4 a full-width note can't be pinned: only the lines, and the panel expanded on hover has no pin button", async ({ browser }) => {
  const { context, page } = await openNote(browser, notes.long, {
    storage: { [PINNED]: "1", [`note.width.${notes.longId.toLowerCase()}`]: "full" },
  });
  try {
    await expect(railLines(page)).toHaveCount(5, { timeout: 15_000 });
    await expectRailOnly(page);
    await openPanel(page);
    await expect(panel(page).locator("[data-outline-item]")).toHaveCount(5);
    await expect(pinButton(page)).toHaveCount(0);
    await expect(unpinButton(page)).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("60-5 1280 wide with the sidebar at 320 doesn't fit: falls back to lines with no pin button; widening to 1440 pins automatically", async ({ browser }) => {
  const { context, page } = await openNote(browser, notes.long, { viewport: { width: 1280, height: 800 }, storage: { [PINNED]: "1" } });
  try {
    await expect(railLines(page)).toHaveCount(5, { timeout: 15_000 });
    await expectRailOnly(page);
    await openPanel(page);
    await expect(pinButton(page)).toHaveCount(0);
    await expect(unpinButton(page)).toHaveCount(0);
    await page.mouse.move(10, 400);
    await expect(panel(page)).toHaveCount(0);

    await page.setViewportSize(VIEWPORT);
    await expectPinnedPanel(page);
    expect(await page.evaluate((key) => window.localStorage.getItem(key), PINNED)).toBe("1");
  } finally {
    await context.close();
  }
});

test("60-11 wheel over the lines and the panel: the body scrolls", async ({ browser }) => {
  const { context, page } = await openNote(browser, notes.long);
  try {
    await expect(railLines(page)).toHaveCount(5, { timeout: 15_000 });
    const scroller = scrollerOf(page);
    const scrollTop = (): Promise<number> => scroller.evaluate((el) => el.scrollTop);
    expect(await scrollTop()).toBe(0);
    await rail(page).hover();
    await page.mouse.wheel(0, 400);
    await expect.poll(scrollTop, { timeout: 5_000, message: "滾輪在細線上，內文往下捲" }).toBeGreaterThan(200);
    // The panel list fits all five items and doesn't scroll itself: the wheel is still handed to the body.
    await expect(panel(page)).toBeVisible();
    const before = await scrollTop();
    await panelItem(page, "Usage").hover();
    await page.mouse.wheel(0, 400);
    await expect.poll(scrollTop, { timeout: 5_000, message: "滾輪在面板上，內文往下捲" }).toBeGreaterThan(before + 200);
  } finally {
    await context.close();
  }
});

test("60-6 adding an H2 by typing: within 5 seconds the lines gain one and the panel has New section", async ({ browser }) => {
  const { context, page } = await openNote(browser, async (page) => (await createNoteVia(page, `Outline typing ${RUN} ${Date.now()}`, "# First\n\nfirst body\n\nlast line")).path);
  try {
    await expect(railLines(page)).toHaveCount(1, { timeout: 15_000 });
    await clickEndOfParagraph(page, editorLocator(page).locator('[data-content-type="paragraph"]').filter({ hasText: /^last line$/ }));
    await page.keyboard.press("Enter");
    await page.keyboard.type("## New section");
    await expect(railLines(page)).toHaveCount(2, { timeout: 5_000 });
    await openPanel(page);
    await expect(panelItem(page, "New section")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("60-8 public page (logged out): the lines are there; hovering and clicking Usage scrolls to the top", async ({ browser }) => {
  const { context, page } = await newContext(browser);
  try {
    await page.goto(`/p/${notes.publicToken}`);
    await expect(page.locator('[data-testid="public-note-editor"]')).toBeVisible({ timeout: 15_000 });
    await expect(railLines(page)).toHaveCount(5, { timeout: 15_000 });
    await openPanel(page);
    const id = await headingId(page, "Usage");
    await panelItem(page, "Usage").click();
    await expectLandedAtTop(page, id);
    await expect(panel(page)).toBeHidden();
  } finally {
    await context.close();
  }
});

const sheet = (page: Page): Locator => page.getByRole("dialog", { name: "Heading outline" });
const sheetItem = (page: Page, text: string): Locator => sheet(page).locator("[data-outline-item]").filter({ hasText: new RegExp(`^${text}$`) });
const bubble = (page: Page): Locator => page.getByRole("button", { name: /^Open heading outline: / });
const moreButton = (page: Page): Locator => page.getByRole("button", { name: "More", exact: true });
const headingText = (page: Page, text: string): Locator => page.locator('[data-content-type="heading"]').filter({ hasText: new RegExp(`^${text}$`) });

async function headingBelowHeader(page: Page, id: string): Promise<number> {
  return page.evaluate((id) => {
    const block = document.querySelector(`.bn-block-outer[data-id="${id}"]`)!;
    const header = document.querySelector("[data-note-header-slot]")!;
    return block.getBoundingClientRect().top - header.getBoundingClientRect().bottom;
  }, id);
}

/**
 * Scrolls a little so the bubble appears and taps it at once, until the bottom panel opens. The bubble disappears 1.5 seconds after scrolling stops and on a slow machine may already be gone between scrolling and the tap: the whole step is retried.
 * Once the panel is open it neither scrolls nor taps again (while open the page locks scrolling, and the bubble is under the panel).
 */
async function openSheetFromBubble(page: Page, scroll: () => Promise<unknown>, pointer: "tap" | "click" = "tap"): Promise<void> {
  await expect(async () => {
    if (await sheet(page).isVisible()) return;
    await scroll();
    await (pointer === "tap" ? bubble(page).tap({ timeout: 1_000 }) : bubble(page).click({ timeout: 1_000 }));
    await expect(sheet(page)).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

/** Waits two frames: the scroll event and the repaint it causes. */
async function twoFrames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test("60-7a phone kebab: Heading outline opens the bottom panel, and clicking Section D scrolls below the header", async ({ browser }) => {
  const { context, page } = await openNote(browser, notes.long, { phone: true });
  try {
    await expect(headingText(page, "Section D")).toBeAttached({ timeout: 15_000 });
    await expect(rail(page)).toHaveCount(0);
    await moreButton(page).click();
    await page.getByRole("menuitem", { name: "Heading outline" }).click();
    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page).locator("[data-outline-item]")).toHaveText(LONG_HEADINGS);
    const id = await headingId(page, "Section D");
    await sheetItem(page, "Section D").click();
    await expect(sheet(page)).toBeHidden();
    // The panel has no trigger button: focus is returned to the kebab and doesn't fall to body.
    await expect(moreButton(page)).toBeFocused();
    await expect.poll(() => headingBelowHeader(page, id), { timeout: 5_000, message: "標題頂端與頁首下緣的差（px）" }).toBeGreaterThanOrEqual(-2);
    await expect.poll(() => headingBelowHeader(page, id), { timeout: 5_000, message: "標題頂端與頁首下緣的差（px）" }).toBeLessThanOrEqual(4);
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  } finally {
    await context.close();
  }
});

test("60-7b phone bubble: appears while scrolling, disappears about 1.5 seconds after stopping, and tapping it opens the bottom panel", async ({ browser }) => {
  const { context, page } = await openNote(browser, notes.long, { phone: true });
  try {
    await expect(headingText(page, "Section D")).toBeAttached({ timeout: 15_000 });
    await expect(bubble(page)).toHaveCount(0);
    await page.evaluate(() => window.scrollBy(0, 600));
    await expect(bubble(page)).toBeVisible();
    await expect(bubble(page)).toContainText("/5");
    await expect(bubble(page)).toHaveCount(0, { timeout: 3_000 });
    await openSheetFromBubble(page, () => page.evaluate(() => window.scrollBy(0, 300)));
    await expect(sheet(page).locator("[data-outline-item]")).toHaveCount(5);
  } finally {
    await context.close();
  }
});

test("60-7c phone, a note without headings: the kebab has no Heading outline and no bubble appears after scrolling", async ({ browser }) => {
  const { context, page } = await openNote(
    browser,
    async (page) => (await createNoteVia(page, `Outline none ${RUN} ${Date.now()}`, filler("plain", 60))).path,
    { phone: true },
  );
  try {
    await expect(page.locator('[data-content-type="paragraph"]').filter({ hasText: /^plain filler paragraph 59$/ })).toBeAttached({ timeout: 15_000 });
    await moreButton(page).click();
    await expect(page.getByRole("menuitem", { name: "Present" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Heading outline" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.evaluate(() => window.scrollBy(0, 600));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await twoFrames(page);
    await expect(bubble(page)).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("60-7d phone public page: the scroll container shows a bubble, tapping it opens the panel and clicking Usage scrolls to the top; no kebab", async ({ browser }) => {
  const { context, page } = await newContext(browser, { phone: true });
  try {
    await page.goto(`/p/${notes.publicToken}`);
    await expect(page.locator('[data-testid="public-note-editor"]')).toBeVisible({ timeout: 15_000 });
    await expect(headingText(page, "Section D")).toBeAttached({ timeout: 15_000 });
    await expect(moreButton(page)).toHaveCount(0);
    await expect(rail(page)).toHaveCount(0);
    await scrollerOf(page).evaluate((el) => el.scrollBy(0, 600));
    await expect(bubble(page)).toBeVisible();
    await expect(bubble(page)).toContainText("/5");
    await openSheetFromBubble(page, () => scrollerOf(page).evaluate((el) => el.scrollBy(0, 300)));
    const id = await headingId(page, "Usage");
    await sheetItem(page, "Usage").click();
    await expect(sheet(page)).toBeHidden();
    await expectLandedAtTop(page, id);
  } finally {
    await context.close();
  }
});

test("60-7e phone while editing: pressing Enter repeatedly makes the document scroll with the caret and the bubble does not appear", async ({ browser }) => {
  const { context, page } = await openNote(
    browser,
    async (page) => (await createNoteVia(page, `Outline caret ${RUN} ${Date.now()}`, "# Top\n\nfirst line")).path,
    { phone: true },
  );
  try {
    await expect(headingText(page, "Top")).toBeAttached({ timeout: 15_000 });
    await page.evaluate(() => {
      const w = window as Window & { bubbleSeen?: boolean };
      w.bubbleSeen = false;
      new MutationObserver(() => {
        if (document.querySelector('button[aria-label^="Open heading outline: "]') !== null) w.bubbleSeen = true;
      }).observe(document.body, { childList: true, subtree: true });
    });
    await clickEndOfParagraph(page, editorLocator(page).locator('[data-content-type="paragraph"]').filter({ hasText: /^first line$/ }));
    for (let i = 0; i < 40; i++) await page.keyboard.press("Enter");
    await page.keyboard.type("last line");
    await expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 5_000, message: "游標跟著讓文件往下捲" }).toBeGreaterThan(200);
    await twoFrames(page);
    expect(await page.evaluate(() => (window as Window & { bubbleSeen?: boolean }).bubbleSeen)).toBe(false);
    await expect(bubble(page)).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("60-7f phone while editing: opening the panel from the bubble and closing it directly returns focus to the editor and the toolbar stays", async ({ browser }) => {
  const { context, page } = await openNote(browser, notes.long, { phone: true });
  try {
    await expect(headingText(page, "Section D")).toBeAttached({ timeout: 15_000 });
    await clickEndOfParagraph(page, editorLocator(page).locator('[data-content-type="paragraph"]').filter({ hasText: /^intro filler paragraph 0$/ }));
    const toolbar = page.locator("[data-mobile-edit-toolbar]");
    await expect(toolbar).toBeVisible();
    // The reader scrolls by themselves (not caused by typing): only then does the bubble appear. Tapping the bubble doesn't take focus and the toolbar stays.
    await openSheetFromBubble(page, () => page.evaluate(() => window.scrollBy(0, 300)));
    await page.keyboard.press("Escape");
    await expect(sheet(page)).toBeHidden();
    await expect.poll(() => editorLocator(page).evaluate((el) => el.contains(document.activeElement)), { timeout: 5_000, message: "焦點回到編輯器" }).toBe(true);
    await expect(toolbar).toBeVisible();
  } finally {
    await context.close();
  }
});

test("60-9 toggle heading: after collapsing the lit one changes to the toggle heading; clicking a folded heading in the panel expands it and scrolls there", async ({ browser }) => {
  test.setTimeout(90_000);
  const md = ["# Top", filler("top"), "toggle anchor", filler("tail")].join("\n\n");
  const { context, page } = await openNote(browser, async (page) => (await createNoteVia(page, `Outline toggle ${RUN} ${Date.now()}`, md)).path);
  try {
    await expect(railLines(page)).toHaveCount(1, { timeout: 15_000 });
    await clickEndOfParagraph(page, editorLocator(page).locator('[data-content-type="paragraph"]').filter({ hasText: /^toggle anchor$/ }));
    await page.keyboard.press("Enter");
    await page.keyboard.type("/toggle heading 2");
    const menu = page.locator(".bn-suggestion-menu");
    await expect(menu.getByText("Toggle Heading 2", { exact: true })).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Enter");
    await waitForEditorSelection(page);
    await page.keyboard.type("Folded");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await page.keyboard.type("### Inner");
    await expect(railLines(page)).toHaveCount(3, { timeout: 5_000 });

    const foldedId = await headingId(page, "Folded");
    const innerId = await headingId(page, "Inner");
    const folded = page.locator(`.bn-block-outer[data-id="${foldedId}"]`);
    const wrapper = folded.locator("> .bn-block > .bn-block-content .bn-toggle-wrapper");
    await expect(wrapper).toHaveAttribute("data-show-children", "true");
    expect(await folded.locator(`.bn-block-outer[data-id="${innerId}"]`).count(), "Inner 在 Folded 裡").toBe(1);

    await scrollHeadingPastTop(page, innerId);
    await expectActiveLine(page, 2);

    // Only click the toggle button (`click()`: no pointer events and no scrolling): the content gets shorter and the outline re-measures from the size change.
    await folded.locator("> .bn-block > .bn-block-content .bn-toggle-button").evaluate((el) => (el as HTMLElement).click());
    await expect(wrapper).toHaveAttribute("data-show-children", "false");
    await expect(page.locator(`.bn-block-outer[data-id="${innerId}"]`)).toBeHidden();
    await expectActiveLine(page, 1);

    await openPanel(page);
    await panelItem(page, "Inner").click();
    await expect(wrapper).toHaveAttribute("data-show-children", "true");
    await expectLandedAtTop(page, innerId);
    await expectActiveLine(page, 2);
  } finally {
    await context.close();
  }
});

test("60-10 clicking the last heading: it is still the lit one even though it can't reach the top", async ({ browser }) => {
  const { context, page } = await openNote(browser, notes.tail);
  try {
    await expect(railLines(page)).toHaveCount(2, { timeout: 15_000 });
    await openPanel(page);
    const id = await headingId(page, "Omega");
    await panelItem(page, "Omega").click();
    const scroller = scrollerOf(page);
    await expect
      .poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop), { timeout: 5_000, message: "捲到底" })
      .toBeLessThanOrEqual(1);
    expect(await headingOffset(page, id)).toBeGreaterThan(50);
    await expectActiveLine(page, 1);
    // Wait a few frames (measurement is scheduled per frame): it must not revert to Alpha.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          let left = 5;
          const step = () => (--left === 0 ? resolve() : requestAnimationFrame(step));
          requestAnimationFrame(step);
        }),
    );
    await expectActiveLine(page, 1);
  } finally {
    await context.close();
  }
});

test("60-12 700 wide (640-767): no lines; the scroll container shows a bubble, which opens the bottom panel, and clicking Section D scrolls to the container top", async ({ browser }) => {
  const { context, page } = await openNote(browser, notes.long, { viewport: { width: 700, height: 900 } });
  try {
    await expect(headingText(page, "Section D")).toBeAttached({ timeout: 15_000 });
    await expect(rail(page)).toHaveCount(0);
    // The page itself does not scroll here: the card's scroll container does.
    const scrollContainerBy = (dy: number) =>
      page.evaluate((dy) => {
        for (let n = document.querySelector(".bn-block-content")!.parentElement; n; n = n.parentElement) {
          const o = getComputedStyle(n).overflowY;
          if ((o === "auto" || o === "scroll") && n.scrollHeight > n.clientHeight) {
            n.scrollBy(0, dy);
            return;
          }
        }
      }, dy);
    await expect(bubble(page)).toHaveCount(0);
    await scrollContainerBy(600);
    await expect(bubble(page)).toBeVisible();
    await expect(bubble(page)).toContainText("/5");
    // The bubble sits inside the scroll container's box, not above it.
    const topGap = await bubble(page).evaluate((el) => {
      for (let n = document.querySelector(".bn-block-content")!.parentElement; n; n = n.parentElement) {
        const o = getComputedStyle(n).overflowY;
        if ((o === "auto" || o === "scroll") && n.scrollHeight > n.clientHeight) return el.getBoundingClientRect().top - n.getBoundingClientRect().top;
      }
      return null;
    });
    expect(topGap).not.toBeNull();
    expect(topGap!).toBeGreaterThanOrEqual(0);
    await openSheetFromBubble(page, () => scrollContainerBy(1), "click");
    await expect(sheet(page).locator("[data-outline-item]")).toHaveText(LONG_HEADINGS);
    const id = await headingId(page, "Section D");
    await sheetItem(page, "Section D").click();
    await expect(sheet(page)).toBeHidden();
    const offset = () =>
      page.evaluate((id) => {
        const block = document.querySelector(`.bn-block-outer[data-id="${id}"]`)!;
        for (let n = block.parentElement; n; n = n.parentElement) {
          const o = getComputedStyle(n).overflowY;
          if ((o === "auto" || o === "scroll") && n.scrollHeight > n.clientHeight) return block.getBoundingClientRect().top - n.getBoundingClientRect().top;
        }
        return null;
      }, id);
    await expect.poll(offset, { timeout: 5_000, message: "標題頂端與捲動容器上緣的差（px）" }).toBeGreaterThanOrEqual(-2);
    await expect.poll(offset, { timeout: 5_000, message: "標題頂端與捲動容器上緣的差（px）" }).toBeLessThanOrEqual(60);
    // The ⋮ menu has the entry at this width as well.
    await moreButton(page).click();
    await expect(page.getByRole("menuitem", { name: "Heading outline" })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("60-13 the top edge of the lines and panel equals the first body line's top edge and doesn't move while scrolling; in a wide viewport the panel covers the lines", async ({ browser }) => {
  const { context, page } = await openNote(browser, notes.long);
  try {
    await expect(railLines(page)).toHaveCount(5, { timeout: 15_000 });
    const firstLineTop = () => page.evaluate(() => document.querySelector(".bn-block-content")!.getBoundingClientRect().top);
    const railTop = () => rail(page).evaluate((el) => el.getBoundingClientRect().top);
    await expect.poll(async () => Math.abs((await railTop()) - (await firstLineTop())), { timeout: 5_000, message: "細線上緣與第一行內文上緣的差（px）" }).toBeLessThanOrEqual(2);
    const before = await railTop();
    await page.evaluate(() => {
      const block = document.querySelector(".bn-block-content")!;
      for (let n = block.parentElement; n; n = n.parentElement) {
        const o = getComputedStyle(n).overflowY;
        if ((o === "auto" || o === "scroll") && n.scrollHeight > n.clientHeight) {
          n.scrollTop = 300;
          return;
        }
      }
    });
    await twoFrames(page);
    expect(await railTop()).toBe(before);
    await rail(page).hover();
    await expect(panel(page)).toBeVisible();
    const panelBox = (await panel(page).boundingBox())!;
    const railBox = (await rail(page).boundingBox())!;
    expect(Math.abs(panelBox.y - railBox.y)).toBeLessThanOrEqual(1);
    expect(panelBox.x).toBeLessThanOrEqual(railBox.x);
    expect(panelBox.x + panelBox.width).toBeGreaterThanOrEqual(railBox.x + railBox.width);
  } finally {
    await context.close();
  }
});
