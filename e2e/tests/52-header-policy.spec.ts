import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { ADMIN, clickByPointer, createNote, createUserViaInvite, editorLocator, loginAs, noteIdFromUrl, randomEmail } from "./helpers.js";

/**
 * Trade-offs of the note page header at each viewport width (real-browser measurement; six users online at once = the most crowded header):
 * - The right edges of the star (Favorite), share, width button (when visible) and kebab do not exceed the header's content box, nor the card's inner edge (nearest ancestor with overflow:hidden).
 * - Viewport < 640: the online list is a single "5 more, show everyone" with no avatars; at >= 640 there is no such button.
 * - "Last edited" and the connection text are screen-reader-only (sr-only) when the viewport is < 640 or the header's content box is < 36rem (576 px); the connection dot stays visible.
 *   640-767 is the range where the text starts to show: binary search finds the boundary and one measurement is taken on each side (about 641/642).
 * - The star collapses when the header's content box is < 18rem (288 px); the width button appears when the content box is >= 43.5rem (696 px).
 * - 1440: pressing the width button three times cycles Standard -> Wide -> Full width -> Standard, the name carrying the next one; kebab -> Width is a Radix submenu.
 * - 390 (hasTouch): kebab -> Width expands its three options in place, choosing one keeps the menu open, and Esc first collapses then closes.
 * - Viewport 640-1279: the sidebar and the version panel both float over the note and take no width, so the header's content box = viewport width - 66 (page and card padding); with the panel open the header does not narrow and the panel's top
 *   edge sits at the header's bottom edge (frame lines overlap within 1 px). Viewport 1280 with the default sidebar width plus the panel: the two sit side by side, and the content box is still enough for share and kebab without clipping.
 * Each measurement prints a `MEASURE ...` line; failure messages carry each button's bounding box and the right edges of the two boundaries.
 */

const RUN = Date.now();
const PASSWORD = "e2e-header-policy-pw";
const OTHERS = ["bob", "carol", "dave", "erin", "frank"] as const;
const OTHERS_LABEL = "5 more, show everyone";
/** Header content box thresholds (px): text 36rem, star 18rem, width button 43.5rem. */
const TEXT_EDGE = 576;
const STAR_EDGE = 288;
const WIDTH_EDGE = 696;
const TOLERANCE = 0.5;
/** At viewport 640-1279 (sidebar and version panel both floating) the difference between viewport width and header content box: page and card padding and frame lines. */
const FLOATING_CHROME = 66;
const CYCLE = {
  standard: "Width: Standard — click for Wide",
  wide: "Width: Wide — click for Full width",
  full: "Width: Full width — click for Standard",
} as const;

interface Account {
  email: string;
  displayName: string;
}

const accountOf = (name: string): Account => ({ email: randomEmail(), displayName: `${name} ${RUN}` });

const contexts: BrowserContext[] = [];
let desktop: Page;
let touch: Page;

const headerOf = (page: Page): Locator => page.locator("header").filter({ has: page.getByRole("button", { name: "More", exact: true }) }).first();
const presenceOf = (page: Page): Locator => page.getByRole("group", { name: "Also viewing this note" });
const buttonIn = (header: Locator, name: string): Locator => header.getByRole("button", { name, exact: true });
const widthButtonIn = (header: Locator): Locator => header.getByRole("button", { name: /^Width:/ });

async function waitForNoteTitle(page: Page, title: string): Promise<void> {
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue(title, { timeout: 15_000 });
}

async function openAs(browser: Browser, account: Account, options?: Parameters<Browser["newContext"]>[0]): Promise<Page> {
  const context = await browser.newContext(options);
  contexts.push(context);
  const page = await context.newPage();
  await loginAs(page, account.email, PASSWORD);
  return page;
}

/** After changing the viewport width, wait until the header width is unchanged for 3 consecutive frames before measuring (layout settles over several frames after a resize; measuring at once would catch an intermediate value). */
async function setViewport(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await headerOf(page).evaluate(
    (h) =>
      new Promise<void>((resolve) => {
        let last = -1;
        let same = 0;
        let frames = 0;
        const tick = () => {
          const w = h.getBoundingClientRect().width;
          same = w === last ? same + 1 : 0;
          last = w;
          frames += 1;
          if (same >= 3 || frames > 120) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
}

interface Frame {
  contentRight: number;
  cardRight: number | null;
  contentW: number;
  scrollW: number;
  clientW: number;
  innerWidth: number;
}

/** Right edge and width of the header content box, right edge of the content card (parent of the header slot `[data-note-header-slot]`), and horizontal overflow. */
async function frameOf(header: Locator): Promise<Frame> {
  return header.evaluate((h) => {
    const style = getComputedStyle(h);
    const r = h.getBoundingClientRect();
    const px = (v: string) => parseFloat(v) || 0;
    // The content card is the parent of the header slot (from 640 up it has overflow hidden and clips overflow; on a phone the document scrolls and the card doesn't clip, but the header is still inside the card).
    const card: Element | null = h.closest("[data-note-header-slot]")?.parentElement ?? null;
    return {
      contentRight: r.right - px(style.paddingRight) - px(style.borderRightWidth),
      cardRight: card ? card.getBoundingClientRect().right : null,
      contentW: r.width - px(style.paddingLeft) - px(style.paddingRight) - px(style.borderLeftWidth) - px(style.borderRightWidth),
      scrollW: h.scrollWidth,
      clientW: h.clientWidth,
      innerWidth: window.innerWidth,
    };
  });
}

async function isSrOnly(el: Locator): Promise<boolean> {
  const box = await el.boundingBox();
  return box !== null && box.width <= 1 && box.height <= 1;
}

interface Policy {
  /** Expected star visibility; omitted = derived from content box >= 288. */
  star?: boolean;
}

/**
 * Measures the header at one viewport width and asserts the trade-offs. `phone` = viewport < 640. On failure the message carries each button's box and the two boundaries.
 */
async function checkHeader(page: Page, tag: string, vw: number, policy: Policy = {}): Promise<Frame> {
  const header = headerOf(page);
  await expect(buttonIn(header, "More")).toBeVisible();
  const frame = await frameOf(header);
  const phone = vw < 640;
  const star = buttonIn(header, "Favorite");
  const share = buttonIn(header, "Share");
  const more = buttonIn(header, "More");
  const width = widthButtonIn(header);

  const boxes: Record<string, { x: number; y: number; width: number; height: number } | null> = {};
  for (const [name, button] of [["Favorite", star], ["Share", share], ["Width", width], ["More", more]] as const) {
    boxes[name] = (await button.isVisible()) ? await button.boundingBox() : null;
  }
  const detail = JSON.stringify({ tag, vw, contentW: frame.contentW, contentRight: frame.contentRight, cardRight: frame.cardRight, boxes });
  console.log(`MEASURE ${tag} vw=${vw} innerWidth=${frame.innerWidth} contentW=${frame.contentW.toFixed(2)} contentRight=${frame.contentRight.toFixed(2)} cardRight=${frame.cardRight?.toFixed(2)} ${JSON.stringify(boxes)}`);

  expect(frame.cardRight, `沒有找到內文卡 ${detail}`).not.toBeNull();
  if (vw >= 640 && vw < 1280) expect(Math.abs(frame.contentW - (vw - FLOATING_CHROME)), `浮動段 content box 應為視窗寬 − ${FLOATING_CHROME} ${detail}`).toBeLessThanOrEqual(1);
  expect(frame.scrollW, `頁首有橫向溢出 ${detail}`).toBeLessThanOrEqual(frame.clientW);
  for (const [name, box] of Object.entries(boxes)) {
    if (box === null) continue;
    const right = box.x + box.width;
    expect(right, `${name} 超出頁首 content box ${detail}`).toBeLessThanOrEqual(frame.contentRight + TOLERANCE);
    expect(right, `${name} 被卡片裁掉 ${detail}`).toBeLessThanOrEqual(frame.cardRight! + TOLERANCE);
  }
  expect(boxes.Share, `分享鈕不見 ${detail}`).not.toBeNull();
  expect(boxes.More, `⋮ 不見 ${detail}`).not.toBeNull();
  expect(boxes.Favorite !== null, `星號可見性（content box ${frame.contentW}，門檻 ${STAR_EDGE}）${detail}`).toBe(policy.star ?? frame.contentW >= STAR_EDGE);
  expect(boxes.Width !== null, `寬度鈕可見性（content box ${frame.contentW}，門檻 ${WIDTH_EDGE}）${detail}`).toBe(frame.contentW >= WIDTH_EDGE);

  const group = presenceOf(page);
  const compact = group.getByRole("button", { name: OTHERS_LABEL, exact: true });
  if (phone) {
    await expect(compact, `手機寬在線者只該有一顆「+N」 ${detail}`).toHaveCount(1);
    await expect(group.getByRole("button"), `手機寬不該有頭像 ${detail}`).toHaveCount(1);
  } else {
    await expect(compact, `≥ 640 不該出現精簡的「+N」 ${detail}`).toHaveCount(0);
    expect(await group.getByRole("button").count(), `≥ 640 要有頭像 ${detail}`).toBeGreaterThan(1);
  }

  const textHidden = phone || frame.contentW < TEXT_EDGE;
  const lastEdited = page.getByTestId("last-edited");
  const status = page.getByRole("status").filter({ hasText: /^Connected/ });
  const statusText = status.locator("span").last();
  expect(await isSrOnly(lastEdited), `「最後編輯」sr-only 與否（content box ${frame.contentW}，門檻 ${TEXT_EDGE}）${detail}`).toBe(textHidden);
  expect(await isSrOnly(statusText), `連線文字 sr-only 與否（content box ${frame.contentW}，門檻 ${TEXT_EDGE}）${detail}`).toBe(textHidden);
  const dot = (await status.locator("span[aria-hidden]").first().boundingBox())!;
  expect(dot.width, `連線點要看得見 ${detail}`).toBeGreaterThan(0);
  return frame;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  const alice = accountOf("alice");
  const others = OTHERS.map((name) => accountOf(name));
  const adminContext = await browser.newContext();
  try {
    const admin = await adminContext.newPage();
    await loginAs(admin, ADMIN.email, ADMIN.password);
    for (const account of [alice, ...others]) await createUserViaInvite(admin, { ...account, password: PASSWORD });
  } finally {
    await adminContext.close();
  }

  desktop = await openAs(browser, alice, { viewport: { width: 1440, height: 900 } });
  const title = `E2E header policy ${RUN}`;
  await createNote(desktop, title);
  const noteUrl = desktop.url();
  const noteId = await noteIdFromUrl(desktop);
  const editor = editorLocator(desktop);
  await editor.click();
  await editor.pressSequentially("Header policy paragraph.");

  for (const account of others) {
    const shared = await desktop.request.put(`/api/notes/${noteId}/shares`, { data: { email: account.email, role: "editor" } });
    expect(shared.status(), await shared.text()).toBe(200);
    const page = await openAs(browser, account, { viewport: { width: 1280, height: 800 } });
    await page.goto(noteUrl);
    await waitForNoteTitle(page, title);
    await expect(page.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible({ timeout: 15_000 });
  }

  // "Last edited" must appear (the header is most crowded): reload until it is seen.
  await expect(async () => {
    await desktop.reload();
    await waitForNoteTitle(desktop, title);
    await expect(desktop.getByTestId("last-edited")).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  await expect(presenceOf(desktop).getByRole("button")).toHaveCount(5, { timeout: 20_000 }); // 5 avatars (exactly fills the wide form's capacity)

  touch = await openAs(browser, alice, { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await touch.goto(noteUrl);
  await waitForNoteTitle(touch, title);
  await expect(presenceOf(touch).getByRole("button", { name: OTHERS_LABEL, exact: true })).toHaveCount(1, { timeout: 20_000 });
});

test.afterAll(async () => {
  for (const context of contexts) await context.close();
});

test("C1 each viewport width: buttons do not exceed the header or card, a phone shows a single \"+N\", text and star collapse by threshold", async () => {
  test.setTimeout(120_000);
  for (const [vw, vh] of [[320, 640], [360, 800], [768, 900], [1024, 900], [1440, 900]] as const) {
    await setViewport(desktop, vw, vh);
    await checkHeader(desktop, "C1", vw);
  }
  await setViewport(desktop, 320, 640);
  await expect(buttonIn(headerOf(desktop), "Favorite")).toBeHidden();
  await checkHeader(touch, "C1-touch", 390);
});

test("C2 with the version panel open: at 640-1279 the panel floats over the note and the header neither narrows nor is covered; at 1280 the default sidebar sits side by side and the header still doesn't overflow", async () => {
  test.setTimeout(90_000);
  const header = headerOf(desktop);
  for (const vw of [768, 1024]) {
    await setViewport(desktop, vw, 900);
    const before = await frameOf(header);
    await desktop.getByTestId("versions-bubble").click();
    const panel = desktop.getByTestId("versions-panel");
    await expect(panel).toBeVisible();
    const after = await checkHeader(desktop, "C2-floating", vw);
    expect(Math.abs(after.contentW - before.contentW), `面板開著頁首寬度不變（開前 ${before.contentW}）`).toBeLessThanOrEqual(1);
    // Top edge: within 1 px above the header's bottom edge (the panel's top frame overlaps the header's bottom frame line); the header's share and kebab are not under the panel.
    const headerBox = (await header.boundingBox())!;
    const panelBox = (await panel.boundingBox())!;
    expect(panelBox.y, `面板上緣 ${panelBox.y} 應 ≥ 頁首下緣 ${headerBox.y + headerBox.height} − 1`).toBeGreaterThanOrEqual(headerBox.y + headerBox.height - 1);
    await desktop.getByRole("button", { name: "Close version history", exact: true }).click();
    await expect(panel).toBeHidden();
  }

  // Fixed range: sidebar and panel side by side (this spec never set sidebar.width, so the sidebar has its default width).
  await setViewport(desktop, 1280, 900);
  await desktop.getByTestId("versions-bubble").click();
  await expect(desktop.getByTestId("versions-panel")).toBeVisible();
  const docked = await checkHeader(desktop, "C2-docked", 1280);
  console.log(`MEASURE C2 docked contentW=${docked.contentW}`);
  await desktop.getByRole("button", { name: "Close version history", exact: true }).click();
  await expect(desktop.getByTestId("versions-panel")).toBeHidden();
  await setViewport(desktop, 1440, 900);
});

test("C3 640-767: measure one point on each side of the boundary (about 641/642) where the text starts to show", async () => {
  test.setTimeout(120_000);
  const lastEdited = desktop.getByTestId("last-edited");
  for (const vw of [640, 641, 642, 700, 767]) {
    await setViewport(desktop, vw, 900);
    await checkHeader(desktop, "C3", vw);
  }
  await setViewport(desktop, 640, 900);
  expect(await isSrOnly(lastEdited), "640 時 content box 應在 36rem 以下").toBe(true);
  await setViewport(desktop, 767, 900);
  expect(await isSrOnly(lastEdited), "767 時 content box 應在 36rem 以上").toBe(false);
  let lo = 640;
  let hi = 767;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    await setViewport(desktop, mid, 900);
    if (await isSrOnly(lastEdited)) lo = mid;
    else hi = mid;
  }
  await setViewport(desktop, hi, 900);
  const edge = await checkHeader(desktop, "C3-edge", hi);
  await setViewport(desktop, hi - 1, 900);
  const below = await checkHeader(desktop, "C3-edge-1", hi - 1);
  console.log(`MEASURE C3 edgeVw=${hi} contentW@edge=${edge.contentW} contentW@edge-1=${below.contentW}`);
  expect(edge.contentW).toBeGreaterThanOrEqual(TEXT_EDGE);
  expect(below.contentW).toBeLessThan(TEXT_EDGE);
  expect(hi, "邊界應落在 641–642 附近").toBeLessThanOrEqual(643);
  expect(hi).toBeGreaterThanOrEqual(641);
});

test("C4 1440 width button: three presses cycle; kebab -> Width submenu switches back to Standard", async () => {
  test.setTimeout(90_000);
  await setViewport(desktop, 1440, 900);
  const header = headerOf(desktop);
  const toggle = widthButtonIn(header);
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-label", CYCLE.standard);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-label", CYCLE.wide);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-label", CYCLE.full);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-label", CYCLE.standard);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-label", CYCLE.wide);

  await buttonIn(header, "More").click();
  await desktop.getByRole("menuitem", { name: "Width", exact: true }).click();
  await clickByPointer(desktop, desktop.getByRole("menuitemradio", { name: "Standard", exact: true }));
  await expect(desktop.getByRole("menu")).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-label", CYCLE.standard);
});

test("C5 touch: the kebab at 390 has no Width; at 700 kebab -> Width expands in place, choosing one keeps the menu open, and Esc first collapses then closes", async () => {
  test.setTimeout(90_000);
  const header = headerOf(touch);
  await expect(widthButtonIn(header)).toHaveCount(0);
  await buttonIn(header, "More").click();
  await expect(touch.getByRole("menu")).toHaveCount(1);
  await expect(touch.getByRole("menuitem", { name: "Width", exact: true })).toHaveCount(0);
  await touch.keyboard.press("Escape");
  await expect(touch.getByRole("menu")).toHaveCount(0);
  // Width exists only from 640 up (touch devices in the floating range, e.g. a tablet held upright).
  await touch.setViewportSize({ width: 700, height: 844 });
  await buttonIn(header, "More").click();
  const menu = touch.getByRole("menu");
  await expect(menu).toHaveCount(1);
  const trigger = menu.getByRole("menuitem", { name: "Width", exact: true });
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(menu, "窄形不開第二層選單").toHaveCount(1);
  await expect(menu.getByRole("menuitemradio")).toHaveCount(3);
  await expect(menu.getByRole("menuitemradio", { name: "Standard", exact: true })).toHaveAttribute("aria-checked", "true");
  await menu.getByRole("menuitemradio", { name: "Wide", exact: true }).click();
  await expect(menu, "選了選單不關").toHaveCount(1);
  await expect(menu.getByRole("menuitemradio", { name: "Wide", exact: true })).toHaveAttribute("aria-checked", "true");
  await touch.keyboard.press("Escape");
  await expect(menu.getByRole("menuitemradio")).toHaveCount(0);
  await expect(menu).toHaveCount(1);
  await touch.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  // Open again: the choice is remembered; restore Standard so later tests are not affected.
  await buttonIn(header, "More").click();
  await menu.getByRole("menuitem", { name: "Width", exact: true }).click();
  await expect(menu.getByRole("menuitemradio", { name: "Wide", exact: true })).toHaveAttribute("aria-checked", "true");
  await menu.getByRole("menuitemradio", { name: "Standard", exact: true }).click();
  await touch.keyboard.press("Escape");
  await touch.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await touch.setViewportSize({ width: 390, height: 844 });
});
