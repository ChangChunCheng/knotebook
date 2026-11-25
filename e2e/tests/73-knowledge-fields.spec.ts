import { expect, test, type Page } from "@playwright/test";
import { ADMIN, adminNav, loginAs, openSiteAdmin } from "./helpers.js";
import {
  RUN,
  apiCreateNote,
  createAccount,
  fillForm,
  formOf,
  hoverCardOf,
  iconOf,
  iconsIn,
  localToday,
  openAs,
  openFormFromSlash,
  openNote,
  resetKnowledgeFields,
  saveForm,
} from "./knowledge-helpers.js";
import { knowledgeComment } from "./markdown-helpers.js";

/**
 * The site's knowledge field settings as an admin sets them and a person meets them in the form and on the card, the status a person picks with no other field,
 * and knowledge written before statuses were stored.
 * The settings are site-wide and every spec shares one stack, so they are put back to the defaults before each test and after the last.
 */

test.use({ actionTimeout: 15_000 });

const DESKTOP = { width: 1440, height: 900 };
// Options can't be deleted, so a rerun on a kept stack must not reuse the name and get a suffixed key.
const VENDOR = `Vendor docs ${RUN}`;

async function asAdmin(browser: import("@playwright/test").Browser, run: (page: Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext({ viewport: DESKTOP });
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await run(page);
  } finally {
    await context.close();
  }
}

test.describe("knowledge fields", () => {
  // Each test starts from the defaults, whatever an earlier test or run left behind.
  test.beforeEach(async ({ browser }) => {
    await asAdmin(browser, resetKnowledgeFields);
  });

  test.afterAll(async ({ browser }) => {
    await asAdmin(browser, resetKnowledgeFields);
  });

  test("73-1 an admin turns Conclusion off, renames a basis option and adds one; the form and the card follow", async ({ browser }) => {
    test.setTimeout(180_000);
    await asAdmin(browser, async (page) => {
      const dialog = await openSiteAdmin(page);
      await adminNav(page, "Knowledge fields");
      await dialog.getByRole("switch", { name: "Show Conclusion", exact: true }).click();
      await dialog.getByPlaceholder("Documentation", { exact: true }).fill("Spec");
      await dialog.getByRole("button", { name: "Add option", exact: true }).click();
      // The new row comes last; options added by earlier runs share its placeholder.
      await dialog.getByPlaceholder("Option name", { exact: true }).last().fill(VENDOR);
      await expect(dialog.getByPlaceholder("key", { exact: true })).toHaveValue(`vendor-docs-${RUN}`);
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
    });

    const alice = await createAccount(browser, "alice");
    const { context, page } = await openAs(browser, alice, { viewport: DESKTOP });
    try {
      const title = `E2E knowledge fields form ${RUN}`;
      const note = await apiCreateNote(page, title, "## Vendor limits\n\nBody text.");
      await openNote(page, note, title);
      await openFormFromSlash(page, "Vendor limits");
      const form = formOf(page);
      await expect(form.getByLabel("When to read", { exact: true })).toBeVisible();
      await expect(form.getByLabel("Conclusion", { exact: true })).toHaveCount(0);

      await form.getByLabel("Basis", { exact: true }).click();
      await expect(page.getByRole("listbox").getByRole("option")).toHaveText(["Not filled", "Tested", "Spec", "Inferred", VENDOR]);
      await page.getByRole("option", { name: VENDOR, exact: true }).click();
      await expect(page.getByRole("listbox")).toHaveCount(0);
      await fillForm(page, { when: "Before calling the vendor API" });
      await saveForm(page);

      await iconOf(page, "Needs review").hover();
      const card = hoverCardOf(page);
      await expect(card).toContainText("Before calling the vendor API");
      await expect(card).toContainText(VENDOR);
      await expect(card.getByText("Basis", { exact: true })).toBeVisible();
      await expect(card.getByText("Conclusion", { exact: true })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("73-2 knowledge saved with only Verified and every field empty shows a green check; Today fills in the date, and switching to Outdated saves without a replacement", async ({ browser }) => {
    test.setTimeout(150_000);
    const alice = await createAccount(browser, "alice");
    const { context, page } = await openAs(browser, alice, { viewport: DESKTOP });
    try {
      const title = `E2E knowledge status only ${RUN}`;
      const note = await apiCreateNote(page, title, "## Bare rule\n\nBody text.");
      await openNote(page, note, title);
      const today = await localToday(page);
      await openFormFromSlash(page, "Bare rule");
      const date = formOf(page).getByLabel("Last verified", { exact: true });
      await fillForm(page, { status: "Verified" });
      await expect(date).toHaveValue(today);
      // Picking Verified filled in the date; clearing it leaves an entry with nothing but its status.
      await date.fill("");
      await expect(date).toHaveValue("");
      await saveForm(page);
      const verified = iconOf(page, "Verified");
      await expect(verified).toBeVisible();
      await expect(page.locator('[data-kb-knowledge-icon][data-kind="verified"]')).toHaveCount(1);
      await verified.hover();
      await expect(hoverCardOf(page).getByText("Not filled", { exact: true })).toHaveCount(4);
      await page.mouse.move(0, 0);

      await verified.click();
      await expect(formOf(page)).toBeVisible();
      await expect(date).toHaveValue("");
      await fillForm(page, { verifiedToday: true });
      await expect(date).toHaveValue(today);
      await expect(formOf(page).getByRole("radio", { name: "Verified", exact: true })).toHaveAttribute("aria-checked", "true");
      await fillForm(page, { status: "Outdated" });
      await expect(formOf(page).getByRole("combobox", { name: "Replaced by" })).toHaveValue("");
      await saveForm(page);
      const outdated = iconOf(page, "Outdated");
      await expect(outdated).toBeVisible();
      await expect(iconsIn(page)).toHaveCount(1);
      await outdated.hover();
      await expect(hoverCardOf(page)).toContainText(today);
    } finally {
      await context.close();
    }
  });

  test("73-3 knowledge written without a status reads as needs review when it has no verified date, and as verified when it has one", async ({ browser }) => {
    test.setTimeout(120_000);
    const alice = await createAccount(browser, "alice");
    const { context, page } = await openAs(browser, alice, { viewport: DESKTOP });
    try {
      const title = `E2E knowledge old shape ${RUN}`;
      const content = [
        "## Undated rule",
        knowledgeComment(["when: Written before statuses were stored"]),
        "",
        "Body text.",
        "",
        "## Dated rule",
        knowledgeComment(["when: Checked once", "verified: 2026-01-15"]),
        "",
        "More text.",
        "",
      ].join("\n");
      const note = await apiCreateNote(page, title, content);
      await openNote(page, note, title);
      await expect(iconsIn(page)).toHaveCount(2, { timeout: 15_000 });
      await expect(iconOf(page, "Needs review")).toHaveCount(1);
      await expect(iconOf(page, "Verified")).toHaveCount(1);
      await expect(page.locator('[data-kb-knowledge-icon][data-kind="needsReview"]')).toHaveCount(1);

      await iconOf(page, "Needs review").hover();
      await expect(hoverCardOf(page)).toContainText("Written before statuses were stored");
      await expect(hoverCardOf(page).locator('[data-kb-knowledge-banner="amber"]')).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
