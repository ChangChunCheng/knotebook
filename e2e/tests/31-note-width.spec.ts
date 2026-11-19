import { test, expect, type Locator, type Page } from "@playwright/test";
import { ADMIN, chooseSelectOption, clickByPointer, createNote, editorLocator, loginAs, randomEmail } from "./helpers.js";

/**
 * W = clientWidth of the column's parent (the scroll container, no padding): max-width percentages resolve against it; checking
 * the formula against the measured W means a scrollbar only changes W and does not affect the verdict.
 * E2: for viewports 640-1279 the sidebar floats over the note and takes no width, so the width button looks only at the header
 * content box and appears at exactly >= 696 px (`@min-[43.5rem]`); for viewports >= 1280 the sidebar is fixed on the left
 * (default and 320 px widths).
 * Each measurement prints a `MEASURE ...` line.
 */

const RUN_ID = Date.now();

/** Standard clamp(42.5rem,85%,66rem), wide clamp(42.5rem,92.5%,88rem), full width has no cap; then bounded by w-full to within W. */
const CLAMP = { standard: { ratio: 0.85, cap: 1056 }, wide: { ratio: 0.925, cap: 1408 } } as const;
type Mode = "standard" | "wide" | "full";
function expected(mode: Mode, W: number): number {
  if (mode === "full") return W;
  const { ratio, cap } = CLAMP[mode];
  return Math.min(W, Math.min(cap, Math.max(680, ratio * W)));
}

const MODE_LABEL: Record<Mode, string> = { standard: "Standard", wide: "Wide", full: "Full width" };
const CYCLE_LABEL: Record<Mode, string> = {
  standard: "Width: Standard — click for Wide",
  wide: "Width: Wide — click for Full width",
  full: "Width: Full width — click for Standard",
};
/** Threshold at which the header width button appears: header content box >= 43.5rem. */
const HEADER_EDGE = 696;

async function measureColumn(page: Page): Promise<{ col: number; W: number }> {
  return page.getByTestId("article-column").evaluate((el) => ({
    col: el.getBoundingClientRect().width,
    W: el.closest<HTMLElement>(".overflow-y-auto")!.clientWidth,
  }));
}

async function setViewport(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
}

async function loginAndCreateNote(page: Page, title: string, email: string = ADMIN.email, password: string = ADMIN.password): Promise<void> {
  await loginAs(page, email, password);
  await expect(page).toHaveURL(/\/$/);
  await createNote(page, title);
  const editor = editorLocator(page);
  await editor.click();
  await editor.pressSequentially("Width measurement paragraph.");
}

test("E1 in-app three widths: column width follows the formula, selection applies, and survives reload", async ({ page }) => {
  test.setTimeout(120_000);
  await loginAndCreateNote(page, `E2E note width E1 ${RUN_ID}`);
  await setViewport(page, 1920, 1000);
  const button = page.getByRole("button", { name: /^Width/ });
  await expect(button).toHaveAttribute("aria-label", CYCLE_LABEL.standard);

  const seenW: number[] = [];
  for (const mode of ["standard", "wide", "full"] as const) {
    await setViewport(page, 1920, 1000);
    if (mode !== "standard") await button.click();
    await expect(button).toHaveAttribute("aria-label", CYCLE_LABEL[mode]);
    for (const vw of [1920, 1440, 1280, 1200, 900, 700, 640]) {
      await setViewport(page, vw, 1000);
      const { col, W } = await measureColumn(page);
      const want = expected(mode, W);
      seenW.push(W);
      console.log(`MEASURE E1 mode=${mode} vw=${vw} W=${W} col=${col.toFixed(2)} expected=${want.toFixed(2)}`);
      expect(Math.abs(col - want), `E1 ${mode} vw=${vw} W=${W}`).toBeLessThanOrEqual(1);
    }
  }
  // The viewport list must cover both ends: W >= 1523 (all three reach their caps / full width) and W < 680 (all three = W).
  expect(Math.max(...seenW)).toBeGreaterThanOrEqual(1523);
  expect(Math.min(...seenW)).toBeLessThan(680);

  await setViewport(page, 1920, 1000);
  await page.reload();
  await expect(page.getByRole("button", { name: /^Width/ })).toHaveAttribute("aria-label", CYCLE_LABEL.full);
  const after = await measureColumn(page);
  console.log(`MEASURE E1 reload vw=1920 W=${after.W} col=${after.col.toFixed(2)}`);
  expect(Math.abs(after.col - after.W)).toBeLessThanOrEqual(1);
});

test("E4 Width submenu of the more menu: choosing Wide / Full width, column width follows the formula and the width button's name changes", async ({ page }) => {
  test.setTimeout(90_000);
  await loginAndCreateNote(page, `E2E note width E4 ${RUN_ID}`);
  await setViewport(page, 1440, 1000);
  const button = page.getByRole("button", { name: /^Width/ });
  await expect(button).toHaveAttribute("aria-label", CYCLE_LABEL.standard);
  for (const mode of ["wide", "full", "standard"] as const) {
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "Width", exact: true }).click();
    await clickByPointer(page, page.getByRole("menuitemradio", { name: MODE_LABEL[mode], exact: true }));
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(button).toHaveAttribute("aria-label", CYCLE_LABEL[mode]);
    const { col, W } = await measureColumn(page);
    console.log(`MEASURE E4 mode=${mode} vw=1440 W=${W} col=${col.toFixed(2)} expected=${expected(mode, W).toFixed(2)}`);
    expect(Math.abs(col - expected(mode, W)), `E4 ${mode} W=${W}`).toBeLessThanOrEqual(1);
  }
});

type HeaderMeasure = { contentW: number; clientW: number; scrollW: number; right: number; moreRight: number; visible: boolean };

async function measureHeader(header: Locator, widthButton: Locator, more: Locator): Promise<HeaderMeasure> {
  const box = await header.evaluate((h) => {
    const cs = getComputedStyle(h);
    const r = h.getBoundingClientRect();
    const inline = (a: string, b: string) => parseFloat(a) + parseFloat(b);
    return {
      contentW: r.width - inline(cs.paddingLeft, cs.paddingRight) - inline(cs.borderLeftWidth, cs.borderRightWidth),
      clientW: h.clientWidth,
      scrollW: h.scrollWidth,
      right: r.right,
    };
  });
  const moreBox = (await more.boundingBox())!;
  return { ...box, moreRight: moreBox.x + moreBox.width, visible: await widthButton.isVisible() };
}

test("E2 header not clipped: floating range (640-1279) and fixed range (>= 1280) x English/Chinese; the width button appears exactly when content box >= 696", async ({ page }) => {
  test.setTimeout(180_000);
  await loginAndCreateNote(page, `E2E note width E2 ${RUN_ID}`);
  // Wait for "last edited" to show, so the header is at its most crowded.
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId("last-edited")).toBeVisible();
  }).toPass({ timeout: 20_000 });

  for (const lang of ["en", "zh-TW"] as const) {
    for (const sidebar of [null, 320] as const) {
      await setViewport(page, 1280, 900);
      await page.evaluate(
        ([l, s]) => {
          if (l === "en") window.localStorage.removeItem("knotebook:lang");
          else window.localStorage.setItem("knotebook:lang", l);
          if (s === null) window.localStorage.removeItem("sidebar.width");
          else window.localStorage.setItem("sidebar.width", String(s));
        },
        [lang, sidebar] as const,
      );
      await page.reload();
      const widthName = lang === "en" ? /^Width/ : /^寬度/;
      const moreName = lang === "en" ? "More" : "更多";
      const header = page.locator("header").filter({ has: page.getByRole("button", { name: widthName, includeHidden: true }) });
      const widthButton = header.getByRole("button", { name: widthName, includeHidden: true });
      const more = header.getByRole("button", { name: moreName, exact: true });
      await expect(more).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId("last-edited")).toBeVisible();
      const tag = `lang=${lang} sidebar=${sidebar ?? "default"}`;

      const check = async (vw: number): Promise<HeaderMeasure> => {
        await setViewport(page, vw, 900);
        const m = await measureHeader(header, widthButton, more);
        console.log(
          `MEASURE E2 ${tag} vw=${vw} contentW=${m.contentW} clientW=${m.clientW} scrollW=${m.scrollW} ` +
            `headerRight=${m.right.toFixed(2)} moreRight=${m.moreRight.toFixed(2)} widthButton=${m.visible ? "visible" : "hidden"}`,
        );
        expect(m.scrollW, `${tag} vw=${vw}：頁首有橫向溢出`).toBeLessThanOrEqual(m.clientW);
        expect(m.moreRight, `${tag} vw=${vw}：⋮ 超出頁首右緣`).toBeLessThanOrEqual(m.right + 0.5);
        expect(m.visible, `${tag} vw=${vw} contentW=${m.contentW}`).toBe(m.contentW >= HEADER_EDGE);
        return m;
      };

      for (const vw of [1280, 1440]) await check(vw);

      // Floating range: the sidebar takes no width, so the content box ~ viewport - 66 and the width button looks only at it.
      const narrow = await check(640);
      expect(narrow.visible, `${tag}：640 時寬度鈕要隱藏`).toBe(false);
      const wide = await check(1279);
      expect(wide.visible, `${tag}: width button must be visible at 1279`).toBe(true);

      let lo = 640;
      let hi = 1279;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        await setViewport(page, mid, 900);
        if (await widthButton.isVisible()) hi = mid;
        else lo = mid;
      }
      const edge = await check(hi);
      const below = await check(hi - 1);
      const predicted = 1279 - (wide.contentW - HEADER_EDGE);
      console.log(`MEASURE E2 ${tag} edgeVw=${hi} predictedVw=${predicted} contentW@edge=${edge.contentW} contentW@edge-1=${below.contentW}`);
      expect(edge.visible).toBe(true);
      expect(below.visible).toBe(false);
      expect(edge.contentW).toBeGreaterThanOrEqual(HEADER_EDGE);
      expect(edge.contentW).toBeLessThan(HEADER_EDGE + 1);
      if (Number.isInteger(wide.contentW)) expect(hi).toBe(predicted);
    }
  }
});

test("E3 public page: full width set in the share dialog -> an anonymous reader sees a W-wide column, and the in-app width is unaffected", async ({ browser, request }) => {
  test.setTimeout(120_000);
  const ownerContext = await browser.newContext();
  const anonContext = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  try {
    const owner = await ownerContext.newPage();
    // Use a newly registered account as owner: PUT/DELETE of the public-link allow 10 per user per 10 minutes (PUBLIC_LINK_LIMIT);
    // by this point of a serial run admin has used up its quota in 11 / 16 / 18 / 22 / 27, and opening another public link would get a 429.
    const email = randomEmail();
    const password = "e2e-note-width-pw";
    expect((await request.post("/api/auth/register", { data: { email, password } })).status()).toBe(201);
    await loginAndCreateNote(owner, `E2E note width E3 ${RUN_ID}`, email, password);

    await owner.getByRole("button", { name: "Share", exact: true }).click();
    const dialog = owner.getByRole("dialog", { name: "Share note" });
    await expect(dialog).toBeVisible();
    const publicRadio = dialog.getByRole("radio", { name: /^Public link/ });
    await expect(publicRadio).toBeEnabled();
    const publish = owner.waitForResponse((res) => res.url().endsWith("/public-link") && res.request().method() === "PUT");
    await publicRadio.check();
    expect((await publish).status()).toBe(200);
    const tokenInput = dialog.getByLabel("Public link URL");
    await expect(tokenInput).toBeVisible();
    const token = await tokenInput.inputValue();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const widthSelect = dialog.getByLabel("Public page width");
    await expect(widthSelect).toHaveAttribute("data-value", "standard");

    const anon = await anonContext.newPage();
    // Content flush is asynchronous (collab 2 s debounce): reload until the body text is seen.
    await expect(async () => {
      await anon.goto(`/p/${token}`);
      await expect(anon.getByText("Width measurement paragraph.")).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    const before = await measureColumn(anon);
    console.log(`MEASURE E3 public=standard vw=1600 W=${before.W} col=${before.col.toFixed(2)} expected=${expected("standard", before.W).toFixed(2)}`);
    expect(Math.abs(before.col - expected("standard", before.W))).toBeLessThanOrEqual(1);

    const put = owner.waitForResponse((res) => res.url().endsWith("/public-width") && res.request().method() === "PUT");
    await chooseSelectOption(owner, widthSelect, "Full width");
    expect((await put).status()).toBe(200);
    await expect(widthSelect).toHaveAttribute("data-value", "full");

    await anon.reload();
    await expect(anon.getByText("Width measurement paragraph.")).toBeVisible({ timeout: 15_000 });
    const after = await measureColumn(anon);
    console.log(`MEASURE E3 public=full vw=1600 W=${after.W} col=${after.col.toFixed(2)}`);
    expect(Math.abs(after.col - after.W)).toBeLessThanOrEqual(1);
    expect(after.col).toBeGreaterThan(1056 + 1);

    // The in-app width is a preference of the owner's own browser and does not follow the public page.
    await owner.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(owner.getByRole("button", { name: /^Width/ })).toHaveAttribute("aria-label", CYCLE_LABEL.standard);
  } finally {
    await anonContext.close();
    await ownerContext.close();
  }
});
