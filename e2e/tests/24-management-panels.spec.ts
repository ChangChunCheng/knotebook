import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { ADMIN, createNote, loginAs, openGroupPanel, openSiteAdmin, showSidebarTab } from "./helpers.js";

/**
 * The two focus-timing cases use useLayoutEffect, which jsdom cannot see. The content level's `getByRole("dialog", { name })`
 * works because, while the left card is hidden, the title is still the node referenced directly by aria-labelledby.
 * Screenshots for visual inspection: taken only when `PANELS_SCREENSHOT_DIR` is set, otherwise skipped; this file writes no
 * absolute path.
 */
const shotDir = process.env.PANELS_SCREENSHOT_DIR;
async function shot(page: Page, name: string): Promise<void> {
  if (shotDir) await page.screenshot({ path: path.join(shotDir, name) });
}

async function createGroup(page: Page, name: string): Promise<void> {
  await showSidebarTab(page, "Groups");
  await page.getByRole("complementary").getByRole("button", { name: "New group", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New group" });
  await dialog.getByLabel("Group name").fill(name);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

/**
 * An outline button's hover must fill: after hover the background must **equal** the actual colour of `--brand-deep` (the
 * `hover:bg-brand-deep` of the outline variant in `button.tsx`). "Not transparent" is not enough: the first intermediate frame
 * of `transition-colors` would pass (a screenshot would catch it midway), and so would a caller adding its own background
 * (opaque at rest) - both remove the assertion's discriminating power. The expected colour is obtained in the page by
 * resolving the CSS variable on a temporary element.
 */
async function expectOutlineHoverFilled(page: Page, scope: ReturnType<Page["locator"]>, name: string): Promise<void> {
  const button = scope.getByRole("button", { name, exact: true });
  const brandDeep = await button.evaluate((el) => {
    const probe = document.createElement("span");
    probe.style.backgroundColor = "var(--brand-deep)";
    el.parentElement!.appendChild(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  });
  expect(brandDeep).not.toBe("rgba(0, 0, 0, 0)");
  await button.hover();
  await expect.poll(async () => button.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(brandDeep);
}

/** The element's whole box is inside the viewport (not just "partly visible"). Uses the box rather than `toBeInViewport()`, which passes with any intersection. */
async function expectInViewport(page: Page, locator: ReturnType<Page["locator"]>): Promise<void> {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
}

test.describe.serial("24 management panels (#247)", () => {
  test("24-1 1440x900: open each of the three panels once (title, left-card item aria-current; personal settings also checks focus lands on the close button on open) -> Esc returns to the background page", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const page = await context.newPage();
      await loginAs(page, ADMIN.email, ADMIN.password);
      await expect(page).toHaveURL(/\/$/);
      const groupName = `E2E Panels ${Date.now()}`;
      await createGroup(page, groupName);

      await page.getByRole("button", { name: "admin", exact: true }).click();
      await page.getByRole("menuitem", { name: "Settings" }).click();
      const settings = page.getByRole("dialog", { name: "Settings" });
      await expect(settings.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Account info" })).toHaveAttribute("aria-current", "page");
      await expect(settings.getByRole("button", { name: "Close" })).toBeFocused();
      // Before the screenshot wait for the right card's lazy block to really draw (otherwise it captures "Loading...").
      await expect(settings.getByRole("heading", { level: 1 })).toBeVisible();
      await shot(page, "24-settings-1440.png");
      await page.keyboard.press("Escape");
      await expect(page).toHaveURL(/\/$/);
      await expect(settings).toHaveCount(0);

      await openGroupPanel(page, groupName);
      const group = page.getByRole("dialog", { name: groupName });
      await expect(group.getByRole("navigation", { name: groupName }).getByRole("link", { name: "Members" })).toHaveAttribute("aria-current", "page");
      await expect(group.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
      await shot(page, "24-group-1440.png");
      await page.keyboard.press("Escape");
      await expect(page).toHaveURL(/\/$/);

      const admin = await openSiteAdmin(page);
      await expect(admin.getByRole("navigation", { name: "Site admin" }).getByRole("link", { name: "Users" })).toHaveAttribute("aria-current", "page");
      await expect(admin.getByRole("heading", { level: 1, name: "User management" })).toBeVisible();
      // #267: the "Last active" column - the admin's own session request just now counts as activity, so that row shows Online.
      // Query by table name / row name (= email) / cell name, not by column index.
      const usersTable = admin.getByRole("table", { name: "Users", exact: true });
      await expect(usersTable.getByRole("columnheader", { name: "Last active", exact: true })).toHaveCount(1);
      await expect(usersTable.getByRole("row", { name: ADMIN.email, exact: true }).getByRole("cell", { name: "Online", exact: true })).toBeVisible();
      await shot(page, "24-admin-1440.png");
      await page.keyboard.press("Escape");
      await expect(page).toHaveURL(/\/$/);
    } finally {
      await context.close();
    }
  });

  test("24-2 390x844: opening lands on the content level (dialog accessible name present, focus on the back button) -> back goes to the item level (focus on the aria-current item) -> clicking that item returns to the content level (focus on the content container)", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      const page = await context.newPage();
      await loginAs(page, ADMIN.email, ADMIN.password);
      await expect(page).toHaveURL(/\/$/);
      await page.goto("/admin/users");
      const dialog = page.getByRole("dialog", { name: "Site admin" });
      await expect(dialog).toBeVisible();
      const back = dialog.getByRole("button", { name: "Back to sections" });
      await expect(back).toBeVisible();
      await expect(back).toBeFocused();
      await expect(dialog.getByRole("navigation", { name: "Site admin" })).toBeHidden();
      await expect(dialog.getByRole("heading", { level: 1, name: "User management" })).toBeVisible();
      // Narrow content level: the users table is wider than 390 and once pushed the right card past the viewport's right edge - the back button at the top left must be entirely inside the viewport. A phone sheet has no close button (back stack).
      await expect(dialog.getByText(ADMIN.email, { exact: true })).toBeVisible();
      await expectInViewport(page, back);
      await expect(dialog.getByRole("button", { name: "Close" })).toHaveCount(0);
      const region = dialog.getByRole("region", { name: "Users", exact: true });
      expect(await region.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await shot(page, "24-admin-390-content.png");

      await back.click();
      const current = dialog.getByRole("navigation", { name: "Site admin" }).getByRole("link", { name: "Users" });
      await expect(current).toBeVisible();
      await expect(current).toHaveAttribute("aria-current", "page");
      await expect(current).toBeFocused();
      await expect(dialog.locator("[data-management-content]")).toBeHidden();
      await expect(page).toHaveURL(/\/admin\/users$/);
      await shot(page, "24-admin-390-items.png");

      await current.click();
      await expect(dialog.locator("[data-management-content]")).toBeVisible();
      await expect(dialog.locator("[data-management-content]")).toBeFocused();
    } finally {
      await context.close();
    }
  });

  test("24-3 old URL redirects: /settings/groups/<id> -> /groups/<id>; /settings/users -> /admin/users; /admin, /admin/auth, /admin/versions -> the matching item of the site modal", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const page = await context.newPage();
      await loginAs(page, ADMIN.email, ADMIN.password);
      await expect(page).toHaveURL(/\/$/);
      const groupName = `E2E Redirect ${Date.now()}`;
      await createGroup(page, groupName);
      const groupId = await openGroupPanel(page, groupName);
      await page.keyboard.press("Escape");

      await page.goto(`/settings/groups/${groupId}`);
      await expect(page).toHaveURL(new RegExp(`/groups/${groupId}$`));
      await expect(page.getByRole("dialog", { name: groupName })).toBeVisible();
      await page.goto(`/settings/groups/${groupId}/roles`);
      await expect(page).toHaveURL(new RegExp(`/groups/${groupId}/roles$`));

      for (const [from, to] of [
        ["/settings/users", /\/admin\/users$/],
        ["/admin", /\/admin\/users$/],
        ["/admin/auth", /\/admin\/login$/],
        ["/admin/versions", /\/admin\/storage$/],
      ] as const) {
        await page.goto(from);
        await expect(page).toHaveURL(to);
        await expect(page.getByRole("dialog", { name: "Site admin" })).toBeVisible();
        await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
      }
    } finally {
      await context.close();
    }
  });

  test("24-4 site-wide outline hover fill (three places, screenshots): the share panel, the change-password page, the cancel button of the delete-group confirmation", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const page = await context.newPage();
      await loginAs(page, ADMIN.email, ADMIN.password);
      await expect(page).toHaveURL(/\/$/);
      const groupName = `E2E Outline ${Date.now()}`;
      await createGroup(page, groupName);

      await page.getByRole("complementary").getByRole("button", { name: `Group actions for ${groupName}` }).click();
      await page.getByRole("menuitem", { name: "Delete group" }).click();
      const del = page.getByRole("dialog", { name: "Delete group?" });
      await expectOutlineHoverFilled(page, del, "Cancel");
      await shot(page, "24-outline-delete-cancel.png");
      await del.getByRole("button", { name: "Cancel", exact: true }).click();

      // 2. Share panel: a group note's share panel has no outline button (only the explanation, link and the public link switch),
      //    so use a personal note's share panel and hover-assert the add-member form's submit button "Add" (variant outline,
      //    `ShareDialog.tsx`) that appears after choosing "Members only".
      await createNote(page, `E2E Outline note ${Date.now()}`);
      await page.getByRole("button", { name: "Share", exact: true }).click();
      const share = page.getByRole("dialog", { name: "Share note" });
      await expect(share).toBeVisible();
      await share.getByRole("radio", { name: "Members only" }).check();
      await expectOutlineHoverFilled(page, share, "Add");
      await shot(page, "24-outline-share.png");
      await page.keyboard.press("Escape");

      await page.goto("/change-password");
      // Wait for the page to really draw (lazy chunk) before the screenshot: an unflagged account can also open this page directly (the route does not block).
      await expect(page.getByRole("button", { name: "Change password", exact: true })).toBeVisible();
      // This page has only a brandSolid submit button and no outline button, so it is screenshot only (no hover assertion).
      await shot(page, "24-outline-change-password.png");
    } finally {
      await context.close();
    }
  });

  test("24-5 1280x720: when the right card's content is longer than the panel it scrolls inside the right card, the tray does not push out of the panel and the close button stays in the viewport (the panel's grid track is minmax(0,1fr))", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    try {
      const page = await context.newPage();
      await loginAs(page, ADMIN.email, ADMIN.password);
      await expect(page).toHaveURL(/\/$/);
      // The "Authorization" page has an API token section plus a three-step MCP setup, which is taller than the 720 panel even for an empty account, so no extra data is needed.
      await page.goto("/settings/authorization");
      const dialog = page.getByRole("dialog", { name: "Settings" });
      await expect(dialog.getByRole("heading", { level: 1, name: "Authorization" })).toBeVisible();
      await expect(dialog.getByRole("heading", { level: 2, name: "Connect Claude with MCP" })).toBeVisible();
      const content = dialog.locator("[data-management-content]");
      await expect
        .poll(async () => content.evaluate((el) => el.scrollHeight - el.clientHeight), {
          message: "右卡內容區要自己捲動（scrollHeight > clientHeight）；軌道被內容撐大時兩者相等、整塊溢出視窗",
        })
        .toBeGreaterThan(0);
      const overflow = await content.evaluate((el) => {
        // The tray is the content area's grandparent.
        const tray = el.parentElement!.parentElement!.getBoundingClientRect();
        const box = el.closest('[role="dialog"]')!.getBoundingClientRect();
        return Math.max(box.left - tray.left, box.top - tray.top, tray.right - box.right, tray.bottom - box.bottom);
      });
      expect(overflow).toBeLessThanOrEqual(0.5);
      await expectInViewport(page, dialog.getByRole("button", { name: "Close" }));
    } finally {
      await context.close();
    }
  });
});
