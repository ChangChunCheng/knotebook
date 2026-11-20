import { deflateSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";
import { ADMIN, createNote, editorLocator, loginAs, noteIdFromUrl, waitForEditorSelection } from "./helpers.js";

/**
 * The outline of a fully selected block (image, code block) and how it relates to clicking blank space:
 *
 * Whether the outline is drawn is measured from the browser's computed outline (computed style), never from class names.
 */

const RUN = Date.now();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    let c = (crc ^ buf[i]!) & 0xff;
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
    multipart: { file: { name: "box.png", mimeType: "image/png", buffer: grayPng(240, 120) } },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { url: string }).url;
}

async function frameWidth(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const node = document.querySelector<HTMLElement>('[data-testid="note-editor"] .ProseMirror-selectednode');
    if (!node) return null;
    const content = node.classList.contains("bn-block-content") ? node : node.querySelector<HTMLElement>(".bn-block-content");
    // A code block's first child is the language dropdown's container and the outline is drawn on the pre after it: take the thickest among all children.
    const widths = Array.from(content?.children ?? []).map((inner) => {
      const cs = getComputedStyle(inner);
      // When blurred the outline color is transparent (the outline is still there, just invisible).
      const invisible = cs.outlineStyle === "none" || cs.outlineColor === "rgba(0, 0, 0, 0)" || cs.outlineColor === "transparent";
      return invisible ? 0 : parseFloat(cs.outlineWidth);
    });
    return widths.length ? Math.max(...widths) : null;
  });
}

async function selectionKind(page: Page): Promise<"node" | "text"> {
  return editorLocator(page).evaluate((el) => {
    const view = (el as Element & { editor?: { view?: { state: { selection: { node?: unknown } } } } }).editor?.view;
    if (!view) throw new Error("no-editor");
    return view.state.selection.node === undefined ? "text" : "node";
  });
}

async function setup(page: Page, label: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAs(page, ADMIN.email, ADMIN.password);
  await createNote(page, `E2E blank click ${label} ${RUN}`);
  const url = await uploadPng(page);
  const editor = editorLocator(page);
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await waitForEditorSelection(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });
  await page.evaluate((text) => navigator.clipboard.writeText(text), `intro\n\n![box](${url})\n\n\`\`\`ts\nconst x = 1;\n\`\`\`\n\noutro`);
  await page.keyboard.press("ControlOrMeta+v");
  const img = editor.locator('[data-content-type="image"] img');
  await expect(img).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 15_000 }).toBeGreaterThan(0);
  await expect(editor.locator('[data-content-type="codeBlock"]')).toHaveCount(1);
}

test("62-1 clicking an image shows the selection outline; clicking the padding left of the article column removes it, turns into a caret and the editor keeps focus", async ({ page }) => {
  test.setTimeout(90_000);
  await setup(page, "image");
  const editor = editorLocator(page);
  await editor.locator('[data-content-type="image"] img').click();
  await expect.poll(() => frameWidth(page)).toBeGreaterThan(0);
  expect(await selectionKind(page)).toBe("node");

  const column = await page.getByTestId("article-column").boundingBox();
  const y = (await editor.locator('[data-content-type="image"]').boundingBox())!.y + 20;
  await page.mouse.click(column!.x + 4, y);
  await expect.poll(() => selectionKind(page), ).toBe("text");
  expect(await frameWidth(page)).toBeNull();
  await expect(editor).toBeFocused();
});

test("62-2 a code block selected as a whole has the outline; clicking the empty ground outside the column removes it", async ({ page }) => {
  test.setTimeout(90_000);
  await setup(page, "code");
  const editor = editorLocator(page);
  const block = editor.locator('[data-content-type="codeBlock"]');
  const box = (await block.boundingBox())!;
  // A code block has no mouse path that selects the whole block with one click (clicking in gives a text caret): select the whole block with the editor's own NodeSelection command;
  // the outline and the click-blank behaviour then follow the same path as an image.
  await editor.evaluate((el) => {
    const ed = (el as Element & { editor?: { view: { posAtDOM(n: Node, o: number): number }; commands: { setNodeSelection(pos: number): boolean } } }).editor!;
    const content = el.querySelector('[data-content-type="codeBlock"]')!;
    ed.commands.setNodeSelection(ed.view.posAtDOM(content.parentElement!, 0));
  });
  await editor.focus();
  await expect.poll(() => selectionKind(page)).toBe("node");
  await expect.poll(() => frameWidth(page)).toBeGreaterThan(0);

  // The article column is centered with a maximum width: to the left of the column there is still some empty ground inside the scroll container.
  const column = (await page.getByTestId("article-column").boundingBox())!;
  const xOutside = column.x - 30;
  await page.mouse.click(xOutside, box.y + 40);
  await expect.poll(() => selectionKind(page)).toBe("text");
  expect(await frameWidth(page)).toBeNull();
});

test("62-3 editor blurred (clicking the note title box): the selection outline is no longer drawn; clicking back on the image brings it back", async ({ page }) => {
  test.setTimeout(90_000);
  await setup(page, "blur");
  const editor = editorLocator(page);
  const img = editor.locator('[data-content-type="image"] img');
  await img.click();
  await expect.poll(() => frameWidth(page)).toBeGreaterThan(0);
  await page.getByLabel("Note title").click();
  await expect(editor).not.toBeFocused();
  await expect.poll(() => frameWidth(page)).toBe(0);
  await img.click();
  await expect.poll(() => frameWidth(page)).toBeGreaterThan(0);
});

test("62-4 clicking the blank space below the last block still puts the caret at the end of the document", async ({ page }) => {
  test.setTimeout(90_000);
  await setup(page, "below");
  const editor = editorLocator(page);
  await editor.locator('[data-content-type="image"] img').click();
  await expect.poll(() => selectionKind(page)).toBe("node");
  const column = (await page.getByTestId("article-column").boundingBox())!;
  const last = (await editor.locator(".bn-block-outer").last().boundingBox())!;
  const belowY = Math.min(last.y + last.height + 120, column.y + column.height - 10);
  await page.mouse.click(column.x + column.width / 2, belowY);
  await expect.poll(() => selectionKind(page)).toBe("text");
  await page.keyboard.type("Z");
  await expect(editor.locator(".bn-block-outer").last()).toContainText("outroZ");
});
