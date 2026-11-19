import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { E2E_ORIGIN } from "../ports.js";
import { ADMIN, createNote, createUserViaInvite, editorLocator, loginAs, noteIdFromUrl, randomEmail, reEscape, showSidebarTab, waitForEditorSelection } from "./helpers.js";

/**
 * E1-E6 are the site-link behaviours (E6: #352, drag from the sidebar); C1-C4 are cases that need a real browser; the touch case
 * of #269 is E6 in 22-presentation.spec.ts.
 * - A wikilink is always located by `[data-inline-content-type="wikilink"]` (the attribute BlockNote puts on the outer element
 *   of inline content).
 * - The e2e package does not import `@knotebook/shared` (rsync does not carry dist; same explanation as the 11-public-share
 *   header), so URLs are built by hand.
 * - A read-only editor (viewer, public page) has no `contenteditable="true"`, so `editorLocator` cannot find it - those
 *   scenarios are scoped to the page container.
 */

const ORIGIN = E2E_ORIGIN;
const WIKILINK = '[data-inline-content-type="wikilink"]';

async function grantClipboard(page: Page): Promise<void> {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: ORIGIN });
}

/** Pastes the text at the caret through the clipboard; the caller positions the caret. */
async function pasteAtCaret(page: Page, text: string): Promise<void> {
  await grantClipboard(page);
  await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  await page.keyboard.press("ControlOrMeta+v");
}

/** Pastes markdown at the end of the note (same shape as pasteMarkdown in 22-presentation; after Ctrl+End wait for ProseMirror to read back the selection before pasting, as in 34-columns). */
async function appendMarkdown(page: Page, markdown: string): Promise<void> {
  await editorLocator(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await waitForEditorSelection(page);
  await pasteAtCaret(page, markdown);
}

async function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

/** The block outer (`.bn-block-outer`) whose text is exactly `text`. When nested, take the innermost (ancestors come first in DOM order, so take the last). */
function blockOuterIn(root: Locator, text: string): Locator {
  return root
    .locator(".bn-block-outer")
    .filter({ has: root.page().locator(".bn-inline-content", { hasText: new RegExp(`^${reEscape(text)}$`) }) })
    .last();
}

function blockOuter(page: Page, text: string): Locator {
  return blockOuterIn(editorLocator(page), text);
}

async function blockIdOf(page: Page, text: string): Promise<string> {
  const id = await blockOuter(page, text).getAttribute("data-id");
  expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  return id!;
}

type WikilinkAttrs = { targetNoteId: string; label: string; anchorBlockId: string };

/** Props of every wikilink node in the main editor's ProseMirror document (document order). Reads the Tiptap editor attached to the contenteditable (same as `waitForEditorSelection`). */
async function wikilinkAttrs(page: Page): Promise<WikilinkAttrs[]> {
  return editorLocator(page).evaluate((el) => {
    type PmNode = { type: { name: string }; attrs: Record<string, string>; descendants(f: (n: PmNode) => boolean | void): void };
    const view = (el as Element & { editor?: { view?: { state: { doc: PmNode } } } }).editor?.view;
    if (!view) throw new Error("no-editor");
    const out: WikilinkAttrs[] = [];
    view.state.doc.descendants((n) => {
      if (n.type.name === "wikilink") out.push({ targetNoteId: n.attrs.targetNoteId!, label: n.attrs.label!, anchorBlockId: n.attrs.anchorBlockId! });
    });
    return out;
  });
}

async function createViewer(browser: Browser, adminPage: Page): Promise<{ context: BrowserContext; page: Page; email: string }> {
  const email = randomEmail();
  const password = "e2e-sitelinks-user-pw";
  await createUserViaInvite(adminPage, { email, password, displayName: "E2E Site Links Viewer" });

  const context = await browser.newContext();
  const page = await context.newPage();
  await loginAs(page, email, password);
  await expect(page).toHaveURL(/\/$/);
  return { context, page, email };
}

/** Shares the current note with the email (default role viewer, which the reader steps of E1 rely on). */
async function shareWith(page: Page, email: string): Promise<void> {
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Share note" });
  await dialog.getByRole("radio", { name: /Members only/ }).click();
  await dialog.getByLabel("Email address").fill(email);
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await expect(dialog.getByText(email)).toBeVisible();
  await page.keyboard.press("Escape");
}

async function makePublicToken(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Share note" });
  await dialog.getByRole("radio", { name: /^Public link/ }).check();
  const input = dialog.getByLabel("Public link URL");
  await expect(input).toHaveValue(/^[A-Za-z0-9_-]{43}$/, { timeout: 10_000 });
  const token = await input.inputValue();
  await page.keyboard.press("Escape");
  return token;
}

/** Turns on the public link for the current note and turns off Anonymous link (custom URL form); returns `/p/<handle>/<name>` (same shape as readAliasPath in 11-public-share). */
async function makePublicCustom(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Share note" });
  await dialog.getByRole("radio", { name: /^Public link/ }).check();
  const toggle = dialog.getByRole("switch", { name: "Anonymous link" });
  await expect(toggle).toBeChecked({ timeout: 10_000 });
  await toggle.click();
  const aliasInput = dialog.getByLabel("Custom public link", { exact: true });
  await expect(aliasInput).toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => aliasInput.inputValue()).not.toBe("");
  const prefix = await dialog.locator("#share-public-slug-prefix").innerText();
  expect(prefix).toMatch(/^\/p\/[a-z0-9-]+\/$/);
  const path = `${prefix}${await aliasInput.inputValue()}`;
  await page.keyboard.press("Escape");
  return path;
}

async function backlinkIds(page: Page, noteId: string): Promise<string[]> {
  const res = await page.request.get(`/api/notes/${noteId}/backlinks`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { backlinks: Array<{ id: string }> }).backlinks.map((b) => b.id);
}

/**
 * Highlight of a paragraph anchor (#269): useBlockAnchor lays a `.kn-anchor-flash[data-anchor-flash="<id>"]` overlay outside
 * ProseMirror's control. Assertions: the overlay appears, covers the block (within 1px), sits outside the editable DOM, has an
 * animation; it is still there after 300 ms (the old approach put an attribute on `.bn-block-outer`, and while editable
 * ProseMirror replaced that element within about 70 ms and the highlight vanished with it).
 */
async function expectAnchorFlash(page: Page, blockId: string): Promise<void> {
  const overlay = page.locator(`.kn-anchor-flash[data-anchor-flash="${blockId}"]`);
  await expect(overlay).toBeAttached({ timeout: 15_000 });
  const geo = await overlay.evaluate((el, id) => {
    const block = document.querySelector(`.bn-block-outer[data-id="${id}"]`)!.getBoundingClientRect();
    const o = el.getBoundingClientRect();
    return {
      dTop: Math.abs(o.top - block.top),
      dLeft: Math.abs(o.left - block.left),
      dWidth: Math.abs(o.width - block.width),
      dHeight: Math.abs(o.height - block.height),
      inEditable: el.closest('[contenteditable="true"], .ProseMirror') !== null,
      animation: getComputedStyle(el).animationName,
    };
  }, blockId);
  expect(geo).toEqual({ dTop: expect.any(Number), dLeft: expect.any(Number), dWidth: expect.any(Number), dHeight: expect.any(Number), inEditable: false, animation: "kn-anchor-flash" });
  for (const d of [geo.dTop, geo.dLeft, geo.dWidth, geo.dHeight]) expect(d).toBeLessThanOrEqual(1);
  await page.waitForTimeout(300);
  await expect(overlay).toBeAttached();
}

/**
 * `click` (Ctrl/Cmd+Click, middle click) must open exactly one new tab in the same context as `page`, navigated to
 * `targetPath`, with `page` itself not navigating; the new tab is closed after measuring.
 *
 * The new tab is recognised at the browser level (CDP `Target.getTargets`), not with `context.waitForEvent("page")`: in the
 * cloud the page event sometimes never arrives, and it reproduces locally under four-way parallel load (about once in several
 * dozen runs). When it reproduces, the browser did open a tab in the same context, Playwright had attached to it and the tab
 * had navigated to the target URL, but within 30 s there was no page event and `context.pages()` did not contain it - what is
 * lost is Playwright's report, not the tab (the click event was neither intercepted nor preventDefault-ed, and the event
 * sequence on the page is identical for success and failure).
 */
async function expectClickOpensNewTab(browser: Browser, page: Page, click: () => Promise<void>, targetPath: string): Promise<void> {
  const before = page.url();
  const pageSession = await page.context().newCDPSession(page);
  const { targetInfo: self } = await pageSession.send("Target.getTargetInfo");
  await pageSession.detach();
  const pathOf = (url: string) => {
    try {
      return new URL(url).pathname;
    } catch {
      return "";
    }
  };
  const browserSession = await browser.newBrowserCDPSession();
  try {
    const tabsAtTarget = async () =>
      (await browserSession.send("Target.getTargets")).targetInfos.filter(
        (t) => t.type === "page" && t.browserContextId === self.browserContextId && t.targetId !== self.targetId && pathOf(t.url) === targetPath,
      );
    expect(await tabsAtTarget(), "點擊前同一個 context 不該已有開在目標網址的分頁").toHaveLength(0);
    await click();
    await expect
      .poll(async () => (await tabsAtTarget()).length, { timeout: 15_000, message: `同一個 context 要多出一個開在 ${targetPath} 的分頁` })
      .toBe(1);
    expect(page.url()).toBe(before);
    for (const t of await tabsAtTarget()) await browserSession.send("Target.closeTarget", { targetId: t.targetId });
    // A closed tab that Playwright had reported must also disappear from context.pages(), or the later "tab count unchanged" assertion would count it
    await expect.poll(async () => (await tabsAtTarget()).length + page.context().pages().filter((p) => pathOf(p.url()) === targetPath).length).toBe(0);
  } finally {
    await browserSession.detach();
  }
}

async function headingButtonGeometry(outer: Locator): Promise<{ lineMid: number; lineRight: number; buttonMid: number; buttonLeft: number }> {
  return outer.evaluate((el) => {
    const inline = el.querySelector(":scope > .bn-block > .bn-block-content > .bn-inline-content")!;
    const range = document.createRange();
    range.selectNodeContents(inline);
    const line = range.getClientRects()[0]!;
    const button = document.querySelector('button[aria-label="Copy link to this section"]')!.getBoundingClientRect();
    return { lineMid: line.top + line.height / 2, lineRight: line.right, buttonMid: button.top + button.height / 2, buttonLeft: button.left };
  });
}

test("E1: a reader's plain click navigates in the same tab; Ctrl+Click and middle click open a new tab; an editor's hover shows the toolbar (no \"Open\") and a plain click navigates in the same tab", async ({ browser }) => {
  test.setTimeout(180_000);
  const adminContext = await browser.newContext();
  let viewer: { context: BrowserContext; page: Page; email: string } | undefined;
  try {
    const admin = await adminContext.newPage();
    await loginAs(admin, ADMIN.email, ADMIN.password);
    viewer = await createViewer(browser, admin);
    const stamp = String(Date.now());

    const targetTitle = `E2E sl target ${stamp}`;
    await createNote(admin, targetTitle);
    const targetPath = new URL(admin.url()).pathname;
    const targetId = await noteIdFromUrl(admin);
    await shareWith(admin, viewer.email);

    await createNote(admin, `E2E sl source ${stamp}`);
    const sourceUrl = admin.url();
    await shareWith(admin, viewer.email);
    await appendMarkdown(admin, `see [${targetTitle}](/notes/${targetId})\n`);
    const adminLink = editorLocator(admin).locator(WIKILINK);
    await expect(adminLink).toHaveCount(1, { timeout: 10_000 });

    await adminLink.hover();
    const adminToolbar = admin.getByRole("dialog", { name: "Note link" });
    await expect(adminToolbar).toHaveAttribute("data-state", "open");
    await expect(adminToolbar.getByRole("button")).toHaveText(["Edit text", "Change target", "Remove link"]);
    expect(admin.url()).toBe(sourceUrl);
    await admin.keyboard.press("Escape");
    await expect(adminToolbar).not.toBeVisible();

    // Ctrl/Cmd+Click on the contentEditable=false island inside the contenteditable (the measurement point); the hover toolbar may appear with the mouse resting on the link and is not asserted here
    await expectClickOpensNewTab(browser, admin, () => adminLink.locator("a").click({ modifiers: ["ControlOrMeta"] }), targetPath);
    expect(admin.url()).toBe(sourceUrl);

    const adminPagesBefore = adminContext.pages().length;
    await adminLink.locator("a").click();
    await admin.waitForURL((u) => u.pathname === targetPath, { timeout: 15_000 });
    expect(adminContext.pages().length).toBe(adminPagesBefore);

    const vp = viewer.page;
    await vp.goto(sourceUrl);
    await expect(vp.getByRole("status").filter({ hasText: /^Read-only/ })).toBeVisible({ timeout: 15_000 });
    const link = vp.locator(`[data-testid="note-editor"] ${WIKILINK} a`, { hasText: targetTitle });
    await expect(link).toHaveAttribute("href", targetPath, { timeout: 10_000 });

    await expectClickOpensNewTab(browser, vp, () => link.click({ modifiers: ["ControlOrMeta"] }), targetPath);
    expect(vp.url()).toBe(sourceUrl);

    await expectClickOpensNewTab(browser, vp, () => link.click({ button: "middle" }), targetPath);
    expect(vp.url()).toBe(sourceUrl);

    const pagesBefore = viewer.context.pages().length;
    await link.click();
    await vp.waitForURL((u) => u.pathname === targetPath, { timeout: 15_000 });
    await expect(vp.getByRole("heading", { name: targetTitle, level: 1 })).toBeVisible({ timeout: 15_000 });
    expect(viewer.context.pages().length).toBe(pagesBefore);
  } finally {
    await viewer?.context.close();
    await adminContext.close();
  }
});

test("E2: opening #b-<id> scrolls to and highlights it; a missing id stays at the top without error; ?present#b- does not scroll; same-note anchors do not reload and Back returns to before the click", async ({ browser }) => {
  test.setTimeout(150_000);
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    const stamp = String(Date.now());
    await createNote(page, `E2E sl anchor ${stamp}`);
    const noteUrl = page.url();
    const notePath = new URL(noteUrl).pathname;
    const noteId = await noteIdFromUrl(page);
    const paras = Array.from({ length: 40 }, (_, i) => `para ${i + 1}`);
    await appendMarkdown(page, paras.join("\n\n") + "\n");
    await expect(editorLocator(page).getByText("para 40", { exact: true })).toBeVisible({ timeout: 15_000 });
    const targetId = await blockIdOf(page, "para 35");

    const cold = await context.newPage();
    const coldErrors: string[] = [];
    cold.on("pageerror", (e) => coldErrors.push(e.message));
    await cold.goto(`${noteUrl}#b-${targetId}`);
    const coldTarget = cold.locator(`.bn-block-outer[data-id="${targetId}"]`);
    await expectAnchorFlash(cold, targetId); // owner = editable editor: the highlight overlay must survive ProseMirror redraws
    await expect(coldTarget).toBeInViewport();
    expect(coldErrors).toEqual([]);

    const missing = await context.newPage();
    const missingErrors: string[] = [];
    missing.on("pageerror", (e) => missingErrors.push(e.message));
    await missing.goto(`${noteUrl}#b-doesnotexist`);
    await expect(missing.locator(`.bn-block-outer[data-id="${targetId}"]`)).toBeAttached({ timeout: 15_000 });
    // Wait out the 2 s give-up window: a missing id stays at the top without an error
    await missing.waitForTimeout(2_500);
    await expect(missing.getByText("para 1", { exact: true })).toBeInViewport();
    expect(missingErrors).toEqual([]);
    await missing.close();
    await cold.close();

    // During presentation playback (?present) #b- is ignored: the note underneath does not scroll. The guard is not.toBeInViewport
    // (para 35 is within 40 paragraphs and is outside the viewport if not scrolled); the highlight overlay is not asserted -
    // after waiting 1.5 s, even if the anchor was consumed the overlay may already have expired and been removed, so 0 of them proves nothing.
    const present = await context.newPage();
    await present.goto(`${noteUrl}?present#b-${targetId}`);
    await expect(present.locator(".reveal.ready")).toBeVisible({ timeout: 15_000 });
    const presentTarget = present.locator(`.bn-block-outer[data-id="${targetId}"]`);
    await expect(presentTarget).toBeAttached();
    await present.waitForTimeout(1_500); // presentation ready requires synced; if the anchor were consumed it would scroll at sync - wait one more beat
    await expect(presentTarget).not.toBeInViewport();
    await present.close();

    // Same-note anchor: add a link at the top of the note pointing at this note's para 35 (self-link conversion), and click it directly in edit mode
    await editorLocator(page).getByText("para 1", { exact: true }).click();
    await page.keyboard.press("Home");
    await waitForEditorSelection(page);
    await pasteAtCaret(page, `[jump](/notes/${noteId}#b-${targetId}) `);
    const jump = editorLocator(page).locator(WIKILINK, { hasText: "jump" });
    await expect(jump).toHaveCount(1, { timeout: 10_000 });
    await page.evaluate(() => {
      (window as unknown as { __kbMarker?: number }).__kbMarker = 1;
    });
    await jump.locator("a").click();
    await page.waitForURL((u) => u.pathname === notePath && u.hash === `#b-${targetId}`, { timeout: 10_000 });
    await expect(page.locator(`.bn-block-outer[data-id="${targetId}"]`)).toBeInViewport({ timeout: 5_000 });
    await expectAnchorFlash(page, targetId);
    expect(await page.evaluate(() => (window as unknown as { __kbMarker?: number }).__kbMarker)).toBe(1);

    await page.goBack();
    await page.waitForURL((u) => u.pathname === notePath && u.hash === "", { timeout: 10_000 });
    expect(await page.evaluate(() => (window as unknown as { __kbMarker?: number }).__kbMarker)).toBe(1);
  } finally {
    await context.close();
  }
});

test("E3: the drag handle's \"Copy link to block\" and the heading \"#\" write the right URL to the clipboard; \"#\" is vertically centred on the first line; a viewer also has \"#\" but no handle menu", async ({ browser }) => {
  test.setTimeout(180_000);
  const adminContext = await browser.newContext();
  let viewer: { context: BrowserContext; page: Page; email: string } | undefined;
  try {
    const admin = await adminContext.newPage();
    await loginAs(admin, ADMIN.email, ADMIN.password);
    viewer = await createViewer(browser, admin);
    await createNote(admin, `E2E sl copy ${Date.now()}`);
    const noteUrl = admin.url();
    const notePath = new URL(noteUrl).pathname;
    await shareWith(admin, viewer.email);
    await appendMarkdown(admin, "## Copy heading\n\ncopy para\n");
    await expect(editorLocator(admin).getByText("copy para", { exact: true })).toBeVisible({ timeout: 15_000 });
    const paraId = await blockIdOf(admin, "copy para");
    const headingId = await blockIdOf(admin, "Copy heading");
    await grantClipboard(admin);

    await blockOuter(admin, "copy para").hover();
    await admin.getByRole("button", { name: "Open block menu" }).click();
    await admin.getByRole("menuitem", { name: "Copy link to block" }).click();
    await expect(admin.getByText("Block link copied", { exact: true }).first()).toBeVisible();
    expect(await readClipboard(admin)).toBe(`${ORIGIN}${notePath}#b-${paraId}`);

    await blockOuter(admin, "Copy heading").hover();
    const hash = admin.getByRole("button", { name: "Copy link to this section" });
    await expect(hash).toBeVisible();
    const geo = await headingButtonGeometry(blockOuter(admin, "Copy heading"));
    expect(Math.abs(geo.buttonMid - geo.lineMid)).toBeLessThanOrEqual(1);
    expect(geo.buttonLeft).toBeGreaterThanOrEqual(geo.lineRight);
    await hash.click();
    expect(await readClipboard(admin)).toBe(`${ORIGIN}${notePath}#b-${headingId}`);

    // viewer: has "#", no handle menu (a read-only editor has no contenteditable="true", so scope to the note-editor container)
    const vp = viewer.page;
    await grantClipboard(vp);
    await vp.goto(noteUrl);
    await expect(vp.getByRole("status").filter({ hasText: /^Read-only/ })).toBeVisible({ timeout: 15_000 });
    const viewerEditor = vp.getByTestId("note-editor");
    await blockOuterIn(viewerEditor, "Copy heading").hover();
    await vp.getByRole("button", { name: "Copy link to this section" }).click();
    expect(await readClipboard(vp)).toBe(`${ORIGIN}${notePath}#b-${headingId}`);
    await blockOuterIn(viewerEditor, "copy para").hover();
    await expect(vp.getByRole("button", { name: "Open block menu" })).toHaveCount(0);

    await blockOuter(admin, "Copy heading").hover();
    await expect(hash).toBeVisible();
    await editorLocator(admin).evaluate((el, text) => {
      type PmNode = { type: { name: string }; nodeSize: number; textContent: string; firstChild: PmNode | null; descendants(f: (n: PmNode, pos: number) => boolean | void): void };
      type View = { state: { doc: PmNode; tr: { delete(from: number, to: number): unknown } }; dispatch(tr: unknown): void };
      const view = (el as Element & { editor?: { view?: View } }).editor!.view!;
      let range: [number, number] | null = null;
      view.state.doc.descendants((n, pos) => {
        if (range) return false;
        if (n.type.name === "blockContainer" && n.firstChild?.type.name === "heading" && n.firstChild.textContent === text) range = [pos, pos + n.nodeSize];
        return true;
      });
      if (!range) throw new Error("heading not found");
      view.dispatch(view.state.tr.delete(range[0], range[1]));
    }, "Copy heading");
    await expect(blockOuter(admin, "Copy heading")).toHaveCount(0);
    await expect(hash).toHaveCount(0);
  } finally {
    await viewer?.context.close();
    await adminContext.close();
  }
});

test("E4: pasting [x](/n/...) mid-paragraph, typing /g/... in the link dialog, typing http://.../notes/<id> followed by a space -> all become wikilinks and appear in the target's backlinks", async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    const stamp = String(Date.now());

    await createNote(page, `E2E sl t1 ${stamp}`);
    const t1Path = new URL(page.url()).pathname;
    const t1Id = await noteIdFromUrl(page);
    await createNote(page, `E2E sl t3 ${stamp}`);
    const t3Id = await noteIdFromUrl(page);

    const groupRes = await page.request.post("/api/groups", { headers: { Origin: ORIGIN }, data: { name: `E2E sl group ${stamp}` } });
    expect(groupRes.status()).toBe(201);
    const groupId = ((await groupRes.json()) as { id: string }).id;
    const t2Res = await page.request.post("/api/notes", { headers: { Origin: ORIGIN }, data: { title: `E2E sl t2 ${stamp}`, groupId } });
    expect(t2Res.status()).toBe(201);
    const t2 = (await t2Res.json()) as { id: string; slug: string };
    const t2Path = `/g/${groupId}/${t2.slug}`;

    await createNote(page, `E2E sl writer ${stamp}`);
    const sourceId = await noteIdFromUrl(page);
    const wikilinks = editorLocator(page).locator(WIKILINK);

    await editorLocator(page).click();
    await page.keyboard.type("alpha omega");
    await page.keyboard.press("Home");
    for (let i = 0; i < "alpha ".length; i += 1) await page.keyboard.press("ArrowRight");
    await waitForEditorSelection(page);
    await pasteAtCaret(page, `[x](${t1Path})`);
    await expect(wikilinks.filter({ hasText: "x" })).toHaveCount(1, { timeout: 10_000 });

    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/Link");
    await expect(page.locator(".bn-suggestion-menu")).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Enter");
    const linkDialog = page.getByRole("dialog", { name: "Insert link" });
    await linkDialog.getByLabel("Display text").fill("group target");
    await linkDialog.getByLabel("URL").fill(t2Path);
    await linkDialog.getByRole("button", { name: "Insert" }).click();
    await expect(wikilinks.filter({ hasText: "group target" })).toHaveCount(1, { timeout: 10_000 });

    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type(`${ORIGIN}/notes/${t3Id} `);
    await expect(wikilinks).toHaveCount(3, { timeout: 10_000 });

    // Backlinks (the client sends the link set with a debounce - poll)
    for (const target of [t1Id, t2.id, t3Id]) {
      await expect(async () => {
        expect(await backlinkIds(page, target)).toContain(sourceId);
      }).toPass({ timeout: 20_000 });
    }
  } finally {
    await context.close();
  }
});

test("E5: public page - custom-URL targets are clickable and go to /p/...; non-public targets and token-only targets are plain text; cold open of #b- scrolls and highlights; \"#\" copies the public URL; same-note anchors do not reload; no /api/notes requests", async ({ browser }) => {
  test.setTimeout(180_000);
  const ownerContext = await browser.newContext();
  const anonContext = await browser.newContext();
  try {
    const owner = await ownerContext.newPage();
    await loginAs(owner, ADMIN.email, ADMIN.password);
    const stamp = String(Date.now());

    const pubTitle = `E2E sl pub ${stamp}`;
    await createNote(owner, pubTitle);
    const pubId = await noteIdFromUrl(owner);
    const pubPath = await makePublicCustom(owner);

    await createNote(owner, `E2E sl priv ${stamp}`);
    const privId = await noteIdFromUrl(owner);

    await createNote(owner, `E2E sl tok ${stamp}`);
    const tokId = await noteIdFromUrl(owner);
    await makePublicToken(owner);

    await createNote(owner, `E2E sl public source ${stamp}`);
    const sourceId = await noteIdFromUrl(owner);
    const fillers = Array.from({ length: 30 }, (_, i) => `filler ${i + 1}`);
    await appendMarkdown(owner, [`links [pub](/notes/${pubId}) [priv](/notes/${privId}) [tok](/notes/${tokId})`, "## Pub heading", ...fillers].join("\n\n") + "\n");
    await expect(editorLocator(owner).getByText("filler 30", { exact: true })).toBeVisible({ timeout: 15_000 });
    const anchorId = await blockIdOf(owner, "filler 28");
    const headingId = await blockIdOf(owner, "Pub heading");
    await appendMarkdown(owner, `[jump](/notes/${sourceId}#b-${anchorId})\n`);
    await expect(editorLocator(owner).locator(WIKILINK)).toHaveCount(4, { timeout: 10_000 });
    const token = await makePublicToken(owner);

    // The public snapshot (persist debounce) has caught up: all four wikilinks are in the ydoc
    await expect(async () => {
      const res = await owner.request.get(`/api/public/notes/${token}`);
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { ydoc: string; links: Array<{ id: string; path: string }> };
      expect(Buffer.from(body.ydoc, "base64").toString("utf8")).toContain(anchorId);
      expect(body.links.map((l) => l.id)).toEqual([pubId]);
    }).toPass({ timeout: 20_000 });

    const anon = await anonContext.newPage();
    const apiNotesHits: string[] = [];
    anon.on("request", (r) => {
      if (new URL(r.url()).pathname === "/api/notes") apiNotesHits.push(r.url());
    });

    await anon.goto(`/p/${token}#b-${anchorId}`);
    const coldTarget = anon.locator(`.bn-block-outer[data-id="${anchorId}"]`);
    await expectAnchorFlash(anon, anchorId);
    await expect(coldTarget).toBeInViewport();

    await anon.goto(`/p/${token}`);
    // "jump" is an inline link pasted at the end of the last paragraph (filler 30), so that paragraph's text is no longer exactly "filler 30" - use filler 29 to tell the body has loaded
    await expect(anon.getByText("filler 29", { exact: true })).toBeAttached({ timeout: 15_000 });
    const scope = anon.locator(WIKILINK);
    await expect(scope.filter({ hasText: "pub" }).locator("a")).toHaveAttribute("href", pubPath);
    for (const text of ["priv", "tok"]) {
      await expect(scope.filter({ hasText: text })).toBeVisible();
      await expect(scope.filter({ hasText: text }).locator("a")).toHaveCount(0);
    }

    await grantClipboard(anon);
    await blockOuterIn(anon.locator("body"), "Pub heading").hover();
    await anon.getByRole("button", { name: "Copy link to this section" }).click();
    expect(await readClipboard(anon)).toBe(`${ORIGIN}/p/${token}#b-${headingId}`);

    await anon.evaluate(() => {
      (window as unknown as { __kbMarker?: number }).__kbMarker = 1;
    });
    await scope.filter({ hasText: "jump" }).locator("a").click();
    await anon.waitForURL((u) => u.hash === `#b-${anchorId}`, { timeout: 10_000 });
    await expect(anon.locator(`.bn-block-outer[data-id="${anchorId}"]`)).toBeInViewport({ timeout: 5_000 });
    expect(await anon.evaluate(() => (window as unknown as { __kbMarker?: number }).__kbMarker)).toBe(1);

    await scope.filter({ hasText: "pub" }).locator("a").click();
    await anon.waitForURL((u) => u.pathname === pubPath, { timeout: 15_000 });
    await expect(anon.getByText(pubTitle).first()).toBeVisible({ timeout: 15_000 });

    expect(apiNotesHits).toEqual([]);
  } finally {
    await anonContext.close();
    await ownerContext.close();
  }
});

test("C1: selecting text that contains a wikilink - copy and paste back keeps the wikilink (label / anchor) and the clipboard is non-empty; dragging moves it keeping the wikilink; an editable wikilink itself cannot be dragged out as a plain link", async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    const stamp = String(Date.now());
    await createNote(page, `E2E sl c1 target ${stamp}`);
    const targetId = await noteIdFromUrl(page);
    await createNote(page, `E2E sl c1 source ${stamp}`);
    await appendMarkdown(page, ["copy src [lbl](/notes/" + targetId + "#b-anc1) tail", "drop here", "paste here"].join("\n\n") + "\n");
    const editor = editorLocator(page);
    const wikilinks = editor.locator(WIKILINK);
    await expect(wikilinks).toHaveCount(1, { timeout: 10_000 });
    const expected: WikilinkAttrs = { targetNoteId: targetId, label: "lbl", anchorBlockId: "anc1" };
    expect(await wikilinkAttrs(page)).toEqual([expected]);
    // Locate the paragraph by its starting text (`^`): after paste/drop other paragraphs also contain "copy src"
    const srcInline = editor.locator(".bn-inline-content", { hasText: /^copy src/ });
    const pasted = editor.locator(".bn-inline-content", { hasText: /^paste here/ });
    const dropInline = editor.locator(".bn-inline-content", { hasText: /^drop here/ });

    // Select the whole paragraph (wikilink included) -> Ctrl+C: both the clipboard's plain text and HTML are non-empty (before the fix serializeForClipboard threw and the clipboard was empty)
    await grantClipboard(page);
    await page.evaluate(() => navigator.clipboard.writeText(""));
    await srcInline.click({ position: { x: 4, y: 4 } });
    await page.keyboard.press("Home");
    await waitForEditorSelection(page);
    await page.keyboard.press("Shift+End");
    await page.keyboard.press("ControlOrMeta+c");
    const copied = await page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      const html = items[0]?.types.includes("text/html") ? await (await items[0]!.getType("text/html")).text() : "";
      return { text: await navigator.clipboard.readText(), html };
    });
    expect(copied.text).toContain("lbl");
    expect(copied.html).toContain("lbl");

    await pasted.click();
    await page.keyboard.press("End");
    await waitForEditorSelection(page);
    await page.keyboard.press("ControlOrMeta+v");
    await expect(wikilinks).toHaveCount(2, { timeout: 10_000 });
    await expect(pasted.locator(WIKILINK)).toHaveCount(1);
    expect(await wikilinkAttrs(page)).toEqual([expected, expected]);
    await expect(editor.locator("a[href]")).toHaveCount(2);

    await srcInline.click({ position: { x: 4, y: 4 } });
    await page.keyboard.press("Home");
    await waitForEditorSelection(page);
    await page.keyboard.press("Shift+End");
    // Drop on the right part of the target row (80% of the block outer's width): while dragging, BlockNote's side-menu button
    // overlaps the start of the paragraph text (dragover landed on the mantine Button, which did not preventDefault => no drop
    // fired), so dropping on the text does not work. posAtCoords on the right part lands at the end of that paragraph.
    const from = (await srcInline.boundingBox())!;
    const dropOuter = editor.locator(".bn-block-outer").filter({ has: page.locator(".bn-inline-content", { hasText: /^drop here/ }) }).last();
    const to = (await dropOuter.boundingBox())!;
    await page.mouse.move(from.x + 8, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 40, from.y + from.height / 2, { steps: 5 });
    await page.mouse.move(to.x + to.width * 0.8, to.y + to.height / 2, { steps: 10 });
    await page.mouse.move(to.x + to.width * 0.8 + 2, to.y + to.height / 2);
    await page.mouse.up();
    await expect(dropInline.locator(WIKILINK)).toHaveCount(1, { timeout: 10_000 });
    await expect(dropInline).toContainText("copy src");
    await expect(srcInline).toHaveCount(0);
    expect(await wikilinkAttrs(page)).toEqual([expected, expected]);
    await expect(editor.locator("a[href]")).toHaveCount(2);

    // The editable wikilink itself (draggable=false): press and drag it to another paragraph and release => no plain link appears and the wikilink does not move
    // Release at the same point as above (the right part of the target row - the previous step proved a drop is accepted there): if the <a> could be natively dragged, a plain link would appear here
    const linkBox = (await pasted.locator(WIKILINK).boundingBox())!;
    const target = (await dropOuter.boundingBox())!;
    await page.mouse.move(linkBox.x + linkBox.width / 2, linkBox.y + linkBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(linkBox.x + linkBox.width / 2 + 20, linkBox.y + linkBox.height / 2, { steps: 5 });
    await page.mouse.move(target.x + target.width * 0.8, target.y + target.height / 2, { steps: 10 });
    await page.mouse.move(target.x + target.width * 0.8 + 2, target.y + target.height / 2);
    await page.mouse.up();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    await expect(pasted.locator(WIKILINK)).toHaveCount(1);
    await expect(dropInline.locator(WIKILINK)).toHaveCount(1);
    await expect(editor.locator("a[href]")).toHaveCount(2);
    expect(await wikilinkAttrs(page)).toEqual([expected, expected]);
  } finally {
    await context.close();
  }
});

test("E6 (#352): dragging a note from the sidebar into the editor -> becomes a wikilink to it (empty label), no plain link, URL unchanged; after a pause one Ctrl+Z removes the whole thing", async ({ browser }) => {
  test.setTimeout(180_000);
  const adminContext = await browser.newContext();
  let user: { context: BrowserContext; page: Page; email: string } | undefined;
  try {
    const admin = await adminContext.newPage();
    await loginAs(admin, ADMIN.email, ADMIN.password);
    // New user: the sidebar contains only this test's notes
    user = await createViewer(browser, admin);
    const page = user.page;
    const stamp = String(Date.now());
    const titleN = `E2E sl e6 source ${stamp}`;

    await createNote(page, titleN);
    const nId = await noteIdFromUrl(page);
    await createNote(page, `E2E sl e6 host ${stamp}`);
    const editor = editorLocator(page);
    await editor.click();
    await page.keyboard.type(`drop target ${stamp}`);
    const dropInline = editor.locator(".bn-inline-content", { hasText: /^drop target / });
    await expect(dropInline).toHaveText(`drop target ${stamp}`);

    const panel = await showSidebarTab(page, "My notes");
    const link = panel.getByRole("link", { name: titleN, exact: true });
    const nPath = (await link.getAttribute("href"))!;
    expect(nPath).toMatch(/^\/n\//);
    const urlBefore = page.url();

    // Hand-written mouse (as in C1: drop on the right part of the target row, since the side-menu button overlaps the start of the paragraph text while dragging). Do not use dragTo / dragAndDrop.
    const from = (await link.boundingBox())!;
    const dropOuter = editor.locator(".bn-block-outer").filter({ has: page.locator(".bn-inline-content", { hasText: /^drop target / }) }).last();
    const to = (await dropOuter.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 30, from.y + from.height / 2, { steps: 5 });
    await page.mouse.move(to.x + to.width * 0.8, to.y + to.height / 2, { steps: 10 });
    await page.mouse.move(to.x + to.width * 0.8 + 2, to.y + to.height / 2);
    // Pause at least 600 ms before dropping (a semantic pause so the undo history separates the drop from the earlier typing, not a wait condition)
    await page.waitForTimeout(600);
    await page.mouse.up();

    await expect(dropInline.locator(WIKILINK)).toHaveCount(1, { timeout: 10_000 });
    expect(await wikilinkAttrs(page)).toEqual([{ targetNoteId: nId, label: "", anchorBlockId: "" }]);
    await expect(editor.locator(`a[href$="${nPath}"]:not(${WIKILINK} a)`)).toHaveCount(0);
    expect(page.url()).toBe(urlBefore);
    await page.keyboard.press("ControlOrMeta+z");
    await expect(editor.locator(WIKILINK)).toHaveCount(0);
    await expect(dropInline).toHaveText(`drop target ${stamp}`);
    await expect(editor.locator("a[href]")).toHaveCount(0);
  } finally {
    await user?.context.close();
    await adminContext.close();
  }
});

test("C2: hover A shows its toolbar -> moving into the toolbar does not close it -> a real mouse move to B leaves only B's toolbar; moving away closes it and focus is not pulled into the editor", async ({ browser }) => {
  test.setTimeout(150_000);
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    const stamp = String(Date.now());
    await createNote(page, `E2E sl c2 a ${stamp}`);
    const aId = await noteIdFromUrl(page);
    await createNote(page, `E2E sl c2 b ${stamp}`);
    const bId = await noteIdFromUrl(page);
    await createNote(page, `E2E sl c2 source ${stamp}`);
    await appendMarkdown(page, `first [link A](/notes/${aId}) then [link B](/notes/${bId}) end\n`);
    const editor = editorLocator(page);
    await expect(editor.locator(WIKILINK)).toHaveCount(2, { timeout: 10_000 });
    const toolbars = page.getByRole("dialog", { name: "Note link" });

    const center = async (l: Locator) => {
      const box = (await l.boundingBox())!;
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };
    const a = await center(editor.locator(WIKILINK, { hasText: "link A" }));
    await page.mouse.move(a.x, a.y, { steps: 5 });
    // A closing Popover's content still passes toBeVisible: always assert Radix's open/closed state (data-state is "closed" when closed)
    await expect(toolbars).toHaveAttribute("data-state", "open");
    expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') ?? null)).toBeNull();

    // Move slowly into the toolbar: it leaves the link and crosses a 4px gap on the way, and the toolbar does not close
    const t = await center(toolbars);
    await page.mouse.move(t.x, t.y, { steps: 10 });
    await page.waitForTimeout(600);
    await expect(toolbars).toHaveCount(1);
    await expect(toolbars).toHaveAttribute("data-state", "open");

    const b = await center(editor.locator(WIKILINK, { hasText: "link B" }));
    await page.mouse.move(b.x, b.y, { steps: 10 });
    await page.waitForTimeout(800); // A's delayed close + close transition, B's delayed open
    await expect(toolbars).toHaveCount(1);
    await expect(toolbars).toHaveAttribute("data-state", "open");
    await toolbars.getByRole("button", { name: "Edit text" }).click();
    await expect(toolbars.getByRole("textbox", { name: "Link text" })).toHaveValue("link B");
    await page.mouse.move(b.x, b.y + 200, { steps: 5 });
    await page.waitForTimeout(600);
    await expect(toolbars).toHaveAttribute("data-state", "open");
    await page.keyboard.press("Escape");
    await expect(toolbars).toHaveCount(0);
    // After Esc closes it, focus returns to the editor, but that is Radix FocusScope's onCloseAutoFocus, queued with its own
    // setTimeout(0) when it unmounts: it may not have run yet when toHaveCount(0) passes, and then a blur would be overridden by
    // its late editor.focus() (when the next hover opens the toolbar it records "the editor had focus at open" as true, and
    // focus ends up in the editor).
    // So wait for focus to really return to the editor, and only then blur.
    await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[data-testid="note-editor"]') != null)).toBe(true);

    // Hover-only open and move-away-only: it closes and focus is not pulled into the editor (first let focus sit on body - Esc and similar ways of closing would give focus back to the editor in this case)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    await page.mouse.move(a.x, a.y, { steps: 5 });
    await expect(toolbars).toHaveAttribute("data-state", "open");
    await page.mouse.move(a.x, a.y + 200, { steps: 5 });
    await expect(toolbars).toHaveCount(0);
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  } finally {
    await context.close();
  }
});

/**
 * Touch long press: CDP `Input.dispatchTouchEvent` touchStart -> hold `ms` -> touchEnd (`page.touchscreen.tap` takes the same
 * CDP path, only without the hold). Chromium's gesture recognizer treats it as real touch: pointer events carry
 * `pointerType: "touch"`, a long press may fire contextmenu, and a short tap synthesizes click.
 */
async function touchHold(page: Page, at: { x: number; y: number }, ms: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: at.x, y: at.y }] });
    await page.waitForTimeout(ms);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await cdp.detach();
  }
}

test("C4: touch (hasTouch) - plain link and wikilink: long press (about 0.5 s) shows the toolbar and does not navigate; short tap navigates (plain link opens a new tab, wikilink the same tab)", async ({ browser }) => {
  test.setTimeout(150_000);
  const context = await browser.newContext({ hasTouch: true });
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    const stamp = String(Date.now());
    const targetTitle = `E2E sl c4 target ${stamp}`;
    await createNote(page, targetTitle);
    const targetPath = new URL(page.url()).pathname;
    const targetId = await noteIdFromUrl(page);
    await createNote(page, `E2E sl c4 source ${stamp}`);
    const sourceUrl = page.url();
    await appendMarkdown(page, `wiki [link W](/notes/${targetId}) and ext [link E](https://example.com/kn-e2e-${stamp}) end\n`);
    const editor = editorLocator(page);
    const wiki = editor.locator(WIKILINK, { hasText: "link W" });
    const ext = editor.locator('a[data-inline-content-type="link"]', { hasText: "link E" });
    await expect(wiki).toHaveCount(1, { timeout: 10_000 });
    await expect(ext).toHaveCount(1);
    const center = async (l: Locator) => {
      const box = (await l.boundingBox())!;
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };
    // External URLs do not go over the network: intercept and answer with a blank page, so the new tab's URL is still visible
    await context.route("https://example.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<p>ok</p>" }));
    const popups: Page[] = [];
    context.on("page", (p) => popups.push(p));

    await touchHold(page, await center(ext), 800);
    const linkToolbar = page.locator(".bn-link-toolbar");
    await expect(linkToolbar).toBeVisible();
    await expect(linkToolbar.getByRole("button", { name: "Open in new tab" })).toBeVisible();
    await page.waitForTimeout(800);
    expect(popups).toHaveLength(0);
    expect(page.url()).toBe(sourceUrl);
    await expect(linkToolbar).toBeVisible(); // a synthesized event (if any) did not close the toolbar that just opened

    const popupPromise = context.waitForEvent("page", { timeout: 10_000 });
    await page.touchscreen.tap((await center(ext)).x, (await center(ext)).y);
    const popup = await popupPromise;
    await popup.waitForURL((u) => u.pathname === `/kn-e2e-${stamp}`, { timeout: 10_000 });
    await popup.close();
    expect(page.url()).toBe(sourceUrl);

    await touchHold(page, await center(wiki), 800);
    const toolbar = page.getByRole("dialog", { name: "Note link" });
    await expect(toolbar).toHaveAttribute("data-state", "open");
    await expect(toolbar.getByRole("button")).toHaveText(["Edit text", "Change target", "Remove link"]);
    await page.waitForTimeout(800);
    expect(page.url()).toBe(sourceUrl);
    await expect(toolbar).toHaveAttribute("data-state", "open");

    await page.keyboard.press("Escape");
    await expect(toolbar).toHaveCount(0);
    await touchHold(page, await center(wiki), 100);
    await page.waitForURL((u) => u.pathname === targetPath, { timeout: 15_000 });
    expect(context.pages()).toHaveLength(1);
  } finally {
    await context.close();
  }
});

test("C3: stale tab (collab-token with an old schema version) - the note page shows a refresh banner and is read-only; presentation mode shows no banner and its toolbar says a refresh is needed", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    const title = `E2E sl outdated ${Date.now()}`;
    await createNote(page, title);
    await appendMarkdown(page, "## Outdated slide\n\noutdated text\n");
    await expect(editorLocator(page).getByText("outdated text", { exact: true })).toBeVisible({ timeout: 15_000 });
    const noteUrl = page.url();

    // Simulate a tab from before the gate: the token request carries no new version (the server signs sv=0 and the handshake is rejected as client-outdated)
    const stale = await context.newPage();
    await stale.route("**/api/notes/*/collab-token", (route) => route.continue({ postData: JSON.stringify({ noteSchemaVersion: 0 }) }));
    await stale.goto(noteUrl);
    const message = "Knotebook has been updated. Reload the page to keep editing. Changes in this tab that haven't synced won't be kept after reloading.";
    await expect(stale.getByRole("alert").filter({ hasText: message })).toBeVisible({ timeout: 15_000 });
    await expect(stale.getByRole("status").filter({ hasText: /^Reload required/ })).toBeVisible();
    await expect(stale.locator('[data-testid="note-editor"] [contenteditable="true"]')).toHaveCount(0);
    await expect(stale.getByRole("heading", { name: title, level: 1 })).toBeVisible();

    await stale.goto(`${noteUrl}?present`);
    const shell = stale.getByRole("dialog", { name: `${title} — presentation` });
    await expect(shell).toBeVisible({ timeout: 15_000 });
    await expect(shell.getByText("Reload required")).toBeVisible({ timeout: 15_000 });
    const banner = stale.getByText(message);
    await expect(banner).toBeAttached();
    const covered = await banner.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit === null || !el.contains(hit);
    });
    expect(covered).toBe(true);
  } finally {
    await context.close();
  }
});
