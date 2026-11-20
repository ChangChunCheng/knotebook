import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { E2E_ORIGIN } from "../ports.js";
import { ADMIN, clickEndOfParagraph, createUserViaInvite, editorLocator, loginAs, randomEmail } from "./helpers.js";

/**
 * The track of the phone outline bubble: the bubble moves along a track at the right edge and its position on the track is the scroll position; tapping it opens the bottom panel.
 * All in touch 390x844 except 63-4 (700x900, mouse); every case opens a new context.
 *
 * Account and data: one account (alice) is created through an invite and the read-only notes are created once in beforeAll via the API (including one with a public link).
 */

test.use({ actionTimeout: 15_000 });

const RUN = Date.now();
const PASSWORD = "e2e-outline-track-pw";
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

let alice: { email: string; displayName: string };
const notes = { long: "", publicToken: "" };

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
    notes.long = (await createNoteVia(page, `Track long ${RUN}`, LONG_MD)).path;
    const published = await createNoteVia(page, `Track public ${RUN}`, LONG_MD);
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
}

async function newContext(browser: Browser, options: ContextOptions = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(options.phone ? { hasTouch: true, isMobile: true, viewport: PHONE } : { viewport: options.viewport ?? VIEWPORT });
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem("sidebar.width", "320");
    } catch {
      // When localStorage can't be read, run with the default width.
    }
  });
  return { context, page: await context.newPage() };
}

async function openNote(browser: Browser, path: string, options: ContextOptions = {}): Promise<{ context: BrowserContext; page: Page }> {
  const { context, page } = await newContext(browser, options);
  await loginAs(page, alice.email, PASSWORD);
  await expect(page).toHaveURL(/\/$/);
  await page.goto(path);
  await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible({ timeout: 15_000 });
  return { context, page };
}

const sheet = (page: Page): Locator => page.getByRole("dialog", { name: "Heading outline" });
const chipOf = (page: Page): Locator => page.getByRole("button", { name: /^Open heading outline: / });
const trackOf = (page: Page): Locator => page.getByTestId("outline-bubble-track");
const moreButton = (page: Page): Locator => page.getByRole("button", { name: "More", exact: true });
const headingText = (page: Page, text: string): Locator => page.locator('[data-content-type="heading"]').filter({ hasText: new RegExp(`^${text}$`) });
const scrollerOf = (page: Page): Locator => page.getByTestId("article-column").locator("xpath=ancestor::div[contains(@class,'overflow-y-auto')][1]");

const scrollWindowTo = (page: Page, y: number) => page.evaluate((y) => window.scrollTo(0, y), y);
const windowMax = (page: Page) => page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);

interface Place {
  chipTop: number;
  chipBottom: number;
  trackTop: number;
  trackHeight: number;
}

/**
 * Scrolls to `y` (alternating by 1 px so a scroll event is certain) and measures once while the bubble is present. The bubble disappears 1.5 seconds after scrolling stops and on a slow machine may already be gone: the whole step is retried.
 */
async function measureAt(page: Page, scrollTo: (y: number) => Promise<unknown>, y: number, check: (m: Place) => Promise<void> | void): Promise<void> {
  let attempt = 0;
  await expect(async () => {
    await scrollTo(y + (attempt++ % 2 === 0 ? 0 : y === 0 ? 1 : -1));
    await expect(chipOf(page)).toBeVisible({ timeout: 1_000 });
    const chip = (await chipOf(page).boundingBox())!;
    const track = (await trackOf(page).boundingBox())!;
    await check({ chipTop: chip.y, chipBottom: chip.y + chip.height, trackTop: track.y, trackHeight: track.height });
  }).toPass({ timeout: 15_000 });
}

async function expectFollowsScroll(page: Page, scrollTo: (y: number) => Promise<unknown>, max: number): Promise<void> {
  await measureAt(page, scrollTo, 1, (m) => {
    expect(Math.abs(m.chipTop - m.trackTop), "捲到最上：泡泡貼著軌道上端").toBeLessThanOrEqual(2);
  });
  await measureAt(page, scrollTo, Math.round(max / 2), (m) => {
    expect(Math.abs(m.chipTop - m.trackTop - 0.5 * (m.trackHeight - 36)), "捲到一半：泡泡在軌道正中").toBeLessThanOrEqual(2);
  });
  await measureAt(page, scrollTo, max, (m) => {
    expect(Math.abs(m.chipBottom - (m.trackTop + m.trackHeight)), "捲到底：泡泡貼著軌道下端").toBeLessThanOrEqual(2);
  });
}

test("63-1 phone tap: tapping the bubble opens the bottom panel", async ({ browser }) => {
  const { context, page } = await openNote(browser, notes.long, { phone: true });
  try {
    await expect(headingText(page, "Section D")).toBeAttached({ timeout: 15_000 });
    let attempt = 0;
    await expect(async () => {
      if (await sheet(page).isVisible()) return;
      await scrollWindowTo(page, 300 + (attempt++ % 2));
      await chipOf(page).tap({ timeout: 1_000 });
      await expect(sheet(page)).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
  } finally {
    await context.close();
  }
});

test("63-2 phone while editing: the track is between the editing toolbar and the header", async ({ browser }) => {
  const { context, page } = await openNote(browser, notes.long, { phone: true });
  try {
    await expect(headingText(page, "Section D")).toBeAttached({ timeout: 15_000 });
    await clickEndOfParagraph(page, editorLocator(page).locator('[data-content-type="paragraph"]').filter({ hasText: /^intro filler paragraph 0$/ }));
    const toolbar = page.locator("[data-mobile-edit-toolbar]");
    await expect(toolbar).toBeVisible();

    await measureAt(page, (y) => scrollWindowTo(page, y), 1, async (m) => {
      const header = (await page.locator("[data-note-header-slot]").boundingBox())!;
      expect(Math.abs(m.chipTop - m.trackTop), "捲到最上：泡泡貼著軌道上端").toBeLessThanOrEqual(2);
      expect(m.chipTop, "泡泡上緣不高過頁首下緣").toBeGreaterThanOrEqual(header.y + header.height);
    });
    await measureAt(page, (y) => scrollWindowTo(page, y), await windowMax(page), async (m) => {
      const capsule = (await toolbar.locator(":scope > *").first().boundingBox())!;
      expect(Math.abs(m.chipBottom - (m.trackTop + m.trackHeight)), "捲到底：泡泡貼著軌道下端").toBeLessThanOrEqual(2);
      expect(m.chipBottom, "泡泡下緣不超過編輯工具列上緣").toBeLessThanOrEqual(capsule.y);
    });
  } finally {
    await context.close();
  }
});

test("63-3 phone position: the bubble's position on the track is the scroll position, and at the bottom it doesn't overlap the New note button", async ({ browser }) => {
  const { context, page } = await openNote(browser, notes.long, { phone: true });
  try {
    await expect(headingText(page, "Section D")).toBeAttached({ timeout: 15_000 });
    const max = await windowMax(page);
    const scrollTo = (y: number) => scrollWindowTo(page, y);
    await expectFollowsScroll(page, scrollTo, max);
    const newNote = page.getByTestId("note-browse-bar").getByRole("button", { name: "New note", exact: true });
    await measureAt(page, scrollTo, max, async () => {
      const button = (await newNote.boundingBox())!;
      const chip = (await chipOf(page).boundingBox())!;
      const overlaps = chip.x < button.x + button.width && chip.x + chip.width > button.x && chip.y < button.y + button.height && chip.y + chip.height > button.y;
      expect(overlaps, "泡泡不壓到 New note 鈕").toBe(false);
    });
  } finally {
    await context.close();
  }
});

test("63-4 700 wide (640-767): the scroll container's position is the bubble's position on the track; the track is above the Version history button", async ({ browser }) => {
  const { context, page } = await openNote(browser, notes.long, { viewport: { width: 700, height: 900 } });
  try {
    await expect(headingText(page, "Section D")).toBeAttached({ timeout: 15_000 });
    const scroller = scrollerOf(page);
    const max = await scroller.evaluate((el) => el.scrollHeight - el.clientHeight);
    const scrollTo = (y: number) => scroller.evaluate((el, top) => (el.scrollTop = top), y);
    await expectFollowsScroll(page, scrollTo, max);
    await measureAt(page, scrollTo, max, async () => {
      const chip = (await chipOf(page).boundingBox())!;
      const history = (await page.getByRole("button", { name: "Version history" }).boundingBox())!;
      expect(chip.y + chip.height, "泡泡下緣不超過 Version history 鈕上緣").toBeLessThanOrEqual(history.y);
    });
  } finally {
    await context.close();
  }
});

test("63-5 public page on a phone (logged out): the scroll container's position is the bubble's position on the track; the page has no kebab", async ({ browser }) => {
  const { context, page } = await newContext(browser, { phone: true });
  try {
    await page.goto(`/p/${notes.publicToken}`);
    await expect(page.locator('[data-testid="public-note-editor"]')).toBeVisible({ timeout: 15_000 });
    await expect(headingText(page, "Section D")).toBeAttached({ timeout: 15_000 });
    await expect(moreButton(page)).toHaveCount(0);
    const scroller = scrollerOf(page);
    const max = await scroller.evaluate((el) => el.scrollHeight - el.clientHeight);
    await expectFollowsScroll(page, (y) => scroller.evaluate((el, top) => (el.scrollTop = top), y), max);
  } finally {
    await context.close();
  }
});
