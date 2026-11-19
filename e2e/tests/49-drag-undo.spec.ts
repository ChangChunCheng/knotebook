import { deflateSync } from "node:zlib";
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { ADMIN, clickEndOfParagraph, createNote, editorLocator, loginAs, noteIdFromUrl, reEscape, waitForEditorSelection } from "./helpers.js";

/**
 * Undo and focus after a handle drag. Issue refs: #428 undo right after a drop or copy drag and image delete/redo, #429 a collaborator typing during a multi-select drag, #430 focus and Ctrl+Z when focus is not in the editor. Real mouse, 1440x900.
 *
 * - Content is always pasted as markdown (same as `34-columns` and `48-columns-drag`). The document shape is read from the main editor's ProseMirror document: `docShape` has the format of
 *   `48-columns-drag`, and `docIds` lists each top-level block (including blocks in a row's columns) as `text#first 8 chars of id`.
 * - Drags use the steps of `48-columns-drag` (hover -> wait for the handle to move next to the block -> press -> 5 small steps -> 15 steps to the end point -> 1px further down -> release).
 * - The collaborator is another browser context opening the same note with the same account.
 * - Wait 1 second between paste and drag, because they are different undo steps; after the drag wait 800 ms before Ctrl+Z (a user's rhythm, not relying on the undo merge window).
 * - Every case collects `pageerror` and asserts none at the end (`ResizeObserver loop` is a known benign browser message and is excluded).
 */

const RUN = Date.now();

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

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
  await createNote(page, `E2E drag undo ${label} ${RUN}`);
  return errors;
}

async function openCollaborator(browser: Browser, url: string): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = collectPageErrors(page);
  await loginAs(page, ADMIN.email, ADMIN.password);
  await page.goto(url);
  await expect(page.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible({ timeout: 15_000 });
  await editorLocator(page).waitFor({ timeout: 15_000 });
  return { context, page, errors };
}

function columnsMarkdown(cols: string[]): string {
  return [
    '<div data-kb-columns style="display:flex;gap:16px">',
    ...cols.flatMap((c) => ['<div data-kb-column style="flex:1">', "", c, "", "</div>"]),
    "</div>",
  ].join("\n");
}

/** Pastes markdown at the end of the note and waits 1 second so the paste becomes its own undo step. */
async function pasteMarkdown(page: Page, markdown: string): Promise<void> {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });
  await editorLocator(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await waitForEditorSelection(page);
  await page.evaluate((text) => navigator.clipboard.writeText(text), markdown);
  await page.keyboard.press("ControlOrMeta+v");
}

type PmNode = { type: { name: string }; attrs: { id?: unknown }; childCount: number; child(i: number): PmNode; firstChild: PmNode | null; textContent: string };

async function docShape(page: Page): Promise<string> {
  return editorLocator(page).evaluate((el) => {
    type Node = { type: { name: string }; childCount: number; child(i: number): Node; firstChild: Node | null; textContent: string };
    const view = (el as Element & { editor?: { view?: { state: { doc: Node } } } }).editor?.view;
    if (!view) throw new Error("no-editor");
    const kids = (n: Node): Node[] => Array.from({ length: n.childCount }, (_, i) => n.child(i));
    const shapeOf = (n: Node): string => {
      if (n.type.name === "columnList") return `ROW[${kids(n).map(shapeOf).join(" | ")}]`;
      if (n.type.name === "column") return `COL(${kids(n).map(shapeOf).join(",")})`;
      const text = n.firstChild!.textContent;
      return `${n.firstChild!.type.name}${text ? `:${text}` : ""}`;
    };
    return kids(view.state.doc.firstChild!).map(shapeOf).join("  ");
  });
}

async function docIds(page: Page): Promise<string[]> {
  return editorLocator(page).evaluate((el) => {
    type Node = PmNode & { descendants(f: (n: Node) => boolean | void): void };
    const view = (el as Element & { editor?: { view?: { state: { doc: Node } } } }).editor!.view!;
    const out: string[] = [];
    view.state.doc.descendants((n) => {
      if (n.type.name === "blockContainer") out.push(`${n.firstChild!.textContent}#${String(n.attrs.id).slice(0, 8)}`);
    });
    return out;
  });
}

const focusInEditor = (page: Page) => editorLocator(page).evaluate((el) => el.contains(document.activeElement));

function blockOuter(page: Page, text: string): Locator {
  return editorLocator(page)
    .locator(".bn-block-outer")
    .filter({ has: page.locator(".bn-inline-content", { hasText: new RegExp(`^${reEscape(text)}$`) }) })
    .last();
}

type Point = { x: number; y: number };

async function hoverForSideMenu(page: Page, block: Locator, label: string): Promise<void> {
  await block.hover();
  await expect(page.getByRole("button", { name: "Open block menu" })).toBeVisible();
  await expect(async () => {
    const menu = await page.locator(".bn-side-menu").boundingBox();
    const box = await block.boundingBox();
    expect(menu, "side menu").not.toBeNull();
    expect(box, `block ${label}`).not.toBeNull();
    const overlap = menu!.y < box!.y + box!.height && box!.y < menu!.y + menu!.height;
    const center = menu!.x + menu!.width / 2;
    expect({ overlap, nearLeft: center > box!.x - 100 && center < box!.x + 4 }).toEqual({ overlap: true, nearLeft: true });
  }).toPass({ timeout: 5_000 });
}

async function moveInSteps(page: Page, from: Point, to: Point, steps: number): Promise<void> {
  for (let i = 1; i <= steps; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
}

/**
 * Presses the handle of `sourceText` and drags it in the steps of `48-columns-drag` to the lower half of the paragraph `targetText` (horizontal-line drop), then releases. `midDrag` runs after the small move
 * and before moving to the end point (lets the collaborator type mid-drag).
 */
async function dragBlockBelow(page: Page, sourceText: string, targetText: string, midDrag?: () => Promise<void>, opts: { copy?: boolean } = {}): Promise<void> {
  await hoverForSideMenu(page, blockOuter(page, sourceText), sourceText);
  const h = (await page.getByRole("button", { name: "Open block menu" }).boundingBox())!;
  const start = { x: h.x + h.width / 2, y: h.y + h.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const nudge = { x: start.x + 10, y: start.y + 10 };
  await moveInSteps(page, start, nudge, 5);
  await midDrag?.();
  const t = (await blockOuter(page, targetText).boundingBox())!;
  const end = { x: t.x + t.width / 2, y: t.y + t.height * 0.75 };
  // Copy drag: hold Ctrl through the move and release (PM reads the modifier key at drop).
  if (opts.copy) await page.keyboard.down("Control");
  await moveInSteps(page, nudge, end, 15);
  await moveInSteps(page, end, { x: end.x, y: end.y + 1 }, 1);
  await page.mouse.up();
  if (opts.copy) await page.keyboard.up("Control");
}

/** Whether document received this drag's dragend (it is not received if the handle is replaced at drop). */
async function watchDragEnd(page: Page): Promise<() => Promise<boolean>> {
  await page.evaluate(() => {
    const w = window as unknown as { kbDragEnd?: boolean };
    w.kbDragEnd = false;
    document.addEventListener("dragend", () => void (w.kbDragEnd = true), { once: true });
  });
  return () => page.evaluate(() => !!(window as unknown as { kbDragEnd?: boolean }).kbDragEnd);
}

test("#428 horizontal-line drop of z into column 1 of [a|b], then Ctrl+Z without clicking the editor: one press undoes it, no pageerror, the collaborator sees the same, ids unchanged", async ({ page, browser }) => {
  test.setTimeout(150_000);
  const errors = await startNote(page, "u1");
  await pasteMarkdown(page, ["x", "", columnsMarkdown(["a", "b"]), "", "z", ""].join("\n"));
  const original = "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b)]  paragraph:z";
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain(original);
  const peer = await openCollaborator(browser, page.url());
  try {
    await expect.poll(() => docShape(peer.page), { timeout: 15_000 }).toBe(await docShape(page));
    const before = await docShape(page);
    const idsBefore = await docIds(page);
    await page.waitForTimeout(1_000);

    const dragEnded = await watchDragEnd(page);
    await dragBlockBelow(page, "z", "a");
    const moved = "paragraph:x  ROW[COL(paragraph:a,paragraph:z) | COL(paragraph:b)]";
    await expect.poll(() => docShape(page)).toContain(moved);
    await expect.poll(() => docShape(peer.page)).toBe(await docShape(page));
    expect(await focusInEditor(page), "放下後焦點在編輯器").toBe(true);
    test.info().annotations.push({ type: "dragend-reached-document-after-drop-into-column", description: String(await dragEnded()) });

    await page.waitForTimeout(800);
    await page.keyboard.press("Control+z");
    await expect.poll(() => docShape(page)).toBe(before);
    expect(await docIds(page)).toEqual(idsBefore);
    await expect.poll(() => docShape(peer.page), { message: "共享文件也還原" }).toBe(before);
    // Type one more character: if local and shared documents agree, typing does not write the pre-undo state back.
    await clickEndOfParagraph(page, blockOuter(page, "x").locator(".bn-inline-content").first());
    await page.keyboard.type("T");
    await expect.poll(() => docShape(peer.page)).toContain("paragraph:xT  ROW[COL(paragraph:a) | COL(paragraph:b)]  paragraph:z");
    expectNoPageErrors(errors);
    expectNoPageErrors(peer.errors);
  } finally {
    await peer.context.close();
  }
});

test("#430 x y z dragging x below z: focus stays in the editor with the caret in x; Ctrl+Z without clicking the editor undoes it in one press, ids unchanged", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "u2");
  await pasteMarkdown(page, "x\n\ny\n\nz\n");
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("paragraph:x  paragraph:y  paragraph:z");
  const before = await docShape(page);
  const idsBefore = await docIds(page);
  await page.waitForTimeout(1_000);

  const dragEnded = await watchDragEnd(page);
  await dragBlockBelow(page, "x", "z");
  await expect.poll(() => docShape(page)).toContain("paragraph:y  paragraph:z  paragraph:x");
  await expect.poll(() => focusInEditor(page), { message: "放下後焦點在編輯器" }).toBe(true);
  test.info().annotations.push({ type: "dragend-reached-document-after-top-level-sort", description: String(await dragEnded()) });
  const cursor = await editorLocator(page).evaluate((el) => {
    type View = { state: { selection: { toJSON(): { type: string }; $from: { parent: { textContent: string }; parentOffset: number } } } };
    const sel = (el as Element & { editor?: { view?: View } }).editor!.view!.state.selection;
    return { type: sel.toJSON().type, text: sel.$from.parent.textContent, offset: sel.$from.parentOffset };
  });
  expect(cursor).toEqual({ type: "text", text: "x", offset: 0 });

  await page.waitForTimeout(800);
  await page.keyboard.press("Control+z");
  await expect.poll(() => docShape(page)).toBe(before);
  expect(await docIds(page)).toEqual(idsBefore);
  expectNoPageErrors(errors);
});

test("#428 holding Ctrl to copy x below z (end of document), then Ctrl+Z without clicking the editor: one press undoes it, no pageerror, the collaborator sees the same [sc:dragBlockCopy]", async ({ page, browser }) => {
  test.setTimeout(150_000);
  const errors = await startNote(page, "u6");
  await pasteMarkdown(page, "x\n\ny\n\nz\n");
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("paragraph:x  paragraph:y  paragraph:z");
  const peer = await openCollaborator(browser, page.url());
  try {
    await expect.poll(() => docShape(peer.page), { timeout: 15_000 }).toBe(await docShape(page));
    const before = await docShape(page);
    const idsBefore = await docIds(page);
    await page.waitForTimeout(1_000);

    await dragBlockBelow(page, "x", "z", undefined, { copy: true });
    await expect.poll(() => docShape(page)).toBe("paragraph:x  paragraph:y  paragraph:z  paragraph:x");
    await expect.poll(() => docShape(peer.page)).toBe(await docShape(page));
    await expect.poll(() => focusInEditor(page), { message: "放下後焦點在編輯器" }).toBe(true);
    const idsCopied = await docIds(page);

    await page.waitForTimeout(800);
    await page.keyboard.press("Control+z");
    await expect.poll(() => docShape(page)).toBe(before);
    const idsUndone = await docIds(page);
    // A copy drag is PM's default drop and how the two copies of x get ids is not decided here, so it is only recorded; the ids of y and z, which were not copied, are unchanged.
    test.info().annotations.push({ type: "ids-before-copied-undone", description: JSON.stringify({ idsBefore, idsCopied, idsUndone }) });
    expect(idsUndone.slice(1)).toEqual(idsBefore.slice(1));
    await expect.poll(() => docShape(peer.page), { message: "共享文件也還原" }).toBe(before);
    expect(await docIds(peer.page)).toEqual(idsUndone);
    // If local and shared documents agree, later typing does not write the copy back.
    await clickEndOfParagraph(page, blockOuter(page, "y").locator(".bn-inline-content").first());
    await page.keyboard.type("T");
    await expect.poll(() => docShape(peer.page)).toBe("paragraph:x  paragraph:yT  paragraph:z");
    expectNoPageErrors(errors);
    expectNoPageErrors(peer.errors);
  } finally {
    await peer.context.close();
  }
});

test("#429 a b multi-selected and dragged below c while a collaborator types in d mid-drag: a b move as one block, no empty paragraph, both sides match; one Ctrl+Z undoes it", async ({ page, browser }) => {
  test.setTimeout(150_000);
  const errors = await startNote(page, "u3");
  await pasteMarkdown(page, "a\n\nb\n\nc\n\nd\n");
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("paragraph:a  paragraph:b  paragraph:c  paragraph:d");
  const peer = await openCollaborator(browser, page.url());
  try {
    await expect.poll(() => docShape(peer.page), { timeout: 15_000 }).toBe(await docShape(page));
    const idsBefore = await docIds(page);
    await page.waitForTimeout(1_000);

    await clickEndOfParagraph(page, blockOuter(page, "a").locator(".bn-inline-content").first());
    // The selection spans a to b (core turns it into a two-block multi-selection at dragstart).
    await page.keyboard.press("Shift+ArrowDown");
    await waitForEditorSelection(page);
    const selectionType = () =>
      editorLocator(page).evaluate((el) => (el as Element & { editor?: { view?: { state: { selection: { toJSON(): { type: string } } } } } }).editor!.view!.state.selection.toJSON().type);
    let midType = "";
    await dragBlockBelow(page, "a", "c", async () => {
      expect(await selectionType(), "前提：dragstart 後是多選").toBe("multiple-node");
      await clickEndOfParagraph(peer.page, blockOuter(peer.page, "d").locator(".bn-inline-content").first());
      await peer.page.keyboard.type("Q");
      await expect.poll(() => docShape(page), { timeout: 10_000 }).toContain("paragraph:dQ");
      midType = await selectionType();
    });
    test.info().annotations.push({ type: "selection-after-remote-update-mid-drag", description: midType });
    expect(midType, "前提：遠端更新之後多選退化成文字選取").toBe("text");
    const moved = "paragraph:c  paragraph:a  paragraph:b  paragraph:dQ";
    await expect.poll(() => docShape(page)).toBe(moved);
    await expect.poll(() => docShape(peer.page)).toBe(moved);
    const idsMoved = await docIds(page);
    expect(idsMoved.map((s) => s.split("#")[1])).toEqual([idsBefore[2], idsBefore[0], idsBefore[1], idsBefore[3]].map((s) => s!.split("#")[1]));
    expect(await docIds(peer.page)).toEqual(idsMoved);

    await page.waitForTimeout(800);
    await page.keyboard.press("Control+z");
    await expect.poll(() => docShape(page)).toBe("paragraph:a  paragraph:b  paragraph:c  paragraph:dQ");
    await expect.poll(() => docShape(peer.page)).toBe("paragraph:a  paragraph:b  paragraph:c  paragraph:dQ");
    const idsUndone = await docIds(page);
    test.info().annotations.push({ type: "ids-before-moved-undone", description: JSON.stringify({ idsBefore, idsMoved, idsUndone }) });
    expect(idsUndone.map((s) => s.split("#")[1]), "撤銷後 id 回到拖曳前").toEqual(idsBefore.map((s) => s.split("#")[1]));
    expectNoPageErrors(errors);
    expectNoPageErrors(peer.errors);
  } finally {
    await peer.context.close();
  }
});

async function clickHeaderBlank(page: Page): Promise<void> {
  const header = page.locator("header").filter({ has: page.getByLabel("Note title") });
  const box = (await header.boundingBox())!;
  // The header's top-left padding is not a control.
  const p = { x: box.x + 3, y: box.y + 3 };
  const hit = await header.evaluate((el, pt) => document.elementFromPoint(pt.x, pt.y) === el, p);
  expect(hit, "前提：點的是頁首本身").toBe(true);
  await page.mouse.click(p.x, p.y);
  await expect.poll(() => page.evaluate(() => document.activeElement === document.body), { message: "焦點在 body" }).toBe(true);
}

test("#430 after a reorder, clicking blank header space (focus on body): Ctrl+Z still undoes this note and focus returns to the editor; Ctrl+Shift+Z redoes", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "u4");
  await pasteMarkdown(page, "x\n\ny\n\nz\n");
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("paragraph:x  paragraph:y  paragraph:z");
  const before = await docShape(page);
  await page.waitForTimeout(1_000);
  await dragBlockBelow(page, "x", "z");
  const moved = "paragraph:y  paragraph:z  paragraph:x";
  await expect.poll(() => docShape(page)).toContain(moved);

  await clickHeaderBlank(page);
  await page.waitForTimeout(800);
  await page.keyboard.press("Control+z");
  await expect.poll(() => docShape(page)).toBe(before);
  await expect.poll(() => focusInEditor(page), { message: "撤銷後焦點回到編輯器" }).toBe(true);

  await clickHeaderBlank(page);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(() => docShape(page)).toBe(moved);
  expectNoPageErrors(errors);
});

test("#430 after a reorder with focus in the title box: Ctrl+Z leaves the note content alone", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "u5");
  await pasteMarkdown(page, "x\n\ny\n\nz\n");
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("paragraph:x  paragraph:y  paragraph:z");
  await page.waitForTimeout(1_000);
  await dragBlockBelow(page, "x", "z");
  const moved = "paragraph:y  paragraph:z  paragraph:x";
  await expect.poll(() => docShape(page)).toContain(moved);
  const title = page.getByLabel("Note title");

  await title.click();
  await expect(title).toBeFocused();
  await page.keyboard.press("Control+z");
  // Undo applies synchronously; wait to rule out a late change from elsewhere.
  await page.waitForTimeout(800);
  expect(await docShape(page)).toBe(moved);
  // The key was not intercepted: the title box's own undo received it and went back to the value before `createNote` filled the title.
  await expect(title).toHaveValue("Untitled");
  await expect(title).toBeFocused();
  expectNoPageErrors(errors);
});

async function docWidths(page: Page): Promise<number[]> {
  return editorLocator(page).evaluate((el) => {
    type Node = { type: { name: string }; attrs: { width?: number }; childCount: number; child(i: number): Node };
    type View = { state: { doc: { descendants(f: (n: Node) => boolean | void): void } } };
    const view = (el as Element & { editor?: { view?: View } }).editor!.view!;
    let widths: number[] | null = null;
    view.state.doc.descendants((n) => {
      if (widths) return false;
      if (n.type.name !== "columnList") return true;
      widths = Array.from({ length: n.childCount }, (_, i) => Number(n.child(i).attrs.width));
      return false;
    });
    return widths ?? [];
  });
}

test("#430 with a separator between columns focused, ArrowRight resizes; Ctrl+Z without clicking back into the note restores the column widths and returns focus to the editor", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "u7");
  await pasteMarkdown(page, ["x", "", columnsMarkdown(["a", "b"]), "", "z", ""].join("\n"));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(paragraph:a) | COL(paragraph:b)]");
  await page.waitForTimeout(1_000);
  const divider = page.locator('.kb-column-dividers [role="separator"]').first();
  await divider.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => docWidths(page)).not.toEqual([1, 1]);
  await expect(divider).toBeFocused();
  await page.waitForTimeout(800);
  await page.keyboard.press("Control+z");
  await expect.poll(() => docWidths(page)).toEqual([1, 1]);
  await expect.poll(() => focusInEditor(page), { message: "撤銷後焦點回到編輯器" }).toBe(true);
  expectNoPageErrors(errors);
});

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

async function uploadPng(page: Page): Promise<string> {
  const noteId = await noteIdFromUrl(page);
  const res = await page.request.post(`/api/notes/${noteId}/uploads`, {
    headers: { Origin: new URL(page.url()).origin },
    multipart: { file: { name: "u8.png", mimeType: "image/png", buffer: grayPng(120, 80) } },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { url: string }).url;
}

const selectionJSON = (page: Page) =>
  editorLocator(page).evaluate((el) => (el as Element & { editor?: { view?: { state: { selection: { toJSON(): { type: string } } } } } }).editor!.view!.state.selection.toJSON().type);

for (const where of ["end", "column"] as const) {
  test(`#428 click-select the image (${where === "end" ? "end of document" : "last block of column 1"}) -> Backspace deletes it -> Ctrl+Z -> Ctrl+Shift+Z immediately: no pageerror, the redo takes effect, the collaborator sees the same`, async ({ page, browser }) => {
    test.setTimeout(150_000);
    const errors = await startNote(page, `u8-${where}`);
    const url = await uploadPng(page);
    const image = `![a](${url})`;
    await pasteMarkdown(page, where === "end" ? `x\n\n${image}\n` : ["x", "", columnsMarkdown([`a\n\n${image}`, "b"]), ""].join("\n"));
    const withImage = where === "end" ? "paragraph:x  image" : "paragraph:x  ROW[COL(paragraph:a,image) | COL(paragraph:b)]";
    const without = where === "end" ? "paragraph:x" : "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b)]";
    await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain(withImage);
    const img = editorLocator(page).locator(`img[src*="${url}"]`);
    await expect(img).toBeVisible({ timeout: 15_000 });
    const peer = await openCollaborator(browser, page.url());
    try {
      await expect.poll(() => docShape(peer.page), { timeout: 15_000 }).toBe(await docShape(page));
      await page.waitForTimeout(1_000);

      await img.click();
      await expect.poll(() => selectionJSON(page), { message: "前提：點圖片之後是 NodeSelection" }).toBe("node");
      await page.keyboard.press("Backspace");
      await expect.poll(() => docShape(page)).toBe(without);
      await page.waitForTimeout(800);
      await page.keyboard.press("Control+z");
      await expect.poll(() => docShape(page)).toBe(withImage);
      await page.keyboard.press("Control+Shift+z");
      await expect.poll(() => docShape(page)).toBe(without);
      await expect.poll(() => docShape(peer.page), { message: "共享文件也重做了" }).toBe(without);
      // If local and shared documents agree, later typing is visible on both sides.
      await clickEndOfParagraph(page, blockOuter(page, "x").locator(".bn-inline-content").first());
      await page.keyboard.type("T");
      await expect.poll(() => docShape(peer.page)).toBe(without.replace("paragraph:x", "paragraph:xT"));
      expectNoPageErrors(errors);
      expectNoPageErrors(peer.errors);
    } finally {
      await peer.context.close();
    }
  });

  test(`#428 click-select the image (${where === "end" ? "end of document" : "last block of column 1"}) and then the collaborator deletes it: no pageerror, local and collaborator see the same, and later typing matches on both sides`, async ({ page, browser }) => {
    test.setTimeout(150_000);
    const errors = await startNote(page, `u9-${where}`);
    const url = await uploadPng(page);
    const image = `![a](${url})`;
    await pasteMarkdown(page, where === "end" ? `x\n\n${image}\n` : ["x", "", columnsMarkdown([`a\n\n${image}`, "b"]), ""].join("\n"));
    const withImage = where === "end" ? "paragraph:x  image" : "paragraph:x  ROW[COL(paragraph:a,image) | COL(paragraph:b)]";
    const without = where === "end" ? "paragraph:x" : "paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b)]";
    await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain(withImage);
    const img = editorLocator(page).locator(`img[src*="${url}"]`);
    await expect(img).toBeVisible({ timeout: 15_000 });
    const peer = await openCollaborator(browser, page.url());
    try {
      await expect.poll(() => docShape(peer.page), { timeout: 15_000 }).toBe(await docShape(page));
      const peerImg = editorLocator(peer.page).locator(`img[src*="${url}"]`);
      await expect(peerImg).toBeVisible({ timeout: 15_000 });

      await img.click();
      await expect.poll(() => selectionJSON(page), { message: "前提：點圖片之後是 NodeSelection" }).toBe("node");
      await peerImg.click();
      await expect.poll(() => selectionJSON(peer.page)).toBe("node");
      await peer.page.keyboard.press("Backspace");
      await expect.poll(() => docShape(peer.page)).toBe(without);
      await expect.poll(() => docShape(page), { message: "本機收到刪除" }).toBe(without);
      // If local and shared documents agree, later typing is visible on both sides. The collaborator's cursor label may be inside x (x's text is then no longer just "x"), so move with the keyboard to
      // the end of the first paragraph (x) instead of clicking it.
      expect(await focusInEditor(page), "焦點還在編輯器").toBe(true);
      await page.keyboard.press("ControlOrMeta+Home");
      await page.keyboard.press("End");
      await waitForEditorSelection(page);
      await page.keyboard.type("T");
      await expect.poll(() => docShape(peer.page)).toBe(without.replace("paragraph:x", "paragraph:xT"));
      await expect.poll(() => docShape(page)).toBe(await docShape(peer.page));
      expectNoPageErrors(errors);
      expectNoPageErrors(peer.errors);
    } finally {
      await peer.context.close();
    }
  });
}
