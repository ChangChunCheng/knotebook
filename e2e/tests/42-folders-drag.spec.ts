import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  ADMIN,
  createUserViaInvite,
  dragMoveTo,
  dragTo,
  editorLocator,
  folderRow,
  loginAs,
  randomEmail,
  reEscape,
  showSidebarTab,
  submitFolderName,
  toastWithTitle,
} from "./helpers.js";

/**
 * Each test creates its own user via `createUserViaInvite` and logs in as it (folders change the visible rows of a shared account); data is
 * created via API, then `goto("/")`. Drags always use `dragTo`/`dragMoveTo` (page.mouse, Chromium) and wait only through assertions (drop
 * marker `data-drop-scope`, preview `data-node-kind="preview"`), never waitForTimeout; triggers that need a 0.5 s hover (spring, preview) are
 * asserted by waiting for them to appear, not by timing. Negative assertions wait for a positive anchor first; toast assertions anchor the full text.
 * Hovering 0.5 s over another note in the same space that is droppable and at depth < 5 shows the stack-folder preview (canStack in
 * `evaluateDragOver` in drag-zone.ts), so a case that wants to drop at root (42-2) releases in the empty area below the list, not on a note row.
 */

test.use({ viewport: { width: 1280, height: 720 } });

const RUN = Date.now();
const PASSWORD = "e2e-folders-drag-pw";
/** Outer element of a wikilink (attribute BlockNote adds to inline content). */
const WIKILINK = '[data-inline-content-type="wikilink"]';
type FolderParent = { parentId: string } | { space: { kind: "personal" } | { kind: "group"; groupId: string } };

/** ADMIN issues an invite to create a new user, logged in on `page` (lands on `/`). */
async function asNewUser(page: Page, displayName: string): Promise<void> {
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);
  const email = randomEmail();
  await createUserViaInvite(page, { email, password: PASSWORD, displayName });
  await page.context().clearCookies();
  await loginAs(page, email, PASSWORD);
  await expect(page).toHaveURL(/\/$/);
}

/** POST /api/folders (`space` for root, `parentId` for subfolders); returns the id. */
async function apiCreateFolder(page: Page, name: string, parent: FolderParent): Promise<string> {
  const res = await page.request.post("/api/folders", { data: { name, ...parent } });
  expect(res.status(), `POST /api/folders → ${await res.text()}`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** Creates a note without content (avoids the write throttle); accepts `groupId` and `folderId`. Returns the id. */
async function apiCreateNote(page: Page, title: string, place: { groupId?: string; folderId?: string } = {}): Promise<string> {
  const res = await page.request.post("/api/notes", { data: { title, ...place } });
  expect(res.status(), `POST /api/notes → ${await res.text()}`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** Creates a group (creator = current user); returns the id. */
async function apiCreateGroup(page: Page, name: string): Promise<string> {
  const res = await page.request.post("/api/groups", { data: { name } });
  expect(res.status(), `POST /api/groups → ${await res.text()}`).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** Reads `GET /api/notes` as `page`'s user and returns that note's placement (`folderId`) and group (`groupId`). */
async function placementOf(page: Page, noteId: string): Promise<{ folderId: string | null; groupId: string | null }> {
  const res = await page.request.get("/api/notes");
  expect(res.status()).toBe(200);
  const note = ((await res.json()) as Array<{ id: string; folderId: string | null; groupId: string | null }>).find((n) => n.id === noteId);
  if (note === undefined) throw new Error(`GET /api/notes 裡沒有 ${noteId}`);
  return { folderId: note.folderId, groupId: note.groupId };
}

async function folderIdOf(page: Page, noteId: string): Promise<string | null> {
  return (await placementOf(page, noteId)).folderId;
}

/** Sidebar note link (accessible name starts with the title; titles in this file are chosen not to be prefixes of one another). */
function noteLink(scope: Locator, title: string): Locator {
  return scope.getByRole("link", { name: new RegExp("^" + reEscape(title)) });
}

/** Main button of a folder row (exact name): drop target and spring target. */
function folderButton(scope: Locator, name: string): Locator {
  return scope.getByRole("button", { name, exact: true });
}

/** Stack-folder preview (StackPreview's `<li data-node-kind="preview">`). */
function previews(scope: Locator): Locator {
  return scope.locator('[data-node-kind="preview"]');
}

test("42-1 drag into folder: dropping root note N on row F puts N under F with toast \"Moved to F\"; Undo returns it to root [sc:dragNoteToFolder]", async ({ page }) => {
  test.setTimeout(150_000);
  const F = `F ${RUN}`;
  const N = `E2E Drag Into ${RUN}`;
  await asNewUser(page, "E2E Drag Into");
  const fId = await apiCreateFolder(page, F, { space: { kind: "personal" } });
  const noteId = await apiCreateNote(page, N);
  await page.goto("/");
  const panel = await showSidebarTab(page, "My notes");
  await expect(folderButton(panel, F)).toBeVisible({ timeout: 15_000 });
  await expect(noteLink(panel, N)).toBeVisible();

  await dragTo(page, noteLink(panel, N), folderButton(panel, F), {
    waitFor: () => expect(folderRow(panel, F)).toHaveAttribute("data-drop-scope", ""),
  });
  const moved = toastWithTitle(page, `Moved to “${F}”`);
  await expect(moved).toBeVisible({ timeout: 15_000 });
  // The pointer rests on the toast: this pauses Radix's 5 s timer so the toast doesn't dismiss between the sidebar assertion and Undo.
  await moved.hover();
  await expect(noteLink(folderRow(panel, F), N)).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => folderIdOf(page, noteId), { timeout: 15_000 }).toBe(fId);
  await expect(panel.locator("[data-drop-scope]")).toHaveCount(0);

  await moved.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(() => folderIdOf(page, noteId), { timeout: 15_000 }).toBeNull();
  await expect(noteLink(panel, N)).toBeVisible();
  await expect(noteLink(folderRow(panel, F), N)).toHaveCount(0, { timeout: 15_000 });
});

test("42-2 drag back to root: N inside F passes over root row R (whole list marked) and is released in the empty area below the list -> N at root, toast \"Moved to Top level\"", async ({ page }) => {
  test.setTimeout(150_000);
  const F = `F ${RUN}`;
  const N = `E2E Drag Out ${RUN}`;
  const R = `E2E Drag Rest ${RUN}`;
  await asNewUser(page, "E2E Drag Out");
  const fId = await apiCreateFolder(page, F, { space: { kind: "personal" } });
  const noteId = await apiCreateNote(page, N, { folderId: fId });
  await apiCreateNote(page, R);
  await page.goto("/");
  const panel = await showSidebarTab(page, "My notes");
  await expect(noteLink(folderRow(panel, F), N)).toBeVisible({ timeout: 15_000 });
  await expect(noteLink(panel, R)).toBeVisible();
  const list = panel.locator("[data-sidebar-list]");
  const listScope = panel.locator("[data-sidebar-list] > div");

  await dragTo(page, noteLink(panel, N), noteLink(panel, R), {
    drop: false,
    waitFor: () => expect(listScope).toHaveAttribute("data-drop-scope", ""),
  });
  // Release in the empty area below the list: holding 0.5 s on row R shows R's stack preview (R is also a stackable root note),
  // which would make a drop on the row a race. The empty area is also the root, has no timer, and moving off R collapses the preview if it appeared.
  const listBox = await list.boundingBox();
  expect(listBox, "側欄清單量不到位置").not.toBeNull();
  await dragMoveTo(page, list, {
    position: { x: listBox!.width / 2, y: listBox!.height - 12 },
    waitFor: async () => {
      await expect(listScope).toHaveAttribute("data-drop-scope", "");
      await expect(previews(panel)).toHaveCount(0);
    },
  });
  await page.mouse.up();

  await expect(toastWithTitle(page, "Moved to “Top level”")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => folderIdOf(page, noteId), { timeout: 15_000 }).toBeNull();
  await expect(noteLink(panel, N)).toBeVisible();
  await expect(noteLink(folderRow(panel, F), N)).toHaveCount(0, { timeout: 15_000 });
});

test("42-3 spring folder: hovering the collapsed F row auto-expands it and shows F1; moving to F1 and releasing puts N in F1 and F stays expanded", async ({ page }) => {
  test.setTimeout(150_000);
  const F = `F ${RUN}`;
  const F1 = `F1 ${RUN}`;
  const N = `E2E Drag Spring ${RUN}`;
  await asNewUser(page, "E2E Drag Spring");
  const fId = await apiCreateFolder(page, F, { space: { kind: "personal" } });
  const f1Id = await apiCreateFolder(page, F1, { parentId: fId });
  const noteId = await apiCreateNote(page, N);
  await page.goto("/");
  const panel = await showSidebarTab(page, "My notes");
  const fButton = folderButton(panel, F);
  const f1Button = folderButton(panel, F1);
  await expect(f1Button).toBeVisible({ timeout: 15_000 });
  await expect(noteLink(panel, N)).toBeVisible();

  await fButton.click();
  await expect(fButton).toHaveAttribute("aria-expanded", "false");
  await expect(f1Button).toBeHidden();

  await dragTo(page, noteLink(panel, N), fButton, {
    drop: false,
    waitFor: () => expect(f1Button).toBeVisible({ timeout: 15_000 }),
  });
  await dragMoveTo(page, f1Button, {
    waitFor: () => expect(folderRow(panel, F1)).toHaveAttribute("data-drop-scope", ""),
  });
  await page.mouse.up();

  await expect(toastWithTitle(page, `Moved to “${F1}”`)).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => folderIdOf(page, noteId), { timeout: 15_000 }).toBe(f1Id);
  await expect(noteLink(folderRow(panel, F1), N)).toBeVisible({ timeout: 15_000 });
  // End state: F expanded, F1 visible. These two lines cannot tell whether the spring is wrongly collapsed at drag end, because placing
  // into F1 expands F again (note-place's optimistic update and the PUT success both call expandFolderChain). Drag end without a
  // placement is covered by 42-3b.
  await expect(fButton).toHaveAttribute("aria-expanded", "true");
  await expect(f1Button).toBeVisible();
});

test("42-3b spring is not collapsed: hovering the collapsed F row until it expands, then releasing outside the sidebar (tab bar) without placing, leaves F expanded and F1 visible", async ({ page }) => {
  test.setTimeout(150_000);
  const F = `F ${RUN}`;
  const F1 = `F1 ${RUN}`;
  const M = `E2E Drag Stay ${RUN}`;
  await asNewUser(page, "E2E Drag Spring Stay");
  const fId = await apiCreateFolder(page, F, { space: { kind: "personal" } });
  await apiCreateFolder(page, F1, { parentId: fId });
  const mId = await apiCreateNote(page, M);
  await page.goto("/");
  const panel = await showSidebarTab(page, "My notes");
  const fButton = folderButton(panel, F);
  const f1Button = folderButton(panel, F1);
  await expect(f1Button).toBeVisible({ timeout: 15_000 });
  await expect(noteLink(panel, M)).toBeVisible();

  await fButton.click();
  await expect(fButton).toHaveAttribute("aria-expanded", "false");
  await expect(f1Button).toBeHidden();

  // Hold on row F until the spring expands (wait for F1), move to the tab bar (outside the list container: leaves the tree, no drop target),
  // release. Nothing is placed, so note-place's expandFolderChain cannot re-expand F behind the spring.
  await dragTo(page, noteLink(panel, M), fButton, {
    drop: false,
    waitFor: () => expect(f1Button).toBeVisible({ timeout: 15_000 }),
  });
  const tabs = page.getByRole("complementary").getByRole("tablist", { name: "Sidebar sections" });
  await dragMoveTo(page, tabs, {
    waitFor: () => expect(panel.locator("[data-drop-scope]")).toHaveCount(0),
  });
  await page.mouse.up();

  // M was not placed and stays at root; then F is still expanded. Drag end leaves no DOM marker to wait on, so the API round trip only gives cleanup time and is not a causal anchor.
  expect(await placementOf(page, mId)).toEqual({ folderId: null, groupId: null });
  await expect(noteLink(panel, M)).toBeVisible();
  await expect(noteLink(folderRow(panel, F), M)).toHaveCount(0);
  await expect(fButton).toHaveAttribute("aria-expanded", "true");
  await expect(f1Button).toBeVisible();
});

test("42-4 stack A on B: N1 held over N2 shows the preview; releasing opens the rename dialog (New folder) with no toast before it closes; saving as Stack shows the toast; Undo returns both notes to root and removes the folder [sc:dragNoteToFolder]", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const N1 = `E2E Drag Alpha ${RUN}`;
  const N2 = `E2E Drag Beta ${RUN}`;
  const STACK = `Stack ${RUN}`;
  await asNewUser(page, "E2E Drag Stack");
  const n1Id = await apiCreateNote(page, N1);
  const n2Id = await apiCreateNote(page, N2);
  await page.goto("/");
  const panel = await showSidebarTab(page, "My notes");
  for (const title of [N1, N2]) await expect(noteLink(panel, title)).toBeVisible({ timeout: 15_000 });

  await dragTo(page, noteLink(panel, N1), noteLink(panel, N2), {
    waitFor: () => expect(previews(panel)).toBeVisible({ timeout: 15_000 }),
  });

  const dialog = page.getByRole("dialog", { name: "Rename folder", exact: true });
  const input = dialog.getByRole("textbox", { name: "Folder name", exact: true });
  await expect(input).toBeFocused({ timeout: 15_000 });
  await expect(input).toHaveValue("New folder");
  // While a modal is open the toast region is aria-hidden (invisible to getByRole), so look it up by text, which ignores aria-hidden.
  await expect(page.getByText(/^Created “/)).toHaveCount(0);

  await submitFolderName(page, "Rename folder", STACK);
  const created = toastWithTitle(page, `Created “${STACK}” with 2 notes`);
  await expect(created).toBeVisible({ timeout: 15_000 });
  await created.hover();
  for (const title of [N1, N2]) await expect(noteLink(folderRow(panel, STACK), title)).toBeVisible({ timeout: 15_000 });
  const stackId = await folderIdOf(page, n1Id);
  expect(stackId).not.toBeNull();
  expect(await folderIdOf(page, n2Id)).toBe(stackId);

  await created.getByRole("button", { name: "Undo", exact: true }).click();
  for (const id of [n1Id, n2Id]) await expect.poll(() => folderIdOf(page, id), { timeout: 15_000 }).toBeNull();
  for (const title of [N1, N2]) await expect(noteLink(panel, title)).toBeVisible();
  await expect(folderButton(panel, STACK)).toHaveCount(0, { timeout: 15_000 });
});

test("42-5 move away after preview: N1 held over N2 shows the preview; moving to row R collapses it; releasing outside the sidebar (tab bar) sends no POST /api/folders and creates no folder", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const N1 = `E2E Drag Gamma ${RUN}`;
  const N2 = `E2E Drag Delta ${RUN}`;
  const R = `E2E Drag Omega ${RUN}`;
  await asNewUser(page, "E2E Drag Away");
  for (const title of [N1, N2, R]) await apiCreateNote(page, title);
  await page.goto("/");
  const panel = await showSidebarTab(page, "My notes");
  for (const title of [N1, N2, R]) await expect(noteLink(panel, title)).toBeVisible({ timeout: 15_000 });
  let folderPosts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/folders") folderPosts += 1;
  });

  await dragTo(page, noteLink(panel, N1), noteLink(panel, N2), {
    drop: false,
    waitFor: () => expect(previews(panel)).toBeVisible({ timeout: 15_000 }),
  });
  await expect(noteLink(panel, N2)).toHaveCount(0);

  // Moving to R collapses N2's preview and N2's row returns. Only N2's preview is asserted absent: holding 0.5 s on R may show R's preview (without N2's title).
  await dragMoveTo(page, noteLink(panel, R), {
    waitFor: async () => {
      await expect(noteLink(panel, N2)).toBeVisible();
      await expect(previews(panel).filter({ hasText: N2 })).toHaveCount(0);
    },
  });

  const tabs = page.getByRole("complementary").getByRole("tablist", { name: "Sidebar sections" });
  await dragMoveTo(page, tabs, {
    waitFor: async () => {
      await expect(previews(panel)).toHaveCount(0);
      await expect(panel.locator("[data-drop-scope]")).toHaveCount(0);
    },
  });
  await page.mouse.up();

  // The last two checks (no folder, POST count 0) are a safety net: the release point is outside the list container, so the sidebar's drop never
  // fires and any implementation passes them. What this test checks is above: the preview replaces N2's row, collapses after moving to R, and
  // the preview and markers are cleared after leaving the list.
  for (const title of [N1, N2, R]) await expect(noteLink(panel, title)).toBeVisible();
  await expect(panel.locator('li[data-node-kind="folder"]')).toHaveCount(0);
  expect(folderPosts).toBe(0);
});

test("42-6 groups tab across groups: dragging G's g1 to group H's row does not mark H as a drop target; after release g1 is still in G", async ({ page }) => {
  test.setTimeout(150_000);
  const G = `E2E Drag G ${RUN}`;
  const H = `E2E Drag H ${RUN}`;
  const GF = `GF ${RUN}`;
  const g1 = `E2E Drag InG ${RUN}`;
  const h1 = `E2E Drag InH ${RUN}`;
  await asNewUser(page, "E2E Drag Across");
  const gId = await apiCreateGroup(page, G);
  const hId = await apiCreateGroup(page, H);
  // GF is only a positive anchor: dragging over it marks it, proving the sidebar took over this drag.
  await apiCreateFolder(page, GF, { space: { kind: "group", groupId: gId } });
  const g1Id = await apiCreateNote(page, g1, { groupId: gId });
  await apiCreateNote(page, h1, { groupId: hId });
  await page.goto("/");
  const workspace = await showSidebarTab(page, "Groups");
  const gNode = workspace.locator(`li[data-node-kind="group"][data-node-id="${gId}"]`);
  const hNode = workspace.locator(`li[data-node-kind="group"][data-node-id="${hId}"]`);
  await expect(noteLink(gNode, g1)).toBeVisible({ timeout: 15_000 });
  await expect(noteLink(hNode, h1)).toBeVisible({ timeout: 15_000 });

  await dragTo(page, noteLink(gNode, g1), folderButton(workspace, GF), {
    drop: false,
    waitFor: () => expect(folderRow(workspace, GF)).toHaveAttribute("data-drop-scope", ""),
  });
  await dragMoveTo(page, workspace.getByRole("button", { name: H, exact: true }), {
    waitFor: () => expect(folderRow(workspace, GF)).not.toHaveAttribute("data-drop-scope"),
  });
  await expect(hNode).not.toHaveAttribute("data-drop-scope");
  await expect(page.locator("[data-drop-scope]")).toHaveCount(0);
  await page.mouse.up();

  // After release only confirm nothing changed (g1 still at G's root). What this test checks is before release: H has no data-drop-scope and
  // no drop marker exists anywhere on the page; the reads right after release do not prove a wrong drop would be caught.
  await expect(noteLink(gNode, g1)).toBeVisible();
  await expect(noteLink(hNode, g1)).toHaveCount(0);
  await expect(noteLink(folderRow(workspace, GF), g1)).toHaveCount(0);
  expect(await placementOf(page, g1Id)).toEqual({ folderId: null, groupId: gId });
});

test("42-7 drag into editor: dropping sidebar note N into P's editor keeps the URL, leaves no drop marker or preview in the sidebar, and adds a wikilink to N in P [sc:dragNoteToEditor]", async ({ page }) => {
  test.setTimeout(150_000);
  const P = `E2E Drag Page ${RUN}`;
  const N = `E2E Drag Linked ${RUN}`;
  await asNewUser(page, "E2E Drag Editor");
  await apiCreateNote(page, P);
  await apiCreateNote(page, N);
  await page.goto("/");
  const panel = await showSidebarTab(page, "My notes");
  await expect(noteLink(panel, N)).toBeVisible({ timeout: 15_000 });

  await noteLink(panel, P).click();
  // Wait for the note's title box before touching the editor: until the lazy NotePage mounts, only its fallback is on screen.
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue(P, { timeout: 15_000 });
  await expect(page.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible({ timeout: 15_000 });
  const editor = editorLocator(page);
  await editor.waitFor({ timeout: 15_000 });
  await editor.click();
  await page.keyboard.type(`drop here ${RUN}`);
  await expect(editor).toContainText(`drop here ${RUN}`);
  const dropOuter = editor
    .locator(".bn-block-outer")
    .filter({ has: page.locator(".bn-inline-content", { hasText: /^drop here/ }) })
    .last();

  const urlBefore = page.url();
  const nPath = await noteLink(panel, N).getAttribute("href");
  expect(nPath).toMatch(/^\/n\/[^/"]+\/[^/"]+$/);

  // Drop on the right part of the paragraph (80% of the block width): during the drag BlockNote's side menu button sits over the start of the
  // paragraph, and a drop on that button does not reach the editor's drop.
  const box = await dropOuter.boundingBox();
  expect(box, "放下目標段量不到位置").not.toBeNull();
  await dragTo(page, noteLink(panel, N), dropOuter, { position: { x: box!.width * 0.8, y: box!.height / 2 } });

  // Positive anchor: the dropped paragraph gains exactly one wikilink to N (#352: an in-site link dragged in from outside the editor is converted
  // to a wikilink within the drop range, `withSiteLinkDrop` in collab/site-link-convert.ts). In the editor the resolved wikilink (MemberWikilink) is
  // `<a href={canonicalNotePath(note)}>` with the label or current title as text (a dragged-in label is empty). Also assert no plain link
  // (link mark `<a href="<origin>/n/...">`) to N exists.
  await expect(dropOuter.locator(WIKILINK)).toHaveCount(1, { timeout: 15_000 });
  await expect(dropOuter.locator(`${WIKILINK} a[href$="${nPath}"]`)).toHaveText(N, { timeout: 15_000 });
  await expect(editor.locator(`a[href$="${nPath}"]:not(${WIKILINK} a)`)).toHaveCount(0);
  await expect(page).toHaveURL(urlBefore);
  await expect(noteLink(panel, N)).toBeVisible();
  await expect(page.locator("[data-drop-scope]")).toHaveCount(0);
  await expect(page.locator('[data-node-kind="preview"]')).toHaveCount(0);
});
