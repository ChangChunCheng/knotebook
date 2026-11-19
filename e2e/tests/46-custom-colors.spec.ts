import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import {
  ADMIN,
  clickEndOfParagraph,
  createNote,
  createUserViaInvite,
  editorLocator,
  loginAs,
  randomEmail,
  reEscape,
  waitForEditorSelection,
} from "./helpers.js";
import { E2E_ORIGIN } from "../ports.js";

/**
 * Display surfaces for custom color codes (any #rrggbb text and background color) and the custom color panel, e2e.
 *
 * Cases are numbered C1-C14 in their titles. They cover the format toolbar's and drag handle's custom color panels, the table cell/row handles, and display surfaces (editor, public page, version preview, presentation).
 *
 * - C7: the built-in `red` control element must keep its built-in value (guards against a false green where everything turns the same color).
 * - C8: no `securitypolicyviolation` throughout C7 (the custom-color rules are inserted dynamically by JS and must not rely on inline style or `unsafe-inline`).
 * - C12: B shows a color A pasted without reloading (colors applied by a remote collaborator don't go through local operations).
 * - C9: a short, uppercase hex code written as `style` over REST is stored as lowercase `#rrggbb`.
 * - Table handle menus are always found through the trigger's `aria-controls`: BlockNote's handle overlay shows a copy of the HTML from when it was last open during its fade-out (it may contain the menu just closed), so querying by class on the page would match that copy too.
 *
 * How codes get into the note: panel cases apply colors through the UI; C9 uses the REST API; the rest only care how a code already in the document is displayed, so they put it in by pasting HTML (`pasteHtml`).
 * The paste is a synthetic `ClipboardEvent("paste")` with a real `DataTransfer` holding only `text/html`:
 * - it avoids the browser's async clipboard (Chromium sanitizes HTML on write and `data-*` attributes are not guaranteed to survive) and needs no clipboard permission;
 * - no `text/plain`: the editor's paste flow parses plain text as markdown first, so the HTML would never be processed.
 *
 * The helpers `openShareDialog`, `readPublicUrl`, `saveVersion`, `presentFromHeaderMenu` and the CSP collector are trimmed copies from `11-public-share`, `22-versions`, `22-presentation`
 * and `09-csp` (those files' helpers are not exported). The public link owner is a fresh account, not admin (the public-link limiter is per userId, see the header of helpers).
 */

const CUSTOM = "#ff6600";
const RGB_CUSTOM = "rgb(255, 102, 0)";
/** Built-in red: `--bn-colors-highlights-red-text: #e03e3e`, `--bn-colors-highlights-red-background: #fbe4e4` (light theme). */
const RGB_RED_TEXT = "rgb(224, 62, 62)";
const RGB_RED_BG = "rgb(251, 228, 228)";

/**
 * Seed: inline text color, block text color of a paragraph and a heading, and a cell background, each with one custom code and one built-in color name as control.
 * Presentation paging (the smallest level among top-level headings is the chapter; anything before the first heading is the cover) yields three slides:
 * cover [i, cp, rp], slide 2 [ch], slide 3 [rh, table].
 */
const SEED_HTML =
  `<p>i <span data-style-type="textColor" data-value="${CUSTOM}">ci</span> <span data-style-type="textColor" data-value="red">ri</span></p>` +
  `<p data-text-color="${CUSTOM}">cp</p><p data-text-color="red">rp</p>` +
  `<h2 data-text-color="${CUSTOM}">ch</h2><h2 data-text-color="red">rh</h2>` +
  `<table><tr><td data-background-color="${CUSTOM}">cc</td><td data-background-color="red">rc</td></tr></table>`;

type Surface = "editor" | "present";
interface Probe {
  text: string;
  kind: "inline" | "block" | "cell";
  value: string;
  css: "color" | "background-color";
  expected: string;
}
const PROBES: Probe[] = [
  { text: "ci", kind: "inline", value: CUSTOM, css: "color", expected: RGB_CUSTOM },
  { text: "ri", kind: "inline", value: "red", css: "color", expected: RGB_RED_TEXT },
  { text: "cp", kind: "block", value: CUSTOM, css: "color", expected: RGB_CUSTOM },
  { text: "rp", kind: "block", value: "red", css: "color", expected: RGB_RED_TEXT },
  { text: "ch", kind: "block", value: CUSTOM, css: "color", expected: RGB_CUSTOM },
  { text: "rh", kind: "block", value: "red", css: "color", expected: RGB_RED_TEXT },
  { text: "cc", kind: "cell", value: CUSTOM, css: "background-color", expected: RGB_CUSTOM },
  { text: "rc", kind: "cell", value: "red", css: "background-color", expected: RGB_RED_BG },
];

function probeLocator(scope: Locator, surface: Surface, probe: Probe): Locator {
  let selector: string;
  if (probe.kind === "inline") selector = `[data-style-type="textColor"][data-value="${probe.value}"]`;
  else if (probe.kind === "cell") selector = `td[data-background-color="${probe.value}"]`;
  // Editor surfaces: the block color attributes are on `.bn-block-content`; the presentation is sanitized HTML with the attributes directly on p/h2.
  else selector = surface === "editor" ? `.bn-block-content[data-text-color="${probe.value}"]` : `[data-text-color="${probe.value}"]`;
  return scope.locator(selector).filter({ hasText: new RegExp(`^${probe.text}$`) }).first();
}

async function expectColors(scope: Locator, surface: Surface, texts: string[]): Promise<void> {
  for (const probe of PROBES.filter((p) => texts.includes(p.text))) {
    await expect(probeLocator(scope, surface, probe), `${surface}：${probe.text} 的 ${probe.css}`).toHaveCSS(probe.css, probe.expected, { timeout: 15_000 });
  }
}

const ALL_TEXTS = PROBES.map((p) => p.text);

async function pasteHtml(page: Page, html: string): Promise<void> {
  await editorLocator(page).click();
  await page.evaluate((markup) => {
    const dt = new DataTransfer();
    dt.setData("text/html", markup);
    const target = document.querySelector('[data-testid="note-editor"] [contenteditable="true"]');
    if (!target) throw new Error("editor not found");
    target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, html);
}

interface Violation {
  directive: string;
  blockedURI: string;
}
type CspWindow = { __cspViolations?: Violation[] };

/** Registers the CSP violation collector before any script of every page in the context (pages of an anonymous context need their own registration). */
async function collectCspViolations(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const w = window as unknown as CspWindow;
    w.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      w.__cspViolations!.push({ directive: event.violatedDirective, blockedURI: event.blockedURI });
    });
  });
}

async function drainCspViolations(page: Page): Promise<Violation[]> {
  return page.evaluate(() => (window as unknown as CspWindow).__cspViolations ?? []);
}

async function openShareDialog(page: Page) {
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Share note" });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** The anonymous public-link input holds only the token; the URL has to be rebuilt. */
async function readPublicUrl(dialog: Locator, page: Page): Promise<string> {
  const input = dialog.getByLabel("Public link URL");
  await expect(input).toBeVisible();
  const token = await input.inputValue();
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return `${new URL(page.url()).origin}/p/${token}`;
}

async function saveVersion(page: Page, name: string): Promise<void> {
  await page.keyboard.press("Control+s");
  const dialog = page.getByRole("dialog", { name: "Save current version" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Version name (optional)").fill(name);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

async function presentFromHeaderMenu(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Present" }).click();
  await expect(page.getByRole("dialog", { name: `${title} — presentation` })).toBeVisible();
  await expect(page.locator(".reveal.ready")).toBeVisible({ timeout: 15_000 });
}

test("C7+C8 custom color codes show in the editor, public page, version preview and presentation, with zero CSP violations throughout", async ({ browser }) => {
  test.setTimeout(180_000);
  const adminContext = await browser.newContext();
  // Wide enough that with the version panel open the preview area can still sit side by side (>= 720 px), so "Single column" can be switched to later.
  const ownerContext = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const anonContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  const violations: Violation[] = [];
  try {
    await collectCspViolations(ownerContext);
    await collectCspViolations(anonContext);

    // Create a new account as owner (the public-link limiter should not consume admin's allowance).
    await loginAs(adminPage, ADMIN.email, ADMIN.password);
    await expect(adminPage).toHaveURL(/\/$/);
    const ownerEmail = randomEmail();
    const ownerPassword = "e2e-colors-owner-pw";
    await createUserViaInvite(adminPage, { email: ownerEmail, password: ownerPassword, displayName: "E2E Colors Owner" });

    const page = await ownerContext.newPage();
    await loginAs(page, ownerEmail, ownerPassword);
    await expect(page).toHaveURL(/\/$/);
    const title = `E2E custom colors ${Date.now()}`;
    await createNote(page, title);

    // Editor: first confirm the document really has the color attributes after pasting (a failure is a paste parsing problem, not display), then check computed values.
    await pasteHtml(page, SEED_HTML);
    const editor = editorLocator(page);
    await expect(editor.locator(`[data-value="${CUSTOM}"]`)).toHaveCount(1);
    await expect(editor.locator(`.bn-block-content[data-text-color="${CUSTOM}"]`)).toHaveCount(2);
    await expect(editor.locator(`td[data-background-color="${CUSTOM}"]`)).toHaveCount(1);
    await expectColors(editor, "editor", ALL_TEXTS);

    const dialog = await openShareDialog(page);
    const publicRadio = dialog.getByRole("radio", { name: /^Public link/ });
    await expect(publicRadio).toBeEnabled();
    await publicRadio.check();
    const publicUrl = await readPublicUrl(dialog, page);
    const token = publicUrl.slice(publicUrl.lastIndexOf("/p/") + 3);
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(async () => {
      const res = await anonContext.request.get(`/api/public/notes/${token}`);
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { ydoc: string };
      // The code string is encoded verbatim in the Yjs update: containing it means this content (not the pre-paste snapshot) has been persisted.
      expect(Buffer.from(body.ydoc, "base64").toString("utf8")).toContain(CUSTOM);
    }).toPass({ timeout: 20_000 });

    const anon = await anonContext.newPage();
    await anon.goto(publicUrl);
    await expect(anon.getByRole("heading", { name: title })).toBeVisible({ timeout: 15_000 });
    await expect(anon.getByText("Read-only")).toBeVisible();
    await expectColors(anon.locator(".bn-editor").first(), "editor", ALL_TEXTS);
    violations.push(...(await drainCspViolations(anon)));

    await presentFromHeaderMenu(page, title);
    const slide = page.locator(".reveal .slides section.present");
    await expect(slide.getByText("cp", { exact: true })).toBeVisible();
    await expectColors(slide, "present", ["ci", "ri", "cp", "rp"]);
    await page.keyboard.press("ArrowRight");
    await expect(slide.getByText("ch", { exact: true })).toBeVisible();
    await expectColors(slide, "present", ["ch"]);
    await page.keyboard.press("ArrowRight");
    await expect(slide.getByText("rh", { exact: true })).toBeVisible();
    await expectColors(slide, "present", ["rh", "cc", "rc"]);
    await page.evaluate(async () => {
      if (document.fullscreenElement) await document.exitFullscreen();
    });
    // The 350 ms must be longer than the presentation's own 300 ms double-exit guard window, otherwise Esc is treated as the same exit and swallowed.
    await page.waitForTimeout(350);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(editorLocator(page)).toBeVisible();

    await saveVersion(page, "colors-v1");
    await page.getByTestId("versions-bubble").click();
    const panel = page.getByTestId("versions-panel");
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: /^colors-v1 \(/ }).click();
    const banner = page.getByTestId("preview-banner");
    await expect(banner).toBeVisible();
    // Single column: side by side renders the content twice.
    await banner.getByRole("button", { name: "Single column" }).click();
    await expectColors(page.getByTestId("diff-single"), "editor", ALL_TEXTS);

    violations.push(...(await drainCspViolations(page)));
    expect(violations, `CSP 擋到了自己的東西：${JSON.stringify(violations)}`).toEqual([]);
  } finally {
    await Promise.all([adminContext.close(), ownerContext.close(), anonContext.close()]);
  }
});

test("C12 two tabs open the same note: A pastes a custom code and B shows it without reload", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext();
  try {
    const pageA = await context.newPage();
    await loginAs(pageA, ADMIN.email, ADMIN.password);
    await expect(pageA).toHaveURL(/\/$/);
    const title = `E2E colors two tabs ${Date.now()}`;
    await createNote(pageA, title);

    const pageB = await context.newPage();
    await pageB.goto(pageA.url());
    await expect(pageB.getByLabel("Note title")).toHaveValue(title, { timeout: 15_000 });
    await expect(pageB.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible({ timeout: 15_000 });
    await expect(editorLocator(pageB)).toBeVisible();

    // Let A paste only after B has loaded and connected, so B gets the color as a remote update and not through its initial sync.
    await pasteHtml(pageA, `<p data-text-color="${CUSTOM}">tab</p><p>x <span data-style-type="textColor" data-value="${CUSTOM}">y</span></p>`);

    const editorB = editorLocator(pageB);
    await expect(editorB.locator(`.bn-block-content[data-text-color="${CUSTOM}"]`).filter({ hasText: /^tab$/ }).first()).toHaveCSS("color", RGB_CUSTOM, { timeout: 10_000 });
    await expect(editorB.locator(`[data-style-type="textColor"][data-value="${CUSTOM}"]`).filter({ hasText: /^y$/ }).first()).toHaveCSS("color", RGB_CUSTOM, { timeout: 10_000 });
  } finally {
    await context.close();
  }
});

test("C9 API token writes a code via style: the page shows it without reload and it is stored as lowercase #rrggbb", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  // New account: the token-creation allowance (10 per user per hour) is per user and does not use up admin's.
  const adminContext = await browser.newContext();
  const userContext = await browser.newContext();
  let anonymous: BrowserContext | undefined;
  let tokenId: string | undefined;
  const page = await userContext.newPage();
  try {
    const adminPage = await adminContext.newPage();
    await loginAs(adminPage, ADMIN.email, ADMIN.password);
    await expect(adminPage).toHaveURL(/\/$/);
    const email = randomEmail();
    const password = "e2e-colors-api-pw";
    await createUserViaInvite(adminPage, { email, password, displayName: "E2E Colors Api" });

    await loginAs(page, email, password);
    const title = `E2E colors api ${Date.now()}`;
    await createNote(page, title);
    const noteUrl = page.url();

    const created = await page.request.post("/api/auth/tokens", {
      data: { name: `e2e-colors-${Date.now()}`, scope: "notes:read notes:write", expiresInDays: 30 },
    });
    expect(created.status(), await created.text()).toBe(201);
    const body = (await created.json()) as { id: string; token: string };
    tokenId = body.id;
    const token = body.token;
    expect(token).toMatch(/^knb_/);

    await page.goto(noteUrl);
    const editor = editorLocator(page);
    // A matching editable editor implies connected and first sync done.
    await editor.waitFor();

    // Cookie-less context: a browser context would pass through the session cookie and have no discriminating power over Bearer.
    anonymous = await browser.newContext();
    const api = anonymous.request;
    const auth = { Authorization: `Bearer ${token}` };
    const listRes = await api.get(`${baseURL}/api/notes`, { headers: auth });
    expect(listRes.status()).toBe(200);
    const notes = (await listRes.json()) as Array<{ id: string; title: string }>;
    const mine = notes.find((n) => n.title === title)!;
    expect(mine).toBeTruthy();

    // A short, uppercase code written via style: the parser first turns it into rgb(255, 102, 0), then the write side normalizes it to #ff6600.
    const res = await api.post(`${baseURL}/api/notes/${mine.id}/edits`, {
      headers: auth,
      data: { op: "append", markdown: '<span style="color:#F60">c9</span>' },
    });
    expect(res.status()).toBe(201);

    // After the write the token's remote cursor sits before the first character it wrote. ProseMirror wraps the widget into the mark of the following character,
    // so the cursor (with its name tag text) is drawn inside the colored span and the span's textContent is not exactly "c9".
    // So find the span by substring, then compare the span's own text without the widget: the whole "c9" is colored, not just part of it.
    const colored = editor.locator('[data-style-type="textColor"]').filter({ hasText: "c9" }).first();
    await expect(colored).toHaveCSS("color", RGB_CUSTOM, { timeout: 10_000 });
    await expect(colored).toHaveAttribute("data-value", CUSTOM);
    const ownText = () =>
      colored.evaluate((el) => {
        const copy = el.cloneNode(true) as Element;
        copy.querySelectorAll(".ProseMirror-widget").forEach((w) => w.remove());
        return copy.textContent;
      });
    await expect.poll(ownText).toBe("c9");
  } finally {
    try {
      if (tokenId) await page.request.delete(`/api/auth/tokens/${tokenId}`);
    } finally {
      await anonymous?.close();
      await userContext.close();
      await adminContext.close();
    }
  }
});

test("C14 toolbar custom color panel while typing a code: another tab inserts a paragraph before the selection; focus stays in the code box and Enter applies to the original selection", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext();
  try {
    const pageA = await context.newPage();
    await loginAs(pageA, ADMIN.email, ADMIN.password);
    await expect(pageA).toHaveURL(/\/$/);
    const title = `E2E colors toolbar focus ${Date.now()}`;
    await createNote(pageA, title);
    const editorA = editorLocator(pageA);
    await editorA.click();
    await pageA.keyboard.type("top");
    await pageA.keyboard.press("Enter");
    await pageA.keyboard.type("target text");

    const pageB = await context.newPage();
    await pageB.goto(pageA.url());
    await expect(pageB.getByLabel("Note title")).toHaveValue(title, { timeout: 15_000 });
    await expect(pageB.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible({ timeout: 15_000 });
    const editorB = editorLocator(pageB);
    // A's remote cursor (with its name tag text) is drawn at the end of the `target text` paragraph, so match by substring.
    await expect(editorB.locator(".bn-block-content", { hasText: "target text" })).toBeVisible({ timeout: 10_000 });

    await editorA.getByText("target text", { exact: true }).click({ clickCount: 3 });
    await pageA.locator('.bn-formatting-toolbar [data-test="colors"]').click();
    await pageA.locator('[data-test="text-color-custom"]').click();
    const panel = pageA.locator(".bn-formatting-toolbar .kb-color-panel");
    await expect(panel).toBeVisible();
    await expect(panel.locator(".react-colorful")).toBeVisible();
    const hex = pageA.getByRole("textbox", { name: "Hex color" });
    await expect(hex).toBeFocused();

    // Panel width: the dropdown has no horizontal scrollbar, the color square is inside the panel on both sides, and with the value at 0% (left end of the square and hue) the pointer also stays inside the panel.
    const dropdown = pageA.locator(".bn-formatting-toolbar .bn-color-picker-dropdown");
    const metrics = await dropdown.evaluate((el) => {
      const panelBox = el.querySelector(".kb-color-panel")!.getBoundingClientRect();
      const pickerBox = el.querySelector(".react-colorful")!.getBoundingClientRect();
      const pointers = Array.from(el.querySelectorAll(".react-colorful__pointer")).map((p) => p.getBoundingClientRect());
      return {
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        panelLeft: panelBox.left,
        panelRight: panelBox.right,
        pickerLeft: pickerBox.left,
        pickerRight: pickerBox.right,
        pointerLeft: Math.min(...pointers.map((r) => r.left)),
        pointerRight: Math.max(...pointers.map((r) => r.right)),
      };
    });
    console.log(`MEASURE C14 ${JSON.stringify(metrics)}`);
    await pageA.screenshot({ path: test.info().outputPath("c14-panel.png") });
    expect(metrics.scrollWidth, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.clientWidth);
    expect(metrics.pickerLeft, JSON.stringify(metrics)).toBeGreaterThanOrEqual(metrics.panelLeft);
    expect(metrics.pickerRight, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.panelRight);
    expect(metrics.pointerLeft, JSON.stringify(metrics)).toBeGreaterThanOrEqual(metrics.panelLeft);
    expect(metrics.pointerRight, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.panelRight);

    // The code box opens containing `#`; select all and type over it.
    await pageA.keyboard.press("Control+A");
    await pageA.keyboard.type("#ff6");
    await expect(hex).toHaveValue("#ff6");

    await editorB.getByText("top", { exact: true }).click();
    await pageB.keyboard.press("Home");
    await waitForEditorSelection(pageB);
    await pageB.keyboard.type("zz");
    await pageB.keyboard.press("Enter");

    await expect(editorA.getByText("zz", { exact: true })).toBeVisible({ timeout: 10_000 });
    // After the toolbar redraw Mantine's focus trap refocuses inside a setTimeout, so wait a little before checking focus.
    await pageA.waitForTimeout(300);
    expect(await hex.evaluate((el) => el === document.activeElement)).toBe(true);
    await expect(panel).toBeVisible();

    await pageA.keyboard.type("600");
    await expect(hex).toHaveValue("#ff6600");
    await pageA.keyboard.press("Enter");
    await expect(panel).toHaveCount(0);

    const colored = editorA.locator('[data-style-type="textColor"][data-value="#ff6600"]').filter({ hasText: /^target text$/ });
    await expect(colored).toHaveCSS("color", RGB_CUSTOM, { timeout: 10_000 });
    const blockTexts = () =>
      editorA.evaluate((root) =>
        Array.from(root.querySelectorAll(".bn-block-content"))
          .map((el) => {
            const copy = el.cloneNode(true) as Element;
            copy.querySelectorAll(".ProseMirror-widget").forEach((w) => w.remove());
            return copy.textContent ?? "";
          })
          .filter((text) => text !== ""),
      );
    // B's remote cursor (with its name tag text) is drawn at the start of `top`; blockTexts strips the widget.
    await expect.poll(blockTexts).toEqual(["zz", "top", "target text"]);
  } finally {
    await context.close();
  }
});

// Built-in red's text color in dark theme is `#ec4040`.
const RGB_RED_TEXT_DARK = "rgb(236, 64, 64)";
const RECENT_COLORS_KEY = "knotebook:recent-colors";
/** Wide viewport: the C11a tests move the pointer 160 px outside the panel, so it must be wide enough. */
const WIDE = { width: 1400, height: 900 };

function hexToRgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
}

async function startColorNote(
  browser: Browser,
  name: string,
  lines: string[],
  options: Parameters<Browser["newContext"]>[0] = { viewport: WIDE },
  prepare?: (context: BrowserContext) => Promise<unknown>,
): Promise<{ context: BrowserContext; page: Page; title: string }> {
  const context = await browser.newContext(options);
  await prepare?.(context);
  const page = await context.newPage();
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);
  const title = `E2E colors ${name} ${Date.now()}`;
  await createNote(page, title);
  if (lines.length > 0) await typeLines(page, lines);
  return { context, page, title };
}

async function typeLines(page: Page, lines: string[]): Promise<void> {
  await editorLocator(page).click();
  for (const [i, line] of lines.entries()) {
    if (i > 0) await page.keyboard.press("Enter");
    await page.keyboard.type(line);
  }
  await expect(paragraph(page, lines[lines.length - 1]!)).toBeVisible();
}

function paragraph(page: Page, text: string): Locator {
  return editorLocator(page).locator(".bn-inline-content").filter({ hasText: new RegExp(`^${reEscape(text)}$`) }).first();
}

function blockContent(page: Page, text: string): Locator {
  return editorLocator(page).locator(".bn-block-content").filter({ hasText: new RegExp(`^${reEscape(text)}$`) }).first();
}

function inlineColored(page: Page, hex: string, text: string): Locator {
  return editorLocator(page).locator(`[data-style-type="textColor"][data-value="${hex}"]`).filter({ hasText: new RegExp(`^${reEscape(text)}$`) });
}

async function selectText(page: Page, text: string, from: number, to: number): Promise<void> {
  const toolbar = page.locator(".bn-formatting-toolbar");
  const hasRange = () => page.evaluate(() => !(document.getSelection()?.isCollapsed ?? true));
  if ((await toolbar.isVisible()) || (await hasRange())) {
    // The previous selection is still there: the toolbar may be covering the paragraph to click. Wait for focus to return to the editor (after applying it is restored in a setTimeout);
    // press the arrow key to collapse the selection only if it has not collapsed yet, then wait for the toolbar to disappear.
    await expect.poll(() => editorLocator(page).evaluate((el) => el.contains(document.activeElement))).toBe(true);
    // After focus returns to the editor the selection may be painted back into the DOM a little later: this round may still see a collapsed selection while the toolbar is still open, so look once more.
    await expect(async () => {
      if (await hasRange()) await page.keyboard.press("ArrowRight");
      await expect(toolbar).toBeHidden({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
  }
  await clickEndOfParagraph(page, paragraph(page, text));
  await page.keyboard.press("Home");
  await waitForEditorSelection(page);
  for (let i = 0; i < from; i++) await page.keyboard.press("ArrowRight");
  for (let i = from; i < to; i++) await page.keyboard.press("Shift+ArrowRight");
  await expect(toolbar).toBeVisible();
}

const panelOf = (page: Page) => page.locator(".kb-color-panel");
const hexInput = (page: Page) => page.getByRole("textbox", { name: "Hex color" });
const applyButton = (page: Page) => panelOf(page).getByRole("button", { name: "Apply", exact: true });

async function openToolbarPanel(page: Page, section: "text" | "background", how: "click" | "tap" = "click"): Promise<Locator> {
  const colors = page.locator('.bn-formatting-toolbar [data-test="colors"]');
  const custom = page.locator(`.bn-formatting-toolbar [data-test="${section}-color-custom"]`);
  if (how === "tap") {
    await colors.tap();
    await custom.tap();
  } else {
    await colors.click();
    await custom.click();
  }
  const panel = panelOf(page);
  await expect(panel).toBeVisible();
  await expect(panel.locator(".react-colorful")).toBeVisible();
  return panel;
}

async function openBlockMenu(page: Page, text: string): Promise<Locator> {
  const content = blockContent(page, text);
  await content.hover();
  const handle = page.getByRole("button", { name: "Open block menu" });
  await expect(handle).toBeVisible();
  await expect(async () => {
    const menu = await page.locator(".bn-side-menu").boundingBox();
    const box = await content.boundingBox();
    expect(menu, "side menu").not.toBeNull();
    expect(box, `block ${text}`).not.toBeNull();
    expect(menu!.y < box!.y + box!.height && box!.y < menu!.y + menu!.height, JSON.stringify({ menu, box })).toBe(true);
  }).toPass({ timeout: 5_000 });
  await handle.click();
  const menu = page.locator(".bn-drag-handle-menu");
  await expect(menu).toBeVisible();
  return menu;
}

async function pickBlockColorItem(page: Page, text: string, dataTest: string): Promise<void> {
  const menu = await openBlockMenu(page, text);
  await menu.getByRole("menuitem", { name: "Colors", exact: true }).hover();
  const item = menu.locator(`[data-test="${dataTest}"]`);
  await expect(item).toBeVisible();
  await item.click();
}

async function openBlockPanel(page: Page, text: string, section: "text" | "background"): Promise<Locator> {
  await pickBlockColorItem(page, text, `${section}-color-custom`);
  const panel = page.locator(".bn-drag-handle-menu .kb-color-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".react-colorful")).toBeVisible();
  return panel;
}

function blockTexts(page: Page): Promise<string[]> {
  return editorLocator(page).evaluate((root) =>
    Array.from(root.querySelectorAll(".bn-block-content"))
      .map((el) => {
        const copy = el.cloneNode(true) as Element;
        copy.querySelectorAll(".ProseMirror-widget").forEach((w) => w.remove());
        return copy.textContent ?? "";
      })
      .filter((text) => text !== ""),
  );
}

test("C1+C2 toolbar applies a custom color: vs built-in red as control, toolbar icon shows the custom color, survives reload, zero CSP violations; in dark theme the custom color is unchanged", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: WIDE });
  try {
    // react-colorful injects its own <style>: collect violations from the moment the panel opens.
    await collectCspViolations(context);
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await expect(page).toHaveURL(/\/$/);
    const title = `E2E colors toolbar ${Date.now()}`;
    await createNote(page, title);
    const line = "orange and red";
    await typeLines(page, [line]);

    await selectText(page, line, 0, 6);
    await openToolbarPanel(page, "text");
    await expect(hexInput(page)).toBeFocused();
    await hexInput(page).fill(CUSTOM);
    await applyButton(page).click();
    await expect(panelOf(page)).toHaveCount(0);
    await expect(inlineColored(page, CUSTOM, "orange")).toHaveCSS("color", RGB_CUSTOM, { timeout: 10_000 });

    await selectText(page, line, 11, 14);
    await page.locator('.bn-formatting-toolbar [data-test="colors"]').click();
    await page.locator('.bn-formatting-toolbar [data-test="text-color-red"]').click();
    const red = editorLocator(page).locator('[data-style-type="textColor"][data-value="red"]').filter({ hasText: /^red$/ });
    await expect(red).toHaveCSS("color", RGB_RED_TEXT, { timeout: 10_000 });
    await expect(inlineColored(page, CUSTOM, "orange")).toHaveCSS("color", RGB_CUSTOM);

    await selectText(page, line, 0, 6);
    await expect(page.locator('.bn-formatting-toolbar [data-test="colors"] .bn-color-icon')).toHaveCSS("color", RGB_CUSTOM);

    // The collector resets on every page load: take the violations received while the panel was open (react-colorful injecting <style>) before reloading.
    const violations = await drainCspViolations(page);

    await page.reload();
    await expect(page.getByLabel("Note title")).toHaveValue(title, { timeout: 15_000 });
    await expect(inlineColored(page, CUSTOM, "orange")).toHaveCSS("color", RGB_CUSTOM, { timeout: 15_000 });
    await expect(red).toHaveCSS("color", RGB_RED_TEXT);

    await page.emulateMedia({ colorScheme: "dark" });
    await expect(red).toHaveCSS("color", RGB_RED_TEXT_DARK, { timeout: 10_000 });
    await expect(inlineColored(page, CUSTOM, "orange")).toHaveCSS("color", RGB_CUSTOM);

    violations.push(...(await drainCspViolations(page)));
    expect(violations, `CSP 擋到了自己的東西：${JSON.stringify(violations)}`).toEqual([]);
  } finally {
    await context.close();
  }
});

test("C3 drag handle applies a custom background: the outer block gets the background with the nested child inside it, another paragraph gets built-in red background as control", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await startColorNote(browser, "block bg", []);
  try {
    await editorLocator(page).click();
    await page.keyboard.type("parent");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await page.keyboard.type("child");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.type("other");
    await expect(blockContent(page, "other")).toBeVisible();
    const nested = () =>
      blockContent(page, "child").evaluate((el) => el.closest(".bn-block")!.parentElement!.closest(".bn-block")?.querySelector(":scope > .bn-block-content")?.textContent ?? null);
    await expect.poll(nested, { message: "child 要巢狀在 parent 底下" }).toBe("parent");

    const bright = "#00ff00";
    const panel = await openBlockPanel(page, "parent", "background");
    await hexInput(page).fill(bright);
    await panel.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(panelOf(page)).toHaveCount(0);

    const outer = editorLocator(page).locator(`.bn-block:has(> .bn-block-content[data-background-color="${bright}"])`);
    await expect(outer).toHaveCount(1);
    await expect(outer.locator(":scope > .bn-block-content")).toHaveText("parent");
    await expect(outer).toHaveCSS("background-color", "rgb(0, 255, 0)", { timeout: 10_000 });
    // The child block is a descendant of the outer .bn-block and is drawn on its background. The child's own background-color is not asserted:
    // background-color is not inherited and BlockNote puts the background only on the outer block (built-in colors too); the child's .bn-block is transparent.
    expect(
      await blockContent(page, "child").evaluate(
        (el, sel) => el.closest(".bn-block")!.parentElement!.closest(".bn-block") === document.querySelector(sel),
        `[data-testid="note-editor"] .bn-block:has(> .bn-block-content[data-background-color="${bright}"])`,
      ),
    ).toBe(true);

    await pickBlockColorItem(page, "other", "background-color-red");
    const redOuter = editorLocator(page).locator('.bn-block:has(> .bn-block-content[data-background-color="red"])');
    await expect(redOuter.locator(":scope > .bn-block-content")).toHaveText("other");
    await expect(redOuter).toHaveCSS("background-color", RGB_RED_BG, { timeout: 10_000 });
    await expect(outer).toHaveCSS("background-color", "rgb(0, 255, 0)");
  } finally {
    await context.close();
  }
});

/**
 * First applies `CUSTOM` through the code box to the first character of the `first` paragraph, then opens the panel and clicks the "Recent" swatch to apply it to the first character of the `second` paragraph; `how` selects mouse or touch.
 * `onFirstPanel` is called when the panel is first opened, before the code box is touched.
 */
async function applyThenPickRecent(
  page: Page,
  first: string,
  second: string,
  how: "click" | "tap",
  onFirstPanel?: (panel: Locator) => Promise<void>,
): Promise<void> {
  const press = (target: Locator) => (how === "tap" ? target.tap() : target.click());
  await selectText(page, first, 0, first.indexOf(" "));
  const firstPanel = await openToolbarPanel(page, "text", how);
  await onFirstPanel?.(firstPanel);
  if (how === "tap") await hexInput(page).tap();
  await hexInput(page).fill(CUSTOM);
  await press(applyButton(page));
  await expect(panelOf(page)).toHaveCount(0);
  const firstWord = first.slice(0, first.indexOf(" "));
  await expect(inlineColored(page, CUSTOM, firstWord)).toHaveCSS("color", RGB_CUSTOM, { timeout: 10_000 });

  await selectText(page, second, 0, second.indexOf(" "));
  const panel = await openToolbarPanel(page, "text", how);
  await expect(panel.getByText("Recent", { exact: true })).toBeVisible();
  const swatch = panel.getByRole("button", { name: CUSTOM, exact: true });
  await expect(swatch).toBeVisible();
  await press(swatch);
  await expect(panelOf(page)).toHaveCount(0);
  await expect(page.locator(".bn-color-picker-dropdown")).toHaveCount(0);
  await expect(inlineColored(page, CUSTOM, second.slice(0, second.indexOf(" ")))).toHaveCSS("color", RGB_CUSTOM, { timeout: 10_000 });
}

test("C5 recents: after applying once, reopening the panel shows the color under Recent; clicking the swatch applies it to another paragraph and closes the menu", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await startColorNote(browser, "recent", ["first words", "second words"]);
  try {
    await applyThenPickRecent(page, "first words", "second words", "click");
  } finally {
    await context.close();
  }
});

test("C6 dragging the saturation square: the code box follows, the note and recents are unchanged before Apply, and Apply writes them", async ({ browser }) => {
  test.setTimeout(120_000);
  const line = "drag me";
  const { context, page } = await startColorNote(browser, "drag preview", [line]);
  try {
    const original = await paragraph(page, line).evaluate((el) => getComputedStyle(el).color);
    await selectText(page, line, 0, line.length);
    const panel = await openToolbarPanel(page, "text");

    const sat = (await panel.locator(".react-colorful__saturation").boundingBox())!;
    await page.mouse.move(sat.x + sat.width * 0.7, sat.y + sat.height * 0.3);
    await page.mouse.down();
    await page.mouse.move(sat.x + sat.width * 0.5, sat.y + sat.height * 0.5, { steps: 5 });
    await expect.poll(() => hexInput(page).inputValue()).toMatch(/^#[0-9a-f]{6}$/);
    // Keep dragging while held: the code box must change again with the pointer (not sampled only at press time).
    const midway = await hexInput(page).inputValue();
    await page.mouse.move(sat.x + sat.width * 0.2, sat.y + sat.height * 0.8, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => hexInput(page).inputValue()).toMatch(/^#[0-9a-f]{6}$/);
    const dragged = await hexInput(page).inputValue();
    expect(dragged).not.toBe(midway);

    await expect(paragraph(page, line).locator('[data-style-type="textColor"]')).toHaveCount(0);
    expect(await paragraph(page, line).evaluate((el) => getComputedStyle(el).color)).toBe(original);
    expect(await page.evaluate((key) => localStorage.getItem(key), RECENT_COLORS_KEY) ?? "").not.toContain(dragged);

    await applyButton(page).click();
    await expect(panelOf(page)).toHaveCount(0);
    await expect(inlineColored(page, dragged, line)).toHaveCSS("color", hexToRgb(dragged), { timeout: 10_000 });
    expect(await page.evaluate((key) => localStorage.getItem(key), RECENT_COLORS_KEY)).toContain(dragged);
  } finally {
    await context.close();
  }
});

test("C10 touch device: applying a code and recents both work, and the code box does not take focus when the panel opens", async ({ browser }) => {
  test.setTimeout(150_000);
  const { context: desktop, page: owner, title } = await startColorNote(browser, "touch", ["first words", "second words"]);
  const touch = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 800, height: 1000 } });
  try {
    const page = await touch.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await page.goto(owner.url());
    await expect(page.getByLabel("Note title")).toHaveValue(title, { timeout: 15_000 });
    // The desktop page's remote cursor (with its name tag text) is drawn inside the paragraph text: after seeing the content close the desktop page and wait for the cursor to disappear, so the paragraph text becomes exactly equal.
    await expect(editorLocator(page).locator(".bn-inline-content", { hasText: "second words" })).toBeVisible({ timeout: 15_000 });
    await desktop.close();
    await expect(editorLocator(page).locator(".bn-collaboration-cursor__base")).toHaveCount(0, { timeout: 15_000 });
    await expect(paragraph(page, "second words")).toBeVisible();
    // Precondition: this context is treated as touch (not a fine pointer), so the panel takes the path that does not focus the code box.
    expect(await page.evaluate(() => window.matchMedia("(pointer: fine)").matches)).toBe(false);

    await applyThenPickRecent(page, "first words", "second words", "tap", async (panel) => {
      // Opening the panel by touch does not bring up the on-screen keyboard: the code box has no focus, and focus stays inside the panel (not outside it, or the next key press would close the menu).
      await expect(hexInput(page)).not.toBeFocused();
      expect(await panel.evaluate((el) => el.contains(document.activeElement)), "焦點要留在面板裡").toBe(true);
    });
  } finally {
    await Promise.all([desktop.close(), touch.close()]);
  }
});

test("C11a drag handle panel: pressing on the saturation square, dragging 160 px outside the panel, pausing and releasing keeps the panel open, the value changed and Apply takes effect", async ({ browser }) => {
  test.setTimeout(120_000);
  const line = "drag outside";
  const { context, page } = await startColorNote(browser, "drag outside", [line]);
  try {
    const panel = await openBlockPanel(page, line, "text");
    const sat = (await panel.locator(".react-colorful__saturation").boundingBox())!;
    const box = (await panel.boundingBox())!;
    const y = sat.y + sat.height * 0.5;
    const outsideX = box.x + box.width + 160 < WIDE.width - 10 ? box.x + box.width + 160 : box.x - 160;
    await page.mouse.move(sat.x + sat.width * 0.6, sat.y + sat.height * 0.4);
    await page.mouse.down();
    await page.mouse.move(sat.x + sat.width * 0.3, y, { steps: 5 });
    await expect.poll(() => hexInput(page).inputValue()).toMatch(/^#[0-9a-f]{6}$/);
    // The value reached inside the panel; after leaving the panel the pointer is still tracked and the saturation sticks to the edge (0% or 100%), so the value must change again.
    const inside = await hexInput(page).inputValue();
    await page.mouse.move(outsideX, y, { steps: 10 });
    // Pause longer than the submenu's close delay: if the panel lived in a hover-opened submenu it would be closed during this time.
    await page.waitForTimeout(500);
    await page.mouse.up();

    await expect(panel).toBeVisible();
    await expect.poll(() => hexInput(page).inputValue()).toMatch(/^#[0-9a-f]{6}$/);
    const dragged = await hexInput(page).inputValue();
    expect(dragged).not.toBe(inside);
    await panel.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(panelOf(page)).toHaveCount(0);
    const colored = editorLocator(page).locator(`.bn-block-content[data-text-color="${dragged}"]`).filter({ hasText: new RegExp(`^${line}$`) });
    await expect(colored).toHaveCSS("color", hexToRgb(dragged), { timeout: 10_000 });
  } finally {
    await context.close();
  }
});

test("C11b drag handle panel: moving the mouse to the other end of the editor and pausing while halfway through typing a code, then finishing and pressing Enter, applies the full code", async ({ browser }) => {
  test.setTimeout(120_000);
  const line = "type then move";
  const { context, page } = await startColorNote(browser, "type move", [line, "far line"]);
  try {
    const panel = await openBlockPanel(page, line, "text");
    await hexInput(page).click();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("#ff6");
    await expect(hexInput(page)).toHaveValue("#ff6");

    const editorBox = (await editorLocator(page).boundingBox())!;
    await page.mouse.move(editorBox.x + editorBox.width - 10, editorBox.y + editorBox.height - 5, { steps: 10 });
    await page.waitForTimeout(500);
    await expect(panel).toBeVisible();

    await page.keyboard.type("600");
    await expect(hexInput(page)).toHaveValue("#ff6600");
    await page.keyboard.press("Enter");
    await expect(panelOf(page)).toHaveCount(0);
    const colored = editorLocator(page).locator(`.bn-block-content[data-text-color="${CUSTOM}"]`).filter({ hasText: new RegExp(`^${line}$`) });
    await expect(colored).toHaveCSS("color", RGB_CUSTOM, { timeout: 10_000 });
  } finally {
    await context.close();
  }
});

/**
 * With the panel open, the code box focused and no recents (new context): type a valid code so Apply is enabled, Tab to Apply (the last element),
 * Tab again must wrap to Back; Shift+Tab returns to Apply. The menu stays open and the note content is unchanged throughout.
 */
async function expectTabWrapsInPanel(page: Page, panel: Locator): Promise<void> {
  const texts = await blockTexts(page);
  await expect(panel.getByText("Recent", { exact: true })).toHaveCount(0);
  await expect(hexInput(page)).toBeFocused();
  await page.keyboard.press("Control+A");
  await page.keyboard.type(CUSTOM);
  await expect(applyButton(page)).toBeEnabled();

  const active = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      return { inPanel: !!el?.closest(".kb-color-panel"), text: el?.textContent?.trim() ?? "" };
    });
  await page.keyboard.press("Tab");
  await expect.poll(active).toEqual({ inPanel: true, text: "Apply" });
  await page.keyboard.press("Tab");
  await expect.poll(active).toEqual({ inPanel: true, text: "←Back" });
  await expect(panel).toBeVisible();
  expect(await blockTexts(page)).toEqual(texts);

  await page.keyboard.press("Shift+Tab");
  await expect.poll(active).toEqual({ inPanel: true, text: "Apply" });
  await expect(panel).toBeVisible();
  expect(await blockTexts(page)).toEqual(texts);
}

function enabledToolbarButtonsAfterColors(page: Page): Promise<string[]> {
  return page.locator(".bn-formatting-toolbar").evaluate((bar) => {
    const colors = bar.querySelector('[data-test="colors"]')!;
    return Array.from(bar.querySelectorAll<HTMLButtonElement>("button"))
      .filter((b) => !b.closest("[data-menu-dropdown]") && !b.disabled && b.offsetParent !== null)
      .filter((b) => (colors.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0)
      .map((b) => b.getAttribute("data-test") ?? b.getAttribute("aria-label") ?? b.textContent ?? "");
  });
}

// The panel handles Tab/Shift+Tab itself at both ends (moves focus and preventDefault), so whether or not the panel's last element is also the last tabbable element of
// the whole toolbar, the focus traps the toolbar and dropdown hang on document see focus no longer at an end and do not intervene, and focus stays in the panel.
// The two cases below measure each situation: a plain text selection (a create-link button follows the color button) and a table cell selection (no usable button follows the color button).
// Open the color menu with the real mouse: only that matches real use for the registration order of Mantine's and the toolbar's two focus traps.
// A scenario where a collaborator makes the toolbar redraw and steal focus cannot be measured on a quiet single-user page; the format-toolbar case where another tab inserts a paragraph covers it.
test("C11c toolbar panel: real-keyboard Tab wraps from the last element to Back and Shift+Tab to the last, the menu stays open and nothing is typed into the note", async ({ browser }) => {
  test.setTimeout(120_000);
  const line = "keyboard target";
  const { context, page } = await startColorNote(browser, "tab toolbar", [line]);
  try {
    await selectText(page, line, 0, line.length);
    // Precondition: a usable button (create link) follows the color button, so the panel's last element is not the toolbar's last tabbable element.
    const enabledAfter = await enabledToolbarButtonsAfterColors(page);
    expect(enabledAfter.length, JSON.stringify(enabledAfter)).toBeGreaterThan(0);

    const panel = await openToolbarPanel(page, "text");
    await expectTabWrapsInPanel(page, panel);
  } finally {
    await context.close();
  }
});

test("C11c toolbar panel (table cell selection, no usable button after the color button): Tab/Shift+Tab still wrap inside the panel and bold is not toggled", async ({ browser }) => {
  test.setTimeout(120_000);
  // When the site has AI actions configured (other tests on the same stack set them) the toolbar gets a trailing AI button, so a usable button follows the color button and this case's scenario cannot be measured.
  // This page replaces the AI action list with an empty one, so the toolbar matches a site without AI actions.
  const { context, page } = await startColorNote(browser, "tab table", [], { viewport: WIDE }, (ctx) =>
    ctx.route("**/api/ai/actions", (route) => route.fulfill({ json: { actions: [] } })),
  );
  try {
    await pasteHtml(page, "<table><tr><td>cell one</td><td>cell two</td></tr></table>");
    const cells = editorLocator(page).locator("td");
    await expect(cells).toHaveCount(2);
    await expect(cells.nth(1)).toHaveText("cell two");

    const a = (await cells.nth(0).boundingBox())!;
    const b = (await cells.nth(1).boundingBox())!;
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 });
    await page.mouse.up();
    await expect(editorLocator(page).locator("td.selectedCell")).toHaveCount(2);
    await expect(page.locator(".bn-formatting-toolbar")).toBeVisible();

    // Precondition: no usable button follows the color button, so the panel's last element is also the toolbar's last tabbable element.
    const enabledAfter = await enabledToolbarButtonsAfterColors(page);
    expect(enabledAfter, JSON.stringify(enabledAfter)).toEqual([]);

    const panel = await openToolbarPanel(page, "text");
    await expectTabWrapsInPanel(page, panel);
    await expect(editorLocator(page).locator("td strong, td b")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("C11c drag handle panel: real-keyboard Tab wraps from the last element to Back and Shift+Tab to the last, the menu stays open and nothing is typed into the note", async ({ browser }) => {
  test.setTimeout(120_000);
  const line = "keyboard block";
  const { context, page } = await startColorNote(browser, "tab handle", [line]);
  try {
    const panel = await openBlockPanel(page, line, "text");
    await expectTabWrapsInPanel(page, panel);
  } finally {
    await context.close();
  }
});

test("C13 copying a paragraph with a custom inline color and block background into another note: after reload the colors match the original note", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: WIDE });
  try {
    const page = await context.newPage();
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: E2E_ORIGIN });
    await loginAs(page, ADMIN.email, ADMIN.password);
    await expect(page).toHaveURL(/\/$/);
    const stamp = Date.now();
    await createNote(page, `E2E colors copy source ${stamp}`);
    await pasteHtml(page, `<p data-background-color="${CUSTOM}">copy <span data-style-type="textColor" data-value="${CUSTOM}">me</span></p><p>tail</p>`);

    const probe = () =>
      editorLocator(page).evaluate((root, hex) => {
        const block = root.querySelector(`.bn-block:has(> .bn-block-content[data-background-color="${hex}"])`);
        const span = root.querySelector(`[data-style-type="textColor"][data-value="${hex}"]`);
        return {
          blockText: block?.querySelector(":scope > .bn-block-content")?.textContent ?? null,
          blockBg: block ? getComputedStyle(block).backgroundColor : null,
          spanText: span?.textContent ?? null,
          spanColor: span ? getComputedStyle(span).color : null,
        };
      }, CUSTOM);
    const expected = { blockText: "copy me", blockBg: RGB_CUSTOM, spanText: "me", spanColor: RGB_CUSTOM };
    await expect.poll(probe, { timeout: 15_000 }).toEqual(expected);

    // With the selection inside one block's text BlockNote copies only the inline content (built-in colors too); a block's background travels only when the selection spans into another block.
    // Ctrl+A in this editor is the browser's native select-all, which ProseMirror reads back as a text selection from the first paragraph's start to the last paragraph's end: with a single paragraph
    // it stays inside that paragraph, hence a trailing paragraph `tail`. The native select-all reaches the editor only on selectionchange, so before copying wait until the selection really spans blocks.
    await clickEndOfParagraph(page, paragraph(page, "copy me"));
    await page.keyboard.press("ControlOrMeta+a");
    await expect
      .poll(() =>
        editorLocator(page).evaluate((el) => {
          type Sel = { empty: boolean; $from: { sameParent(other: unknown): boolean }; $to: unknown };
          const selection = (el as Element & { editor?: { view?: { state: { selection: Sel } } } }).editor?.view?.state.selection;
          return selection ? !selection.empty && !selection.$from.sameParent(selection.$to) : null;
        }),
      )
      .toBe(true);
    await page.keyboard.press("ControlOrMeta+c");
    const copied = await page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      return items[0]?.types.includes("text/html") ? await (await items[0]!.getType("text/html")).text() : "";
    });
    expect(copied).toContain(`data-background-color="${CUSTOM}"`);

    const targetTitle = `E2E colors copy target ${stamp}`;
    await createNote(page, targetTitle);
    await editorLocator(page).click();
    await page.keyboard.press("ControlOrMeta+v");
    await expect.poll(probe, { timeout: 15_000 }).toEqual(expected);

    await page.reload();
    await expect(page.getByLabel("Note title")).toHaveValue(targetTitle, { timeout: 15_000 });
    await expect.poll(probe, { timeout: 15_000 }).toEqual(expected);
  } finally {
    await context.close();
  }
});

const TABLE_HTML = "<table><tr><td>a1</td><td>b1</td></tr><tr><td>a2</td><td>b2</td></tr></table>";

async function startTableNote(browser: Browser, name: string): Promise<{ context: BrowserContext; page: Page; title: string }> {
  const started = await startColorNote(browser, name, []);
  await pasteHtml(started.page, TABLE_HTML);
  const cells = editorLocator(started.page).locator("td");
  await expect(cells).toHaveCount(4);
  await expect(cells.nth(3)).toHaveText("b2");
  return started;
}

function tableCell(page: Page, text: string): Locator {
  return editorLocator(page).locator("td").filter({ hasText: new RegExp(`^${reEscape(text)}$`) }).first();
}

function tableTexts(page: Page): Promise<string[][]> {
  return editorLocator(page)
    .locator("tr")
    .evaluateAll((rows) =>
      rows.map((tr) =>
        Array.from(tr.querySelectorAll("td")).map((td) => {
          const copy = td.cloneNode(true) as Element;
          copy.querySelectorAll(".ProseMirror-widget").forEach((w) => w.remove());
          return copy.textContent ?? "";
        }),
      ),
    );
}

const cellHandle = (page: Page) => page.locator("button.bn-table-cell-handle");
// The row handle and column handle are the same component; the column handle is rotated 90 degrees with a transform.
const rowHandle = (page: Page) => page.locator('.bn-table-handle:not([style*="rotate"])');
const columnHandle = (page: Page) => page.locator('.bn-table-handle[style*="rotate"]');

type Box = { x: number; y: number; width: number; height: number };
const overlapsX = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width;
const overlapsY = (a: Box, b: Box) => a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Moves the mouse onto the cell `text` and waits until there is one cell handle, one row handle and one column handle, all aligned with that cell.
 * boundingBox throws when it matches several elements (retry until one is left): the copy of a handle overlay that is fading out is retried away too.
 */
async function hoverCell(page: Page, text: string): Promise<Locator> {
  const cell = tableCell(page, text);
  await cell.hover();
  await expect(async () => {
    const box = (await cell.boundingBox({ timeout: 1_000 }))!;
    const handle = await cellHandle(page).boundingBox({ timeout: 1_000 });
    const row = await rowHandle(page).boundingBox({ timeout: 1_000 });
    const column = await columnHandle(page).boundingBox({ timeout: 1_000 });
    const all = JSON.stringify({ box, handle, row, column });
    expect(handle && overlapsX(handle, box) && overlapsY(handle, box), `cell handle ${all}`).toBe(true);
    expect(row && overlapsY(row, box), `row handle ${all}`).toBe(true);
    expect(column && overlapsX(column, box), `column handle ${all}`).toBe(true);
  }).toPass({ timeout: 5_000 });
  return cell;
}

/** Opens the root menu by clicking a handle with the real mouse, and returns that handle's own dropdown (the trigger's `aria-controls` points to it). */
async function openTableMenu(page: Page, trigger: Locator): Promise<Locator> {
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const id = await trigger.getAttribute("aria-controls");
  expect(id, "trigger aria-controls").toBeTruthy();
  const menu = page.locator(`[id="${id}"]`);
  await expect(menu).toBeVisible();
  return menu;
}

async function openTablePanel(menu: Locator, section: "text" | "background"): Promise<Locator> {
  await menu.getByRole("menuitem", { name: "Colors", exact: true }).hover();
  const custom = menu.locator(`[data-test="${section}-color-custom"]`);
  await expect(custom).toBeVisible();
  await custom.click();
  const panel = menu.locator(".kb-color-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".react-colorful")).toBeVisible();
  return panel;
}

const panelHex = (panel: Locator) => panel.getByRole("textbox", { name: "Hex color" });
const panelApply = (panel: Locator) => panel.getByRole("button", { name: "Apply", exact: true });

test("C4a cell handle: Colors -> Background -> Custom... applies #ff6600; only that cell gets the background and it survives reload", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page, title } = await startTableNote(browser, "cell bg");
  try {
    await hoverCell(page, "b1");
    const menu = await openTableMenu(page, cellHandle(page));
    // The cell menu has only Colors (split cells is not enabled).
    await expect(menu.getByRole("menuitem")).toHaveText(["Colors"]);
    const panel = await openTablePanel(menu, "background");
    await panelHex(panel).fill(CUSTOM);
    await panelApply(panel).click();
    await expect(panel).toHaveCount(0);
    await expect(page.locator(".kb-color-panel")).toHaveCount(0);

    const editor = editorLocator(page);
    await expect(tableCell(page, "b1")).toHaveAttribute("data-background-color", CUSTOM);
    await expect(tableCell(page, "b1")).toHaveCSS("background-color", RGB_CUSTOM, { timeout: 10_000 });
    await expect(editor.locator("td[data-background-color]")).toHaveCount(1);

    await page.reload();
    await expect(page.getByLabel("Note title")).toHaveValue(title, { timeout: 15_000 });
    await expect(tableCell(page, "b1")).toHaveCSS("background-color", RGB_CUSTOM, { timeout: 15_000 });
    await expect(editor.locator("td[data-background-color]")).toHaveCount(1);
  } finally {
    await context.close();
  }
});

test("C4b row handle: Colors -> Text -> Custom... applies #0000ff; every cell of the row changes text color and the other row is unchanged", async ({ browser }) => {
  test.setTimeout(120_000);
  const blue = "#0000ff";
  const { context, page } = await startTableNote(browser, "row text");
  try {
    const before = await tableCell(page, "a2").evaluate((el) => getComputedStyle(el).color);
    expect(before).not.toBe("rgb(0, 0, 255)");

    await hoverCell(page, "a1");
    const menu = await openTableMenu(page, rowHandle(page));
    const panel = await openTablePanel(menu, "text");
    await panelHex(panel).fill(blue);
    await panelApply(panel).click();
    await expect(panel).toHaveCount(0);

    for (const text of ["a1", "b1"]) {
      await expect(tableCell(page, text)).toHaveAttribute("data-text-color", blue);
      await expect(tableCell(page, text), `${text} 的字色`).toHaveCSS("color", "rgb(0, 0, 255)", { timeout: 10_000 });
    }
    for (const text of ["a2", "b2"]) {
      await expect(tableCell(page, text)).not.toHaveAttribute("data-text-color");
      await expect(tableCell(page, text), `${text} 的字色`).toHaveCSS("color", before);
    }
  } finally {
    await context.close();
  }
});

test("C4c row/column handle menu: items are exactly delete, two inserts and Colors; inserting a row and deleting a column work; only one set of handles on screen", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await startTableNote(browser, "row col");
  try {
    await hoverCell(page, "a1");
    // Only one set of handles: if the built-in table handles were not turned off, another set would be stacked on top.
    await expect(cellHandle(page)).toHaveCount(1);
    await expect(page.locator(".bn-table-handle")).toHaveCount(2);
    await expect(rowHandle(page)).toHaveCount(1);
    await expect(columnHandle(page)).toHaveCount(1);

    // Open the cell menu right after closing the row menu: while the row handle overlay fades out the DOM still holds a copy of the row menu, and aria-controls finds only the cell menu.
    const peek = await openTableMenu(page, rowHandle(page));
    await expect(peek.getByRole("menuitem")).toHaveText(["Delete row", "Add row above", "Add row below", "Colors"]);
    await page.keyboard.press("Escape");
    await expect(rowHandle(page)).toHaveAttribute("aria-expanded", "false");
    await expect(cellHandle(page)).toHaveCount(1);
    const cellMenu = await openTableMenu(page, cellHandle(page));
    await expect(cellMenu.getByRole("menuitem")).toHaveText(["Colors"]);
    await page.keyboard.press("Escape");
    await expect(cellHandle(page)).toHaveAttribute("aria-expanded", "false");

    await hoverCell(page, "a1");
    const rowMenu = await openTableMenu(page, rowHandle(page));
    await expect(rowMenu.getByRole("menuitem")).toHaveText(["Delete row", "Add row above", "Add row below", "Colors"]);
    await rowMenu.getByRole("menuitem", { name: "Add row below", exact: true }).click();
    await expect.poll(() => tableTexts(page)).toEqual([["a1", "b1"], ["", ""], ["a2", "b2"]]);

    await hoverCell(page, "b2");
    const columnMenu = await openTableMenu(page, columnHandle(page));
    await expect(columnMenu.getByRole("menuitem")).toHaveText(["Delete column", "Add column left", "Add column right", "Colors"]);
    await columnMenu.getByRole("menuitem", { name: "Delete column", exact: true }).click();
    await expect.poll(() => tableTexts(page)).toEqual([["a1"], [""], ["a2"]]);

    await hoverCell(page, "a2");
    await expect(cellHandle(page)).toHaveCount(1);
    await expect(page.locator(".bn-table-handle")).toHaveCount(2);
  } finally {
    await context.close();
  }
});

test("C4d with the cell handle's panel open, another tab deletes the whole table: the panel disappears with the table, nothing is written and the page throws no exception", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page: pageA, title } = await startTableNote(browser, "cell remote delete");
  const errors: string[] = [];
  pageA.on("pageerror", (error) => errors.push(error.message));
  try {
    const pageB = await context.newPage();
    pageB.on("pageerror", (error) => errors.push(`B: ${error.message}`));
    await pageB.goto(pageA.url());
    await expect(pageB.getByLabel("Note title")).toHaveValue(title, { timeout: 15_000 });
    await expect(pageB.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible({ timeout: 15_000 });
    const editorB = editorLocator(pageB);
    await expect(editorB.locator("td")).toHaveCount(4, { timeout: 10_000 });

    await hoverCell(pageA, "b1");
    const menu = await openTableMenu(pageA, cellHandle(pageA));
    const panel = await openTablePanel(menu, "background");
    await panelHex(panel).fill(CUSTOM);
    await expect(panelApply(panel)).toBeEnabled();

    const tableB = editorB.locator(".bn-block-content", { has: pageB.locator("table") }).first();
    await editorB.locator("td", { hasText: "a2" }).first().hover();
    const handle = pageB.getByRole("button", { name: "Open block menu" });
    await expect(handle).toBeVisible();
    await expect(async () => {
      const side = await pageB.locator(".bn-side-menu").boundingBox();
      const box = await tableB.boundingBox();
      expect(side && box && overlapsY(side, box), JSON.stringify({ side, box })).toBe(true);
    }).toPass({ timeout: 5_000 });
    await handle.click();
    const blockMenu = pageB.locator(".bn-drag-handle-menu");
    await expect(blockMenu).toBeVisible();
    await blockMenu.getByRole("menuitem", { name: "Delete", exact: true }).click();
    await expect(editorB.locator("table")).toHaveCount(0);

    await expect(editorLocator(pageA).locator("table")).toHaveCount(0, { timeout: 10_000 });
    await expect(pageA.locator(".kb-color-panel")).toHaveCount(0, { timeout: 10_000 });
    // Nothing was written: read every 200 ms, three times; each time neither page has a table or this background.
    const reads: number[][] = [];
    await expect
      .poll(
        async () => {
          reads.push(await Promise.all([pageA, pageB].map((p) => editorLocator(p).locator(`table, [data-background-color="${CUSTOM}"]`).count())));
          return reads.length >= 3 ? reads : "reading";
        },
        { intervals: [200] },
      )
      .toEqual([[0, 0], [0, 0], [0, 0]]);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test("C11a cell handle panel: pressing on the saturation square, dragging 160 px outside the panel, pausing and releasing keeps the panel open, the value changed and Apply takes effect", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await startTableNote(browser, "cell drag outside");
  try {
    await hoverCell(page, "a1");
    const menu = await openTableMenu(page, cellHandle(page));
    const panel = await openTablePanel(menu, "background");
    const sat = (await panel.locator(".react-colorful__saturation").boundingBox())!;
    const box = (await panel.boundingBox())!;
    const y = sat.y + sat.height * 0.5;
    const outsideX = box.x + box.width + 160 < WIDE.width - 10 ? box.x + box.width + 160 : box.x - 160;
    await page.mouse.move(sat.x + sat.width * 0.6, sat.y + sat.height * 0.4);
    await page.mouse.down();
    await page.mouse.move(sat.x + sat.width * 0.3, y, { steps: 5 });
    await expect.poll(() => panelHex(panel).inputValue()).toMatch(/^#[0-9a-f]{6}$/);
    // The value reached inside the panel; after leaving the panel the pointer is still tracked and the saturation sticks to the edge (0% or 100%), so the value must change again.
    const inside = await panelHex(panel).inputValue();
    await page.mouse.move(outsideX, y, { steps: 10 });
    // Pause longer than the submenu's close delay: if the panel lived in a hover-opened submenu it would be closed during this time.
    await page.waitForTimeout(500);
    await page.mouse.up();

    await expect(panel).toBeVisible();
    await expect.poll(() => panelHex(panel).inputValue()).toMatch(/^#[0-9a-f]{6}$/);
    const dragged = await panelHex(panel).inputValue();
    expect(dragged).not.toBe(inside);
    await panelApply(panel).click();
    await expect(panel).toHaveCount(0);
    await expect(tableCell(page, "a1")).toHaveAttribute("data-background-color", dragged);
    await expect(tableCell(page, "a1")).toHaveCSS("background-color", hexToRgb(dragged), { timeout: 10_000 });
  } finally {
    await context.close();
  }
});

test("C11b cell handle panel: moving the mouse to the other end of the editor and pausing while halfway through typing a code, then finishing and pressing Enter, applies the full code", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await startTableNote(browser, "cell type move");
  try {
    await hoverCell(page, "a1");
    const menu = await openTableMenu(page, cellHandle(page));
    const panel = await openTablePanel(menu, "text");
    await panelHex(panel).click();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("#ff6");
    await expect(panelHex(panel)).toHaveValue("#ff6");

    const editorBox = (await editorLocator(page).boundingBox())!;
    await page.mouse.move(editorBox.x + editorBox.width - 10, editorBox.y + editorBox.height - 5, { steps: 10 });
    await page.waitForTimeout(500);
    await expect(panel).toBeVisible();

    await page.keyboard.type("600");
    await expect(panelHex(panel)).toHaveValue("#ff6600");
    await page.keyboard.press("Enter");
    await expect(panel).toHaveCount(0);
    await expect(tableCell(page, "a1")).toHaveAttribute("data-text-color", CUSTOM);
    await expect(tableCell(page, "a1")).toHaveCSS("color", RGB_CUSTOM, { timeout: 10_000 });
  } finally {
    await context.close();
  }
});
