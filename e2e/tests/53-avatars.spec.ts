import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { ADMIN, createNote, createUserViaInvite, loginAs, noteIdFromUrl, openSiteAdmin, randomEmail, showSidebarTab, solidPng } from "./helpers.js";

/**
 * 53-1 covers the whole upload UI; 53-2 and 53-3 set avatars through the API and check other people's avatars in lists.
 *
 * The site upload limit is shared by the whole stack, so it is restored in a finally block, and both the change and the restore go
 * through the API rather than the UI.
 */

const RUN = Date.now();

async function waitForNoteTitle(page: Page): Promise<void> {
  await expect(page.getByLabel("Note title")).toBeVisible({ timeout: 15_000 });
}

async function setUploadMaxBytes(page: Page, value: number | null): Promise<void> {
  const res = await page.request.patch("/api/admin/limits", { data: { set: { uploadMaxBytes: value } } });
  expect(res.status(), `PATCH /api/admin/limits → HTTP ${res.status()} ${await res.text()}`).toBe(200);
}

test("53-1 avatar: upload and crop (256x256 display image) -> sidebar -> others see it in the header -> delete falls back to the initial -> over-limit upload is rejected", async ({ browser }) => {
  test.setTimeout(180_000);

  const contexts: BrowserContext[] = [];
  const open = async (): Promise<Page> => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    contexts.push(ctx);
    return ctx.newPage();
  };
  try {
    const aliceName = `Alice ${RUN}`;
    const bobName = `Bob ${RUN}`;
    const alice = { email: randomEmail(), password: "e2e-avatar-alice-pw", displayName: aliceName };
    const bob = { email: randomEmail(), password: "e2e-avatar-bob-pw", displayName: bobName };

    const adminPage = await open();
    await loginAs(adminPage, ADMIN.email, ADMIN.password);
    await adminPage.goto("/");
    await createUserViaInvite(adminPage, alice);
    await createUserViaInvite(adminPage, bob);

    const alicePage = await open();
    await loginAs(alicePage, alice.email, alice.password);
    const title = `E2E avatar ${RUN}`;
    await createNote(alicePage, title);
    const noteUrl = alicePage.url();
    const noteId = await noteIdFromUrl(alicePage);
    const shared = await alicePage.request.put(`/api/notes/${noteId}/shares`, { data: { email: bob.email, role: "viewer" } });
    expect(shared.status(), await shared.text()).toBe(200);

    await alicePage.goto("/settings/account");
    const group = alicePage.getByRole("radiogroup", { name: "Picture options" });
    await expect(group.getByRole("radio", { name: "No picture", exact: true })).toHaveAttribute("aria-checked", "true");
    await expect(group.getByRole("radio")).toHaveCount(1);

    await alicePage.getByTestId("avatar-file-input").setInputFiles({ name: "a.png", mimeType: "image/png", buffer: solidPng(600, 400) });
    const dialog = alicePage.getByRole("dialog", { name: "Adjust picture", exact: true });
    await expect(dialog).toBeVisible();
    const area = dialog.getByRole("application");
    const box = await area.boundingBox();
    expect(box, "裁切區域應有版面").not.toBeNull();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;
    await alicePage.mouse.move(cx, cy);
    await alicePage.mouse.down();
    await alicePage.mouse.move(cx + 12, cy + 6, { steps: 6 });
    await alicePage.mouse.up();
    const zoom = dialog.getByRole("slider", { name: "Zoom", exact: true });
    const min = Number(await zoom.getAttribute("min"));
    const max = Number(await zoom.getAttribute("max"));
    await zoom.fill((min + (max - min) * 0.5).toFixed(2));
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).not.toBeVisible({ timeout: 15_000 });

    await expect(group.getByRole("radio")).toHaveCount(2);
    await expect(group.getByRole("radio").nth(1)).toHaveAttribute("aria-checked", "true");
    await expect(group.getByRole("radio", { name: "No picture", exact: true })).toHaveAttribute("aria-checked", "false");

    // The display image is the browser's canvas encoding (only e2e exercises that path): the served image decodes to 256x256.
    const me = (await (await alicePage.request.get("/api/auth/me")).json()) as { avatar: { id: string; v: number; pending: boolean } | null };
    expect(me.avatar, "選用後 /me 應帶 avatar").not.toBeNull();
    const shown = await alicePage.evaluate(async ({ id, v }) => {
      const res = await fetch(`/api/avatars/${id}?v=${v}`);
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob);
      return { status: res.status, type: blob.type, width: bitmap.width, height: bitmap.height };
    }, { id: me.avatar!.id, v: me.avatar!.v });
    expect(shown.status).toBe(200);
    expect(shown.type).toMatch(/^image\/(webp|jpeg|png)$/);
    expect([shown.width, shown.height]).toEqual([256, 256]);

    // Re-cropping goes through a different request (PUT); the display version must increase.
    await group.getByRole("radio").nth(1).hover();
    await alicePage.getByRole("button", { name: /^More actions for / }).click();
    await alicePage.getByRole("menuitem", { name: "Adjust crop", exact: true }).click();
    await expect(dialog).toBeVisible();
    const box2 = await dialog.getByRole("application").boundingBox();
    expect(box2, "裁切區域應有版面").not.toBeNull();
    await alicePage.mouse.move(box2!.x + box2!.width / 2, box2!.y + box2!.height / 2);
    await alicePage.mouse.down();
    await alicePage.mouse.move(box2!.x + box2!.width / 2 - 20, box2!.y + box2!.height / 2, { steps: 6 });
    await alicePage.mouse.up();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).not.toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => ((await (await alicePage.request.get("/api/auth/me")).json()) as { avatar: { v: number } | null }).avatar?.v)
      .toBeGreaterThan(me.avatar!.v);

    // The settings page has no sidebar, so go back to the note page; wait for the title box first, because the lazy page's
    // shell swap must finish before the sidebar is touched.
    await alicePage.goto(noteUrl);
    await waitForNoteTitle(alicePage);
    const accountButton = alicePage.getByRole("button", { name: aliceName, exact: true });
    const accountImg = accountButton.locator("img");
    await expect(accountImg).toHaveCount(1);
    await expect.poll(() => accountImg.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 15_000 }).toBeGreaterThan(0);

    const bobPage = await open();
    await loginAs(bobPage, bob.email, bob.password);
    await bobPage.goto(noteUrl);
    await expect(bobPage.getByRole("heading", { name: title, level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(bobPage.getByRole("status").filter({ hasText: /^Read-only/ })).toBeVisible({ timeout: 15_000 });
    const row = bobPage.getByRole("group", { name: "Also viewing this note" });
    const aliceInRow = row.getByRole("button", { name: new RegExp(`^${aliceName},`) });
    await expect(aliceInRow).toBeVisible({ timeout: 35_000 });
    await expect(aliceInRow.locator("img")).toHaveCount(1, { timeout: 35_000 });

    await alicePage.goto("/settings/account");
    await expect(group.getByRole("radio")).toHaveCount(2);
    await group.getByRole("radio").nth(1).hover();
    await alicePage.getByRole("button", { name: /^More actions for / }).click();
    await alicePage.getByRole("menuitem", { name: "Delete", exact: true }).click();
    const confirm = alicePage.getByRole("dialog", { name: "Delete this picture?", exact: true });
    await confirm.getByRole("button", { name: "Delete", exact: true }).click();
    // Settings is a modal, so the toast region outside it is hidden from the accessibility tree: find by text, not role.
    await expect(alicePage.getByText("Deleted. Your initial is shown instead.", { exact: true })).toBeVisible();
    await expect(group.getByRole("radio")).toHaveCount(1);
    await alicePage.goto(noteUrl);
    await waitForNoteTitle(alicePage);
    await expect(accountButton).toBeVisible();
    await expect(accountButton.locator("img")).toHaveCount(0);
    await expect(accountButton.locator("span").first()).toHaveText("A");

    try {
      await setUploadMaxBytes(adminPage, 1_048_576);
      // Picking a file before the site settings arrive skips the browser-side size pre-check, so wait for that response first.
      const authConfig = alicePage.waitForResponse(r => r.url().endsWith("/api/auth/config") && r.ok());
      await alicePage.goto("/settings/account");
      await authConfig;
      await expect(group.getByRole("radio")).toHaveCount(1);
      await alicePage.getByTestId("avatar-file-input").setInputFiles({
        name: "big.png",
        mimeType: "image/png",
        buffer: Buffer.alloc(1_572_864),
      });
      await expect(alicePage.getByRole("alert").filter({ hasText: /larger than the .* limit/ })).toBeVisible();
      await expect(alicePage.getByRole("dialog", { name: "Adjust picture", exact: true })).toHaveCount(0);
    } finally {
      await setUploadMaxBytes(adminPage, null);
    }
  } finally {
    await Promise.all(contexts.map(ctx => ctx.close().catch(() => undefined)));
  }
});

async function setAvatarViaApi(page: Page): Promise<{ id: string; v: number }> {
  const res = await page.request.post("/api/auth/avatars", {
    multipart: {
      original: { name: "o.png", mimeType: "image/png", buffer: solidPng(300, 300) },
      display: { name: "d.png", mimeType: "image/png", buffer: solidPng(256, 256) },
      crop: JSON.stringify({ x: 0, y: 0, size: 300, width: 300, height: 300 }),
    },
  });
  expect(res.status(), `POST /api/auth/avatars → HTTP ${res.status()} ${await res.text()}`).toBe(201);
  const me = (await (await page.request.get("/api/auth/me")).json()) as { avatar: { id: string; v: number; pending: boolean } | null };
  expect(me.avatar, "上傳後 /me 應帶 avatar").not.toBeNull();
  expect(me.avatar!.pending).toBe(false);
  return { id: me.avatar!.id, v: me.avatar!.v };
}

/** Waits for naturalWidth > 0: an <img> node alone doesn't prove the picture loaded. */
async function expectLoadedImg(scope: Locator): Promise<Locator> {
  const img = scope.locator("img");
  await expect(img).toHaveCount(1, { timeout: 15_000 });
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 15_000 }).toBeGreaterThan(0);
  return img;
}

test("53-2 avatars on lists (bob views alice): group member table and version history show images; users without one show none; the server serves each person's image once across screens; the last-edit byline has no image", async ({ browser }) => {
  test.setTimeout(180_000);
  const contexts: BrowserContext[] = [];
  const open = async (): Promise<Page> => {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    contexts.push(ctx);
    return ctx.newPage();
  };
  try {
    const aliceName = `Alice ${RUN}`;
    const bobName = `Bob ${RUN}`;
    const alice = { email: randomEmail(), password: "e2e-avatar-alice-pw", displayName: aliceName };
    const bob = { email: randomEmail(), password: "e2e-avatar-bob-pw", displayName: bobName };
    const adminPage = await open();
    await loginAs(adminPage, ADMIN.email, ADMIN.password);
    await adminPage.goto("/");
    await createUserViaInvite(adminPage, alice);
    await createUserViaInvite(adminPage, bob);

    const alicePage = await open();
    await loginAs(alicePage, alice.email, alice.password);
    const aliceAvatar = await setAvatarViaApi(alicePage);
    const groupName = `E2E avatar group ${RUN}`;
    const g = await alicePage.request.post("/api/groups", { data: { name: groupName } });
    expect(g.status(), await g.text()).toBe(201);
    const groupId = ((await g.json()) as { id: string }).id;
    const added = await alicePage.request.put(`/api/groups/${groupId}/members`, { data: { email: bob.email } });
    expect(added.status(), await added.text()).toBe(200);
    const title = `E2E avatar list ${RUN}`;
    const created = await alicePage.request.post("/api/notes", { data: { title, groupId } });
    expect(created.status(), await created.text()).toBe(201);
    const noteId = ((await created.json()) as { id: string }).id;
    const wrote = await alicePage.request.post(`/api/notes/${noteId}/edits`, { data: { op: "append", markdown: "Written by alice." } });
    expect(wrote.status(), await wrote.text()).toBe(201);
    const saved = await alicePage.request.post(`/api/notes/${noteId}/versions`, { data: { name: "first" } });
    expect(saved.status(), await saved.text()).toBe(201);
    const aliceSrc = `/api/avatars/${aliceAvatar.id}?v=${aliceAvatar.v}`;

    const bobPage = await open();
    await loginAs(bobPage, bob.email, bob.password);
    // Playwright's request event also fires for memory-cache hits, so use CDP and count only requests that reached the server.
    const cdp = await bobPage.context().newCDPSession(bobPage);
    await cdp.send("Network.enable");
    const avatarIds = new Map<string, string>();
    const servedFromCache = new Set<string>();
    cdp.on("Network.requestWillBeSent", e => {
      if (new URL(e.request.url).pathname === `/api/avatars/${aliceAvatar.id}`) avatarIds.set(e.requestId, e.request.url);
    });
    cdp.on("Network.requestServedFromCache", e => servedFromCache.add(e.requestId));
    cdp.on("Network.responseReceived", e => {
      if (e.response.fromDiskCache || e.response.fromPrefetchCache) servedFromCache.add(e.requestId);
    });
    await bobPage.goto("/");
    // bob is a regular member, so the group menu item is "View members" (it is "Members & settings" with the manage-members permission).
    await showSidebarTab(bobPage, "Groups");
    await bobPage.getByRole("complementary").getByRole("button", { name: `Group actions for ${groupName}` }).click();
    await bobPage.getByRole("menuitem", { name: "View members" }).click();
    await expect(bobPage).toHaveURL(/\/groups\/[0-9a-f-]{36}$/);
    const dialog = bobPage.getByRole("dialog", { name: groupName });
    const aliceRow = dialog.getByRole("row").filter({ hasText: aliceName });
    const bobRow = dialog.getByRole("row").filter({ hasText: bobName });
    await expect(aliceRow).toHaveCount(1, { timeout: 15_000 });
    await expect(bobRow).toHaveCount(1, { timeout: 15_000 });
    await expect(await expectLoadedImg(aliceRow)).toHaveAttribute("src", aliceSrc);
    await expect(bobRow.locator("img")).toHaveCount(0);

    // Navigating inside the SPA: within one document an image with the same URL is not requested from the server again.
    await bobPage.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    const sidebar = bobPage.getByRole("complementary");
    const noteRow = sidebar.getByText(title, { exact: true });
    await expect(sidebar.getByRole("button", { name: groupName, exact: true })).toHaveAttribute("aria-expanded", "true");
    await expect(noteRow).toBeVisible({ timeout: 15_000 });
    await noteRow.click();
    await waitForNoteTitle(bobPage);

    const lastEdited = bobPage.getByTestId("last-edited");
    await expect(lastEdited).toBeVisible({ timeout: 15_000 });
    await expect(lastEdited.locator("img")).toHaveCount(0);

    await bobPage.getByTestId("versions-bubble").click();
    const panel = bobPage.getByTestId("versions-panel");
    await expect(panel).toBeVisible();
    const editorAvatar = panel.locator("[data-editor-avatar]");
    await expect(editorAvatar).toHaveCount(1, { timeout: 15_000 });
    await expect(await expectLoadedImg(editorAvatar)).toHaveAttribute("src", aliceSrc);

    // Both screens use the same URL, so the server is asked only once.
    // The second screen may not show up here at all, so its request is not counted: while the image the
    // first screen loaded is still alive, Chromium reuses it for the same URL in the same document and
    // reports no network event; once garbage collection has freed it, the second <img> is fetched again
    // and served from the HTTP cache. Which one happens depends on GC timing. The src check on each
    // screen above is what shows both used the same URL.
    const hitServer = [...avatarIds.keys()].filter(id => !servedFromCache.has(id));
    expect(hitServer, `alice 的圖發出 ${avatarIds.size} 個請求，其中 ${hitServer.length} 個到了伺服器`).toHaveLength(1);
  } finally {
    await Promise.all(contexts.map(ctx => ctx.close().catch(() => undefined)));
  }
});

test("53-3 avatars on lists (alice views bob): suggestion list, share list (after adding and after reopening), site admin users table", async ({ browser }) => {
  test.setTimeout(180_000);
  const contexts: BrowserContext[] = [];
  const open = async (): Promise<Page> => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    contexts.push(ctx);
    return ctx.newPage();
  };
  try {
    const aliceName = `Alice ${RUN}`;
    const bobName = `Bob ${RUN}`;
    const alice = { email: randomEmail(), password: "e2e-avatar-alice-pw", displayName: aliceName };
    const bob = { email: randomEmail(), password: "e2e-avatar-bob-pw", displayName: bobName };
    const adminPage = await open();
    await loginAs(adminPage, ADMIN.email, ADMIN.password);
    await adminPage.goto("/");
    await createUserViaInvite(adminPage, alice);
    await createUserViaInvite(adminPage, bob);

    // alice must share a group with bob: the suggestion list only looks among people already known.
    const bobPage = await open();
    await loginAs(bobPage, bob.email, bob.password);
    const bobAvatar = await setAvatarViaApi(bobPage);
    const bobSrc = `/api/avatars/${bobAvatar.id}?v=${bobAvatar.v}`;
    const alicePage = await open();
    await loginAs(alicePage, alice.email, alice.password);
    const g = await alicePage.request.post("/api/groups", { data: { name: `E2E avatar known ${RUN}` } });
    expect(g.status(), await g.text()).toBe(201);
    const added = await alicePage.request.put(`/api/groups/${((await g.json()) as { id: string }).id}/members`, { data: { email: bob.email } });
    expect(added.status(), await added.text()).toBe(200);

    await alicePage.goto("/");
    await createNote(alicePage, `E2E avatar share ${RUN}`);
    await alicePage.getByRole("button", { name: "Share", exact: true }).click();
    const shareDialog = alicePage.getByRole("dialog", { name: "Share note" });
    await shareDialog.getByRole("radio", { name: /Members only/ }).click();

    const emailBox = shareDialog.getByLabel("Email address");
    await emailBox.fill(bob.email.slice(0, 10));
    const option = alicePage.getByRole("listbox").getByRole("option").filter({ hasText: bobName });
    await expect(option).toHaveCount(1, { timeout: 15_000 });
    await expect(await expectLoadedImg(option)).toHaveAttribute("src", bobSrc);

    // The row right after adding is rendered from the PUT response.
    await emailBox.fill(bob.email);
    await shareDialog.getByRole("button", { name: "Add", exact: true }).click();
    const shareRow = shareDialog.getByRole("listitem").filter({ hasText: bob.email });
    await expect(shareRow).toHaveCount(1, { timeout: 15_000 });
    await expect(await expectLoadedImg(shareRow)).toHaveAttribute("src", bobSrc);

    // After reload the list is refetched (GET).
    await alicePage.reload();
    await waitForNoteTitle(alicePage);
    await alicePage.getByRole("button", { name: "Share", exact: true }).click();
    const reopened = alicePage.getByRole("dialog", { name: "Share note" });
    const reopenedRow = reopened.getByRole("listitem").filter({ hasText: bob.email });
    await expect(reopenedRow).toHaveCount(1, { timeout: 15_000 });
    await expect(await expectLoadedImg(reopenedRow)).toHaveAttribute("src", bobSrc);

    const admin = await openSiteAdmin(adminPage);
    const table = admin.getByRole("table", { name: "Users", exact: true });
    const bobUserRow = table.getByRole("row").filter({ hasText: bob.email });
    await expect(bobUserRow).toHaveCount(1, { timeout: 15_000 });
    // The image is loading="lazy": with many users in the stack this row may be outside the scroll area and only loads once scrolled into view.
    await bobUserRow.scrollIntoViewIfNeeded();
    await expect(await expectLoadedImg(bobUserRow)).toHaveAttribute("src", bobSrc);
    const aliceUserRow = table.getByRole("row").filter({ hasText: alice.email });
    await expect(aliceUserRow).toHaveCount(1);
    await expect(aliceUserRow.locator("img")).toHaveCount(0);
  } finally {
    await Promise.all(contexts.map(ctx => ctx.close().catch(() => undefined)));
  }
});
