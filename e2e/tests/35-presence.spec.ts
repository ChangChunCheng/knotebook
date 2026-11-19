import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { ADMIN, createNote, createUserViaInvite, editorLocator, loginAs, noteIdFromUrl, randomEmail, reEscape, waitForEditorSelection } from "./helpers.js";

/**
 * A read-only user has no cursor: in this file "B's avatar is no cursor" is the guard; red means the viewer also sent a cursor,
 * and the assertion must not be loosened.
 * Clicking the avatar of a deleted position scrolls to a neighbour, so scrolling is asserted only for avatars with "no cursor".
 */

const RUN = Date.now();

function scrollerOf(page: Page): Locator {
  return page.getByTestId("article-column").locator("xpath=ancestor::div[contains(@class,'overflow-y-auto')][1]");
}

const scrollTopOf = (page: Page) => scrollerOf(page).evaluate((el) => el.scrollTop);

/** For viewers only: waits for the read-only h1 title and the "Read-only" badge. */
async function waitConnectedOnNote(page: Page, title: string): Promise<void> {
  await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("status").filter({ hasText: /^Read-only/ })).toBeVisible({ timeout: 15_000 });
}

test("header avatar row: A sees B (no cursor), B sees A (outline colour, click scrolls to the cursor), one avatar for multiple tabs, two AIs, full list on a narrow screen, keyboard, disappears after closing", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(150_000);

  let ctxA: BrowserContext | undefined;
  let ctxB: BrowserContext | undefined;
  let anonymous: BrowserContext | undefined;
  try {
    ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    ctxB = await browser.newContext({ viewport: { width: 1280, height: 600 } });
    anonymous = await browser.newContext();
    const pageA = await ctxA.newPage();
    await loginAs(pageA, ADMIN.email, ADMIN.password);
    const title = `E2E presence ${RUN}`;
    await createNote(pageA, title);
    const noteUrl = pageA.url();
    const noteId = await noteIdFromUrl(pageA);
    const me = (await (await pageA.request.get("/api/auth/me")).json()) as { displayName: string };

    await editorLocator(pageA).click();
    for (let i = 0; i < 40; i++) {
      await pageA.keyboard.insertText(i === 39 ? `Last line ${RUN}` : `Line ${i} ${RUN}`);
      if (i < 39) await pageA.keyboard.press("Enter");
    }
    await expect(editorLocator(pageA)).toContainText(`Last line ${RUN}`);

    const bEmail = randomEmail();
    const bPassword = "e2e-presence-viewer-pw";
    await createUserViaInvite(pageA, { email: bEmail, password: bPassword, displayName: "E2E Viewer" });
    const shared = await pageA.request.put(`/api/notes/${noteId}/shares`, { data: { email: bEmail, role: "viewer" } });
    expect(shared.status(), await shared.text()).toBe(200);

    const pageB = await ctxB.newPage();
    await loginAs(pageB, bEmail, bPassword);
    await pageB.goto(noteUrl);
    await waitConnectedOnNote(pageB, title);
    // For the "read-only user has no cursor" guard to discriminate, B really clicks into the body (y-prosemirror sends a cursor
    // only while view.hasFocus()). Click an early paragraph, inside B's viewport, so no scrolling.
    await pageB.getByTestId("note-editor").getByText(`Line 2 ${RUN}`).click();

    const rowA = pageA.getByRole("group", { name: "Also viewing this note" });
    const bAvatar = rowA.getByRole("button", { name: "E2E Viewer, Viewer, no cursor right now" });
    await expect(bAvatar).toBeVisible({ timeout: 15_000 });
    await expect(rowA.getByRole("button", { name: new RegExp("^" + reEscape(me.displayName) + ",") })).toHaveCount(0);

    await bAvatar.hover();
    const tip = pageA.getByRole("tooltip");
    await expect(tip).toContainText("E2E Viewer · Viewer");
    await expect(tip).toContainText("No cursor right now");
    // Observation window for the negative assertion: if B (wrongly) sent a cursor, awareness has to reach A and render; assert again after at least 300 ms.
    await pageA.waitForTimeout(300);
    await expect(bAvatar).toBeVisible();

    const scrollBefore = await scrollTopOf(pageA);
    await bAvatar.click();
    expect(await scrollTopOf(pageA)).toBe(scrollBefore);

    // From here until the narrow-screen part A touches no other element, which keeps focus = the cursor.
    await editorLocator(pageA).getByText(`Last line ${RUN}`).click();
    // The caret lands at the end of the line, so on B's side that paragraph's text is not split by A's remote cursor widget.
    await pageA.keyboard.press("End");
    // A types nothing more, but the cursor position A sends (awareness) is read from PM's state.selection: wait for it to read back End, so the cursor on B's side starts at the line end and does not move during assertions.
    await waitForEditorSelection(pageA);

    const rowB = pageB.getByRole("group", { name: "Also viewing this note" });
    const aBtn = rowB.getByRole("button", {
      name: new RegExp("^" + reEscape(me.displayName) + ", Owner, go to their cursor$"),
    });
    await expect(aBtn).toBeVisible({ timeout: 10_000 });

    const caret = pageB.locator(".bn-collaboration-cursor__caret").first();
    await expect(caret).toBeAttached();
    const caretBg = await caret.evaluate((el) => getComputedStyle(el).backgroundColor);
    const shadow = await aBtn.locator("span[aria-hidden]").first().evaluate((el) => getComputedStyle(el).boxShadow);
    expect(shadow).toContain(caretBg);

    expect(await scrollTopOf(pageB)).toBe(0);
    await expect(caret).not.toBeInViewport();
    await aBtn.click();
    await expect.poll(() => scrollTopOf(pageB)).toBeGreaterThan(0);
    await expect(caret).toBeInViewport();

    const bAnyAvatar = rowA.getByRole("button", { name: /^E2E Viewer, Viewer,/ });
    const pageB2 = await ctxB.newPage();
    await pageB2.goto(noteUrl);
    await waitConnectedOnNote(pageB2, title);
    // A negative property needs a time window: when merging fails, the second avatar appears only after pageB2's awareness reaches A and renders (A has no observable "received" signal).
    await pageA.waitForTimeout(1_500);
    await expect(bAnyAvatar).toHaveCount(1);
    await pageB2.close();
    await pageA.waitForTimeout(1_500);
    await expect(bAnyAvatar).toHaveCount(1);

    const bMe = (await (await pageB.request.get("/api/auth/me")).json()) as { handle: string };
    const labels: string[] = [];
    for (const n of ["ai1", "ai2"]) {
      const name = `e2e-${n}-${RUN % 1_000_000}`;
      const created = await pageB.request.post("/api/auth/tokens", { data: { name, scope: "notes:read", expiresInDays: 30 } });
      expect(created.status(), await created.text()).toBe(201);
      const { token } = (await created.json()) as { token: string };
      const read = await anonymous.request.get(`${baseURL}/api/notes/${noteId}/content`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(read.status()).toBe(200);
      labels.push(name); // all lowercase without spaces, so the agent label equals the name (as in 13)
    }
    const agentBtn = (label: string) =>
      rowA.getByRole("button", { name: `${bMe.handle} (${label}), AI agent, go to its cursor` });
    await expect(agentBtn(labels[0]!)).toBeVisible({ timeout: 15_000 });
    await expect(agentBtn(labels[1]!)).toBeVisible({ timeout: 15_000 });
    const agentRing = await agentBtn(labels[0]!).locator("span[aria-hidden]").first().evaluate((el) => getComputedStyle(el).boxShadow);
    expect(agentRing).toContain("rgb(124, 58, 237)"); // AGENT_PRESENCE_COLOR #7c3aed
    await agentBtn(labels[0]!).hover();
    await expect(pageA.getByRole("tooltip")).toContainText(`${bMe.handle} (${labels[0]}) · AI agent`);
    await expect(bAnyAvatar).toHaveCount(1);

    // ai1's Tooltip is still open; after narrowing that avatar is hidden, so first move the mouse away to close the Tooltip, or it would cover +N.
    // Do not use hover() (it may move A's scroll, and the later Enter scroll needs scrollTop > 0). A Radix hoverable Tooltip leaving its trigger only builds a grace area and closes only when a later pointermove lands outside it (react-tooltip), so send two moves, retried on slow machines.
    const sb = (await scrollerOf(pageA).boundingBox())!;
    const cx = sb.x + sb.width / 2;
    const cy = sb.y + sb.height / 2;
    await expect(async () => {
      await pageA.mouse.move(cx, cy);
      await pageA.mouse.move(cx, cy + 60, { steps: 5 });
      await expect(pageA.getByRole("tooltip")).toHaveCount(0, { timeout: 1_000 });
    }).toPass({ timeout: 5_000 });
    await pageA.setViewportSize({ width: 390, height: 844 });
    // Phone width (< 640) shows no avatars, only a single "+N", where N is everyone else
    const personBtn = rowA.getByRole("button", { name: /, (go to (their|its) cursor|no cursor right now)$/ });
    await expect(personBtn).toHaveCount(0);
    const more = rowA.getByRole("button", { name: "3 more, show everyone" });
    await expect(more).toBeVisible();

    const header = rowA.locator("xpath=ancestor::header[1]");
    expect(await header.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const rowBox = (await rowA.boundingBox())!;
    const headerBox = (await header.boundingBox())!;
    expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(headerBox.x + headerBox.width + 0.5);

    await more.click();
    const menu = pageA.getByRole("menu", { name: "People on this note (3)" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem")).toHaveCount(3);
    const bRow = menu.getByRole("menuitem").filter({ hasText: "E2E Viewer" });
    await expect(bRow).toHaveAttribute("aria-disabled", "true");
    await expect(bRow).not.toHaveAttribute("data-disabled");
    await expect(bRow).toContainText("No cursor");
    await expect(bRow).toContainText(/E2E Viewer\s*Viewer/);
    await pageA.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(more).toBeFocused();

    await pageA.setViewportSize({ width: 1280, height: 800 });
    await expect(personBtn).toHaveCount(3);
    await expect(rowA.getByRole("button", { name: /more, show everyone/ })).toHaveCount(0);

    const first = rowA.getByRole("button").first();
    const second = rowA.getByRole("button").nth(1);
    await first.focus();
    await expect(pageA.getByRole("tooltip")).toBeVisible();
    const secondLabel = (await second.getAttribute("aria-label")) ?? "";
    // The second avatar's (AI) tooltip must contain its own name: `{handle} ({label}), AI agent, ...` -> `{handle} ({label}) · AI agent`
    const secondTip = secondLabel.replace(/, AI agent, (go to its cursor|no cursor right now)$/, " · AI agent");
    expect(secondTip).not.toBe(secondLabel);
    await pageA.keyboard.press("Tab");
    await expect(second).toBeFocused();
    await expect(pageA.getByRole("tooltip")).toContainText(secondTip);

    // Enter scrolls to the AI's cursor (document start): after A typed it sat at the bottom, so scrollTop must decrease; and no menu opens.
    const topBeforeEnter = await scrollTopOf(pageA);
    expect(topBeforeEnter).toBeGreaterThan(0);
    await rowA.getByRole("button", { name: /AI agent/ }).first().focus();
    await pageA.keyboard.press("Enter");
    await expect.poll(() => scrollTopOf(pageA)).toBeLessThan(topBeforeEnter);
    await expect(pageA.getByRole("menu")).toHaveCount(0);

    await pageB.close();
    await expect(bAnyAvatar).toHaveCount(0, { timeout: 35_000 });
    await expect(agentBtn(labels[0]!)).toBeVisible();
    await expect(agentBtn(labels[1]!)).toBeVisible();
  } finally {
    await ctxA?.close();
    await ctxB?.close();
    await anonymous?.close();
  }
});
