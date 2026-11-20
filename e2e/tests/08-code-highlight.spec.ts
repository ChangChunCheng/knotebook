import { expect, test } from "@playwright/test";
import { ADMIN, createNote, editorLocator, loginAs } from "./helpers.js";

/**
 * issue #96: end-to-end check of code block syntax highlighting. Unit tests already cover the highlighter contract, the schema
 * wiring and the CSS-variable guard; this checks three things only a real browser can show:
 * 1. the shiki chunk is really lazy-loaded and decorations really draw (a jsdom green cannot prove the real bundle's
 *    `import("shiki")` resolves);
 * 2. the CSS variables really resolve to **different colours** (computed style; when the variables are undefined all tokens
 *    silently inherit one foreground colour while the DOM structure looks completely normal);
 * 3. the colours follow the light/dark switch (the :root / .dark variable sets in index.css).
 */

const codeBlock = (page: import("@playwright/test").Page) =>
  page.locator('[data-testid="note-editor"] [data-content-type="codeBlock"]');

test("```ts fence -> highlighting appears and token colours are distinct -> light/dark switch changes colours -> language dropdown works", async ({ page }) => {
  await loginAs(page, ADMIN.email, ADMIN.password);
  await createNote(page, `E2E code highlight ${Date.now()}`);

  const editor = editorLocator(page);
  await editor.click();

  // ``` fence input rule (triggered by the trailing space); "ts" goes through the alias mapping in SUPPORTED_LANGUAGES.
  await editor.pressSequentially("```ts ");
  await expect(codeBlock(page)).toHaveCount(1);
  await expect(codeBlock(page).locator("select")).toHaveValue("typescript");

  await editor.pressSequentially('const greeting = "hello" // 註解');

  // 1. Core: shiki chunk lazy load -> grammar load -> decoration redraw. The first run fetches two chunks (shiki core +
  // typescript grammar), hence the generous timeout.
  const tokens = codeBlock(page).locator(".shiki");
  await expect(tokens.first()).toBeVisible({ timeout: 20_000 });

  // 2. Token colours are CSS variables and **resolve to distinct colours**. The inline-style assertion pins "the
  // css-variables theme is used"; the computed-colour count pins "the variables really have values" (when undefined, var()
  // fails to resolve and every token falls back to the inherited colour, leaving 1 distinct colour).
  const keywordToken = codeBlock(page).locator('.shiki[style*="--code-token-keyword"]');
  await expect(keywordToken.first()).toBeVisible();
  const lightColors = await tokens.evaluateAll((els) => [...new Set(els.map((el) => getComputedStyle(el).color))]);
  expect(lightColors.length).toBeGreaterThan(1);

  // Light-mode background: --code-background #f6f8fa (no longer the built-in hard-coded dark #161616 block).
  // resolvedTheme must be light: Playwright's default colorScheme is light, pinned explicitly here so a future config
  // change cannot make this assertion test dark while looking like light.
  await page.emulateMedia({ colorScheme: "light" });
  const lightBg = await codeBlock(page).evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(lightBg).toBe("rgb(246, 248, 250)");

  // The app follows the system theme by default, so emulateMedia flips it
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(async () => {
    const darkBg = await codeBlock(page).evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(darkBg).toBe("rgb(21, 24, 30)");
  }).toPass({ timeout: 5_000 });
  const darkColors = await tokens.evaluateAll((els) => [...new Set(els.map((el) => getComputedStyle(el).color))]);
  expect(darkColors.length).toBeGreaterThan(1);
  // The two colour sets must not intersect (GitHub Light and Dark token colours are entirely different); an overlap means a
  // variable lacks a dark version and silently reuses the light colour.
  for (const color of darkColors) expect(lightColors).not.toContain(color);

  const options = codeBlock(page).locator("select option");
  expect(await options.count()).toBeGreaterThanOrEqual(20);
  await expect(codeBlock(page).locator('select option[value="python"]')).toHaveText("Python");
});
