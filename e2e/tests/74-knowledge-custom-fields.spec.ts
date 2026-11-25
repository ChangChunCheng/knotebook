import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { ADMIN, adminNav, chooseSelectOption, editorLocator, loginAs, openSiteAdmin } from "./helpers.js";
import {
  RUN,
  apiCreateNote,
  createAccount,
  formOf,
  hoverCardOf,
  iconOf,
  openAs,
  openFormFromSlash,
  openNote,
  resetKnowledgeFields,
  saveForm,
  waitForNoteTitle,
} from "./knowledge-helpers.js";

// The settings are site-wide and every spec shares one stack, so they are put back to the defaults before and after.

test.use({ actionTimeout: 15_000 });

const DESKTOP = { width: 1440, height: 900 };
// Fields can't be deleted and their keys are never reused, so a rerun on a kept stack needs names that make new keys.
const OWNER = `Owner ${RUN}`;
const SCOPE = `Scope ${RUN}`;
const OWNER_KEY = `x-owner-${RUN}`;
const SCOPE_KEY = `x-scope-${RUN}`;
const HEADING = "Release checklist";

async function asAdmin(browser: Browser, run: (page: Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext({ viewport: DESKTOP });
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await run(page);
  } finally {
    await context.close();
  }
}

async function handleOf(page: Page): Promise<string> {
  const res = await page.request.get("/api/auth/me");
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { handle: string }).handle;
}

function newFieldForm(dialog: Locator, page: Page): Locator {
  // The innermost box that holds the heading: the basis options outside it have their own Add option button.
  return dialog.locator("div").filter({ has: page.getByRole("heading", { name: "New custom field", exact: true }) }).last();
}

async function setScopeShown(browser: Browser, shown: boolean): Promise<void> {
  await asAdmin(browser, async (page) => {
    const dialog = await openSiteAdmin(page);
    await adminNav(page, "Knowledge fields");
    const toggle = dialog.getByRole("switch", { name: `Show ${SCOPE}`, exact: true });
    await expect(toggle).toHaveAttribute("aria-checked", String(!shown));
    await toggle.click();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  });
}

async function readContent(page: Page, noteId: string): Promise<{ markdown: string; fingerprint: string }> {
  const res = await page.request.get(`/api/notes/${noteId}/content`);
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as { markdown: string; fingerprint: string };
}

test.beforeAll(async ({ browser }) => {
  await asAdmin(browser, resetKnowledgeFields);
});

test.afterAll(async ({ browser }) => {
  await asAdmin(browser, resetKnowledgeFields);
});

test("74-1 an admin adds a person field and a single-choice field; a member fills them in, an agent can't name someone outside their reach, and a field turned off keeps its value", async ({ browser }) => {
  test.setTimeout(300_000);

  await asAdmin(browser, async (page) => {
    const dialog = await openSiteAdmin(page);
    await adminNav(page, "Knowledge fields");

    await dialog.getByRole("button", { name: "Add custom field", exact: true }).click();
    let form = newFieldForm(dialog, page);
    await form.getByLabel("Name", { exact: true }).fill(OWNER);
    await chooseSelectOption(page, form.getByLabel("Type", { exact: true }), "Person");
    await expect(form.getByLabel("Key", { exact: true })).toHaveValue(OWNER_KEY.slice("x-".length));
    await form.getByRole("button", { name: "Add field", exact: true }).click();

    await dialog.getByRole("button", { name: "Add custom field", exact: true }).click();
    form = newFieldForm(dialog, page);
    await form.getByLabel("Name", { exact: true }).fill(SCOPE);
    await chooseSelectOption(page, form.getByLabel("Type", { exact: true }), "Single choice");
    await form.getByRole("button", { name: "Add option", exact: true }).click();
    await form.getByRole("button", { name: "Add option", exact: true }).click();
    const optionNames = form.getByRole("textbox", { name: "Option name", exact: true });
    await optionNames.nth(0).fill("Internal");
    await optionNames.nth(1).fill("Public");
    await form.getByRole("button", { name: "Add field", exact: true }).click();
    await expect(newFieldForm(dialog, page)).toHaveCount(0);

    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  });

  const bob = await createAccount(browser, "bob");
  const carol = await createAccount(browser, "carol");
  const carolSession = await openAs(browser, carol);
  const carolHandle = await handleOf(carolSession.page).finally(() => carolSession.context.close());

  const { context, page } = await openAs(browser, bob, { viewport: DESKTOP });
  try {
    const bobHandle = await handleOf(page);
    const title = `E2E knowledge custom fields ${RUN}`;
    const note = await apiCreateNote(page, title, `## ${HEADING}\n\nBody text.`);
    await openNote(page, note, title);

    await openFormFromSlash(page, HEADING);
    const form = formOf(page);
    const owner = form.getByRole("combobox", { name: OWNER, exact: true });
    await owner.click();
    await form.getByRole("option", { name: "Me", exact: true }).click();
    await expect(owner).toHaveValue(bob.displayName);
    await chooseSelectOption(page, form.getByLabel(SCOPE, { exact: true }), "Internal");
    await saveForm(page);

    const icon = iconOf(page, "Needs review");
    await icon.hover();
    const card = hoverCardOf(page);
    await expect(card.getByText(OWNER, { exact: true })).toBeVisible();
    await expect(card).toContainText(bob.displayName);
    await expect(card.getByText(SCOPE, { exact: true })).toBeVisible();
    await expect(card).toContainText("Internal");
    await page.mouse.move(0, 0);

    const read = await readContent(page, note.id);
    expect(read.markdown).toContain(`\n${OWNER_KEY}: ${bobHandle}\n`);
    expect(read.markdown).toContain(`\n${SCOPE_KEY}: internal\n`);

    // Carol shares no group or note with bob, so his write can't name her: that line is left out and the stored member stays.
    const write = await page.request.post(`/api/notes/${note.id}/edits`, {
      data: {
        op: "replace_all",
        markdown: read.markdown.replace(`${OWNER_KEY}: ${bobHandle}`, `${OWNER_KEY}: ${carolHandle}`).replace("Body text.", "Body after the write."),
        if_match: read.fingerprint,
      },
    });
    expect(write.status(), await write.text()).toBe(201);
    const written = (await write.json()) as { knowledge?: { ignored: unknown } };
    expect(written.knowledge?.ignored).toEqual([{ heading: HEADING, key: OWNER_KEY, value: carolHandle, reason: "unresolved_member" }]);
    await expect(editorLocator(page).getByText("Body after the write.", { exact: true })).toBeVisible({ timeout: 15_000 });
    expect((await readContent(page, note.id)).markdown).toContain(`\n${OWNER_KEY}: ${bobHandle}\n`);
    await icon.hover();
    await expect(card).toContainText(bob.displayName);
    await expect(card).not.toContainText(carol.displayName);
    await page.mouse.move(0, 0);

    await setScopeShown(browser, false);
    await page.reload();
    await waitForNoteTitle(page, title);
    await icon.hover();
    await expect(card.getByText(OWNER, { exact: true })).toBeVisible();
    await expect(card).toContainText(bob.displayName);
    await expect(card.getByText(SCOPE, { exact: true })).toHaveCount(0);
    await expect(card).not.toContainText("Internal");
    await page.mouse.move(0, 0);
    expect((await readContent(page, note.id)).markdown).not.toContain(SCOPE_KEY);
    await icon.click();
    await expect(form).toBeVisible();
    await expect(form.getByRole("combobox", { name: OWNER, exact: true })).toBeVisible();
    await expect(form.getByText(SCOPE, { exact: true })).toHaveCount(0);
    await form.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(form).toBeHidden();

    await setScopeShown(browser, true);
    await page.reload();
    await waitForNoteTitle(page, title);
    await icon.hover();
    await expect(card.getByText(SCOPE, { exact: true })).toBeVisible();
    await expect(card).toContainText("Internal");
  } finally {
    await context.close();
  }
});
