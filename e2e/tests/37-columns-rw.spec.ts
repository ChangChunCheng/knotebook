import { expect, test, type Locator, type Page } from "@playwright/test";
import { E2E_ORIGIN } from "../ports.js";
import { ADMIN, chooseSelectOption, adminNav, createNote, editorLocator, loginAs, noteIdFromUrl, openSiteAdmin, selectionAiBox, waitForEditorSelection } from "./helpers.js";

/**
 * - Content is always pasted as markdown (plain-text clipboard -> `collab/paste.ts` takes over; same as `pasteMarkdown` in
 *   34-columns).
 * - e2e cannot import shared: the canonical literals (`COLUMNS_OPEN_TAG`, `columnOpenTag`) are written out again verbatim in this
 *   file; change both together.
 * - REST goes through the page's session cookie (`page.request`), and writes carry an Origin (as in 27-site-links).
 * - `/echo` returns the last user message with the first `Original` replaced by `Rewritten`; the built-in action's user template
 *   is `{{text}}`, so what comes back is the selected markdown.
 *   E3 and E4 both go through "preview -> Apply": E3's anchor contains an image, so `hasNonTextBlock` blocks auto-apply; E4's
 *   anchor is a side-by-side row with only text blocks, which does not block, so when Rewrite is direct it applies automatically
 *   and there is no Apply button. So the describe's beforeAll sets the built-in Rewrite to preview through the admin API (same
 *   method as `setRewriteApplyMode` in 04) and afterAll restores the value read before the change - it depends neither on 04's
 *   afterAll having restored it nor on a fresh install's default.
 * - The provider is created in the describe's beforeAll with "Default model" ticked (same reason as 25-selection-ai-box: in a
 *   full run the provider other specs leave behind points at `/slow`).
 *   After the run the site's default model stays on this `/echo` one (same convention as 04 / 10 / 25: each spec creates its
 *   own provider and ticks its own default).
 */

const RUN = Date.now();
const ORIGIN = E2E_ORIGIN;
const ROW = '[data-node-type="columnList"]';
const COL = '[data-node-type="column"]';
const IMAGE = '[data-content-type="image"]';
const COLUMNS_OPEN_TAG = '<div data-kb-columns style="display:flex;gap:16px">';
const columnOpenTag = (width: string) => `<div data-kb-column style="flex:${width}">`;
const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const TABLE_120 = '<table><tr><th colwidth="120">h1</th><th>h2</th></tr><tr><td>c1</td><td>c2</td></tr></table>';

type Content = { markdown: string; fingerprint: string };
type Section = { section: { id: string; markdown: string; fingerprint: string } };

function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

function expectNoPageErrors(errors: string[]): void {
  expect(errors.filter((m) => !m.includes("ResizeObserver loop")), "pageerror").toEqual([]);
}

async function startNote(page: Page, label: string): Promise<string[]> {
  const errors = collectPageErrors(page);
  await loginAs(page, ADMIN.email, ADMIN.password);
  await createNote(page, `E2E columns-rw ${label} ${RUN}`);
  return errors;
}

function figure(url: string, alt: string): string {
  return `<figure><img alt="${alt}" src="${url}" width="300"></figure>`;
}

function row2(left: string): string {
  return [COLUMNS_OPEN_TAG, columnOpenTag("1"), "", left, "", "</div>", columnOpenTag("1.5"), "", "## 設備規格", "", "型號：x", "", "</div>", "</div>"].join("\n");
}

async function pasteMarkdown(page: Page, markdown: string): Promise<void> {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });
  await editorLocator(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await waitForEditorSelection(page);
  await page.evaluate((text) => navigator.clipboard.writeText(text), markdown);
  await page.keyboard.press("ControlOrMeta+v");
}

async function uploadPng(page: Page, noteId: string): Promise<string> {
  const res = await page.request.post(`/api/notes/${noteId}/uploads`, {
    headers: { Origin: ORIGIN },
    multipart: { file: { name: "p1x1.png", mimeType: "image/png", buffer: PNG_1X1 } },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { url: string }).url;
}

async function readContent(page: Page, noteId: string): Promise<Content> {
  const res = await page.request.get(`/api/notes/${noteId}/content`);
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as Content;
}

async function postEdit(page: Page, noteId: string, data: Record<string, string>) {
  return page.request.post(`/api/notes/${noteId}/edits`, { headers: { Origin: ORIGIN }, data });
}

/** Width of the first `col` in the main editor's first table (prosemirror-tables' TableView writes colwidth as `style.width`). */
function firstColWidth(page: Page): Promise<string> {
  return editorLocator(page).locator("table colgroup col").first().evaluate((el) => (el as HTMLElement).style.width);
}

/**
 * Shared by E2 / E3: paste "a leading text + an image of width 300 + a table whose first column is 120 wide + a text", and wait
 * until both sizes are in the editor (parsed in the browser).
 * The leading text lets E3's select-all start at text (Ctrl+A in Chromium lands as a TextSelection, see 25-selection-ai-box), so
 * the image is certainly inside the selection.
 */
async function pasteSized(page: Page, noteId: string, paragraph: string): Promise<void> {
  const url = await uploadPng(page, noteId);
  await pasteMarkdown(page, ["Lead line", "", figure(url, "p"), "", TABLE_120, "", paragraph, ""].join("\n"));
  const editor = editorLocator(page);
  await expect(editor.getByText(paragraph, { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(editor.locator(IMAGE)).toHaveCount(1);
  await expect(editor.locator(IMAGE)).toHaveAttribute("data-preview-width", "300");
  await expect.poll(() => firstColWidth(page)).toBe("120px");
}

/** Block ids of the image and the table (the ids change when a write or an AI apply replaces the blocks - used to prove they really were rewritten, not left untouched). */
async function sizedBlockIds(page: Page): Promise<Array<string | null>> {
  const editor = editorLocator(page);
  const idOf = (el: Element) => el.closest("[data-id]")?.getAttribute("data-id") ?? null;
  return [await editor.locator(IMAGE).first().evaluate(idOf), await editor.locator("table").first().evaluate(idOf)];
}

async function expectSizesKept(page: Page, before: Array<string | null>): Promise<void> {
  const editor = editorLocator(page);
  await expect.poll(async () => (await sizedBlockIds(page)).map((id) => id !== null && !before.includes(id))).toEqual([true, true]);
  await expect(editor.locator(IMAGE)).toHaveCount(1);
  await expect(editor.locator(IMAGE)).toHaveAttribute("data-preview-width", "300");
  await expect(editor.locator("table")).toHaveCount(1);
  await expect.poll(() => firstColWidth(page)).toBe("120px");
}

test("E1: REST reads the div form -> replace_all writes it back unchanged with 201, the row is unchanged and a re-read is verbatim identical -> 5 columns get 400 unsupported_columns and the note is unchanged", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "E1");
  const noteId = await noteIdFromUrl(page);
  const url = await uploadPng(page, noteId);
  const editor = editorLocator(page);
  await pasteMarkdown(page, [row2(figure(url, "A 點")), "", "after", ""].join("\n"));
  const rows = editor.locator(ROW);
  await expect(rows).toHaveCount(1, { timeout: 15_000 });
  await expect(rows.first().locator(COL)).toHaveCount(2);
  await expect(editor.getByText("after", { exact: true })).toBeVisible();

  // The paste reaches the server through collab with a delay: it counts as seen by the server once the read contains "after" and the image width
  let original!: Content;
  await expect(async () => {
    original = await readContent(page, noteId);
    expect(original.markdown).toContain("after");
    expect(original.markdown).toContain('width="300"></figure>');
  }).toPass({ timeout: 20_000 });
  const lines = original.markdown.split("\n");
  expect(lines[0]).toBe(COLUMNS_OPEN_TAG);
  expect(lines.filter((l) => l.startsWith("<div data-kb-column "))).toEqual([columnOpenTag("1"), columnOpenTag("1.5")]);
  expect(original.markdown).toContain(figure(url, "A 點"));

  // Write back unchanged: 201; replace_all replaces every block's id, so wait until the row's data-id changes = the page received this write, then check the row and both columns' content
  const rowIdBefore = await rows.first().getAttribute("data-id");
  expect(rowIdBefore).toBeTruthy();
  const same = await postEdit(page, noteId, { op: "replace_all", markdown: original.markdown, if_match: original.fingerprint });
  expect(same.status(), await same.text()).toBe(201);
  await expect.poll(() => rows.first().getAttribute("data-id"), { timeout: 10_000 }).not.toBe(rowIdBefore);
  await expect(rows).toHaveCount(1);
  const cols = editor.locator(`${ROW} > ${COL}`);
  await expect(cols).toHaveCount(2);
  await expect(cols.nth(0).locator(IMAGE)).toHaveAttribute("data-preview-width", "300");
  await expect(cols.nth(1)).toContainText("設備規格");
  await expect(cols.nth(1)).toContainText("型號：x");
  await expect(editor.getByText("after", { exact: true })).toBeVisible();
  const reread = await readContent(page, noteId);
  expect(reread.markdown).toBe(original.markdown);

  const fiveCols = [COLUMNS_OPEN_TAG, ...["k1", "k2", "k3", "k4", "k5"].flatMap((t) => [columnOpenTag("1"), "", t, "", "</div>"]), "</div>", ""].join("\n");
  // The fingerprint comparison happens before parsing: if another update arrives between the read and the send it answers 409 - re-read the fingerprint and resend only on 409; the last request must be 400 unsupported_columns
  let status = 0;
  let body = "";
  await expect(async () => {
    const fresh = await readContent(page, noteId);
    const rejected = await postEdit(page, noteId, { op: "replace_all", markdown: fiveCols, if_match: fresh.fingerprint });
    status = rejected.status();
    body = await rejected.text();
    expect(status, body).not.toBe(409);
  }).toPass({ timeout: 15_000 });
  expect(status, body).toBe(400);
  expect((JSON.parse(body) as { error: { code: string } }).error.code).toBe("unsupported_columns");
  const after = await readContent(page, noteId);
  expect(after.markdown).toBe(reread.markdown);
  await expect(rows).toHaveCount(1);
  await expect(editor).not.toContainText("k5");
  expectNoPageErrors(errors);
});

test("E2 (#305): paste a figure with width 300 and a table with first column 120 -> REST reads _top, old -> new, replace_section -> text changes, width and column width stay", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "E2");
  const noteId = await noteIdFromUrl(page);
  await pasteSized(page, noteId, "old words");
  const idsBefore = await sizedBlockIds(page);
  expect(idsBefore.every((id) => id !== null), "image／table 的 block id").toBe(true);

  let top!: Section["section"];
  await expect(async () => {
    const res = await page.request.get(`/api/notes/${noteId}/content?section=_top`);
    expect(res.status(), await res.text()).toBe(200);
    top = ((await res.json()) as Section).section;
    expect(top.markdown).toContain("old words");
    expect(top.markdown).toContain('width="300"></figure>');
    expect(top.markdown).toContain('colwidth="120"');
  }).toPass({ timeout: 20_000 });

  const res = await postEdit(page, noteId, {
    op: "replace_section",
    section_id: "_top",
    markdown: top.markdown.replace("old words", "new words"),
    if_match: top.fingerprint,
  });
  expect(res.status(), await res.text()).toBe(201);
  const editor = editorLocator(page);
  await expect(editor.getByText("new words", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(editor).not.toContainText("old words");
  await expectSizesKept(page, idsBefore);
  expectNoPageErrors(errors);
});

type ApplyMode = "direct" | "preview";
let originalRewriteMode: ApplyMode | undefined;

/** Same method as `setRewriteApplyMode` in 04 (that one is not exported): changes the built-in Rewrite's applyMode through the admin API; the first call records the original value. */
async function setRewriteApplyMode(page: Page, applyMode: ApplyMode): Promise<void> {
  const listed = await page.request.get("/api/admin/ai/actions");
  expect(listed.status()).toBe(200);
  const { actions } = (await listed.json()) as { actions: { id: string; name: string; builtin: boolean; applyMode: ApplyMode }[] };
  const rewrite = actions.find((action) => action.builtin && action.name === "Rewrite");
  expect(rewrite, "內建 Rewrite 動作").toBeDefined();
  originalRewriteMode ??= rewrite!.applyMode;
  const res = await page.request.patch(`/api/admin/ai/actions/${rewrite!.id}`, { data: { applyMode } });
  expect(res.status()).toBe(200);
}

test.describe("in-app AI (ai-stub /echo)", () => {
  test.afterAll(async ({ browser }) => {
    if (originalRewriteMode === undefined) return;
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await loginAs(page, ADMIN.email, ADMIN.password);
      await setRewriteApplyMode(page, originalRewriteMode);
    } finally {
      await context.close();
    }
  });

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await loginAs(page, ADMIN.email, ADMIN.password);
      await openSiteAdmin(page);
      await adminNav(page, "AI agents");
      await page.getByRole("button", { name: "Add provider", exact: true }).click();
      const providerDialog = page.getByRole("dialog", { name: "Add provider" });
      const providerName = `E2E Echo Provider ${RUN}`;
      await providerDialog.locator("#ai-provider-name").fill(providerName);
      await chooseSelectOption(page, providerDialog.locator("#ai-provider-type"), "OpenAI-compatible");
      await providerDialog.locator("#ai-provider-base-url").fill("http://ai-stub:9500/echo");
      await providerDialog.getByRole("button", { name: "Create", exact: true }).click();
      await expect(providerDialog).not.toBeVisible();
      await page.getByRole("row", { name: `${providerName} details`, exact: true }).getByRole("button", { name: "Add model", exact: true }).click();
      const modelDialog = page.getByRole("dialog", { name: "Add model" });
      await modelDialog.getByLabel("Model ID", { exact: true }).fill("e2e-echo-model");
      await modelDialog.getByLabel("Display name", { exact: true }).fill(`E2E Echo Model ${RUN}`);
      await modelDialog.getByLabel("Default model", { exact: true }).check();
      await modelDialog.getByRole("button", { name: "Create", exact: true }).click();
      await expect(modelDialog).not.toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page).toHaveURL(/\/$/);
      await setRewriteApplyMode(page, "preview"); // E4's anchor has no non-text block, so direct would auto-apply (see the header)
    } finally {
      await context.close();
    }
  });

  async function rewriteAndApply(box: Locator, expected: string): Promise<void> {
    await box.getByRole("button", { name: "Rewrite", exact: true }).click();
    await expect(box.getByTestId("selection-ai-preview")).toContainText(expected, { timeout: 15_000 });
    const apply = box.getByRole("button", { name: "Apply", exact: true });
    await expect(apply).toBeEnabled();
    await apply.click();
    await expect(box).toBeHidden();
  }

  test("E3 (in-app AI half): image width 300 + table with first column 120 + \"Original words\" -> select all -> Rewrite -> apply -> \"Rewritten words\", width and column width unchanged", async ({ page }) => {
    test.setTimeout(120_000);
    const errors = await startNote(page, "E3");
    const noteId = await noteIdFromUrl(page);
    await pasteSized(page, noteId, "Original words");
    const editor = editorLocator(page);
    const idsBefore = await sizedBlockIds(page);
    expect(idsBefore.every((id) => id !== null), "image／table 的 block id").toBe(true);

    await editor.getByText("Original words", { exact: true }).click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.getByRole("button", { name: "AI", exact: true }).click();
    const box = selectionAiBox(page);
    await expect(box).toBeVisible();
    await rewriteAndApply(box, "Rewritten words");

    await expect(editor.getByText("Rewritten words", { exact: true })).toBeVisible();
    await expect(editor).not.toContainText("Original words");
    await expectSizesKept(page, idsBefore);
    expectNoPageErrors(errors);
  });

  test("E4: drag-select from left column text to right column text -> the toolbar has an AI button -> Rewrite -> apply -> still one row with two columns, left column \"Rewritten left\"", async ({ page }) => {
    test.setTimeout(120_000);
    const errors = await startNote(page, "E4");
    const editor = editorLocator(page);
    await pasteMarkdown(page, [row2("Original left"), ""].join("\n"));
    const rows = editor.locator(ROW);
    const cols = editor.locator(`${ROW} > ${COL}`);
    await expect(rows).toHaveCount(1, { timeout: 15_000 });
    await expect(cols).toHaveCount(2);
    await expect(cols.nth(0)).toHaveText("Original left");
    const rowIdBefore = await rows.first().getAttribute("data-id");
    expect(rowIdBefore).toBeTruthy();

    const from = (await editor.getByText("Original left", { exact: true }).boundingBox())!;
    const to = (await editor.getByText("型號：x", { exact: true }).boundingBox())!;
    await page.mouse.move(from.x + 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width - 2, to.y + to.height / 2, { steps: 10 });
    await page.mouse.up();
    const aiButton = page.getByRole("button", { name: "AI", exact: true });
    await expect(aiButton).toBeVisible();
    await aiButton.click();
    const box = selectionAiBox(page);
    await expect(box).toBeVisible();
    await rewriteAndApply(box, "Rewritten left");

    await expect.poll(() => rows.first().getAttribute("data-id")).not.toBe(rowIdBefore);
    await expect(rows).toHaveCount(1);
    await expect(cols).toHaveCount(2);
    await expect(cols.nth(0)).toHaveText("Rewritten left");
    await expect(cols.nth(1)).toContainText("設備規格");
    await expect(cols.nth(1)).toContainText("型號：x");
    await expect(editor).not.toContainText("Original left");
    expectNoPageErrors(errors);
  });
});
