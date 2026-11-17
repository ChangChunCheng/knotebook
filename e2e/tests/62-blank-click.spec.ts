import { deflateSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";
import { ADMIN, createNote, editorLocator, loginAs, noteIdFromUrl, waitForEditorSelection } from "./helpers.js";

/**
 * 整個 block 被選取（圖片、程式碼區塊）時的外框，與「點空白處」的關係：
 *
 * 62-1 點圖片 → 出現選取外框；點文章欄左側的內距 → 外框消失、選取變成游標（編輯器仍有焦點）。
 * 62-2 程式碼區塊整塊被選取 → 外框；點欄外的空地（捲動容器內、文章欄之外）→ 外框消失。
 * 62-3 點編輯器以外的地方（筆記標題框）→ 編輯器失焦，外框不再畫（選取仍在，但畫面上看不到）。
 * 62-4 點最後一個 block 之下的空白仍把游標放在文件結尾。
 *
 * 外框是否「畫出來」量瀏覽器算出的 outline（computed style），不看 class 名稱。
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

/** 目前被選取的 block（ProseMirror-selectednode）內容的外框寬度（px）；沒有被選取的 block 回 null。 */
async function frameWidth(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const node = document.querySelector<HTMLElement>('[data-testid="note-editor"] .ProseMirror-selectednode');
    if (!node) return null;
    const content = node.classList.contains("bn-block-content") ? node : node.querySelector<HTMLElement>(".bn-block-content");
    // 程式碼區塊的第一個子節點是語言下拉的容器，外框畫在後面的 pre 上：取所有子節點中最粗的。
    const widths = Array.from(content?.children ?? []).map((inner) => {
      const cs = getComputedStyle(inner);
      // 失焦時外框顏色是透明（外框仍在、看不見）。
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

test("62-1 點圖片出現選取外框；點文章欄左側的內距 → 外框消失、變成游標且編輯器仍有焦點", async ({ page }) => {
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

test("62-2 程式碼區塊整塊被選取時有外框；點欄外的空地 → 外框消失", async ({ page }) => {
  test.setTimeout(90_000);
  await setup(page, "code");
  const editor = editorLocator(page);
  const block = editor.locator('[data-content-type="codeBlock"]');
  const box = (await block.boundingBox())!;
  // 程式碼區塊沒有「點一下就整塊選取」的滑鼠路徑（點進去就是文字游標）：以編輯器自己的 NodeSelection 命令選取整塊，
  // 外框與「點空白」的行為跟圖片同一條路。
  await editor.evaluate((el) => {
    const ed = (el as Element & { editor?: { view: { posAtDOM(n: Node, o: number): number }; commands: { setNodeSelection(pos: number): boolean } } }).editor!;
    const content = el.querySelector('[data-content-type="codeBlock"]')!;
    ed.commands.setNodeSelection(ed.view.posAtDOM(content.parentElement!, 0));
  });
  await editor.focus();
  await expect.poll(() => selectionKind(page)).toBe("node");
  await expect.poll(() => frameWidth(page)).toBeGreaterThan(0);

  // 文章欄是置中的、寬度有上限：欄的左邊還有一段捲動容器內的空地。
  const column = (await page.getByTestId("article-column").boundingBox())!;
  const xOutside = column.x - 30;
  await page.mouse.click(xOutside, box.y + 40);
  await expect.poll(() => selectionKind(page)).toBe("text");
  expect(await frameWidth(page)).toBeNull();
});

test("62-3 編輯器失焦（點筆記標題框）→ 選取外框不再畫；點回圖片又出現", async ({ page }) => {
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

test("62-4 點最後一個 block 之下的空白，游標仍在文件結尾", async ({ page }) => {
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
