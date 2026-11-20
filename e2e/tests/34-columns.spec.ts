import { deflateSync } from "node:zlib";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { ADMIN, createNote, editorLocator, loginAs, noteIdFromUrl, randomEmail, ratioQuantPx, reEscape, waitForEditorSelection } from "./helpers.js";

/**
 * - Content is always pasted as canonical markdown (plain-text clipboard -> `collab/paste.ts` takes over -> `pasteMarkdown`;
 *   same as 22-presentation).
 * - The document shape is read from the main editor's ProseMirror document (`docShape`, same format as `shape` in web's
 *   `test/columns-fixtures.ts`): `paragraph:x  ROW[COL(paragraph:a) | COL(paragraph)]  paragraph:z` (`paragraph` with no text
 *   = an empty paragraph).
 * - e2e cannot import web: the stacking threshold is computed here (COLUMN_MIN_TEXT_PX / COLUMN_GAP_PX in
 *   `collab/columns/layout.ts`; change both together).
 * - Every case collects `pageerror` and asserts there is none at the end (`ResizeObserver loop` is a known benign browser
 *   message, excluded).
 */

const RUN = Date.now();
const ROW = '[data-node-type="columnList"]';
const COL = '[data-node-type="column"]';
const COLUMN_MIN_TEXT_PX = 200;
const COLUMN_GAP_PX = 24;
/** Two-column text row: stacks only when the row is narrower than 424 (`shouldStack`: sum of the columns' minimum widths + gap > available width). */
const TWO_TEXT_NEEDED = 2 * COLUMN_MIN_TEXT_PX + COLUMN_GAP_PX;

function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

function expectNoPageErrors(errors: string[]): void {
  expect(errors.filter((m) => !m.includes("ResizeObserver loop")), "pageerror").toEqual([]);
}

async function startNote(page: Page, label: string, creds: { email: string; password: string } = ADMIN): Promise<string[]> {
  const errors = collectPageErrors(page);
  await loginAs(page, creds.email, creds.password);
  await createNote(page, `E2E columns ${label} ${RUN}`);
  return errors;
}

function columnsMarkdown(cols: string[]): string {
  return [
    '<div data-kb-columns style="display:flex;gap:16px">',
    ...cols.flatMap((c) => ['<div data-kb-column style="flex:1">', "", c, "", "</div>"]),
    "</div>",
  ].join("\n");
}

function rowDoc(cols: string[]): string {
  return ["x", "", columnsMarkdown(cols), "", "z", ""].join("\n");
}

function originOf(page: Page): string {
  return new URL(page.url()).origin;
}

async function grantClipboard(page: Page): Promise<void> {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: originOf(page) });
}

async function pasteMarkdown(page: Page, markdown: string): Promise<void> {
  await grantClipboard(page);
  await editorLocator(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await waitForEditorSelection(page);
  await page.evaluate((text) => navigator.clipboard.writeText(text), markdown);
  await page.keyboard.press("ControlOrMeta+v");
}

async function docShape(page: Page): Promise<string> {
  return editorLocator(page).evaluate((el) => {
    type PmNode = { type: { name: string }; childCount: number; child(i: number): PmNode; firstChild: PmNode | null; textContent: string };
    const view = (el as Element & { editor?: { view?: { state: { doc: PmNode } } } }).editor?.view;
    if (!view) throw new Error("no-editor");
    const kids = (n: PmNode): PmNode[] => Array.from({ length: n.childCount }, (_, i) => n.child(i));
    const shapeOf = (n: PmNode): string => {
      if (n.type.name === "columnList") return `ROW[${kids(n).map(shapeOf).join(" | ")}]`;
      if (n.type.name === "column") return `COL(${kids(n).map(shapeOf).join(",")})`;
      const content = n.firstChild!;
      const text = content.textContent;
      const group = n.childCount > 1 ? n.child(1) : null;
      return `${content.type.name}${text ? `:${text}` : ""}${group ? `{${kids(group).map(shapeOf).join(",")}}` : ""}`;
    };
    return kids(view.state.doc.firstChild!).map(shapeOf).join("  ");
  });
}

function blockOuter(page: Page, text: string): Locator {
  const root = editorLocator(page);
  return root
    .locator(".bn-block-outer")
    .filter({ has: page.locator(".bn-inline-content", { hasText: new RegExp(`^${reEscape(text)}$`) }) })
    .last();
}

function inlineOf(page: Page, text: string): Locator {
  return blockOuter(page, text).locator(".bn-inline-content").first();
}

async function caretIn(page: Page, text: string, where: "Home" | "End"): Promise<void> {
  await inlineOf(page, text).click();
  await page.keyboard.press(where);
  await waitForEditorSelection(page);
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    let c = (crc ^ byte) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

function grayPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x88)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

async function uploadPng(page: Page, width: number, height: number): Promise<string> {
  const noteId = await noteIdFromUrl(page);
  const res = await page.request.post(`/api/notes/${noteId}/uploads`, {
    headers: { Origin: originOf(page) },
    multipart: { file: { name: `p${width}x${height}.png`, mimeType: "image/png", buffer: grayPng(width, height) } },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { url: string }).url;
}

async function waitImageLoaded(img: Locator): Promise<void> {
  await expect(img).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 15_000 }).toBeGreaterThan(0);
}

/** Whether the slash menu is open (when the popover closes it fades out: the wrapper gets inline `opacity:0` while the DOM stays). */
async function slashMenuOpen(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const menu = document.querySelector(".bn-suggestion-menu");
    if (!menu) return false;
    for (let el: Element | null = menu; el; el = el.parentElement) if ((el as HTMLElement).style?.opacity === "0") return false;
    return true;
  });
}

async function clearTyped(page: Page, typed: string): Promise<void> {
  for (let i = 0; i < typed.length; i++) await page.keyboard.press("Backspace");
  await expect.poll(() => docShape(page)).not.toContain("/");
}

async function slashTitles(page: Page): Promise<string[]> {
  return (await page.locator(".bn-suggestion-menu .bn-mt-suggestion-menu-item-title").allTextContents()).map((t) => t.trim());
}

type Rect = { x: number; y: number; width: number; height: number };

/**
 * Hovers the block with `text` and returns the two boxes once the side menu has moved next to it: vertical ranges overlap, and
 * the menu's centre is within 100px to the left of the block's left edge (the other column of the same row has the same y, so
 * vertical alone cannot tell whose menu it is). After a paste the click leaves the menu on another block first, and without
 * this wait the measurement / drag would hit the wrong block.
 */
async function hoverForSideMenu(page: Page, text: string): Promise<{ menu: Rect; block: Rect }> {
  const block = blockOuter(page, text);
  await block.hover();
  await expect(page.getByRole("button", { name: "Open block menu" })).toBeVisible();
  let got: { menu: Rect; block: Rect } | undefined;
  await expect(async () => {
    const menu = await page.locator(".bn-side-menu").boundingBox();
    const box = await block.boundingBox();
    expect(menu, "side menu").not.toBeNull();
    expect(box, `block ${text}`).not.toBeNull();
    const overlap = menu!.y < box!.y + box!.height && box!.y < menu!.y + menu!.height;
    const center = menu!.x + menu!.width / 2;
    expect({ overlap, nearLeft: center > box!.x - 100 && center < box!.x + 4 }, JSON.stringify({ menu, block: box })).toEqual({ overlap: true, nearLeft: true });
    got = { menu: menu!, block: box! };
  }).toPass({ timeout: 5_000 });
  return got!;
}

async function dragBlockBelow(page: Page, sourceText: string, targetText: string): Promise<void> {
  await hoverForSideMenu(page, sourceText);
  const handle = page.getByRole("button", { name: "Open block menu" });
  const h = (await handle.boundingBox())!;
  const t = (await blockOuter(page, targetText).boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + 10, h.y + h.height / 2 + 10, { steps: 5 });
  await page.mouse.move(t.x + t.width / 2, t.y + t.height * 0.75, { steps: 15 });
  await page.mouse.move(t.x + t.width / 2 + 2, t.y + t.height * 0.75);
  await page.mouse.up();
}

async function saveVersion(page: Page, name: string): Promise<void> {
  await page.keyboard.press("Control+s");
  const dialog = page.getByRole("dialog", { name: "Save current version" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Version name (optional)").fill(name);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

test("C1 /grid: /grid lists 2 / 3 / 4 columns; /grid 3 leaves only 3 columns (closing the menu with a space turns it into /grid3); Enter creates 3 columns with the caret in column 1", async ({ page }) => {
  test.setTimeout(90_000);
  const errors = await startNote(page, "grid");
  const editor = editorLocator(page);
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await waitForEditorSelection(page);

  await page.keyboard.type("/grid");
  await expect.poll(() => slashMenuOpen(page)).toBe(true);
  await expect.poll(() => slashTitles(page)).toEqual(expect.arrayContaining(["2 columns", "3 columns", "4 columns"]));
  await page.keyboard.press("Escape");
  await expect.poll(() => slashMenuOpen(page)).toBe(false);
  // Esc leaves the "/grid" text: clear it with one Backspace per character (not Shift+Home: a native selection waits for selectionchange, and Backspace might delete only one character)
  await clearTyped(page, "/grid");

  await page.keyboard.type("/grid 3");
  const menuState = async () => ((await slashMenuOpen(page)) ? (await slashTitles(page)).join("|") : "closed");
  let outcome = "";
  await expect.poll(async () => (outcome = await menuState()), { timeout: 5_000 }).toMatch(/^(closed|3 columns)$/);
  if (outcome === "closed") {
    test.info().annotations.push({ type: "grid-menu-space", description: "space closes menu" });
    await clearTyped(page, "/grid 3");
    await page.keyboard.type("/grid3");
    await expect.poll(menuState).toBe("3 columns");
  } else {
    test.info().annotations.push({ type: "grid-menu-space", description: "space keeps menu open" });
  }
  await page.keyboard.press("Enter");

  const rows = editor.locator(ROW);
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator(COL)).toHaveCount(3);
  await expect.poll(() => docShape(page)).toContain("ROW[COL(paragraph) | COL(paragraph) | COL(paragraph)]");
  await waitForEditorSelection(page);
  await page.keyboard.type("左");
  await expect(rows.first().locator(COL).first()).toHaveText("左");
  await expect.poll(() => docShape(page)).toContain("ROW[COL(paragraph:左) | COL(paragraph) | COL(paragraph)]");
  expectNoPageErrors(errors);
});

test("C2 and undo: Backspace at the start of b in [a|b] flattens to a b with no empty paragraph in between; one Ctrl+Z brings the row back", async ({ page }) => {
  test.setTimeout(90_000);
  const errors = await startNote(page, "d24");
  const editor = editorLocator(page);
  await pasteMarkdown(page, rowDoc(["a", "b"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b)]  paragraph:z");

  await caretIn(page, "b", "Home");
  await page.keyboard.press("Backspace");
  await expect(editor.locator(ROW)).toHaveCount(0);
  await expect.poll(() => docShape(page)).toContain("paragraph:x  paragraph:a  paragraph:b  paragraph:z");

  await page.keyboard.press("Control+z");
  await expect(editor.locator(ROW)).toHaveCount(1);
  await expect.poll(() => docShape(page)).toContain("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b)]  paragraph:z");
  expectNoPageErrors(errors);
});

test("C3: removing the image inside a column from the toolbar leaves the row and an empty paragraph in the left column; the drag handle's \"Ungroup columns\" flattens the row and r stays", async ({ page }) => {
  test.setTimeout(90_000);
  const errors = await startNote(page, "d25");
  const editor = editorLocator(page);
  const url = await uploadPng(page, 40, 40);
  await pasteMarkdown(page, rowDoc([`![x](${url})`, "r"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(image) | COL(paragraph:r)]");
  const img = editor.locator(`${ROW} ${COL}`).first().locator(`img[src*="${url}"]`);
  await waitImageLoaded(img);

  await img.click();
  const del = page.locator("[data-kb-file-delete]");
  await expect(del).toBeVisible();
  await del.click();
  await expect(editor.locator(ROW)).toHaveCount(1);
  await expect.poll(() => docShape(page)).toContain("ROW[COL(paragraph) | COL(paragraph:r)]");

  await blockOuter(page, "r").hover();
  await page.getByRole("button", { name: "Open block menu" }).click();
  await page.getByRole("menuitem", { name: "Ungroup columns" }).click();
  await expect(editor.locator(ROW)).toHaveCount(0);
  await expect.poll(() => docShape(page)).toContain("paragraph:r");
  expectNoPageErrors(errors);
});

test("C4 stacking: side by side at 1440 / 1024, stacked at 390, 768 depends on the actual width; no horizontal page scroll at every width", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "stack");
  await pasteMarkdown(page, rowDoc(["left text", "right text"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(paragraph:left text) | COL(paragraph:right text)]");
  const row = editorLocator(page).locator(ROW).first();

  type Box = { y: number; bottom: number };
  type Layout = { rowWidth: number; stacked: boolean; cols: Box[]; scrollWidth: number };
  const measure = (): Promise<Layout> =>
    row.evaluate((el) => ({
      rowWidth: (el as HTMLElement).clientWidth,
      stacked: el.hasAttribute("data-stacked"),
      cols: Array.from(el.querySelectorAll(':scope > [data-node-type="column"]')).map((c) => {
        const r = c.getBoundingClientRect();
        return { y: r.y, bottom: r.bottom };
      }),
      scrollWidth: document.documentElement.scrollWidth,
    }));

  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    let m: Layout | undefined;
    // Stacking is recomputed asynchronously by ResizeObserver: wait until data-stacked agrees with the rule for the current row width
    await expect(async () => {
      m = await measure();
      expect(m.rowWidth).toBeGreaterThan(0);
      expect(m.stacked, `width ${width}: rowWidth ${m.rowWidth}`).toBe(m.rowWidth < TWO_TEXT_NEEDED);
    }).toPass({ timeout: 10_000 });
    const got = m!;
    expect(got.cols).toHaveLength(2);
    const [c1, c2] = got.cols as [Box, Box];
    if (width === 1440 || width === 1024) {
      expect(got.stacked, `width ${width} 應並排（rowWidth ${got.rowWidth}）`).toBe(false);
      expect(Math.abs(c2.y - c1.y)).toBeLessThanOrEqual(0.5);
    } else if (width === 390) {
      expect(got.stacked, `width 390 應堆疊（rowWidth ${got.rowWidth}）`).toBe(true);
      expect(c2.y).toBeGreaterThan(c1.bottom);
    } else {
      test.info().annotations.push({ type: "stack-768", description: JSON.stringify({ rowWidth: got.rowWidth, stacked: got.stacked }) });
    }
    expect(got.scrollWidth, `width ${width}：document scrollWidth`).toBeLessThanOrEqual(width);
  }
  expectNoPageErrors(errors);
});

test("C5 wide table: a 6-column long-string table in the left column at width 390 -> no horizontal page scroll, the table scrolls inside the column", async ({ page }) => {
  test.setTimeout(90_000);
  const errors = await startNote(page, "wide-table");
  const cells = (r: string) => `| ${Array.from({ length: 6 }, (_, i) => `${r}LongCellContent${i + 1}WithoutAnyBreaks`).join(" | ")} |`;
  const table = [cells("H"), `| ${Array.from({ length: 6 }, () => "---").join(" | ")} |`, cells("R")].join("\n");
  await pasteMarkdown(page, rowDoc([table, "right text"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(table");
  await page.setViewportSize({ width: 390, height: 844 });
  const leftCol = editorLocator(page).locator(`${ROW} ${COL}`).first();
  await expect(leftCol.locator("table")).toBeVisible();

  const record: Record<string, unknown> = {};
  try {
    let layer = null as "wrapper" | "column" | null;
    await expect(async () => {
      const m = await leftCol.evaluate((col) => {
        const wrapper = col.querySelector<HTMLElement>(".tableWrapper");
        const table = col.querySelector("table")!;
        const overflows = (el: HTMLElement | null) => !!el && el.scrollWidth > el.clientWidth;
        const layer: "wrapper" | "column" | null = overflows(wrapper) ? "wrapper" : overflows(col as HTMLElement) ? "column" : null;
        const target = layer === "wrapper" ? wrapper : layer === "column" ? (col as HTMLElement) : null;
        return {
          page: document.documentElement.scrollWidth,
          col: { scrollWidth: col.scrollWidth, clientWidth: col.clientWidth, right: col.getBoundingClientRect().right },
          wrapper: wrapper ? { scrollWidth: wrapper.scrollWidth, clientWidth: wrapper.clientWidth } : null,
          tableWidth: table.getBoundingClientRect().width,
          layer,
          overflowX: target ? getComputedStyle(target).overflowX : null,
        };
      });
      Object.assign(record, m);
      layer = m.layer;
      expect(m.page, "document scrollWidth").toBeLessThanOrEqual(390);
      expect(m.col.right, "左欄右緣不出視窗").toBeLessThanOrEqual(390);
      expect(m.tableWidth, "前提：表格比欄寬").toBeGreaterThan(m.col.clientWidth);
      expect(m.layer, "欄或欄內 .tableWrapper 有橫向溢出").not.toBeNull();
      // scrollWidth is unaffected by the overflow value (hidden / clip give the same), so separately assert that the overflowing layer really is a scroll container
      expect(["auto", "scroll"], `溢出那層（${m.layer}）的 overflowX`).toContain(m.overflowX);
    }).toPass({ timeout: 10_000 });

    const target = layer === "wrapper" ? leftCol.locator(".tableWrapper").first() : leftCol;
    await target.scrollIntoViewIfNeeded();
    const box = (await target.boundingBox())!;
    const point = { x: box.x + Math.min(box.width, 390 - box.x) / 2, y: box.y + box.height / 2 };
    const hit = await target.evaluate((el, p) => el.contains(document.elementFromPoint(p.x, p.y)), point);
    expect(hit, "滾輪落點在溢出那一層裡").toBe(true);
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(300, 0);
    await expect.poll(async () => (record.scrollLeft = await target.evaluate((el) => el.scrollLeft))).toBeGreaterThan(0);
  } finally {
    test.info().annotations.push({ type: "stacked-rows", description: JSON.stringify(record) });
  }
  expectNoPageErrors(errors);
});

test("C6 image in a column: image width does not exceed the column; dragging the right handle right by 400px widens the image column, the text column yields width but not below 200px, and the written data-preview-width = the displayed image width; dragging left by 50px shrinks the image and the column does not shrink back", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = await startNote(page, "image");
  const url = await uploadPng(page, 800, 200);
  await pasteMarkdown(page, rowDoc([`![wide](${url})`, "right text"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(image) | COL(paragraph:right text)]");
  const leftCol = editorLocator(page).locator(`${ROW} ${COL}`).first();
  const imageBlock = leftCol.locator('[data-content-type="image"]');
  const img = imageBlock.locator(`img[src*="${url}"]`);
  await waitImageLoaded(img);

  const rightCol = editorLocator(page).locator(`${ROW} ${COL}`).nth(1);
  const colWidth = async () => (await leftCol.boundingBox())!.width;
  const rightWidth = async () => (await rightCol.boundingBox())!.width;
  expect((await img.boundingBox())!.width).toBeLessThanOrEqual((await colWidth()) + 0.5);
  const leftBefore = await colWidth();
  const rightBefore = await rightWidth();

  const dragRightHandle = async (dx: number) => {
    await img.hover();
    const handle = imageBlock.locator(".bn-resize-handle").nth(1); // the second handle is the right-hand one (right:4px)
    await expect(handle).toBeVisible();
    const h = (await handle.boundingBox())!;
    const x = h.x + h.width / 2;
    const y = h.y + h.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y, { steps: 10 });
    await page.mouse.up();
  };
  const previewWidth = async () => Number(await imageBlock.getAttribute("data-preview-width"));

  await dragRightHandle(400);
  await expect(imageBlock).toHaveAttribute("data-preview-width", /^\d+$/);
  const widened = await previewWidth();
  const imgWidened = (await img.boundingBox())!.width;
  const leftWidened = await colWidth();
  const rightWidened = await rightWidth();
  test.info().annotations.push({ type: "image-expands-column", description: JSON.stringify({ leftBefore, rightBefore, widened, imgWidened, leftWidened, rightWidened }) });
  // When the image exceeds the original column width the image column widens and the text column yields width, but stays at or above the text column's minimum width.
  expect(leftWidened, "圖片欄變寬").toBeGreaterThan(leftBefore + 50);
  expect(rightWidened, "文字欄讓出寬度").toBeLessThan(rightBefore - 50);
  // The column ratio is rounded to two decimals when written to the document, so converting back to pixels has an error (tolerance: `ratioQuantPx` in helpers).
  const quantPx = Math.max(1, ratioQuantPx([{ width: leftWidened }, { width: rightWidened }]));
  expect(rightWidened, "文字欄不小於 200px").toBeGreaterThanOrEqual(COLUMN_MIN_TEXT_PX - quantPx);
  // The written previewWidth comes from the ratio before rounding, while the displayed image width is clamped by the rounded column width.
  expect(Math.abs(widened - imgWidened), "data-preview-width＝圖片顯示寬").toBeLessThanOrEqual(quantPx);
  expect(imgWidened).toBeLessThanOrEqual(leftWidened + 0.5);

  await dragRightHandle(-50);
  await expect.poll(previewWidth).toBeLessThan(widened);
  expect(Math.abs((await colWidth()) - leftWidened), "欄寬不縮回").toBeLessThanOrEqual(1);
  expectNoPageErrors(errors);
});

test("C7 side handle: the drag handle of column 2 sits in the gap and does not overlap column 1", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = await startNote(page, "side-menu");
  await pasteMarkdown(page, rowDoc(["first column", "second column"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(paragraph:first column) | COL(paragraph:second column)]");
  const row = editorLocator(page).locator(ROW).first();
  // Hard precondition: the row is laid out and side by side - row wide enough for two columns, no data-stacked, both columns at the same y (before the ResizeObserver runs data-stacked does not exist anyway, so asserting only that would pass vacuously)
  await expect(async () => {
    const m = await row.evaluate((el) => ({
      rowWidth: (el as HTMLElement).clientWidth,
      stacked: el.getAttribute("data-stacked"),
      ys: Array.from(el.querySelectorAll(':scope > [data-node-type="column"]')).map((c) => c.getBoundingClientRect().y),
    }));
    expect(m.rowWidth).toBeGreaterThanOrEqual(TWO_TEXT_NEEDED);
    expect(m.stacked).toBeNull();
    expect(m.ys).toHaveLength(2);
    expect(Math.abs(m.ys[0]! - m.ys[1]!)).toBeLessThanOrEqual(0.5);
  }).toPass({ timeout: 10_000 });

  // Positive control: a block outside the columns has "Add block", so asserting "not visible" below cannot pass vacuously because the element is missing
  await blockOuter(page, "x").hover();
  const addBlock = page.getByRole("button", { name: "Add block" });
  await expect(addBlock).toBeVisible();

  let aligned: { menu: Rect; block: Rect } | undefined;
  try {
    aligned = await hoverForSideMenu(page, "second column");
  } finally {
    if (!aligned) test.info().annotations.push({ type: "side-menu-alignment", description: "side menu never aligned with the hovered block (see failure message)" });
  }
  const { menu, block } = aligned!;
  // Inside a column only the drag handle remains: the two buttons are 48px together, wider than the 24px gap.
  await expect(addBlock).toBeHidden();
  const col1 = (await row.locator(COL).nth(0).boundingBox())!;
  const col2 = (await row.locator(COL).nth(1).boundingBox())!;
  const measured = {
    sideMenuLeft: menu.x,
    sideMenuRight: menu.x + menu.width,
    col1Right: col1.x + col1.width,
    col2Left: col2.x,
    sideMenuTop: menu.y,
    blockTop: block.y,
  };
  test.info().annotations.push({ type: "side-menu-alignment", description: JSON.stringify(measured) });
  expect(measured.sideMenuRight).toBeLessThanOrEqual(measured.col2Left + 2);
  expect(measured.sideMenuRight).toBeGreaterThan(measured.col1Right - 2);
  expect(measured.sideMenuLeft).toBeGreaterThanOrEqual(measured.col1Right - 2);
  expectNoPageErrors(errors);
});

test("C8 dragging out the only block: dragging b of [a|b] below z -> still two columns with an empty paragraph in column 2; the same move on [a|b|c] -> two columns a and c remain", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "drag-two");
  await pasteMarkdown(page, rowDoc(["a", "b"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(paragraph:a) | COL(paragraph:b)]");
  await dragBlockBelow(page, "b", "z");
  await expect.poll(() => docShape(page)).toContain("ROW[COL(paragraph:a) | COL(paragraph)]");
  expect(await docShape(page)).toContain("paragraph:b");

  await createNote(page, `E2E columns drag-three ${RUN}`);
  await pasteMarkdown(page, rowDoc(["a", "b", "c"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(paragraph:a) | COL(paragraph:b) | COL(paragraph:c)]");
  await dragBlockBelow(page, "b", "z");
  await expect.poll(() => docShape(page)).toContain("ROW[COL(paragraph:a) | COL(paragraph:c)]");
  expect(await docShape(page)).toContain("paragraph:b");
  expectNoPageErrors(errors);
});

/** Shared by the C9 cases: logs in, creates a note and pastes two columns. The note has no heading, so the whole note including the row is on the cover slide. Returns the pageerror collector and the two columns' text. */
async function startSurfacesNote(
  page: Page,
  label: string,
  creds?: { email: string; password: string },
): Promise<{ errors: string[]; left: string; right: string }> {
  const errors = await startNote(page, label, creds);
  const left = `colL${RUN}`;
  const right = `colR${RUN}`;
  await pasteMarkdown(page, rowDoc([left, right]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain(`ROW[COL(paragraph:${left}) | COL(paragraph:${right})]`);
  return { errors, left, right };
}

test("C9a public page: anonymous opens the public link -> one row with two columns, both columns' text present", async ({ page, browser, request }) => {
  // Use a newly registered account: the public-link PUT allows 10 per user per 10 minutes, and in a serial run admin has used it up by now -> 429 (same as 31-note-width).
  const creds = { email: randomEmail(), password: "e2e-columns-pw" };
  expect((await request.post("/api/auth/register", { data: creds })).status()).toBe(201);
  const { errors, left, right } = await startSurfacesNote(page, "public", creds);
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Share note" });
  const publicRadio = dialog.getByRole("radio", { name: /^Public link/ });
  await expect(publicRadio).toBeEnabled();
  const publish = page.waitForResponse((r) => r.url().includes("/public-link") && r.request().method() === "PUT");
  await publicRadio.check();
  expect((await publish).status()).toBe(200);
  const tokenInput = dialog.getByLabel("Public link URL");
  await expect(tokenInput).toBeVisible();
  const token = await tokenInput.inputValue();
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await page.keyboard.press("Escape");
  await expect(async () => {
    const res = await page.request.get(`/api/public/notes/${token}`);
    expect(res.status()).toBe(200);
    expect(Buffer.from(((await res.json()) as { ydoc: string }).ydoc, "base64").toString("utf8")).toContain(right);
  }).toPass({ timeout: 20_000 });

  const anonContext = await browser.newContext();
  try {
    const anon = await anonContext.newPage();
    const anonErrors = collectPageErrors(anon);
    await anon.goto(`/p/${token}`);
    const publicRow = anon.locator(ROW);
    await expect(publicRow).toHaveCount(1, { timeout: 15_000 });
    await expect(publicRow.locator(COL)).toHaveCount(2);
    await expect(publicRow).toContainText(left);
    await expect(publicRow).toContainText(right);
    expectNoPageErrors(anonErrors);
  } finally {
    await anonContext.close();
  }
  expectNoPageErrors(errors);
});

test("C9b presentation: the cover's row keeps its canonical style; opened at width 390 -> data-stacked, re-entered at 1440 -> none", async ({ page }) => {
  const { errors, left, right } = await startSurfacesNote(page, "present");
  const noteUrl = page.url();
  const slideRow = page.locator("section.present [data-kb-columns]");

  // Persistence barrier (as the toPass(reload...) in 01-bootstrap): goto cuts the note's only collab connection and the content is
  // read back from the server on reload; the server persists with a debounce, so reload until the read-back document has this row before continuing.
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible();
    await editorLocator(page).waitFor({ timeout: 5_000 });
    expect(await docShape(page)).toContain(`ROW[COL(paragraph:${left}) | COL(paragraph:${right})]`);
  }).toPass({ timeout: 30_000 });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${noteUrl}?present`);
  await expect(page.locator(".reveal.ready")).toBeVisible({ timeout: 20_000 });
  await expect(slideRow).toHaveCount(1);
  expect(await slideRow.getAttribute("style")).toBe("display:flex;gap:16px");
  await expect(slideRow).toHaveAttribute("data-stacked", "");

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${noteUrl}?present`);
  await expect(page.locator(".reveal.ready")).toBeVisible({ timeout: 20_000 });
  await expect(slideRow).toHaveCount(1);
  expect(await slideRow.getAttribute("style")).toBe("display:flex;gap:16px");
  await expect(slideRow).not.toHaveAttribute("data-stacked", "");
  expectNoPageErrors(errors);
});

test("C9c versions: manual save -> edit the right column -> in split view the two sides' rows differ in y by <= 1px; single column + changes only does not error", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 }); // 1500 with the panel open: the preview area is wide enough to split automatically (as in 22-versions)
  const { errors, left, right } = await startSurfacesNote(page, "versions");
  await caretIn(page, left, "End");
  await saveVersion(page, "cols-base");
  await expect(page.getByText(/^Saved as cols-base \([0-9a-f]{7}\)$/)).toBeVisible();
  await caretIn(page, right, "End");
  await page.keyboard.type(" edited");
  await expect.poll(() => docShape(page)).toContain(`COL(paragraph:${right} edited)`);

  await page.getByTestId("versions-bubble").click();
  const panel = page.getByTestId("versions-panel");
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: /^cols-base \(/ }).click();
  await expect(page.getByTestId("preview-banner")).toContainText(/Previewing cols-base \([0-9a-f]{7}\)/);
  await expect(page.getByTestId("diff-split")).toBeVisible();
  await expect(async () => {
    const ys = await page.getByTestId("diff-split").evaluate((root) =>
      Array.from(root.querySelectorAll<HTMLElement>(":scope > section")).map(
        (sec) => sec.querySelector<HTMLElement>('.bn-editor > .bn-block-group > [data-node-type="columnList"]')?.getBoundingClientRect().y ?? null,
      ),
    );
    expect(ys).toHaveLength(2);
    const [l, r] = ys;
    expect(l, "左側的列").not.toBeNull();
    expect(r, "右側的列").not.toBeNull();
    expect(Math.abs(l! - r!)).toBeLessThanOrEqual(1);
  }).toPass({ timeout: 10_000 });

  const banner = page.getByTestId("preview-banner");
  await banner.getByRole("button", { name: "Single column" }).click();
  await banner.getByRole("button", { name: "Only changes" }).click();
  const single = page.getByTestId("diff-single");
  await expect(single).toBeVisible();
  await expect(single.locator(ROW)).toHaveCount(1);
  // data-diff is written directly on the column DOM managed by PM and must not be redrawn away in a real browser (the column itself is context, a paragraph edited inside a column is changed).
  await expect(single.locator(`${ROW} > ${COL}`)).toHaveCount(2);
  await expect(single.locator(`${ROW} > ${COL}[data-diff="context"]`)).toHaveCount(2);
  await expect(single.locator(`${COL}[data-diff="context"] .bn-block-outer[data-diff="changed"]`, { hasText: right })).toHaveCount(1);
  await expect(page.getByText("Version history couldn't be shown.")).toHaveCount(0);
  expectNoPageErrors(errors);
});

test("C10 external HTML does not become a row: clipboard text/html is side-by-side divs without data-kb-* (once with display:flex and once without) -> neither yields a columnList after pasting", async ({ page }) => {
  test.setTimeout(90_000);
  const errors = await startNote(page, "external-html");
  const editor = editorLocator(page);
  await grantClipboard(page);
  // The copy with style: Chromium sanitizes HTML when writing the async clipboard, so read back and record whether display:flex survived (if it is stripped, the copy without style still guards the structure)
  const cases = [
    { label: "styled", html: '<div style="display:flex"><div><p>A</p></div><div><p>B</p></div></div>', texts: ["A", "B"] },
    { label: "plain", html: "<div><div><p>C</p></div><div><p>D</p></div></div>", texts: ["C", "D"] },
  ];
  for (const c of cases) {
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await waitForEditorSelection(page);
    const readBack = await page.evaluate(async (html) => {
      await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }) })]);
      const [item] = await navigator.clipboard.read();
      return item && item.types.includes("text/html") ? await (await item.getType("text/html")).text() : null;
    }, c.html);
    test.info().annotations.push({ type: "external-html", description: JSON.stringify({ case: c.label, readBack }) });
    await page.keyboard.press("ControlOrMeta+v");
    for (const t of c.texts) await expect(editor).toContainText(t, { timeout: 10_000 });
    await expect(editor.locator(ROW), `${c.label}：不得成列`).toHaveCount(0);
    expect(await docShape(page)).not.toContain("ROW[");
  }
  expectNoPageErrors(errors);
});
