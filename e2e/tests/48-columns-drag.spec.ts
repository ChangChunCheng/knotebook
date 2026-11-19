import { deflateSync } from "node:zlib";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { ADMIN, clickEndOfParagraph, createNote, editorLocator, loginAs, noteIdFromUrl, ratioQuantPx, reEscape, waitForEditorSelection } from "./helpers.js";

/**
 * Column drags: dragging the handle to a block's left/right edge creates a row or adds a column, the vertical drop indicator during a drag, auto equal height, file drops in the gutter,
 * the handle not taking the pointer during a drag; separator resizing between columns (mouse, keyboard), an image widened inside a column squeezing the other columns, and how the separator
 * hit area relates to the handle, menus and the table's extend button. Real mouse, 1440x900.
 *
 * - Content is always pasted as markdown (plain-text clipboard -> handled by `collab/paste.ts`, as in `34-columns.spec.ts`); the document shape is read from the main editor's ProseMirror document (`docShape`,
 *   format `paragraph:x  ROW[COL(paragraph:a) | COL(paragraph)]  paragraph:z`, `paragraph` without text = an empty paragraph).
 * - Drags move in steps like `dragBlockBelow` in `34-columns.spec.ts` (press, a small move, 15 steps to the end point, a final nudge before release). The vertical indicator is the
 *   `.prosemirror-dropcursor-vertical` element drawn by core DropCursor (left/right edge carry `prosemirror-dropcursor-block-vertical-left|right`).
 * - Geometry is compared only as relative values (column vs row, image vs image, indicator vs block): headless overlay scrollbars skew absolute values.
 * - Every case collects `pageerror` and asserts none at the end (`ResizeObserver loop` is a known benign browser message and is excluded).
 * - Behaviour that is measured but cannot yet be asserted as right or wrong goes into `test.info().annotations` (type says what was measured). The R cases are real-browser measurements:
 *   the stable parts are asserted; the comparison of the gutter indicator with the drop target (R2) is only recorded because Chromium's `posAtCoords` in the gutter is unstable.
 */

const RUN = Date.now();
const ROW = '[data-node-type="columnList"]';
/** Gutter between columns (`COLUMN_GAP_PX` in `collab/columns/layout.ts`; e2e can't import web, so change both together). */
const COLUMN_GAP_PX = 24;
/** Minimum width of a text column (same as above, `COLUMN_MIN_TEXT_PX`). */
const COLUMN_MIN_TEXT_PX = 200;
const VERTICAL = ".prosemirror-dropcursor-vertical";
const ANY_CURSOR = ".prosemirror-dropcursor-vertical, .prosemirror-dropcursor-block, .prosemirror-dropcursor-inline";

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
  await createNote(page, `E2E columns drag ${label} ${RUN}`);
  return errors;
}

function columnsMarkdown(cols: string[]): string {
  return [
    '<div data-kb-columns style="display:flex;gap:16px">',
    ...cols.flatMap((c) => ['<div data-kb-column style="flex:1">', "", c, "", "</div>"]),
    "</div>",
  ].join("\n");
}

/** One paragraph before and after the row (`x`/`z`), same as the fixture of the web unit tests. */
function rowDoc(cols: string[]): string {
  return ["x", "", columnsMarkdown(cols), "", "z", ""].join("\n");
}

function originOf(page: Page): string {
  return new URL(page.url()).origin;
}

async function pasteMarkdown(page: Page, markdown: string): Promise<void> {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: originOf(page) });
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
  return editorLocator(page)
    .locator(".bn-block-outer")
    .filter({ has: page.locator(".bn-inline-content", { hasText: new RegExp(`^${reEscape(text)}$`) }) })
    .last();
}

function imageOuter(page: Page, url: string): Locator {
  return editorLocator(page)
    .locator(".bn-block-outer")
    .filter({ has: page.locator(`img[src*="${url}"]`) })
    .last();
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

type Rect = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };

/**
 * Hovers `block` and waits for the side menu to move next to it before returning both boxes: vertical ranges overlap and the menu center is within 100px to the left of the block's left edge
 * (the other column of the same row has the same y, so vertical alignment alone doesn't tell which column's menu it is). The click made while pasting leaves the menu on another block first; without waiting the drag would pick the wrong block.
 */
async function hoverForSideMenu(page: Page, block: Locator, label: string): Promise<{ menu: Rect; block: Rect }> {
  await block.hover();
  await expect(page.getByRole("button", { name: "Open block menu" })).toBeVisible();
  let got: { menu: Rect; block: Rect } | undefined;
  await expect(async () => {
    const menu = await page.locator(".bn-side-menu").boundingBox();
    const box = await block.boundingBox();
    expect(menu, "side menu").not.toBeNull();
    expect(box, `block ${label}`).not.toBeNull();
    const overlap = menu!.y < box!.y + box!.height && box!.y < menu!.y + menu!.height;
    const center = menu!.x + menu!.width / 2;
    expect({ overlap, nearLeft: center > box!.x - 100 && center < box!.x + 4 }, JSON.stringify({ menu, block: box })).toEqual({ overlap: true, nearLeft: true });
    got = { menu: menu!, block: box! };
  }).toPass({ timeout: 5_000 });
  return got!;
}

async function moveInSteps(page: Page, from: Point, to: Point, steps: number, after?: (p: Point) => Promise<void>): Promise<void> {
  for (let i = 1; i <= steps; i++) {
    const p = { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps };
    await page.mouse.move(p.x, p.y);
    await after?.(p);
  }
}

/**
 * Presses the handle of `source` and moves to `end` in the steps of `dragBlockBelow` (a final 1px nudge down), calling `beforeUp` before release.
 * When `end` is a function it receives the handle's center (a straight drag down needs its x); `nudge` is the displacement of the first small move after the press (default 10px right and down).
 * `steps` is the number of steps of the move to the end point (default 15). `watch` is called after every `mouse.move` (used to check there is no vertical indicator throughout).
 */
async function dragHandleTo(
  page: Page,
  source: Locator,
  label: string,
  end: Point | ((handle: Point) => Point),
  opts: { nudge?: Point; steps?: number; watch?: (p: Point) => Promise<void>; beforeUp?: () => Promise<void> } = {},
): Promise<void> {
  await hoverForSideMenu(page, source, label);
  const h = (await page.getByRole("button", { name: "Open block menu" }).boundingBox())!;
  const start = { x: h.x + h.width / 2, y: h.y + h.height / 2 };
  if (typeof end === "function") end = end(start);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const nudge = { x: start.x + (opts.nudge?.x ?? 10), y: start.y + (opts.nudge?.y ?? 10) };
  await moveInSteps(page, start, nudge, 5, opts.watch);
  await moveInSteps(page, nudge, end, opts.steps ?? 15, opts.watch);
  await moveInSteps(page, end, { x: end.x, y: end.y + 1 }, 1, opts.watch);
  await opts.beforeUp?.();
  await page.mouse.up();
}

async function dragBlockBelow(page: Page, sourceText: string, targetText: string, watch?: (p: Point) => Promise<void>): Promise<void> {
  const t = (await blockOuter(page, targetText).boundingBox())!;
  await dragHandleTo(page, blockOuter(page, sourceText), sourceText, { x: t.x + t.width / 2, y: t.y + t.height * 0.75 }, { watch });
}

/**
 * Drags the handle to `target`'s left/right edge: end point x = 8px inside the right or left edge, y = the box's midline. Asserts the indicator before release:
 * `expectVertical` (default true) -> the vertical line on that side is visible; false -> no vertical line at all.
 */
async function dragToEdge(page: Page, source: Locator, sourceLabel: string, target: Locator, side: "left" | "right", opts: { expectVertical?: boolean } = {}): Promise<void> {
  const box = (await target.boundingBox())!;
  const end = { x: side === "right" ? box.x + box.width - 8 : box.x + 8, y: box.y + box.height / 2 };
  await dragHandleTo(page, source, sourceLabel, end, {
    beforeUp: async () => {
      if (opts.expectVertical ?? true) await expect(page.locator(`${VERTICAL}.prosemirror-dropcursor-block-vertical-${side}`)).toBeVisible();
      else await expect(page.locator(VERTICAL)).toHaveCount(0);
    },
  });
}

async function dragBlockToEdge(page: Page, sourceText: string, targetText: string, side: "left" | "right", opts?: { expectVertical?: boolean }): Promise<void> {
  await dragToEdge(page, blockOuter(page, sourceText), sourceText, blockOuter(page, targetText), side, opts);
}

async function rowGeometry(page: Page, index = 0): Promise<{ row: Rect; cols: Rect[] }> {
  return editorLocator(page)
    .locator(ROW)
    .nth(index)
    .evaluate((el) => {
      const r = (e: Element) => {
        const b = e.getBoundingClientRect();
        return { x: b.x, y: b.y, width: b.width, height: b.height };
      };
      return { row: r(el), cols: Array.from(el.querySelectorAll(':scope > [data-node-type="column"]')).map(r) };
    });
}

async function dropCursorState(page: Page): Promise<{ classes: string; rect: Rect } | null> {
  return page.evaluate((selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { classes: el.className, rect: { x: b.x, y: b.y, width: b.width, height: b.height } };
  }, ANY_CURSOR);
}

async function posInfo(page: Page, p: Point): Promise<{ pos: number; inside: number; parent: string; path: string[] } | null> {
  return editorLocator(page).evaluate((el, pt) => {
    type Resolved = { depth: number; node(d: number): { type: { name: string } }; parent: { type: { name: string } } };
    type View = { posAtCoords(c: { left: number; top: number }): { pos: number; inside: number } | null; state: { doc: { resolve(p: number): Resolved } } };
    const view = (el as Element & { editor?: { view?: View } }).editor!.view!;
    const hit = view.posAtCoords({ left: pt.x, top: pt.y });
    if (!hit) return null;
    const $pos = view.state.doc.resolve(hit.pos);
    return { pos: hit.pos, inside: hit.inside, parent: $pos.parent.type.name, path: Array.from({ length: $pos.depth + 1 }, (_, d) => $pos.node(d).type.name) };
  }, p);
}

async function hitAt(page: Page, p: Point): Promise<{ tag: string; inEditor: boolean }> {
  return editorLocator(page).evaluate((root, pt) => {
    const el = document.elementFromPoint(pt.x, pt.y);
    return { tag: el ? `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)}` : "none", inEditor: !!el && root.contains(el) };
  }, p);
}

/**
 * Where `posAtCoords` lands the moment before the drop: parent node type, index of the column it is in (null if not in a column), id of the direct child block that contains it,
 * and, when the parent is a column, the block ids before and after it.
 */
type DropPos = { pos: number; parent: string; column: number | null; block: string | null; before: string | null; after: string | null } | null;

/**
 * Builds in the page a `DataTransfer` carrying only a PNG file (no dragstart, like a drag in from the operating system) and dispatches, on the element hit at `p`, in order:
 * dragenter -> re-find the hit element and record `posAtCoords` -> dragover -> drop. Returns the element hit at each step, `posAtCoords` before the drop,
 * and whether dragover/drop were `preventDefault`ed.
 */
async function dropFileAt(
  page: Page,
  p: Point,
  png: Buffer,
): Promise<{ first: string; afterEnter: string; afterEnterInEditor: boolean; pos: DropPos; overPrevented: boolean; dropPrevented: boolean }> {
  return editorLocator(page).evaluate(
    (root, { pt, b64 }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], "gutter.png", { type: "image/png" }));
      const describe = (el: Element | null) => (el ? `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)}` : "none");
      const fire = (el: Element, type: string) => {
        const e = new DragEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: pt.x, clientY: pt.y, dataTransfer: dt });
        el.dispatchEvent(e);
        return e.defaultPrevented;
      };
      const first = document.elementFromPoint(pt.x, pt.y)!;
      fire(first, "dragenter");
      const target = document.elementFromPoint(pt.x, pt.y)!;
      type Node = { type: { name: string }; attrs: { id?: unknown } } | null;
      type Resolved = { depth: number; parent: Node; nodeBefore: Node; nodeAfter: Node; node(d: number): Node; index(d: number): number };
      type View = { posAtCoords(c: { left: number; top: number }): { pos: number } | null; state: { doc: { resolve(p: number): Resolved } } };
      const view = (root as Element & { editor?: { view?: View } }).editor!.view!;
      let pos = null as { pos: number; parent: string; column: number | null; block: string | null; before: string | null; after: string | null } | null;
      // Measure in the capture phase on the editor's parent, i.e. just before the product's drop handler (on `view.dom`): the document-capture drop has already cleared
      // `kb-dragging` (the handle and other overlays take the pointer again) and core SideMenu has already changed the selection, so `posAtCoords` is measured in the same state as the product.
      // Measuring before dragover or in window capture is inaccurate: Chromium's `posAtCoords` in the gutter changes with overlays and layout.
      const capture = () => {
        const hit = view.posAtCoords({ left: pt.x, top: pt.y });
        if (!hit) return;
        const $pos = view.state.doc.resolve(hit.pos);
        const idOf = (n: Node) => (n && typeof n.attrs.id === "string" ? n.attrs.id : null);
        let column: number | null = null;
        let block: string | null = null;
        for (let d = $pos.depth; d > 0; d--) {
          if ($pos.node(d)!.type.name !== "column") continue;
          column = $pos.index(d - 1);
          block = d < $pos.depth ? idOf($pos.node(d + 1)) : null;
          break;
        }
        const columnLevel = $pos.parent!.type.name === "column";
        pos = {
          pos: hit.pos,
          parent: $pos.parent!.type.name,
          column,
          block,
          before: columnLevel ? idOf($pos.nodeBefore) : null,
          after: columnLevel ? idOf($pos.nodeAfter) : null,
        };
      };
      root.parentElement!.addEventListener("drop", capture, { capture: true, once: true });
      const overPrevented = fire(target, "dragover");
      const dropPrevented = fire(target, "drop");
      return { first: describe(first), afterEnter: describe(target), afterEnterInEditor: root.contains(target), pos, overPrevented, dropPrevented };
    },
    { pt: p, b64: png.toString("base64") },
  );
}

/** Finds the column nearest to `p` by comparing horizontal distance first, then vertical, taking the earlier one on a tie (the rule by which a file drop in the gutter is retargeted to the nearest column). */
function nearestColumn(cols: Rect[], p: Point): number {
  const dist = (v: number, from: number, to: number) => (v < from ? from - v : v > to ? v - to : 0);
  let best = -1;
  let bestD: [number, number] = [Infinity, Infinity];
  cols.forEach((c, i) => {
    const d: [number, number] = [dist(p.x, c.x, c.x + c.width), dist(p.y, c.y, c.y + c.height)];
    if (d[0] < bestD[0] || (d[0] === bestD[0] && d[1] < bestD[1])) {
      best = i;
      bestD = d;
    }
  });
  return best;
}

/**
 * When `posAtCoords`'s parent at drop time is the row (between two columns) -> the column chosen by the gutter's coordinate-rewriting rule: horizontal distance first, then vertical, the earlier on a full tie.
 * If the horizontal distances differ by 0.5px or less (the pointer is almost in the middle of the gutter) both columns count as right: a float difference in the column boxes flips the side.
 * Otherwise -> the column `posAtCoords` is in (core inserts there without rewriting the coordinate).
 */
function expectedColumns(cols: Rect[], p: Point, pos: NonNullable<DropPos>): number[] {
  if (pos.parent !== "columnList") return pos.column === null ? [] : [pos.column];
  const dx = cols.map((c) => (p.x < c.x ? c.x - p.x : p.x > c.x + c.width ? p.x - c.x - c.width : 0));
  const min = Math.min(...dx);
  const near = dx.flatMap((d, i) => (d - min <= 0.5 ? [i] : []));
  return near.length > 1 ? near : [nearestColumn(cols, p)];
}

/** The direct child block in the same column with the smallest vertical distance (the gutter's coordinate-rewriting rule; the earlier on a tie). */
function nearestBlockByY(blocks: Array<{ id: string; rect: Rect }>, y: number): string | null {
  let best: { id: string; d: number } | null = null;
  for (const b of blocks) {
    const d = y < b.rect.y ? b.rect.y - y : y > b.rect.y + b.rect.height ? y - b.rect.y - b.rect.height : 0;
    if (!best || d < best.d) best = { id: b.id, d };
  }
  return best?.id ?? null;
}

function columnsOf(shape: string): string[] {
  const m = /ROW\[(.*?)\](?=\s{2}|$)/.exec(shape);
  return m ? m[1]!.split(" | ") : [];
}

test("x y z: dragging z to x's right edge gives two columns [x|z]; left edge gives [z|x]; one Ctrl+Z undoes it [sc:columnsDragBeside]", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "p1");
  await pasteMarkdown(page, "x\n\ny\n\nz\n");
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("paragraph:x  paragraph:y  paragraph:z");

  await dragBlockToEdge(page, "z", "x", "right");
  await expect.poll(() => docShape(page)).toContain("ROW[COL(paragraph:x) | COL(paragraph:z)]  paragraph:y");
  await clickEndOfParagraph(page, blockOuter(page, "y").locator(".bn-inline-content").first());
  await page.keyboard.press("Control+z");
  await expect.poll(() => docShape(page)).toContain("paragraph:x  paragraph:y  paragraph:z");
  await expect(editorLocator(page).locator(ROW)).toHaveCount(0);

  await dragBlockToEdge(page, "z", "x", "left");
  await expect.poll(() => docShape(page)).toContain("ROW[COL(paragraph:z) | COL(paragraph:x)]  paragraph:y");
  await clickEndOfParagraph(page, blockOuter(page, "y").locator(".bn-inline-content").first());
  await page.keyboard.press("Control+z");
  await expect.poll(() => docShape(page)).toContain("paragraph:x  paragraph:y  paragraph:z");
  await expect(editorLocator(page).locator(ROW)).toHaveCount(0);
  expectNoPageErrors(errors);
});

test("z outside [a|b] dragged to b's right edge gives three columns; a 4-column row dragged to the first column's right edge shows no vertical indicator and gives the same result as a horizontal-line drop", async ({ page }) => {
  test.setTimeout(150_000);
  const errors = await startNote(page, "p2");
  await pasteMarkdown(page, rowDoc(["a", "b"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(paragraph:a) | COL(paragraph:b)]  paragraph:z");
  await dragBlockToEdge(page, "z", "b", "right");
  await expect.poll(() => docShape(page)).toContain("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b) | COL(paragraph:z)]");
  expect(await docShape(page)).not.toContain("paragraph:z  ");

  const four = rowDoc(["a", "b", "c", "d"]);
  const fourShape = "ROW[COL(paragraph:a) | COL(paragraph:b) | COL(paragraph:c) | COL(paragraph:d)]";
  await createNote(page, `E2E columns drag p2-four ${RUN}`);
  await pasteMarkdown(page, four);
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain(fourShape);
  await dragBlockToEdge(page, "z", "a", "right", { expectVertical: false });
  await expect.poll(() => docShape(page)).not.toContain(`${fourShape}  paragraph:z`);
  const edgeResult = await docShape(page);

  await createNote(page, `E2E columns drag p2-control ${RUN}`);
  await pasteMarkdown(page, four);
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain(fourShape);
  await dragBlockBelow(page, "z", "a");
  await expect.poll(() => docShape(page)).toBe(edgeResult);
  expect(columnsOf(edgeResult)).toHaveLength(4);
  expectNoPageErrors(errors);
});

test("reordering is not misfired: one handle drag down inside a column and one at top level, with the pointer outside the block box and in the gutter, show no vertical indicator and give a horizontal-line reorder", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = await startNote(page, "p3");
  /** `updated`: this point received a dragover (DropCursor redraws from it); otherwise the indicator on screen is left from the previous point and isn't used to judge this one. */
  type Step = { at: Point; vertical: number; updated: boolean };
  let seen: Step[] = [];
  // A dragover during a drag arrives later than `mouse.move`, so each step first waits for this point's dragover before reading the indicator: the document bubble phase records every non-synthetic
  // dragover (DropCursor is on `view.dom` and has already drawn by the time it bubbles to document; the synthetic events core SideMenu clamps into the box don't count). DragEvent coordinates are
  // integers with the fraction dropped, so compare with `Math.floor`. On the step that moves onto a new element Chromium sends only dragenter and no dragover; if none arrives it is recorded as not updated.
  const installDragoverProbe = () =>
    page.evaluate(() => {
      const w = window as unknown as { kbOvers?: string[]; kbOversOn?: boolean };
      w.kbOvers = [];
      if (w.kbOversOn) return;
      w.kbOversOn = true;
      document.addEventListener("dragover", (e) => {
        if ((e as DragEvent & { synthetic?: boolean }).synthetic) return;
        w.kbOvers!.push(`${e.clientX},${e.clientY}`);
      });
    });
  const watch = async (at: Point) => {
    const key = `${Math.floor(at.x)},${Math.floor(at.y)}`;
    const updated = await page
      .waitForFunction((k) => ((window as unknown as { kbOvers?: string[] }).kbOvers ?? []).includes(k), key, { timeout: 1_000 })
      .then(
        () => true,
        () => false,
      );
    seen.push({ at, vertical: await page.locator(VERTICAL).count(), updated });
    await page.evaluate(() => void ((window as unknown as { kbOvers?: string[] }).kbOvers = []));
  };
  const regionOf = (cols: Rect[], p: Point): "outside" | "gutter" | "edge-zone" | "inner" => {
    if (p.x < cols[0]!.x) return "outside";
    const col = cols.find((c) => p.x >= c.x && p.x <= c.x + c.width);
    if (!col) return "gutter";
    const zone = Math.min(64, Math.max(24, 0.2 * col.width));
    return p.x < col.x + zone || p.x > col.x + col.width - zone ? "edge-zone" : "inner";
  };
  const report: Record<string, unknown> = {};

  await pasteMarkdown(page, rowDoc(["a\n\nq", "b"]));
  await installDragoverProbe();
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(paragraph:a,paragraph:q) | COL(paragraph:b)]");
  let { cols } = await rowGeometry(page);
  // The in-column handle is only 16px wide with its right edge against column 1's left edge: after pressing, move left-down first so the first few steps are outside the box.
  const q = (await blockOuter(page, "q").boundingBox())!;
  await dragHandleTo(page, blockOuter(page, "a"), "a", { x: q.x + q.width / 2, y: q.y + q.height * 0.75 }, { nudge: { x: -10, y: 10 }, watch });
  await expect.poll(() => docShape(page)).toContain("paragraph:x  ROW[COL(paragraph:q,paragraph:a) | COL(paragraph:b)]  paragraph:z");
  expect(seen.length).toBe(21);
  let tagged = seen.filter((s) => s.updated).map((s) => ({ ...s, region: regionOf(cols, s.at) }));
  expect(tagged.filter((s) => s.region === "outside").length, "前提：框外有收到 dragover 的點").toBeGreaterThan(0);
  expect(tagged.filter((s) => s.vertical > 0 && (s.region === "outside" || s.region === "inner")), "框外或欄中央出現直線").toEqual([]);
  expect(seen.at(-1)!.updated, "放開的那一點收到 dragover").toBe(true);
  expect(seen.at(-1)!.vertical, "放開的那一點沒有直線").toBe(0);
  report.column1 = { cols, withVertical: tagged.filter((s) => s.vertical > 0), notUpdated: seen.filter((s) => !s.updated).map((s) => s.at) };

  seen = [];
  await createNote(page, `E2E columns drag p3-col2 ${RUN}`);
  await pasteMarkdown(page, rowDoc(["b", "a\n\nq"]));
  await installDragoverProbe();
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(paragraph:b) | COL(paragraph:a,paragraph:q)]");
  ({ cols } = await rowGeometry(page));
  // The handle occupies the rightmost 16px of the gutter: likewise move left-down first so the first few steps are in the gutter.
  const q2 = (await blockOuter(page, "q").boundingBox())!;
  await dragHandleTo(page, blockOuter(page, "a"), "a", { x: q2.x + q2.width / 2, y: q2.y + q2.height * 0.75 }, { nudge: { x: -10, y: 10 }, watch });
  await expect.poll(() => docShape(page)).toContain("paragraph:x  ROW[COL(paragraph:b) | COL(paragraph:q,paragraph:a)]  paragraph:z");
  expect(seen.length).toBe(21);
  tagged = seen.filter((s) => s.updated).map((s) => ({ ...s, region: regionOf(cols, s.at) }));
  expect(tagged.filter((s) => s.region === "gutter").length, "前提：溝裡有收到 dragover 的點").toBeGreaterThan(0);
  expect(tagged.filter((s) => s.vertical > 0 && (s.region === "gutter" || s.region === "inner")), "溝裡或欄中央出現直線").toEqual([]);
  expect(seen.at(-1)!.updated, "放開的那一點收到 dragover").toBe(true);
  expect(seen.at(-1)!.vertical, "放開的那一點沒有直線").toBe(0);
  report.column2 = { cols, withVertical: tagged.filter((s) => s.vertical > 0), notUpdated: seen.filter((s) => !s.updated).map((s) => s.at) };

  // Top level: x y z, drag x below z. The steps through the left edge zone are still over x itself, so there is no vertical indicator throughout.
  seen = [];
  await createNote(page, `E2E columns drag p3-top ${RUN}`);
  await pasteMarkdown(page, "x\n\ny\n\nz\n");
  await installDragoverProbe();
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("paragraph:x  paragraph:y  paragraph:z");
  await dragBlockBelow(page, "x", "z", watch);
  await expect.poll(() => docShape(page)).toContain("paragraph:y  paragraph:z  paragraph:x");
  expect(seen.length).toBe(21);
  expect(seen.filter((s) => s.updated).length, "前提：有收到 dragover 的點").toBeGreaterThan(10);
  expect(seen.filter((s) => s.updated && s.vertical > 0), "頂層排序途中出現直線").toEqual([]);
  await expect(editorLocator(page).locator(ROW)).toHaveCount(0);

  // When reordering inside a column, dragging diagonally from the handle outside the column to the center crosses the target column's left edge zone (inside the box): those steps show a vertical line by the rule, and releasing at the center still gives a horizontal-line reorder.
  test.info().annotations.push({ type: "in-column-sort-path-crosses-edge-zone", description: JSON.stringify(report) });
  expectNoPageErrors(errors);
});

test("[a|b]: dragging b to the right edge of z outside the row gives a new row [z|b] and the original row [a|empty]", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "p4");
  await pasteMarkdown(page, rowDoc(["a", "b"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b)]  paragraph:z");
  await dragBlockToEdge(page, "b", "z", "right");
  await expect.poll(() => docShape(page)).toContain("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph)]  ROW[COL(paragraph:z) | COL(paragraph:b)]");
  expectNoPageErrors(errors);
});

async function imageRowMetrics(page: Page): Promise<{ heights: number[]; widths: number[]; rowWidth: number; colWidths: number[] }> {
  return editorLocator(page)
    .locator(ROW)
    .first()
    .evaluate((row) => {
      const cols = Array.from(row.querySelectorAll<HTMLElement>(':scope > [data-node-type="column"]'));
      const imgs = cols.map((c) => c.querySelector("img")!.getBoundingClientRect());
      return {
        heights: imgs.map((r) => r.height),
        widths: imgs.map((r) => r.width),
        rowWidth: row.getBoundingClientRect().width,
        colWidths: cols.map((c) => c.getBoundingClientRect().width),
      };
    });
}

async function expectEqualHeights(page: Page, n: number, opts: { skip?: number } = {}): Promise<Awaited<ReturnType<typeof imageRowMetrics>>> {
  let m: Awaited<ReturnType<typeof imageRowMetrics>> | undefined;
  await expect(async () => {
    m = await imageRowMetrics(page);
    expect(m.heights).toHaveLength(n);
    const others = m.heights.filter((_, i) => i !== opts.skip);
    expect(Math.max(...others) - Math.min(...others), JSON.stringify(m)).toBeLessThanOrEqual(2);
    const sum = m.colWidths.reduce((a, b) => a + b, 0) + COLUMN_GAP_PX * (n - 1);
    expect(Math.abs(sum - m.rowWidth), JSON.stringify(m)).toBeLessThanOrEqual(1);
  }).toPass({ timeout: 10_000 });
  return m!;
}

test("auto equal height: a row from 400x200 and 200x200, then adding 300x300 -> image heights differ by <= 2px and column widths plus gutters equal the row width; adding an 80x80 small image -> the small image is 80 wide and the others stay equal height", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = await startNote(page, "p5");
  const record: Record<string, unknown> = {};
  try {
    const [u1, u2, u3] = [await uploadPng(page, 400, 200), await uploadPng(page, 200, 200), await uploadPng(page, 300, 300)];
    await pasteMarkdown(page, `![a](${u1})\n\n![b](${u2})\n\n![c](${u3})\n`);
    await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("image  image  image");
    for (const u of [u1, u2, u3]) await waitImageLoaded(editorLocator(page).locator(`img[src*="${u}"]`));

    await dragToEdge(page, imageOuter(page, u2), "200×200", imageOuter(page, u1), "right");
    await expect.poll(() => docShape(page)).toContain("ROW[COL(image) | COL(image)]  image");
    record.two = await expectEqualHeights(page, 2);

    await dragToEdge(page, imageOuter(page, u3), "300×300", imageOuter(page, u2), "right");
    await expect.poll(() => docShape(page)).toContain("ROW[COL(image) | COL(image) | COL(image)]");
    record.three = await expectEqualHeights(page, 3);

    await createNote(page, `E2E columns drag p5-small ${RUN}`);
    const [s1, s2, s3] = [await uploadPng(page, 400, 200), await uploadPng(page, 200, 200), await uploadPng(page, 80, 80)];
    await pasteMarkdown(page, `![a](${s1})\n\n![b](${s2})\n\n![s](${s3})\n`);
    await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("image  image  image");
    for (const u of [s1, s2, s3]) await waitImageLoaded(editorLocator(page).locator(`img[src*="${u}"]`));
    await dragToEdge(page, imageOuter(page, s2), "200×200", imageOuter(page, s1), "right");
    await expect.poll(() => docShape(page)).toContain("ROW[COL(image) | COL(image)]  image");
    await dragToEdge(page, imageOuter(page, s3), "80×80", imageOuter(page, s2), "right");
    await expect.poll(() => docShape(page)).toContain("ROW[COL(image) | COL(image) | COL(image)]");
    const small = await expectEqualHeights(page, 3, { skip: 2 });
    record.small = small;
    expect(Math.abs(small.widths[2]! - 80), JSON.stringify(small)).toBeLessThanOrEqual(0.5);
  } finally {
    const spread = (m: unknown, skip?: number) => {
      const h = (m as { heights?: number[] } | undefined)?.heights?.filter((_, i) => i !== skip);
      return h && h.length ? Math.max(...h) - Math.min(...h) : null;
    };
    const v = { ...record, heightSpread: { two: spread(record.two), three: spread(record.three), small: spread(record.small, 2) } };
    test.info().annotations.push({ type: "equal-height-measurements", description: JSON.stringify(v) });
    console.log("P5=" + JSON.stringify(v));
  }
  expectNoPageErrors(errors);
});

test("file in the gutter (handle shown): the handle's center hits the handle, after dragenter the same point hits the editor and dragover is accepted, dropping puts the image into the nearest column and the URL is unchanged", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "p10");
  await pasteMarkdown(page, rowDoc(["a", "b"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(paragraph:a) | COL(paragraph:b)]");
  const url = page.url();
  await hoverForSideMenu(page, blockOuter(page, "b"), "b");
  const handle = page.locator("[data-kb-column-side-menu]").getByRole("button", { name: "Open block menu" });
  await expect(handle).toBeVisible();
  const h = (await handle.boundingBox())!;
  const center = { x: h.x + h.width / 2, y: h.y + h.height / 2 };
  const onHandle = await handle.evaluate((el, p) => el.contains(document.elementFromPoint(p.x, p.y)), center);
  expect(onHandle, "前提：⋮⋮ 中心命中的是 ⋮⋮").toBe(true);

  const { cols } = await rowGeometry(page);
  const result = await dropFileAt(page, center, grayPng(40, 40));
  expect(result.pos, "放下前 posAtCoords 有結果").not.toBeNull();
  const expected = expectedColumns(cols, center, result.pos!);
  test.info().annotations.push({ type: "gutter-file-drop-on-handle", description: JSON.stringify({ center, cols, expected, result }) });
  expect(expected.length, `預期的欄 ${JSON.stringify(result.pos)}`).toBeGreaterThan(0);
  expect(result.afterEnterInEditor, `dragenter 之後命中 ${result.afterEnter}`).toBe(true);
  expect(result.overPrevented, "dragover 被接受").toBe(true);
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toMatch(/ROW\[COL\([^)]*image[^)]*\) \| COL\(paragraph:b\)\]|ROW\[COL\(paragraph:a\) \| COL\([^)]*image[^)]*\)\]/);
  const columns = columnsOf(await docShape(page));
  expect(expected, `圖片所在的欄 ${JSON.stringify(columns)}`).toContain(columns.findIndex((c) => c.includes("image")));
  expect(page.url()).toBe(url);
  expectNoPageErrors(errors);
});

test("the handle doesn't take the pointer during a drag: a dragenter on document (no dragstart) puts kb-dragging on the columns and sets pointer-events:none on the handle, menu, wrapper and popover; drop, dragend and pointermove clear it, dragleave does not, dragover restores it", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "s6");
  await pasteMarkdown(page, rowDoc(["a", "b"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(paragraph:a) | COL(paragraph:b)]");
  await hoverForSideMenu(page, blockOuter(page, "b"), "b");
  await expect(page.locator("[data-kb-column-side-menu]")).toBeVisible();

  const state = () =>
    page.evaluate(() => {
      const wrapper = document.querySelector("[data-kb-column-side-menu]");
      const pick = {
        button: wrapper?.querySelector("button") ?? null,
        sideMenu: wrapper?.querySelector(".bn-side-menu") ?? null,
        wrapper,
        popover: wrapper?.closest("[data-kb-side-menu-popover]") ?? null,
      };
      const pe = Object.fromEntries(Object.entries(pick).map(([k, el]) => [k, el ? getComputedStyle(el).pointerEvents : "missing"]));
      const marked = Array.from(document.querySelectorAll(".kb-dragging"));
      const editor = document.querySelector('[data-testid="note-editor"]');
      return { pe, marked: marked.length, wrapsEditor: marked.length === 1 && !!editor && marked[0]!.contains(editor) };
    });
  const fire = (type: string) =>
    page.evaluate((t) => {
      const e = t.startsWith("drag") || t === "drop" ? new DragEvent(t, { bubbles: true, cancelable: true }) : new Event(t, { bubbles: true });
      document.dispatchEvent(e);
    }, type);
  const NONE = { button: "none", sideMenu: "none", wrapper: "none", popover: "none" };

  const before = await state();
  expect(before.marked).toBe(0);
  for (const [k, v] of Object.entries(before.pe)) expect(v, `拖放前 ${k}`).not.toMatch(/^(none|missing)$/);

  await fire("dragenter");
  const during = await state();
  expect(during).toEqual({ pe: NONE, marked: 1, wrapsEditor: true });
  await page.evaluate(() => document.dispatchEvent(new DragEvent("dragleave", { bubbles: true, relatedTarget: null })));
  expect((await state()).marked, "dragleave 不清").toBe(1);
  await fire("drop");
  expect((await state()).marked, "drop 清掉").toBe(0);

  await fire("dragenter");
  expect((await state()).marked).toBe(1);
  await fire("dragend");
  expect((await state()).marked, "dragend 清掉").toBe(0);

  await fire("dragenter");
  expect((await state()).marked).toBe(1);
  const h = (await page.locator("[data-kb-column-side-menu]").boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2 + 1);
  await expect.poll(async () => (await state()).marked, { message: "pointermove 清掉" }).toBe(0);
  await fire("dragover");
  expect((await state()).marked, "dragover 補回").toBe(1);
  await fire("dragend");
  expect((await state()).marked).toBe(0);
  expectNoPageErrors(errors);
});

test("during a drag the file input in the file panel (inside a floating-ui portal) is still the element hit by the pointer: external files can be dropped straight onto it", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "s6b");
  const editor = editorLocator(page);
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await waitForEditorSelection(page);
  await editor.pressSequentially("/image");
  await page.getByText("Resizable image with caption").click();
  await page.getByText("Add image", { exact: true }).click();
  const input = page.getByLabel("Choose an image file to upload");
  await expect(input).toBeVisible();
  const box = (await input.boundingBox())!;
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const hitsInput = () => input.evaluate((el, pt) => el === document.elementFromPoint(pt.x, pt.y), center);
  expect(await hitsInput(), "前提：拖放前命中 file input").toBe(true);
  const portal = await input.evaluate((el) => !!el.closest("[data-floating-ui-portal]"));
  expect(portal, "前提：檔案面板在 floating-ui portal 裡").toBe(true);

  await page.evaluate(() => document.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true })));
  await expect(page.locator(".kb-dragging")).toHaveCount(1);
  expect(await hitsInput(), "拖放中仍命中 file input").toBe(true);
  expect(await input.evaluate((el) => getComputedStyle(el).pointerEvents)).not.toBe("none");
  await page.evaluate(() => document.dispatchEvent(new DragEvent("dragend", { bubbles: true })));
  await expect(page.locator(".kb-dragging")).toHaveCount(0);
  expectNoPageErrors(errors);
});

async function resetDragLog(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { kbDragLog?: Record<string, number>; kbDragLogOn?: boolean };
    w.kbDragLog = {};
    if (w.kbDragLogOn) return;
    w.kbDragLogOn = true;
    for (const type of ["dragstart", "dragover", "drop", "dragend"]) {
      document.addEventListener(type, () => void (w.kbDragLog![type] = (w.kbDragLog![type] ?? 0) + 1), true);
    }
  });
}

const dragLog = (page: Page) => page.evaluate(() => (window as unknown as { kbDragLog?: Record<string, number> }).kbDragLog ?? {});

async function probeDrop(page: Page, sourceText: string, p: Point, original: string, undoAnchor: string): Promise<Record<string, unknown>> {
  await resetDragLog(page);
  const pos = await posInfo(page, p);
  let cursor: Awaited<ReturnType<typeof dropCursorState>> = null;
  let hit: Awaited<ReturnType<typeof hitAt>> | null = null;
  await dragHandleTo(page, blockOuter(page, sourceText), sourceText, p, {
    beforeUp: async () => {
      cursor = await dropCursorState(page);
      hit = await hitAt(page, p);
    },
  });
  // Every point of R1, R2 and R4 changes the document: wait for the change before measuring.
  await expect.poll(() => docShape(page), { message: "放下後文件有變" }).not.toBe(original);
  const after = await docShape(page);
  const landed = await blockOuter(page, sourceText).boundingBox();
  const out = { p, pos, hitDuringDrag: hit, cursor, events: await dragLog(page), after, landed };
  if (after !== original) {
    await clickEndOfParagraph(page, blockOuter(page, undoAnchor).locator(".bn-inline-content").first());
    await page.keyboard.press("Control+z");
    await expect.poll(() => docShape(page)).toBe(original);
  }
  return out;
}

// R1: below the last block, `posAtCoords` lands at the end of the document (the parent is the top-level blockGroup, no qualifying Y is found) or not inside `view.dom` at all
// (core SideMenu then emits synthetic events clamped into the box, and the vertical-line check ignores synthetic events), so with x in the right edge zone only a horizontal line is shown and the drop is a horizontal-line drop.
test("R1 below the last block with x in the right edge zone: only a horizontal line, dropping creates no row and x moves to the end of the document", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = await startNote(page, "r1");
  await pasteMarkdown(page, "x\n\ny\n\nz\n");
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("paragraph:x  paragraph:y  paragraph:z");
  const original = await docShape(page);
  const results: unknown[] = [];
  try {
    const last = editorLocator(page).locator(":scope > .bn-block-group > .bn-block-outer").last();
    for (const below of [8, 25, 40, 120]) {
      const box = (await last.boundingBox())!;
      const editorBox = (await editorLocator(page).boundingBox())!;
      const p = { x: box.x + box.width - 8, y: box.y + box.height + below };
      const before = { lastBox: box, editorBottom: editorBox.y + editorBox.height, hitBefore: await hitAt(page, p) };
      const probe = await probeDrop(page, "x", p, original, "y");
      results.push({ below, ...before, ...probe });
      const cursor = probe.cursor as { classes: string } | null;
      expect(cursor?.classes ?? "", `below ${below}: 提示線`).not.toContain("vertical");
      expect(probe.after, `below ${below}: 放下的結果`).toContain("paragraph:y  paragraph:z  paragraph:x");
      expect(probe.after).not.toContain("ROW[");
    }
  } finally {
    test.info().annotations.push({ type: "below-last-block-edge-zone", description: JSON.stringify(results) });
    console.log("R1=" + JSON.stringify(results));
  }
  expectNoPageErrors(errors);
});

// R2: dragging the handle into the gutter. The indicator during the drag is drawn by DropCursor from `posAtCoords` + `dropPoint`; if the drop target's parent is the row at drop time, the coordinate is first rewritten to the nearest
// block of the nearest column. The two can differ (the indicator drawn below the row while the block goes into a column), and Chromium's `posAtCoords` in the gutter at the same point sometimes lands in a column and sometimes between
// two columns, so the drop target moves too. Asserted: every point has a drop, z ends up in one of the row's columns (not left outside the row), and there is no pageerror.
// The comparison of indicator and drop target is only recorded: each point's `posAtCoords`, the indicator before release, and the document and block boxes after the drop.
test("R2 handle dragged into the gutter: every point can be dropped and z ends up in one of the row's columns; indicator position and actual drop target are recorded", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = await startNote(page, "r2");
  await pasteMarkdown(page, rowDoc(["a\n\na2\n\na3", "b"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(paragraph:a,paragraph:a2,paragraph:a3) | COL(paragraph:b)]");
  const original = await docShape(page);
  const results: unknown[] = [];
  try {
    for (const where of ["a-level", "b-lower", "a3-level", "a3-level-near-col2"] as const) {
      const { cols } = await rowGeometry(page);
      const a = (await blockOuter(page, "a").boundingBox())!;
      const b = (await blockOuter(page, "b").boundingBox())!;
      const a3 = (await blockOuter(page, "a3").boundingBox())!;
      const col1Right = cols[0]!.x + cols[0]!.width;
      const x = where === "a3-level-near-col2" ? col1Right + COLUMN_GAP_PX - 6 : col1Right + COLUMN_GAP_PX / 2;
      const y = where === "a-level" ? a.y + a.height * 0.25 : where === "b-lower" ? b.y + b.height * 0.75 : a3.y + a3.height / 2;
      const probe = await probeDrop(page, "z", { x, y }, original, "x");
      results.push({ where, cols, ...probe });
      expect((probe.events as Record<string, number>).drop, `${where}：有 drop`).toBeGreaterThanOrEqual(1);
      const after = probe.after as string;
      expect(columnsOf(after).some((c) => c.includes("paragraph:z")), `${where}：z 在列裡 ${after}`).toBe(true);
      expect(after, `${where}：列外沒有 z`).not.toMatch(/(^|\s{2})paragraph:z(\s{2}|$)/);
    }
  } finally {
    test.info().annotations.push({ type: "gutter-guide-vs-landing", description: JSON.stringify(results) });
    console.log("R2=" + JSON.stringify(results));
  }
  expectNoPageErrors(errors);
});

async function rowBlocks(page: Page): Promise<Array<Array<{ id: string; rect: Rect }>>> {
  return editorLocator(page)
    .locator(ROW)
    .first()
    .evaluate((row) =>
      Array.from(row.querySelectorAll(':scope > [data-node-type="column"]')).map((col) =>
        Array.from(col.querySelectorAll(":scope > .bn-block-outer")).map((b) => {
          const r = b.getBoundingClientRect();
          return { id: b.getAttribute("data-id") ?? "", rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
        }),
      ),
    );
}

// R3: dropping a file-only drag in the gutter (between columns). Chromium's `posAtCoords` in the gutter sometimes lands in a column and sometimes between two columns (the parent is the row);
// the expectation follows the value just before the drop: between two columns -> the vertically nearest block in the column chosen by the coordinate-rewriting rule (horizontal then vertical distance); in a column ->
// the block containing `posAtCoords` (or the blocks before and after it at column level). The new image block must be adjacent to an expected block; no pageerror, and dragover is accepted.
test("R3 file dragged into the gutter (no handle): no pageerror, the image is adjacent to the block chosen by the coordinate-rewriting rule or the one `posAtCoords` points to", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = await startNote(page, "r3");
  await pasteMarkdown(page, rowDoc(["a\n\na2\n\na3", "b"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(paragraph:a,paragraph:a2,paragraph:a3) | COL(paragraph:b)]");
  const results: unknown[] = [];
  try {
    // Move the mouse away so the handle does not cover the gutter.
    await page.mouse.move(5, 5);
    for (const where of ["center-a-level", "near-col1-a2", "near-col2-b-level", "near-col2-below-b"] as const) {
      const { cols } = await rowGeometry(page);
      const a = (await blockOuter(page, "a").boundingBox())!;
      const a2 = (await blockOuter(page, "a2").boundingBox())!;
      const a3 = (await blockOuter(page, "a3").boundingBox())!;
      const b = (await blockOuter(page, "b").boundingBox())!;
      const col1Right = cols[0]!.x + cols[0]!.width;
      const p =
        where === "center-a-level"
          ? { x: col1Right + COLUMN_GAP_PX / 2, y: a.y + a.height * 0.25 }
          : where === "near-col1-a2"
            ? { x: col1Right + 8, y: a2.y + a2.height * 0.75 }
            : where === "near-col2-b-level"
              ? { x: col1Right + COLUMN_GAP_PX - 8, y: b.y + b.height * 0.75 }
              : { x: col1Right + COLUMN_GAP_PX - 8, y: a3.y + a3.height / 2 };
      const before = await docShape(page);
      const blocks = await rowBlocks(page);
      const known = new Set(blocks.flat().map((b) => b.id));
      const hit = await hitAt(page, p);
      const result = await dropFileAt(page, p, grayPng(40, 40));
      const pos = result.pos;
      expect(pos, `${where}：放下前 posAtCoords 有結果`).not.toBeNull();
      const expectedBlocks =
        pos!.parent === "columnList"
          ? expectedColumns(cols, p, pos!).map((k) => nearestBlockByY(blocks[k] ?? [], p.y))
          : [pos!.block, pos!.before, pos!.after];
      const expected = expectedBlocks.filter((id): id is string => !!id);
      let neighbours: string[] = [];
      await expect(async () => {
        const now = await rowBlocks(page);
        const column = now.find((c) => c.some((b) => !known.has(b.id)));
        expect(column, "新的 block 在列裡").toBeDefined();
        const i = column!.findIndex((b) => !known.has(b.id));
        neighbours = [column![i - 1]?.id, column![i + 1]?.id].filter((id): id is string => !!id);
      }).toPass({ timeout: 15_000 });
      const after = await docShape(page);
      results.push({ where, p, pos, hit, expected, neighbours, result, before, after });
      expect(result.overPrevented, "dragover 被接受").toBe(true);
      expect(after.split("image").length, "多一個圖片 block").toBe(before.split("image").length + 1);
      expect(expected.length, `${where}：預期的 block ${JSON.stringify(pos)}`).toBeGreaterThan(0);
      expect(neighbours.filter((id) => expected.includes(id)), `${where}：緊鄰預期的 block`).not.toEqual([]);
    }
  } finally {
    test.info().annotations.push({ type: "gutter-file-drop", description: JSON.stringify(results) });
    console.log("R3=" + JSON.stringify(results));
  }
  expectNoPageErrors(errors);
});

// R4: the pointer in a column's left/right edge zone, right against the gutter (0-3px from the column boundary). Chromium's `posAtCoords` at these points lands in that column's paragraph (the parent is not the row),
// so the gutter coordinate-rewriting path is never reached; what this checks is the outcome: every point has a drop, the vertical indicator is on that side, and dropping creates a new column instead of being turned into a horizontal-line drop into the nearest block.
test("R4 column left/right edge zone right against the gutter: the vertical indicator is on that side and dropping creates a new column [a|z|b], not turned into a horizontal-line drop", async ({ page }) => {
  test.setTimeout(240_000);
  const errors = await startNote(page, "r4");
  await pasteMarkdown(page, rowDoc(["a", "b"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(paragraph:a) | COL(paragraph:b)]");
  const original = await docShape(page);
  const results: unknown[] = [];
  try {
    for (const [label, dx] of [
      ["col2-left+3", 3],
      ["col2-left+1", 1],
      ["col2-left+0", 0],
      ["col1-right-0", -0.001],
      ["col1-right-1", -1],
      ["col1-right-3", -3],
    ] as const) {
      const { cols } = await rowGeometry(page);
      const b = (await blockOuter(page, "b").boundingBox())!;
      const x = dx >= 0 ? cols[1]!.x + dx : cols[0]!.x + cols[0]!.width + Math.round(dx);
      const probe = await probeDrop(page, "z", { x, y: b.y + b.height / 2 }, original, "x");
      results.push({ label, cols, ...probe });
      expect((probe.events as Record<string, number>).drop, `${label}：有 drop`).toBeGreaterThanOrEqual(1);
      const side = dx >= 0 ? "left" : "right";
      expect((probe.cursor as { classes: string } | null)?.classes ?? "", `${label}：提示線`).toContain(`prosemirror-dropcursor-block-vertical-${side}`);
      expect(probe.after, `${label}：放下的結果`).toBe("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:z) | COL(paragraph:b)]");
    }
  } finally {
    test.info().annotations.push({ type: "edge-zone-next-to-gutter", description: JSON.stringify(results) });
    console.log("R4=" + JSON.stringify(results));
  }
  expectNoPageErrors(errors);
});

// R5: when a handle drag starts, core selects the dragged block and the format toolbar appears right above it, covering the left half of the previous block. During the drag the toolbar (and the floating-ui
// wrapper around it) does not take the pointer, so the release point hits the block underneath and the drop happens as usual. First assert the toolbar really covers the release point.
// The toolbar is on screen only briefly after the drag starts (appears after about 25ms and is gone after about 250ms), so this moves to the end point in one step and releases as soon as it appears.
test("R5 x y z: dragging z to the left edge of y directly above (format toolbar covering it) -> the release point hits y and creates the row [z|y]", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "r5");
  await pasteMarkdown(page, "x\n\ny\n\nz\n");
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("paragraph:x  paragraph:y  paragraph:z");
  await resetDragLog(page);
  const box = (await blockOuter(page, "y").boundingBox())!;
  const p = { x: box.x + 8, y: box.y + box.height / 2 };
  let during: unknown = null;
  await dragHandleTo(page, blockOuter(page, "z"), "z", p, {
    steps: 1,
    beforeUp: async () => {
      await expect(page.locator(".bn-formatting-toolbar"), "前提：拖曳中有格式工具列").toBeVisible({ timeout: 1_000 });
      during = await page.evaluate((pt) => {
        const el = document.elementFromPoint(pt.x, pt.y);
        const toolbar = document.querySelector(".bn-formatting-toolbar");
        const bar = toolbar?.getBoundingClientRect();
        // The marker goes on floating-ui's wrapper (the layer that takes the drop), not on the toolbar itself.
        const marked = toolbar?.closest("[data-kb-formatting-toolbar-popover]") ?? null;
        return {
          hit: el ? `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}` : "none",
          onToolbar: !!el?.closest(".bn-formatting-toolbar, [data-kb-formatting-toolbar-popover]"),
          toolbar: bar ? { x: bar.x, y: bar.y, right: bar.right, bottom: bar.bottom } : null,
          markerOnFloatingWrapper: !!marked && marked !== toolbar && marked.hasAttribute("data-floating-ui-focusable"),
          markerPointerEvents: marked ? getComputedStyle(marked).pointerEvents : null,
        };
      }, p);
    },
  });
  await expect.poll(() => docShape(page), { message: "放下後建列" }).toContain("paragraph:x  ROW[COL(paragraph:z) | COL(paragraph:y)]");
  const record = { p, target: box, during, events: await dragLog(page), after: await docShape(page) };
  test.info().annotations.push({ type: "formatting-toolbar-over-drop-point", description: JSON.stringify(record) });
  const seen = during as unknown as {
    onToolbar: boolean;
    toolbar: { x: number; y: number; right: number; bottom: number } | null;
    markerOnFloatingWrapper: boolean;
    markerPointerEvents: string | null;
  };
  const bar = seen.toolbar;
  expect(bar, "前提：拖曳中有格式工具列").not.toBeNull();
  expect(seen.markerOnFloatingWrapper, "標記在 floating-ui 的包裝層上").toBe(true);
  expect(seen.markerPointerEvents, "拖放中包裝層不吃指標").toBe("none");
  expect(p.x >= bar!.x && p.x <= bar!.right && p.y >= bar!.y && p.y <= bar!.bottom, `前提：工具列蓋住放開的點 ${JSON.stringify(record)}`).toBe(true);
  expect(seen.onToolbar, "放開點不命中工具列").toBe(false);
  expect(record.events.drop, "有 drop").toBeGreaterThanOrEqual(1);
  expect(record.after).toContain("paragraph:x  ROW[COL(paragraph:z) | COL(paragraph:y)]");
  expectNoPageErrors(errors);
});

/** Separator between columns (the page also has the sidebar's `Resize sidebar` separator, so scope to the overlay). */
const DIVIDER = '.kb-column-dividers [role="separator"]';

function divider(page: Page, index = 0): Locator {
  return page.locator(DIVIDER).nth(index);
}

async function docWidths(page: Page): Promise<number[]> {
  return editorLocator(page).evaluate((el) => {
    type PmNode = { type: { name: string }; attrs: { width?: number }; childCount: number; child(i: number): PmNode };
    type View = { state: { doc: { descendants(f: (n: PmNode) => boolean | void): void } } };
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

async function resetYUpdates(page: Page): Promise<void> {
  await editorLocator(page).evaluate((el) => {
    type YDoc = { on(ev: "update", f: () => void): void };
    type Plugin = { key: string; getState(s: unknown): { doc?: YDoc } | undefined };
    const view = (el as Element & { editor?: { view?: { state: { plugins: Plugin[] } } } }).editor!.view!;
    const w = window as unknown as { kbYUpdates?: number; kbYDoc?: YDoc };
    w.kbYUpdates = 0;
    const doc = view.state.plugins.find((p) => String(p.key).startsWith("y-sync$"))!.getState(view.state)!.doc!;
    if (w.kbYDoc === doc) return;
    w.kbYDoc = doc;
    doc.on("update", () => void (w.kbYUpdates = (w.kbYUpdates ?? 0) + 1));
  });
}

const yUpdates = (page: Page) => page.evaluate(() => (window as unknown as { kbYUpdates?: number }).kbYUpdates ?? 0);

async function dragState(page: Page): Promise<{ userSelect: string; dragging: number; preview: number }> {
  return page.evaluate(
    (sel) => ({
      userSelect: document.body.style.userSelect,
      dragging: document.querySelectorAll(`${sel}[data-dragging]`).length,
      preview: document.querySelectorAll("style[data-kb-col-preview]").length,
    }),
    DIVIDER,
  );
}

const IDLE = { userSelect: "", dragging: 0, preview: 0 };

/**
 * Presses the center of the hit area of separator `index`, moves `dx` horizontally in 10 steps, then releases; `beforeUp` is called before release. Before pressing, move once over the hit area:
 * the separator re-measures its position on `pointerenter`, and a `pointerdown` right after the position changed does not start a drag.
 */
async function dragDivider(page: Page, dx: number, opts: { index?: number; beforeUp?: () => Promise<void> } = {}): Promise<void> {
  const box = (await divider(page, opts.index).boundingBox())!;
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y - 2);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await moveInSteps(page, start, { x: start.x + dx, y: start.y }, 10);
  await opts.beforeUp?.();
  await page.mouse.up();
}

type HitKind = { separator: boolean; sideMenuButton: boolean; menuItem: string | null; extend: boolean; desc: string };

async function hitKind(page: Page, p: Point): Promise<HitKind> {
  return page.evaluate(
    ({ pt, sel }) => {
      const el = document.elementFromPoint(pt.x, pt.y);
      const item = el?.closest(".bn-suggestion-menu-item");
      const cls = el ? (el.getAttribute("class") ?? "") : "";
      return {
        separator: !!el?.closest(sel),
        sideMenuButton: !!el?.closest("[data-kb-column-side-menu] button"),
        menuItem: item ? (item.textContent ?? "").trim() : null,
        extend: !!el?.closest(".bn-extend-button-add-remove-columns"),
        desc: el ? `${el.tagName.toLowerCase()}.${cls.slice(0, 60)}` : "none",
      };
    },
    { pt: p, sel: DIVIDER },
  );
}

async function leftShare(page: Page): Promise<number> {
  const { cols } = await rowGeometry(page);
  return cols[0]!.width / (cols[0]!.width + cols[1]!.width);
}

function figure(url: string, width: number): string {
  return `<figure><img alt="pic" src="${url}" width="${width}"></figure>`;
}

const toRect = (b: { x: number; y: number; width: number; height: number }): Rect => ({ x: b.x, y: b.y, width: b.width, height: b.height });

const inlineOf = (page: Page, text: string): Locator => blockOuter(page, text).locator(".bn-inline-content").first();

test("[text|text] dragging the separator until the left column hits 200px stops there, releasing writes the column widths once, and Ctrl+Z without clicking back into the editor undoes it; [image|text] narrowing the image column shrinks the image and dragging back restores previewWidth", async ({ page }) => {
  test.setTimeout(150_000);
  const errors = await startNote(page, "p6");
  await pasteMarkdown(page, rowDoc(["a", "b"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b)]  paragraph:z");
  await expect(divider(page)).toHaveCount(1);
  expect(await docWidths(page)).toEqual([1, 1]);
  const before = (await rowGeometry(page)).cols;
  const record: Record<string, unknown> = { before };

  // Start counting Y updates only after the paste's transactions have settled: two reads of the document shape 300 ms apart are the same.
  await expect
    .poll(async () => {
      const first = await docShape(page);
      await page.waitForTimeout(300);
      return first === (await docShape(page));
    })
    .toBe(true);
  await resetYUpdates(page);
  // Drag 150px past what the left column can give: it stops at the 200px text-column minimum.
  await dragDivider(page, -(before[0]!.width - 200) - 150, {
    beforeUp: async () => {
      const during = { cols: (await rowGeometry(page)).cols, widths: await docWidths(page), updates: await yUpdates(page), state: await dragState(page) };
      record.during = during;
      expect(during.widths, "拖曳中文件不變").toEqual([1, 1]);
      expect(during.updates, "拖曳中沒有 Y update").toBe(0);
      expect(during.state, "拖曳中 body 不能選字、預覽表在").toEqual({ userSelect: "none", dragging: 1, preview: 1 });
      expect(during.cols[0]!.width, "左欄停在文字欄最小寬度").toBeGreaterThanOrEqual(COLUMN_MIN_TEXT_PX - ratioQuantPx(during.cols));
      expect(during.cols[0]!.width).toBeLessThanOrEqual(COLUMN_MIN_TEXT_PX + ratioQuantPx(during.cols));
    },
  });
  await expect.poll(() => docWidths(page)).not.toEqual([1, 1]);
  const written = await docWidths(page);
  const after = (await rowGeometry(page)).cols;
  record.written = written;
  record.after = after;
  expect(written[0]!).toBeLessThan(written[1]!);
  expect(Math.round((written[0]! + written[1]!) * 100) / 100).toBe(2);
  expect(after[0]!.width, "放開後左欄仍是文字欄最小寬度").toBeGreaterThanOrEqual(COLUMN_MIN_TEXT_PX - ratioQuantPx(after));
  expect(after[0]!.width).toBeLessThanOrEqual(COLUMN_MIN_TEXT_PX + ratioQuantPx(after));
  expect(await dragState(page), "放開後清掉預覽與 user-select").toEqual(IDLE);
  // The write happens once: one Y update at release and none afterwards.
  await page.waitForTimeout(500);
  record.updates = await yUpdates(page);
  expect(record.updates, "放開後恰一次 Y update").toBe(1);
  expect(await docWidths(page)).toEqual(written);

  // Pressing on the separator does not steal focus: without clicking back into the editor, Ctrl+Z undoes this resize directly.
  record.focusInEditor = await editorLocator(page).evaluate((el) => el.contains(document.activeElement));
  expect(record.focusInEditor, "拖完焦點仍在編輯器").toBe(true);
  await page.keyboard.press("Control+z");
  await expect.poll(() => docWidths(page)).toEqual([1, 1]);
  await expect.poll(() => leftShare(page)).toBeCloseTo(0.5, 2);

  await createNote(page, `E2E columns drag p6-image ${RUN}`);
  const url = await uploadPng(page, 600, 300);
  await pasteMarkdown(page, rowDoc([figure(url, 300), "right text"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(image) | COL(paragraph:right text)]");
  const img = editorLocator(page).locator(`img[src*="${url}"]`);
  await waitImageLoaded(img);
  const imageBlock = editorLocator(page).locator('[data-content-type="image"]');
  await expect(imageBlock).toHaveAttribute("data-preview-width", "300");
  await expect(divider(page)).toHaveCount(1);
  const imgBefore = (await img.boundingBox())!.width;
  const colBefore = (await rowGeometry(page)).cols[0]!.width;
  const image: Record<string, unknown> = { imgBefore, colBefore };
  record.image = image;
  expect(Math.abs(imgBefore - 300), "前提：圖片顯示 300px").toBeLessThanOrEqual(0.5);
  expect(colBefore, "前提：左欄比圖片寬").toBeGreaterThan(300);

  await dragDivider(page, 150 - colBefore);
  await expect.poll(async () => (await rowGeometry(page)).cols[0]!.width).toBeLessThan(160);
  image.narrowCol = (await rowGeometry(page)).cols[0]!.width;
  image.narrowImg = (await img.boundingBox())!.width;
  expect(image.narrowImg as number, "欄變窄、圖片跟著變窄").toBeLessThan(imgBefore);
  expect(image.narrowImg as number).toBeLessThanOrEqual((image.narrowCol as number) + 0.5);
  await expect(imageBlock, "previewWidth 不變").toHaveAttribute("data-preview-width", "300");

  await dragDivider(page, colBefore - (image.narrowCol as number));
  await expect.poll(async () => Math.abs((await rowGeometry(page)).cols[0]!.width - colBefore)).toBeLessThanOrEqual(1);
  await expect.poll(async () => Math.abs((await img.boundingBox())!.width - 300), { message: "圖片長回 previewWidth" }).toBeLessThanOrEqual(0.5);
  image.backImg = (await img.boundingBox())!.width;
  test.info().annotations.push({ type: "divider-drag-measurements", description: JSON.stringify(record) });
  expectNoPageErrors(errors);
});

test("an image above the row loads late and pushes the row down (columnEl height unchanged): the separator moves down with it and stays at the left column's right edge; pressing at the old position does not start a drag and clicking back into the text puts the caret in", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "p6b");
  const url = await uploadPng(page, 400, 200);
  // The image response is released by the test: measure the layout once before releasing (the image has no height yet) and once after.
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    (u) => u.pathname === url,
    async (route) => {
      await released;
      await route.continue();
    },
  );
  await pasteMarkdown(page, [`![late](${url})`, "", columnsMarkdown(["a", "b"]), ""].join("\n"));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("image  ROW[COL(paragraph:a) | COL(paragraph:b)]");
  await expect(divider(page)).toHaveCount(1);
  // Move the mouse away: sliding over the separator triggers its re-measure, and what is measured here is ResizeObserver catching up on its own.
  await page.mouse.move(5, 5);
  const measure = () =>
    page.evaluate((sel) => {
      const r = (e: Element | null | undefined) => {
        const b = e!.getBoundingClientRect();
        return { x: b.x, y: b.y, width: b.width, height: b.height };
      };
      const row = document.querySelector('[data-node-type="columnList"]');
      return {
        sep: r(document.querySelector(sel)),
        row: r(row),
        col1: r(row!.querySelector('[data-node-type="column"]')),
        columnEl: r(document.querySelector(".kb-column-dividers")!.parentElement),
        natural: (document.querySelector(".bn-editor img") as HTMLImageElement | null)?.naturalWidth ?? -1,
      };
    }, DIVIDER);
  const before = await measure();
  expect(before.natural, "前提：圖片還沒載入").toBe(0);
  expect(Math.abs(before.sep.x - (before.col1.x + before.col1.width))).toBeLessThanOrEqual(1);

  release();
  await waitImageLoaded(editorLocator(page).locator(`img[src*="${url}"]`));
  await expect.poll(async () => (await measure()).row.y - before.row.y, { message: "前提：列被圖片往下推" }).toBeGreaterThan(100);
  let after = await measure();
  try {
    await expect(async () => {
      after = await measure();
      expect(Math.abs(after.sep.x - (after.col1.x + after.col1.width)), JSON.stringify(after)).toBeLessThanOrEqual(1);
      expect(Math.abs(after.sep.y - after.row.y), JSON.stringify(after)).toBeLessThanOrEqual(1);
      expect(after.sep.width).toBe(8);
    }).toPass({ timeout: 5_000 });
  } finally {
    test.info().annotations.push({ type: "late-image-divider", description: JSON.stringify({ before, after }) });
  }
  expect(Math.abs(after.columnEl.height - before.columnEl.height), "前提：columnEl 高度不變").toBeLessThanOrEqual(0.5);

  const old = { x: before.sep.x + before.sep.width / 2, y: before.sep.y + before.sep.height / 2 };
  expect((await hitKind(page, old)).separator, "原位置不再命中分隔線").toBe(false);
  await page.mouse.move(old.x, old.y);
  await page.mouse.down();
  const pressed = await dragState(page);
  await page.mouse.up();
  expect(pressed, "在原位置按下沒有開始拖分隔線").toEqual(IDLE);

  // That press selected the image and the image toolbar covers the top of the left column, so click the right column's text.
  await clickEndOfParagraph(page, inlineOf(page, "b"));
  expect(await dragState(page)).toEqual(IDLE);
  expect(await docWidths(page)).toEqual([1, 1]);
  expectNoPageErrors(errors);
});

test("focusing the separator and pressing Right twice raises the left column's share by about 10% and narrows the right column; back in the editor one Ctrl+Z undoes it; one Left lowers the left share by about 5% [sc:columnResizeKeys]", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "p7");
  await pasteMarkdown(page, rowDoc(["a", "b"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(paragraph:a) | COL(paragraph:b)]");
  await expect(divider(page)).toHaveCount(1);
  const share0 = await leftShare(page);
  const right0 = (await rowGeometry(page)).cols[1]!.width;
  expect(share0).toBeCloseTo(0.5, 2);

  await divider(page).focus();
  // No waiting between the two presses: they fall within the undo merge window.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => leftShare(page)).toBeGreaterThan(share0 + 0.09);
  const share2 = await leftShare(page);
  expect(Math.abs(share2 - share0 - 0.1), `左欄比例 ${share0} → ${share2}`).toBeLessThanOrEqual(0.01);
  expect((await rowGeometry(page)).cols[1]!.width, "右欄變窄").toBeLessThan(right0);
  const written = await docWidths(page);
  expect(written).not.toEqual([1, 1]);

  await clickEndOfParagraph(page, inlineOf(page, "a"));
  await page.keyboard.press("Control+z");
  await expect.poll(() => docWidths(page), { message: "一次 Ctrl+Z 還原兩次按鍵" }).toEqual([1, 1]);
  await expect.poll(() => leftShare(page)).toBeCloseTo(0.5, 2);

  await divider(page).focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => leftShare(page)).toBeLessThan(share0 - 0.04);
  const shareLeft = await leftShare(page);
  expect(Math.abs(share0 - shareLeft - 0.05), `左欄比例 ${share0} → ${shareLeft}`).toBeLessThanOrEqual(0.01);
  test.info().annotations.push({ type: "divider-keyboard", description: JSON.stringify({ share0, share2, written, shareLeft }) });
  expectNoPageErrors(errors);
});

test("[image|text] dragging the image's right handle: first it grows inside the column, past the column width the text column narrows until it stops at 200px; after release one Ctrl+Z undoes both the image width and the column width", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "p8");
  const url = await uploadPng(page, 1200, 300);
  await pasteMarkdown(page, rowDoc([figure(url, 200), "right text"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(image) | COL(paragraph:right text)]");
  const img = editorLocator(page).locator(`img[src*="${url}"]`);
  await waitImageLoaded(img);
  const imageBlock = editorLocator(page).locator('[data-content-type="image"]');
  await expect(imageBlock).toHaveAttribute("data-preview-width", "200");
  const before = (await rowGeometry(page)).cols;
  const ck = await imageBlock.evaluate((el) => (el.closest(".bn-block-content") as HTMLElement).clientWidth);
  const record: Record<string, unknown> = { before, ck };
  const snap = async () => ({ img: (await img.boundingBox())!.width, cols: (await rowGeometry(page)).cols });

  try {
    await img.hover();
    const handle = imageBlock.locator(".bn-resize-handle").nth(1); // the second one is the right handle
    await expect(handle).toBeVisible();
    const h = (await handle.boundingBox())!;
    const start = { x: h.x + h.width / 2, y: h.y + h.height / 2 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();

    const inside = { x: start.x + 40, y: start.y };
    await moveInSteps(page, start, inside, 5);
    const step1 = await snap();
    record.inside = step1;
    expect(Math.abs(step1.img - 240), "欄內先變大").toBeLessThanOrEqual(1);
    expect(Math.abs(step1.cols[1]!.width - before[1]!.width), "欄內時文字欄不變").toBeLessThanOrEqual(0.5);

    // 60px past the available width: the text column gives up 60px.
    const over = { x: start.x + (ck - 200) + 60, y: start.y };
    await moveInSteps(page, inside, over, 10);
    const step2 = await snap();
    record.over = step2;
    expect(step2.cols[1]!.width, "超過欄寬後文字欄變窄").toBeLessThan(before[1]!.width - 50);
    expect(step2.cols[0]!.width, "圖片欄變寬").toBeGreaterThan(before[0]!.width + 50);

    // Far right: the text column stops at 200px.
    const far = { x: over.x + 600, y: start.y };
    await moveInSteps(page, over, far, 10);
    const step3 = await snap();
    await moveInSteps(page, far, { x: far.x + 100, y: start.y }, 2);
    const step4 = await snap();
    record.far = { step3, step4 };
    expect(step3.cols[1]!.width, "文字欄停在最小寬度").toBeGreaterThanOrEqual(COLUMN_MIN_TEXT_PX - ratioQuantPx(step3.cols));
    expect(step3.cols[1]!.width).toBeLessThanOrEqual(COLUMN_MIN_TEXT_PX + ratioQuantPx(step3.cols));
    expect(Math.abs(step4.img - step3.img), "再拉也不變").toBeLessThanOrEqual(0.5);
    await page.mouse.up();

    await expect.poll(() => docWidths(page)).not.toEqual([1, 1]);
    const written = { widths: await docWidths(page), previewWidth: await imageBlock.getAttribute("data-preview-width") };
    record.written = written;
    const afterUp = (await rowGeometry(page)).cols;
    // previewWidth is computed from the pre-rounding `ck + granted`, while columns lay out by the rounded ratios and clamp the image within the column width; the difference is at most the pixel width of one ratio step.
    expect(Math.abs(Number(written.previewWidth) - step4.img), "寫入的 previewWidth＝放開時的圖寬").toBeLessThanOrEqual(
      Math.max(1, ratioQuantPx(afterUp)),
    );
    expect(afterUp[1]!.width, "放開後文字欄仍是最小寬度").toBeGreaterThanOrEqual(COLUMN_MIN_TEXT_PX - ratioQuantPx(afterUp));
    expect(afterUp[1]!.width).toBeLessThanOrEqual(COLUMN_MIN_TEXT_PX + ratioQuantPx(afterUp));
  } finally {
    test.info().annotations.push({ type: "image-expands-column", description: JSON.stringify(record) });
  }

  await clickEndOfParagraph(page, inlineOf(page, "right text"));
  await page.keyboard.press("Control+z");
  await expect.poll(() => docWidths(page), { message: "一次 Ctrl+Z 還原欄寬" }).toEqual([1, 1]);
  await expect(imageBlock, "同一次 Ctrl+Z 還原圖寬").toHaveAttribute("data-preview-width", "200");
  await expect.poll(async () => Math.abs((await img.boundingBox())!.width - 200)).toBeLessThanOrEqual(0.5);
  expectNoPageErrors(errors);
});

test("separator and column 2's handle: the button is <= 16 wide, they don't overlap, the handle's right edge touches column 2's left edge; with the handle shown the hit area still hits the separator and can be dragged; the handle can be clicked and dragged", async ({ page }) => {
  test.setTimeout(150_000);
  const errors = await startNote(page, "p9");
  await pasteMarkdown(page, rowDoc(["a", "b"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("paragraph:x  ROW[COL(paragraph:a) | COL(paragraph:b)]  paragraph:z");
  await expect(divider(page)).toHaveCount(1);
  const v: Record<string, unknown> = {};
  try {
    const { menu } = await hoverForSideMenu(page, blockOuter(page, "b"), "b");
    const button = page.locator("[data-kb-column-side-menu]").getByRole("button", { name: "Open block menu" });
    await expect(button).toBeVisible();
    const btn = toRect((await button.boundingBox())!);
    const sep = toRect((await divider(page).boundingBox())!);
    const { row, cols } = await rowGeometry(page);
    const midY = row.y + row.height / 2;
    const hits: Array<{ p: Point } & HitKind> = [];
    for (let dx = 0.5; dx < sep.width; dx++) {
      const p = { x: sep.x + dx, y: midY };
      hits.push({ p, ...(await hitKind(page, p)) });
    }
    Object.assign(v, { btn, sideMenu: menu, sep, cols, hits });
    expect(btn.width, "⋮⋮ 按鈕寬 ≤ 16").toBeLessThanOrEqual(16.01);
    expect(Math.abs(sep.x - (cols[0]!.x + cols[0]!.width)), "命中區左緣＝左欄右緣").toBeLessThanOrEqual(1);
    expect(sep.width).toBe(8);
    expect(Math.abs(menu.x + menu.width - cols[1]!.x), "⋮⋮ 右緣貼右欄左緣").toBeLessThanOrEqual(1);
    // The side menu's popover is positioned by an integer-pixel translate (floating-ui rounds by devicePixelRatio); when the relative columnEl's left edge has a fraction,
    // the handle can sit up to 0.5px further left than column 2's left edge and cover the rightmost pixel column of the hit area (the side menu's z-index is above the separator overlay).
    expect(btn.x, "⋮⋮ 按鈕最多蓋到命中區 0.5px").toBeGreaterThanOrEqual(sep.x + sep.width - 0.5);
    for (const h of hits.slice(0, -1)) expect(h.separator, `⋮⋮ 顯示中命中區 ${JSON.stringify(h)}`).toBe(true);
  } finally {
    test.info().annotations.push({ type: "divider-vs-side-menu", description: JSON.stringify(v) });
    console.log("P9=" + JSON.stringify(v));
  }

  const band = (await divider(page).boundingBox())!;
  await page.mouse.move(band.x + band.width / 2, band.y + band.height / 2);
  await expect(page.locator("[data-kb-column-side-menu]").getByRole("button", { name: "Open block menu" })).toBeVisible();
  await dragDivider(page, -60);
  await expect.poll(() => docWidths(page)).not.toEqual([1, 1]);
  await clickEndOfParagraph(page, inlineOf(page, "a"));
  await page.keyboard.press("Control+z");
  await expect.poll(() => docWidths(page)).toEqual([1, 1]);

  await hoverForSideMenu(page, blockOuter(page, "b"), "b");
  await page.locator("[data-kb-column-side-menu]").getByRole("button", { name: "Open block menu" }).click();
  await expect(page.getByRole("menuitem", { name: "Ungroup columns" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem", { name: "Ungroup columns" })).toBeHidden();

  await dragBlockBelow(page, "b", "z");
  await expect.poll(() => docShape(page)).toContain("ROW[COL(paragraph:a) | COL(paragraph)]  paragraph:z  paragraph:b");
  expect(await docWidths(page)).toEqual([1, 1]);
  expectNoPageErrors(errors);
});

test("typing / in a block at the right of column 1 lets the menu cover the gutter: the hit-area point hits the menu item, clicking applies the menu item and does not start a separator drag", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "p9b");
  // Put six paragraphs in column 2 so the row (and thus the separator hit area) is taller than where the menu items are.
  await pasteMarkdown(page, rowDoc(["a", "b\n\nb2\n\nb3\n\nb4\n\nb5\n\nb6"]));
  await expect
    .poll(() => docShape(page), { timeout: 15_000 })
    .toContain("ROW[COL(paragraph:a) | COL(paragraph:b,paragraph:b2,paragraph:b3,paragraph:b4,paragraph:b5,paragraph:b6)]");
  await expect(divider(page)).toHaveCount(1);
  const { cols } = await rowGeometry(page);
  const col1Right = cols[0]!.x + cols[0]!.width;
  await clickEndOfParagraph(page, inlineOf(page, "a"));
  // Type so the caret is near column 1's right edge (without wrapping); the menu opens rightwards from the caret and covers the gutter.
  const caret = () =>
    page.evaluate(() => {
      const r = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
      return { x: r.x, y: r.y };
    });
  const y0 = (await caret()).y;
  for (let i = 0; i < 120 && (await caret()).x < col1Right - 120; i++) await page.keyboard.type("m");
  expect(Math.abs((await caret()).y - y0), "前提：沒有換行").toBeLessThanOrEqual(1);
  await page.keyboard.type(" /heading");
  const item = page.locator(".bn-suggestion-menu-item").filter({ hasText: "Heading 1" }).first();
  await expect(item).toBeVisible();
  const box = toRect((await item.boundingBox())!);
  const sep = toRect((await divider(page).boundingBox())!);
  const p = { x: sep.x + sep.width / 2, y: box.y + box.height / 2 };
  const hit = await hitKind(page, p);
  test.info().annotations.push({ type: "slash-menu-over-divider", description: JSON.stringify({ item: box, sep, p, hit }) });
  expect(box.x <= p.x && p.x <= box.x + box.width, `前提：選單項蓋住命中區 ${JSON.stringify({ box, sep })}`).toBe(true);
  expect(p.y >= sep.y && p.y <= sep.y + sep.height, `前提：量的點在命中區的高度內 ${JSON.stringify({ p, sep })}`).toBe(true);
  expect(hit.separator, "命中的不是分隔線").toBe(false);
  expect(hit.menuItem, `命中選單項 ${hit.desc}`).toContain("Heading 1");

  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  const pressed = await dragState(page);
  await page.mouse.up();
  expect(pressed, "沒有開始拖分隔線").toEqual(IDLE);
  // After the menu closes the same point hits the separator: it hit the menu item just now because the menu was on top, not because that point had no separator.
  await expect(item).toBeHidden();
  await expect.poll(async () => (await hitKind(page, p)).separator, { message: "選單關掉後同一點命中分隔線" }).toBe(true);
  await expect.poll(() => docShape(page)).toMatch(/ROW\[COL\(paragraph:am+ ?,heading\) \| COL\(paragraph:b,paragraph:b2/);
  expect(await docWidths(page)).toEqual([1, 1]);
  expectNoPageErrors(errors);
});

test("hovering a table in column 1 shows the \"add a column\" extend button: measures its relation to the separator hit area (where they overlap, the overlap hits the extend button); clicking it adds a table column and does not start a separator drag", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "p9c");
  // Give a column width bigger than the column: the table stretches to the widest the column can hold, putting the extend button closest to the gutter.
  const table = '<table><tr><th colwidth="300">h1</th><th colwidth="300">h2</th></tr><tr><td>c1</td><td>c2</td></tr></table>';
  await pasteMarkdown(page, rowDoc([table, "b"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(table:h1h2c1c2) | COL(paragraph:b)]");
  await expect(divider(page)).toHaveCount(1);
  const headerCells = () => editorLocator(page).locator(`${ROW} table tr`).first().locator("th, td").count();
  expect(await headerCells()).toBe(2);
  await editorLocator(page).locator(`${ROW} table tr`).last().locator("td").last().hover();
  const extend = page.locator(".bn-extend-button-add-remove-columns");
  await expect(extend).toBeVisible();
  const ext = toRect((await extend.boundingBox())!);
  const sep = toRect((await divider(page).boundingBox())!);
  const { cols } = await rowGeometry(page);
  const y = ext.y + ext.height / 2;
  const overlap = { from: Math.max(ext.x, sep.x), to: Math.min(ext.x + ext.width, sep.x + sep.width) };
  const overlaps = overlap.to - overlap.from > 0.5;
  const probe = overlaps ? { x: (overlap.from + overlap.to) / 2, y } : { x: sep.x + sep.width / 2, y };
  const hit = await hitKind(page, probe);
  const record = { ext, sep, col1: cols[0], overlap, overlaps, probe, hit };
  test.info().annotations.push({ type: "table-extend-vs-divider", description: JSON.stringify(record) });
  console.log("P9c=" + JSON.stringify(record));
  if (overlaps) expect(hit.extend, `重疊處命中延伸鈕 ${hit.desc}`).toBe(true);
  else expect(hit.separator, `延伸鈕沒蓋到溝時，命中區仍命中分隔線 ${hit.desc}`).toBe(true);

  const target = overlaps ? probe : { x: ext.x + ext.width / 2, y };
  await page.mouse.move(target.x, target.y);
  await page.mouse.down();
  const pressed = await dragState(page);
  await page.mouse.up();
  expect(pressed, "沒有開始拖分隔線").toEqual(IDLE);
  await expect.poll(headerCells, { message: "表格多一欄" }).toBe(3);
  expect(await docWidths(page)).toEqual([1, 1]);
  expectNoPageErrors(errors);
});

test("file in the gutter (separator hit area): the hit area's center first hits the separator, after dragenter the same point hits the editor and dragover is accepted, dropping puts the image into the nearest column and the URL is unchanged", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "p10b");
  await pasteMarkdown(page, rowDoc(["a", "b"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(paragraph:a) | COL(paragraph:b)]");
  await expect(divider(page)).toHaveCount(1);
  const url = page.url();
  // Move the mouse away: the handle is not shown, so the hit-area point has only the separator.
  await page.mouse.move(5, 5);
  const sep = toRect((await divider(page).boundingBox())!);
  const b = (await blockOuter(page, "b").boundingBox())!;
  const p = { x: sep.x + 4, y: b.y + b.height / 2 };
  const before = await hitKind(page, p);
  expect(before.separator, `前提：命中區中心命中分隔線 ${before.desc}`).toBe(true);

  const { cols } = await rowGeometry(page);
  const result = await dropFileAt(page, p, grayPng(40, 40));
  expect(result.pos, "放下前 posAtCoords 有結果").not.toBeNull();
  const expected = expectedColumns(cols, p, result.pos!);
  test.info().annotations.push({ type: "gutter-file-drop-on-divider", description: JSON.stringify({ p, sep, cols, expected, result }) });
  expect(expected.length, `預期的欄 ${JSON.stringify(result.pos)}`).toBeGreaterThan(0);
  expect(result.afterEnterInEditor, `dragenter 之後命中 ${result.afterEnter}`).toBe(true);
  expect(result.overPrevented, "dragover 被接受").toBe(true);
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toMatch(/ROW\[COL\([^)]*image[^)]*\) \| COL\(paragraph:b\)\]|ROW\[COL\(paragraph:a\) \| COL\([^)]*image[^)]*\)\]/);
  const columns = columnsOf(await docShape(page));
  expect(expected, `圖片所在的欄 ${JSON.stringify(columns)}`).toContain(columns.findIndex((c) => c.includes("image")));
  expect(page.url()).toBe(url);
  expectNoPageErrors(errors);
});

/** Canonical form of a column opening tag (shared `canonicalColumnsLine`; e2e can't import shared, so change both together). */
const COLUMNS_OPEN_TAG = '<div data-kb-columns style="display:flex;gap:16px">';
const COLUMN_LINE_RE = /^<div data-kb-column style="flex:((?:0|[1-9][0-9]?)(?:\.[0-9]{1,2})?)">$/;

test("after dragging a separator, a REST read: the column opening tag is canonical and its values equal the document column widths; writing it back unchanged with replace_all gives 201, widths unchanged, and a re-read is byte-identical", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await startNote(page, "p11");
  const noteId = await noteIdFromUrl(page);
  await pasteMarkdown(page, rowDoc(["a", "b"]));
  await expect.poll(() => docShape(page), { timeout: 15_000 }).toContain("ROW[COL(paragraph:a) | COL(paragraph:b)]");
  await expect(divider(page)).toHaveCount(1);
  await dragDivider(page, -150);
  await expect.poll(() => docWidths(page)).not.toEqual([1, 1]);
  const widths = await docWidths(page);

  type Content = { markdown: string; fingerprint: string };
  const read = async (): Promise<Content> => {
    const res = await page.request.get(`/api/notes/${noteId}/content`);
    expect(res.status(), await res.text()).toBe(200);
    return (await res.json()) as Content;
  };
  const columnLines = (md: string) => md.split("\n").filter((l) => l.startsWith("<div data-kb-column"));
  // The resize reaches the server through collab with a delay: the server counts as having seen it once the widths read equal the document's values.
  let original!: Content;
  await expect(async () => {
    original = await read();
    expect(columnLines(original.markdown).slice(1).map((l) => Number(COLUMN_LINE_RE.exec(l)?.[1]))).toEqual(widths);
  }).toPass({ timeout: 20_000 });
  const lines = columnLines(original.markdown);
  test.info().annotations.push({ type: "columns-markdown-after-resize", description: JSON.stringify({ widths, lines }) });
  expect(lines).toHaveLength(3);
  expect(lines[0]).toBe(COLUMNS_OPEN_TAG);
  for (const l of lines.slice(1)) {
    const m = COLUMN_LINE_RE.exec(l);
    expect(m, `正規形 ${l}`).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(0.1);
    expect(Number(m![1])).toBeLessThanOrEqual(10);
  }

  const rowIdBefore = await editorLocator(page).locator(ROW).first().getAttribute("data-id");
  const same = await page.request.post(`/api/notes/${noteId}/edits`, {
    headers: { Origin: originOf(page) },
    data: { op: "replace_all", markdown: original.markdown, if_match: original.fingerprint },
  });
  expect(same.status(), await same.text()).toBe(201);
  // replace_all replaces every block's id: the row's data-id changing means the page received this write.
  await expect.poll(() => editorLocator(page).locator(ROW).first().getAttribute("data-id"), { timeout: 10_000 }).not.toBe(rowIdBefore);
  expect(await docWidths(page)).toEqual(widths);
  expect((await read()).markdown).toBe(original.markdown);
  expectNoPageErrors(errors);
});
