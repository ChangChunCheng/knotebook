import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { expect, request as pwRequest, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { derivedVersionName } from "../../packages/shared/src/version-names.js";
import { E2E_ORIGIN } from "../ports.js";

/**
 * Credentials of the env bootstrap admin built into the stack (`ADMIN_EMAIL`/`ADMIN_PASSWORD` in `docker-compose.e2e.yml`).
 * The env admin is not forced to change its password on first login, so one password serves every spec.
 * Forced password change has no e2e coverage; it is covered by `auth/guards.test.tsx`, `pages/ChangePasswordPage.test.tsx` and server tests.
 *
 * Convention: new tests that toggle a public link (`PUT`/`DELETE .../public-link`) use a fresh account (`randomEmail()` or
 * `createUserViaInvite`), not admin. The `PUBLIC_LINK_LIMIT` limiter is keyed by userId (10 per 10 minutes, fixed window) and
 * admin's allowance is already used up by specs 11, 16, 18, 22 and 27, which stay on admin: don't add admin public-link calls to them
 * (an extra one would 429 in an unrelated later spec).
 */
export const ADMIN = {
  email: "admin@e2e.local",
  password: "e2e-admin-password",
} as const;

/** Random emails keep specs from colliding on the shared stack (single worker, no `down -v` between specs). */
export function randomEmail(): string {
  return `e2e-${randomUUID()}@e2e.local`;
}

/**
 * `/login` -> submit -> wait to leave `/login`. Does not assert the final URL: flagged accounts are sent to `/change-password`
 * client-side by `ChangePasswordGate`, others land on `/`; callers assert theirs with `expect(page).toHaveURL(...)` (which retries).
 */
export async function loginAs(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#login-email").fill(email);
  await page.locator("#login-password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname !== "/login", { timeout: 15_000 });
}

/**
 * Admin creates the invite via API; a separate cookie-less APIRequestContext redeems it. Must not use admin's context: a
 * successful redeem sets a cookie that logs in the new account and overwrites admin's session. `adminPage` must be logged in
 * and already navigated (for its origin). CSRF only needs a JSON content-type (`data` sets it).
 */
export async function createUserViaInvite(
  adminPage: Page,
  user: { email: string; password: string; displayName?: string },
): Promise<void> {
  const created = await adminPage.request.post("/api/admin/invites", { data: { expiresInDays: 1 } });
  expect(created.status(), `POST /api/admin/invites → HTTP ${created.status()} ${await created.text()}`).toBe(201);
  const { token } = (await created.json()) as { token: string };
  const api = await pwRequest.newContext({ baseURL: new URL(adminPage.url()).origin });
  try {
    const accepted = await api.post("/api/auth/invite/accept", { data: { token, ...user } });
    expect(accepted.status(), `POST /api/auth/invite/accept → HTTP ${accepted.status()} ${await accepted.text()}`).toBe(201);
  } finally {
    await api.dispose();
  }
}

/**
 * Creates a new note on the logged-in `page` (must be at `/` with `AppShell` visible) and fills the title. Afterwards
 * `page.url()` is the note's canonical URL.
 *
 * The title is saved on `TitleInput` blur, not after the 800ms debounce; `.blur()` sends the save immediately.
 *
 * Waits for the connection first, then the editor. The connection wait is an explicit precondition (#33); it comes first because
 * `contenteditable="true"` currently implies synced, so the other order would time out on the editor with a misleading message
 * when the handshake hangs and the connection wait would never run.
 *
 * #33 was typing queued in `@hocuspocus/provider`'s `messageQueue` before connect and lost on reload. #48 closed it: a never-synced
 * note is read-only (`NotePage`: `editable = roleCanEdit && synced`) and BlockNote does not mount `contenteditable="true"` then,
 * so the editor wait implies first sync. That depends on #48's read-only behaviour; if the editor ever becomes editable before
 * sync, the flake returns unless this waits for "Connected" explicitly, so the precondition is stated in the test itself.
 * Pages that do not go through `createNote` need their own connection wait.
 */
export async function createNote(page: Page, title: string): Promise<void> {
  // The footer "New note" only shows in My notes/Recent/search; the caller may be on Groups/Shared with me, so switch to My notes first.
  if (!(await page.getByRole("button", { name: "New note", exact: true }).isVisible())) {
    await showSidebarTab(page, "My notes");
  }
  await page.getByRole("button", { name: "New note", exact: true }).click();
  // First hop (#122): the new note's canonical URL is /n/<handle>/untitled-<uuid8> (slug from the DB default).
  await page.waitForURL(/\/n\/[^/]+\/untitled-[0-9a-f]{8}$/, { timeout: 15_000 });

  const titleInput = page.getByLabel("Note title");
  // The URL changes about 180 ms before the screen does (react-router startTransition); filling on the URL alone would type into
  // the previous note's title box. Wait for the new note's title box (value Untitled).
  await expect(titleInput).toHaveValue("Untitled", { timeout: 15_000 });
  await titleInput.fill(title);
  await titleInput.blur();

  // Second hop (#122): title save -> server recomputes the auto slug -> NotePage's convergence effect rewrites the URL to
  // /n/<handle>/<title-slug>. Matching only /\/n\// would pass on the first hop and make later URL assertions racy.
  // The predicate excludes any untitled-<8hex> tail, so a test whose title degrades to the untitled family (or hits the server's
  // uuid8 fallback) would time out here after 15s.
  await page.waitForURL(
    (url) => /^\/n\/[^/]+\/[^/]+$/.test(url.pathname) && !/\/untitled-[0-9a-f]{8}$/.test(url.pathname),
    { timeout: 15_000 },
  );

  // Connection barrier: `ConnectionBadge` (`role="status"`) shows "Connected". `hasText` filters it from the Radix Toast live region,
  // which is also `role="status"`. The regex is anchored because a string `hasText` is a case-insensitive substring match and would
  // match a future "Disconnected".
  //
  // After 3s connected-but-not-synced the badge shows "Not loaded - offline" instead of "Connected", but only while `!synced`;
  // it falls back once the first sync completes, so this wait costs at worst the same as the contenteditable wait below.
  await expect(page.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible({ timeout: 15_000 });

  // The editor (BlockNote) node must be mounted: callers usually click/type next and would not find contenteditable. After #48
  // this also implies first sync.
  await page.locator(MAIN_EDITOR_SELECTOR).first().waitFor({ timeout: 15_000 });
}

/**
 * #263: the main editor's contenteditable. The selection AI box lives inside the main editor's DOM (`editor.portalElement` is in
 * `.bn-container`) and its preview holds a read-only editor (`contenteditable="false"`, which the selector already skips); `:not(...)`
 * states the exclusion so an editable element appearing in the box later is not picked up. Assertions scoped to the main editor
 * go through `editorLocator`.
 */
export const MAIN_EDITOR_SELECTOR = '[data-testid="note-editor"] [contenteditable="true"]:not([data-testid="selection-ai-box"] *)';

/**
 * BlockNote (`@blocknote/mantine`) spreads arbitrary props passed to `<BlockNoteView data-testid=...>` onto the outer
 * `<div class="bn-root bn-container ...">` (see the `{...i}` spread in the `hi` component in `@blocknote/react`'s dist), so
 * `data-testid` lands on an ancestor of the editable node. The ProseMirror root is the child where tiptap/prosemirror-view sets
 * `contentEditable="true"` at mount; locate it as testid ancestor + `[contenteditable="true"]` descendant. Using the testid
 * alone would click/type on the container instead of the ProseMirror root.
 */
export function editorLocator(page: Page) {
  return page.locator(MAIN_EDITOR_SELECTOR).first();
}

/**
 * Waits until ProseMirror has read the current DOM selection into its state, so a following Enter/typing lands at the right place.
 *
 * Click/End/Ctrl+End move the caret natively and the DOM selection changes at once, but ProseMirror reads it into `state.selection`
 * only on `selectionchange` (a separately queued browser task), while Enter and typing use `state.selection`. An Enter sent right
 * after can be handled before `selectionchange`, so the new paragraph/text lands at the **previous** caret position (why it arrives
 * late is presumed to be Chromium's input-event scheduling, unmeasured). Reproduced on the e2e stack with no dialog: click at
 * paragraph end -> End -> Enter was wrong 3 of 30 times before this helper and 30/30 correct after; in the wrong runs no
 * `selectionchange` arrived within the 23 ms from click to Enter and `state.selection` was still at the previous paragraph end.
 * Checking only `window.getSelection()` is not enough; it must be compared with ProseMirror's state.
 *
 * Only for a text caret: a collapsed TextSelection with the caret inside a text node. With a NodeSelection, or a caret next to an
 * inline atom (image, wikilink), `posAtDOM` (bias -1) converts differently from how PM reads its own selection and may never match
 * in a legitimate stable state, so this times out.
 *
 * Reads the `editor` Tiptap attaches to the contenteditable (`view.dom.editor`). On timeout the message carries the last
 * diagnostic: `"no-editor"` (editor not attached), `{ focusOutside: ... }` (activeElement/caret outside the editor), or
 * `{ pm, dom }` (PM's selection.head vs the position converted from the DOM caret).
 */
export async function waitForEditorSelection(page: Page, timeout = 2_000): Promise<void> {
  await expect
    .poll(
      () =>
        editorLocator(page).evaluate((el) => {
          type View = { state: { selection: { head: number } }; posAtDOM(node: Node, offset: number): number };
          const view = (el as Element & { editor?: { view?: View } }).editor?.view;
          if (!view) return "no-editor";
          const sel = window.getSelection();
          const active = document.activeElement;
          if (!active || !el.contains(active) || !sel?.focusNode || !el.contains(sel.focusNode)) {
            return {
              focusOutside: {
                activeElement: active ? `${active.tagName}.${String(active.className).slice(0, 40)}` : null,
                caretInEditor: !!sel?.focusNode && el.contains(sel.focusNode),
              },
            };
          }
          const pm = view.state.selection.head;
          let dom: number | string;
          try {
            dom = view.posAtDOM(sel.focusNode, sel.focusOffset);
          } catch (err) {
            dom = `posAtDOM threw: ${String(err)}`;
          }
          return dom === pm ? "synced" : { pm, dom };
        }),
      { timeout, message: "ProseMirror 的 state.selection 要跟 DOM selection 對齊（值：no-editor／focusOutside／{pm, dom}）" },
    )
    .toEqual("synced");
}

/**
 * Clicks `target` (a single-line paragraph in the editor), presses End, and confirms the caret is at the end of **that** paragraph
 * (both PM state and DOM); otherwise retries the whole sequence. Only for single-line plain-text paragraphs: End moves to the visual
 * line end, and the comparison uses textContent, which can differ when the paragraph has inline atoms such as wikilinks.
 *
 * Why `click -> End -> waitForEditorSelection` is not enough: when the editor had no focus (e.g. focus returned to the trigger
 * button after a dialog Escape), the click triggers prosemirror-view's `handlers.focus`, which schedules a 20 ms `setTimeout`. If the
 * DOM selection then differs from what PM last read (`domObserver.currentSelection`), it runs `selectionToDOM` and writes PM's
 * selection back to the DOM. If End is pressed before the timer fires and PM has not read End's selectionchange, the DOM caret is
 * pulled back to PM's old position (the click point, or the pre-blur position if the click's selectionchange was not read either);
 * PM and DOM then agree on the wrong place, `waitForEditorSelection` passes, and typing goes to the wrong spot. Hence this checks
 * both "at paragraph end" and "this paragraph".
 * Seen in CI slide e2e twice and locally 4 of 20 times with CDP 4x throttling ("one updated text"): the timer pulled the DOM caret
 * from paragraph end back to the click point (DOM offset 8 -> 4). The timer is scheduled once per blur->focus; once the assertion
 * holds PM has read the paragraph end (currentSelection equals DOM), so a late firing is a no-op.
 */
export async function clickEndOfParagraph(page: Page, target: Locator, timeout = 10_000): Promise<void> {
  const expected = (await target.textContent()) ?? "";
  await expect(async () => {
    await target.click();
    await page.keyboard.press("End");
    await expect
      .poll(
        () =>
          editorLocator(page).evaluate((el, expected) => {
            type View = {
              state: {
                selection: {
                  empty: boolean;
                  head: number;
                  $head: { parentOffset: number; parent: { textContent: string; content: { size: number } } };
                };
              };
              posAtDOM(node: Node, offset: number): number;
            };
            const view = (el as Element & { editor?: { view?: View } }).editor?.view;
            if (!view) return "no-editor";
            const sel = window.getSelection();
            if (!sel?.focusNode || !el.contains(sel.focusNode) || !el.contains(document.activeElement)) return "focus-outside";
            const { empty, head, $head } = view.state.selection;
            let dom: number | string;
            try {
              dom = view.posAtDOM(sel.focusNode, sel.focusOffset);
            } catch (err) {
              dom = `posAtDOM threw: ${String(err)}`;
            }
            const parentText = $head.parent.textContent;
            if (empty && dom === head && $head.parentOffset === $head.parent.content.size && parentText === expected) return "at-end";
            return { pm: head, dom, parentOffset: $head.parentOffset, parentSize: $head.parent.content.size, parentText: parentText.slice(0, 40) };
          }, expected),
        { timeout: 1_000, message: "游標要停在目標段尾端且 PM 與 DOM 對齊（值：no-editor／focus-outside／{pm, dom, parentOffset, parentSize, parentText}）" },
      )
      .toBe("at-end");
  }).toPass({ timeout });
}

/**
 * #247: site admin is a modal. UserMenu (trigger named by displayName "admin") -> "Site admin" -> `/admin/users`; returns that dialog.
 * Close it with Esc (or the dialog's close button) to return to the page before.
 */
export async function openSiteAdmin(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "admin", exact: true }).click();
  await page.getByRole("menuitem", { name: "Site admin", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/users$/);
  const dialog = page.getByRole("dialog", { name: "Site admin" });
  await expect(dialog).toBeVisible();
  // Open once the left card's current item has aria-current (the left card is display:none in a narrow viewport, so use a CSS locator).
  await expect(dialog.locator('nav a[aria-current="page"]')).toHaveCount(1);
  return dialog;
}

export async function adminNav(page: Page, item: "Users" | "Groups" | "Sign-in" | "Storage plans" | "AI agents" | "Site limits"): Promise<void> {
  const urls = {
    Users: /\/admin\/users$/,
    Groups: /\/admin\/groups$/,
    "Sign-in": /\/admin\/login$/,
    "Storage plans": /\/admin\/storage$/,
    "AI agents": /\/admin\/ai$/,
    "Site limits": /\/admin\/limits$/,
  };
  await page.getByRole("navigation", { name: "Site admin" }).getByRole("link", { name: item, exact: true }).click();
  await expect(page).toHaveURL(urls[item]);
}

export type SidebarTabName = "Recent" | "Favorites" | "My notes" | "Groups" | "Shared with me" | "Trash";

/**
 * In a narrow viewport (< 1280) brings the sidebar into view and returns the scope to pass to helpers like `showSidebarTab`:
 * - phone (< 640): the list is the whole sidebar (full-screen `complementary`); on a note screen click "Back to notes", on the list do nothing.
 * - 640-1279: the sidebar is a drawer; click "Open sidebar" (unless open) and return the drawer dialog.
 * The branch is chosen by width, not by which buttons are on screen.
 */
export async function openListOnCompact(page: Page): Promise<Locator> {
  const width = page.viewportSize()?.width ?? 1280;
  if (width < 640) {
    // Don't filter on the tab bar: it is absent while the full-screen search layer is open, but the list is still this aside.
    const sidebar = page.getByRole("complementary");
    const back = page.getByRole("button", { name: "Back to notes", exact: true });
    // Navigation runs in a transition: the URL changes before the screen, and isVisible doesn't wait.
    // Wait for either the list or the note screen before deciding whether to press back.
    await expect(sidebar.or(back).first()).toBeVisible({ timeout: 15_000 });
    if (!(await sidebar.isVisible())) await back.click();
    await expect(sidebar).toBeVisible({ timeout: 15_000 });
    return sidebar;
  }
  const drawer = page.getByRole("dialog", { name: "Navigation" });
  if (!(await drawer.isVisible())) {
    await page.getByRole("button", { name: "Open sidebar", exact: true }).click();
  }
  await expect(drawer).toBeVisible();
  return drawer;
}

/**
 * Clicks a sidebar tab, waits for aria-selected, and returns the tabpanel in the same scope. `scope` defaults to the static sidebar
 * (complementary): fixed at 1280 and above, the full-screen list on phones (< 640, also that `<aside>`); for the 640-1279 drawer
 * pass the drawer (`openListOnCompact`'s return value). The sidebar renders only the current tab, so a negative assertion
 * (`toHaveCount(0)`) passes vacuously on a tab that never shows that kind of note; call this again before each one.
 */
export async function showSidebarTab(page: Page, name: SidebarTabName, scope?: Locator): Promise<Locator> {
  const root = scope ?? page.getByRole("complementary");
  const tab = root.getByRole("tablist", { name: "Sidebar sections" }).getByRole("tab", { name, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  return root.getByRole("tabpanel");
}

/**
 * #181: clicks "Select" in the header of a regular tab (My notes/Groups/Shared with me/Recent) and waits for "0 selected" in the
 * selection header (the lazy SelectLazy chunk arrived; selection is cleared on entry). `scope` defaults to the static sidebar;
 * narrow screens pass the drawer. Returns the tabpanel (checkboxes are inside; the narrow action bar sits outside the tabpanel at the
 * sidebar bottom, the wide one in the tabpanel's `[data-sidebar-header]`; both are `[data-select-action-bar]` with the same button
 * names). Selection in the Trash tab is separate.
 */
export async function startSidebarSelection(page: Page, scope?: Locator): Promise<Locator> {
  const panel = (scope ?? page.getByRole("complementary")).getByRole("tabpanel");
  await panel.getByRole("button", { name: "Select", exact: true }).click();
  await expect(panel.getByText("0 selected", { exact: true })).toBeVisible({ timeout: 15_000 });
  return panel;
}

/**
 * #181: in select mode, clicks a note's checkbox (the whole row is a `<label>` whose accessible name starts with the title; the Recent
 * tab appends a location line). Clicks the checkbox itself because a Shift range reads the click event's `shiftKey`. Without
 * `shift` it toggles one row; with `shift` it adds the whole range from the anchor to this note and this note ends up checked.
 */
export async function toggleSelectedNote(panel: Locator, title: string, opts?: { shift?: boolean }): Promise<void> {
  const box = panel.getByRole("checkbox", { name: new RegExp("^" + reEscape(title)) });
  const wasChecked = await box.isChecked();
  await box.click(opts?.shift ? { modifiers: ["Shift"] } : undefined);
  await expect(box).toBeChecked({ checked: opts?.shift ? true : !wasChecked });
}

/**
 * The toast titled `title` (Radix Toast `<li>` in the "Notifications" region). The title is matched exactly because Radix also renders a
 * "Notification ..." announcer node (`role="status"`, removed after about 1 s) containing the same substring. Several toasts can share
 * a title (consecutive trashing); takes the newest.
 */
export function toastWithTitle(page: Page, title: string): Locator {
  return page
    .getByRole("region", { name: /^Notifications/ })
    .getByRole("listitem")
    .filter({ has: page.getByText(title, { exact: true }) })
    .last();
}

/**
 * #181: on a note row in the sidebar (or the given scope), opens the kebab -> "Delete", waits for the row to leave the list and the
 * toast to appear; returns the toast locator. Trashing needs no confirmation. Trashing the open note navigates back to `/`.
 */
export async function moveNoteToTrashFromSidebar(page: Page, title: string, scope?: Locator): Promise<Locator> {
  const root = scope ?? page.getByRole("complementary");
  const actions = root.getByRole("button", { name: `Note actions for ${title}`, exact: true });
  // The kebab only grows on hover (zero width until the pointer has been over the row, and Playwright can't hover/click a zero-width button): hover the row first, then click.
  await actions.locator("xpath=ancestor::li[1]").hover();
  await actions.click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await expect(actions).toHaveCount(0, { timeout: 15_000 });
  const toastItem = toastWithTitle(page, "Moved to the trash");
  await expect(toastItem).toBeVisible();
  return toastItem;
}

/** Group row kebab -> "Members & settings" -> `/groups/<id>`; returns the group id. */
export async function openGroupPanel(page: Page, groupName: string): Promise<string> {
  await showSidebarTab(page, "Groups");
  await page.getByRole("complementary").getByRole("button", { name: `Group actions for ${groupName}` }).click();
  await page.getByRole("menuitem", { name: "Members & settings" }).click();
  await expect(page).toHaveURL(/\/groups\/[0-9a-f-]{36}$/);
  const dialog = page.getByRole("dialog", { name: groupName });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('nav a[aria-current="page"]')).toHaveCount(1);
  return new URL(page.url()).pathname.split("/")[2]!;
}

/**
 * Folder row (`li[data-node-kind="folder"]`) in the current tab. Finds the main button by exact name, then its nearest folder `<li>`
 * ancestor; `filter({ has })` would not work because an outer folder's `<li>` also contains the child folder's main button.
 */
export function folderRow(scope: Locator, name: string): Locator {
  return scope.getByRole("button", { name, exact: true }).locator("xpath=ancestor::li[@data-node-kind='folder'][1]");
}

/**
 * Clicks `opener` (the dialog opened from the header "New folder", a group row's "New folder in G", or a kebab "New subfolder" all work),
 * waits for the lazy create dialog, types the name, clicks Create, waits for the dialog to close and the folder's main button to appear
 * (the visible one: the static card is hidden in a narrow viewport).
 */
export async function createFolder(page: Page, opener: Locator, name: string): Promise<void> {
  await opener.hover();
  await opener.click();
  await submitFolderName(page, "New folder", name);
}

export async function submitFolderName(page: Page, title: "New folder" | "Rename folder", name: string): Promise<void> {
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  const input = dialog.getByRole("textbox", { name: "Folder name", exact: true });
  await expect(input).toBeFocused({ timeout: 15_000 });
  await input.fill(name);
  await dialog.getByRole("button", { name: title === "New folder" ? "Create" : "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name, exact: true }).locator("visible=true").first()).toBeVisible({ timeout: 15_000 });
}

/** Folder kebab (appears on hover: hover the row first). */
export function folderMenuButton(scope: Locator, folder: string): Locator {
  return scope.getByRole("button", { name: `Folder menu for ${folder}`, exact: true });
}

export async function folderMenuItem(page: Page, scope: Locator, folder: string, item: string): Promise<void> {
  const trigger = folderMenuButton(scope, folder);
  await trigger.hover();
  await trigger.click();
  const menuItem = page.getByRole("menu").getByRole("menuitem", { name: item, exact: true });
  await expect(menuItem).toBeVisible();
  await menuItem.click();
}

/**
 * Literal of the wide/narrow pointer query (`WIDE_POINTER_QUERY` in `apps/web/src/lib/wide-pointer.ts`; e2e can't depend on the web package,
 * so keep both in sync). Wide: kebab "Move to.../Copy to..." stacks levels sideways and the selection toolbar is in the header; narrow: levels expand in place and the action bar is at the bottom.
 */
const WIDE_POINTER_QUERY = "(width >= 48rem) and (hover: hover) and (pointer: fine)";

/**
 * Asserts the page is currently on the wide (`true`) or narrow (`false`) query. Called at the start of the wide-case and 390-case tests so a
 * wrong default-viewport assumption fails here rather than somewhere unrelated; called after `setViewportSize` it also waits for matchMedia to catch up.
 * Playwright can't change hover/pointer, so the query can only be switched via width.
 */
export async function expectWidePointer(page: Page, wide: boolean): Promise<void> {
  await expect
    .poll(() => page.evaluate((query) => window.matchMedia(query).matches, WIDE_POINTER_QUERY), {
      message: `matchMedia("${WIDE_POINTER_QUERY}") 應為 ${wide}`,
    })
    .toBe(wide);
}

/**
 * Clicks a menu item while the menu is open (submenu items too). The wide "Move to.../Copy to..." submenu is a Radix flyout: the pointer must
 * move over in steps; jumping straight off the trigger makes Radix decide the pointer is not heading to the submenu and close it
 * (see `pickFromSubmenu` in `16-groups-share.spec.ts`). The narrow in-place form is fine with stepped moves too. The submenu has `max-h` (20rem) and scrolls:
 * scroll into view before measuring.
 * `scope`: stacked levels are open together and same-named items such as "Move here" can exist in several; pass the level returned by `openedSubmenu` to restrict.
 */
export async function clickMenuItemByPointer(page: Page, name: string, scope?: Locator): Promise<void> {
  await clickByPointer(page, (scope ?? page).getByRole("menuitem", { name, exact: true }));
}

/**
 * Moves the pointer to the center of `target` in steps, then clicks (menu radio items etc.: jumping off the SubTrigger makes Radix decide the pointer isn't heading to the submenu and close it).
 */
export async function clickByPointer(page: Page, target: Locator): Promise<void> {
  await expect(target).toBeVisible();
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  expect(box, "要點的元素量不到位置").not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2, { steps: 10 });
  await target.click();
}

/**
 * The menu level opened by a wide stacked SubTrigger (`trigger`). Waits for `aria-expanded="true"`, then finds the level by its `aria-controls`
 * (Radix sets it only when open; the value is that SubContent's id). Every SubContent is a portal and none contains another, so this level's scope excludes deeper ones.
 */
export async function openedSubmenu(page: Page, trigger: Locator): Promise<Locator> {
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const id = await trigger.getAttribute("aria-controls");
  expect(id, "SubTrigger 已打開卻沒有 aria-controls").not.toBeNull();
  const menu = page.locator(`[role="menu"][id="${id}"]`);
  await expect(menu).toBeVisible();
  return menu;
}

/** Suffix of the accessible name of a narrow level-switch item (`folders.dest.openLevel` "{{name}}, open"); the wide stacked SubTrigger has none. */
const OPEN_LEVEL_SUFFIX = ", open";

/**
 * With the kebab open, clicks "Move to..."/"Copy to..." then each of `steps` (exact accessible names; level-switch items written in the narrow form "X, open").
 * The form depends on the trigger:
 * - wide and hoverable (`aria-haspopup="menu"`) = stack sideways: the trigger is a Radix `SubTrigger`; each step goes through
 *   `clickMenuItemByPointer` scoped to the current level. The wide SubTrigger has no ", open" suffix, so strip it before searching, then wait for
 *   `aria-expanded="true"` and search the next step in the level it opened (there is no "Back" to wait for).
 * - narrow or touch = expand in place, level by level: click the indented item (same menu). After "X, open" wait for the new level to replace the old
 *   one (anchor: the item just clicked is gone; waiting on "Back" alone would be an empty wait from level two on, as the old level has one too),
 *   then confirm the new level has "Back" (first item from level two on; its icon is aria-hidden so the accessible name is just "Back").
 * Empty `steps` only opens the submenu (the caller asserts the first level; for wide use `openedSubmenu` to get that level).
 */
export async function pickNoteMenuDestination(page: Page, trigger: "Move to…" | "Copy to…", steps: readonly string[]): Promise<void> {
  const item = page.getByRole("menuitem", { name: trigger, exact: true });
  await expect(item).toBeVisible();
  const cascade = (await item.getAttribute("aria-haspopup")) === "menu";
  await item.click();
  if (!cascade) {
    for (const step of steps) {
      await page.getByRole("menuitem", { name: step, exact: true }).click();
      if (step.endsWith(OPEN_LEVEL_SUFFIX)) {
        await expect(page.getByRole("menuitem", { name: step, exact: true })).toBeHidden();
        await expect(page.getByRole("menuitem", { name: "Back", exact: true })).toBeVisible();
      }
    }
    return;
  }
  let level = await openedSubmenu(page, item);
  for (const step of steps) {
    const opensLevel = step.endsWith(OPEN_LEVEL_SUFFIX);
    const name = opensLevel ? step.slice(0, -OPEN_LEVEL_SUFFIX.length) : step;
    await clickMenuItemByPointer(page, name, level);
    if (opensLevel) level = await openedSubmenu(page, level.getByRole("menuitem", { name, exact: true }));
  }
}

/** Select-mode destination dialog ("Move to"/"Copy to"): clicks each of `steps` (one button per item, exact accessible name; same level-change wait as above: the clicked button disappears, then "Back" appears). */
export async function pickDestination(dialog: Locator, steps: readonly string[]): Promise<void> {
  for (const step of steps) {
    await dialog.getByRole("button", { name: step, exact: true }).click();
    if (step.endsWith(", open")) {
      await expect(dialog.getByRole("button", { name: step, exact: true })).toBeHidden();
      await expect(dialog.getByRole("button", { name: "Back", exact: true })).toBeVisible();
    }
  }
}

/** Native drag drop point: `position` is relative to the target's top-left (like `Locator.dragTo`'s `targetPosition`); omitted = center. */
async function dragPoint(target: Locator, position?: { x: number; y: number }): Promise<{ x: number; y: number }> {
  const box = await target.boundingBox();
  expect(box, "拖曳目標量不到位置（不可見？）").not.toBeNull();
  return position ? { x: box!.x + position.x, y: box!.y + position.y } : { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

/**
 * Folders: while a drag is in progress (mouse already down), moves the pointer to `target` in steps -> waits for `waitFor` (if any) -> moves 1 more
 * step (so the drop state updates). Does not release; the caller moves further or calls `page.mouse.up()`. The target is measured when the move
 * happens because the list can reshape mid-drag (e.g. a spring-loaded folder expanding).
 * `waitFor` is an assertion callback (e.g. preview visible), not waitForTimeout.
 */
export async function dragMoveTo(
  page: Page,
  target: Locator,
  opts: { position?: { x: number; y: number }; waitFor?: () => Promise<void> } = {},
): Promise<void> {
  const to = await dragPoint(target, opts.position);
  await page.mouse.move(to.x, to.y, { steps: 10 });
  if (opts.waitFor) await opts.waitFor();
  await page.mouse.move(to.x + 1, to.y);
}

/**
 * Folders: native drag with page.mouse (Chromium; Playwright intercepts the browser-generated drag data and dispatches dragenter/dragover/drop).
 * Mouse down at the source center -> move a short distance inside the source to start the drag (dragstart) -> `dragMoveTo` in steps to the target
 * (default center, `position` as above), wait for `waitFor`, move 1 more step -> up. `drop: false` stops at the last step without releasing so the caller keeps moving and calls `page.mouse.up()`.
 */
export async function dragTo(
  page: Page,
  source: Locator,
  target: Locator,
  opts: { waitFor?: () => Promise<void>; drop?: boolean; position?: { x: number; y: number } } = {},
): Promise<void> {
  const from = await dragPoint(source);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 8, from.y, { steps: 4 });
  await dragMoveTo(page, target, { position: opts.position, waitFor: opts.waitFor });
  if (opts.drop !== false) await page.mouse.up();
}

export function selectionAiBox(page: Page): Locator {
  return page.getByTestId("selection-ai-box");
}

export async function openSelectionAiBox(page: Page, paragraphText: string): Promise<Locator> {
  // Triple-click gives a non-empty selection that getSelection() sees.
  await editorLocator(page).getByText(paragraphText, { exact: true }).click({ clickCount: 3 });
  await page.getByRole("button", { name: "AI", exact: true }).click();
  const box = selectionAiBox(page);
  await expect(box).toBeVisible();
  return box;
}

/**
 * #272: e2e test hook that sets the autosave-version wait X to `seconds` (null = back to the site setting). Only the e2e stack has this route
 * (`KNOTEBOOK_E2E_TEST_HOOKS=1`, PUBLIC_URL is localhost); `page` must be logged in as site admin. The setting is shared by the whole stack
 * (single worker, serial), so the test sets it at the start and restores null in `finally` (or afterEach).
 */
export async function setAutoWait(page: Page, seconds: number | null): Promise<void> {
  const res = await page.request.put("/api/admin/test/version-auto-wait", { headers: { Origin: E2E_ORIGIN }, data: { seconds } });
  expect(res.status(), await res.text()).toBe(204);
}

/** Id of the note at the current `/n/<handle>/<slug>` URL (not a `/g/` group URL), via the by-path API. */
export async function noteIdFromUrl(page: Page): Promise<string> {
  const [, , handle, slug] = new URL(page.url()).pathname.split("/");
  const res = await page.request.get(`/api/notes/by-path/${handle}/${slug}`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

/**
 * #272: builds a version's full label "name (short id)" from the version list API (unnamed = name derived from the uuid, using the same function as web's `versionLabel`).
 * The format must stay in sync with web's `versionLabel` (`apps/web/src/components/versions/version-labels.ts`); e2e can't depend on the web package.
 */
export async function versionLabelOf(
  request: APIRequestContext,
  noteId: string,
  pick: (v: { id: string; seq: number; kind: string; name: string | null }) => boolean,
): Promise<string> {
  const res = await request.get(`/api/notes/${noteId}/versions?limit=100`);
  expect(res.ok()).toBe(true);
  const { versions } = (await res.json()) as { versions: Array<{ id: string; seq: number; kind: string; name: string | null }> };
  const v = versions.find(pick);
  if (!v) throw new Error(`versionLabelOf：清單裡沒有符合條件的版本（共 ${versions.length} 筆）`);
  return `${v.name ?? derivedVersionName(v.id)} (${v.id.slice(0, 7).toLowerCase()})`;
}

/**
 * Escapes regex special characters when putting a string into a RegExp (version labels contain parentheses).
 * web has the same `reEscape` (`apps/web/src/test/version-fixtures.ts`); keep both in sync (e2e can't depend on the web package).
 */
export function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function tourCard(page: Page): Locator {
  return page.locator("[data-tour-card]");
}

/**
 * From the user menu opens "Help" -> stays on the "Feature tour" page -> "Start tour", and waits for the first stop's card.
 * `userName` is the name of the user menu trigger (the account's display name). For wide viewports; in narrow ones the trigger is inside the drawer and the test drives it itself.
 */
export async function openTour(page: Page, userName: string): Promise<void> {
  await page.getByRole("button", { name: userName, exact: true }).click();
  await page.getByRole("menuitem", { name: "Help", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Help", exact: true });
  await expect(dialog.getByRole("region", { name: "Feature tour" })).toBeVisible();
  await dialog.getByRole("button", { name: "Start tour", exact: true }).click();
  await expect(tourCard(page)).toBeVisible({ timeout: 30_000 });
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** Solid-color RGBA PNG (no fixture file; the repo holds no samples). */
export function solidPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const row = Buffer.alloc(1 + width * 4); // first byte is filter type 0
  for (let x = 0; x < width; x++) row.set([0xe2, 0x43, 0x29, 0xff], 1 + x * 4);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export interface TapArea {
  /** Rendered box (width, height). */
  visual: [number, number];
  /** Tap area (width, height): the farthest from the box center in each direction where the element (or something inside it) is still hit. */
  tap: [number, number];
  /** Box center (viewport coordinates). */
  center: [number, number];
}

/**
 * Measures the area of an element that actually receives taps. Samples `elementFromPoint` every 0.5px from the box center in four directions, up to
 * 24px out; a button whose tap area is enlarged with `::after` measures bigger than its box, and a side covered by another element or touching the
 * viewport edge comes out shorter. The interval includes top-left and excludes bottom-right, so each side can be short by up to 0.5px (1px total).
 */
export async function tapAreaOf(target: Locator): Promise<TapArea> {
  const handle = await target.first().elementHandle({ timeout: 10_000 });
  if (handle === null) throw new Error("tapAreaOf: element not found");
  return handle.evaluate((el): TapArea => {
    const box = el.getBoundingClientRect();
    const hits = (x: number, y: number): boolean => {
      const hit = document.elementFromPoint(x, y);
      return hit !== null && (el === hit || el.contains(hit));
    };
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const reach = (dx: number, dy: number, start: number): number => {
      let d = 0;
      while (d < 24 && hits(cx + dx * (start + d + 0.5), cy + dy * (start + d + 0.5))) d += 0.5;
      return d;
    };
    const left = reach(-1, 0, box.width / 2);
    const right = reach(1, 0, box.width / 2);
    const up = reach(0, -1, box.height / 2);
    const down = reach(0, 1, box.height / 2);
    return {
      visual: [box.width, box.height],
      tap: [box.width + left + right, box.height + up + down],
      center: [cx, cy],
    };
  });
}

/**
 * Picks an item in the shared Select component (`components/ui/select.tsx`): click the trigger, click the option, wait for the menu to close.
 * The option panel is in a portal (outside the dialog), so options are always looked up from `page`. `optionName` matches the option text exactly.
 * The trigger's current value is in `data-value`; the displayed text is in `[data-select-text]` (the trigger also holds hidden text of all options, so don't assert text on the whole button).
 */
export async function chooseSelectOption(page: Page, trigger: Locator, optionName: string | RegExp): Promise<void> {
  await trigger.click();
  await page.getByRole("option", { name: optionName, exact: true }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
}

/** Column ratios are rounded to two decimals when written to the document (`ratiosFromPixels` in `apps/web/src/collab/columns/widths.ts`). */
export const COLUMN_RATIO_STEP = 0.01;

/**
 * Tolerance when converting rounded column ratios back to pixels: the pixel width of one ratio step (larger for wider rows).
 * The real error is at most half a step; pixel rounding and shifts when a column is clamped to its minimum width add more, so a full step is used.
 */
export function ratioQuantPx(cols: readonly { width: number }[]): number {
  return (COLUMN_RATIO_STEP * cols.reduce((sum, c) => sum + c.width, 0)) / cols.length;
}
