import { test, expect, type Page } from "@playwright/test";
import { E2E_ORIGIN } from "../ports.js";
import { ADMIN, createNote, editorLocator, loginAs } from "./helpers.js";

/**
 * Regression guard for issue #160: hovering a table adds a document-level scrollbar and shifts the layout.
 *
 * Cause (see the #160 comment on the centring wrapper in `NoteEditor.tsx`): BlockNote's table hover "add row / column"
 * buttons (`.bn-extend-button`) are mounted through FloatingPortal into `editor.portalElement`, and floating-ui defaults to
 * `position: absolute`. With no positioned ancestor, the containing block falls to `<html>` and passes through every
 * `overflow-hidden` / `overflow-y-auto`. It shows only when the **table's bottom (or right) edge is scrolled out of the
 * viewport**.
 *
 * Why hover the last column and not the last row (do not change it back): both "add" buttons (`TableHandlesController.tsx`)
 * are anchored to `references.tableReference`, the bounding rect of the **whole table**, not the hovered cell;
 * `mouseMoveHandler` in `TableHandles.ts` has two branches that turn them true:
 * - cell branch: `showAddOrRemoveColumnsButton` looks only at `colIndex === last column` (independent of the row), and
 *   `showAddOrRemoveRowsButton` only at `rowIndex === last row`; each is decided independently.
 * - wrapper branch: with the mouse within 20px **below the table** (`belowTable`) `showAddOrRemoveRowsButton` also turns
 *   true; within 20px **right of the table** (`toRightOfTable`) `showAddOrRemoveColumnsButton` likewise.
 * The "add row" conditions of both branches imply the table's bottom edge is under the mouse and therefore inside the
 * viewport (the cell branch hovers that row; the wrapper branch must be at the edge itself to be reachable), so they cannot
 * expose the bug. But the cell branch's "add column" looks only at `colIndex`, so it holds when hovering the **top row, last
 * column**, and then the button stretches to the table's bottom edge, which need not be near the viewport. That is the path
 * that reproduces #160 without scrolling and without Playwright's auto-scroll.
 *
 * An earlier version reproduced with "hover the last cell of the last row": `.hover()`'s auto-scroll-into-view scrolls the
 * target (the last row) into the viewport, which also brings the table's bottom edge back into view, so it measured a false
 * green even on the pre-fix build. It now uses the "top row, last column" path above; see the precondition assertions below
 * (the hover target needs no auto-scroll and does not trigger one).
 *
 * Why only e2e can check this: it is real CSS containing-block / floating-ui geometry, and jsdom has no layout
 * (`getBoundingClientRect` returns 0). The unit test (`NoteEditor.layout.test.tsx`) can guard only that the wrapper has the
 * `relative` class, not that the floating layer is actually contained.
 *
 *
 * Horizontal twin: hover the first cell of the last row (inside the viewport, no scrolling). That turns on
 * `showAddOrRemoveRowsButton` (it looks only at rowIndex), and the "add row" button then stretches to the full table width,
 * with its right edge outside the viewport.
 * Leftover from before #162 (resolved; see the note by the assertion below): `.bn-extend-button` hangs under the `relative`
 * centring wrapper, but the wrapper itself sets no `overflow`, so the part beyond its right edge becomes horizontally
 * scrollable overflow of the **scroll container one level up** (`overflow-y-auto`; CSS promotes its `overflow-x` to `auto`
 * accordingly), not document-level. Since #162 that layer has `overflow-x-clip` (see the comment in `NoteEditor.tsx`), which
 * clips it.
 */

const TABLE_ROWS = 30;
const HEADERS = ["Col1", "Col2", "Col3"];
const LAST_HEADER = HEADERS[HEADERS.length - 1];

function buildMarkdownTable(rows: number): string {
  const header = `| ${HEADERS.join(" | ")} |`;
  const separator = `| ${HEADERS.map(() => "---").join(" | ")} |`;
  const body = Array.from({ length: rows }, (_, i) => `| R${i + 1}C1 | R${i + 1}C2 | R${i + 1}C3 |`);
  return [header, separator, ...body].join("\n") + "\n";
}

// 20 columns: `EMPTY_CELL_WIDTH = 120` in `@blocknote/core/src/blocks/Table/TableExtension.ts`, applied by `editor.css`
// (`td:not([colwidth])` rule) as `min-width: 120px`, so a td/th without an explicit column width is at least 120px.
// 20 columns x 120px = 2400px, far beyond the 800px viewport width below, so horizontal overflow is triggered reliably
// whatever the content length.
const WIDE_TABLE_COLS = 20;
const WIDE_TABLE_ROWS = 2;
const WIDE_LAST_ROW_FIRST_CELL = `W${WIDE_TABLE_ROWS}C1`;

function buildWideMarkdownTable(cols: number, rows: number): string {
  const headers = Array.from({ length: cols }, (_, i) => `WideHeader${i + 1}`);
  const header = `| ${headers.join(" | ")} |`;
  const separator = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = Array.from(
    { length: rows },
    (_, r) => `| ${Array.from({ length: cols }, (_, c) => `W${r + 1}C${c + 1}`).join(" | ")} |`,
  );
  return [header, separator, ...body].join("\n") + "\n";
}

async function documentScrollGeometry(page: Page) {
  return page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: document.documentElement.clientHeight,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
}

/**
 * Wait one tick so the native `scroll` events fired by our programmatic scrolling (`scrollTop` / `scrollLeft` assignments)
 * finish before the caller hovers.
 *
 * Mechanism: `whileElementsMounted` in `TableHandlesController.tsx` is `autoUpdate(reference, floating, callback,
 * { ancestorScroll: true, ... })`, so once the table floating layer is mounted, every ancestor scroll calls
 * `hideHandlesIfNotFrozen()` (`TableHandles.ts`), which sets `show` and both `showAddOrRemove*Button` back to false and
 * `emitUpdate()`, unmounting the layer. If `.hover()` runs before the `scroll` events queued by our own assignments have
 * fired, the just-mounted layer is torn down on the next tick by this "close on any ancestor scroll" safeguard; without this
 * wait `.bn-extend-button` was consistently found 0 times (not an occasional flake). `.tableWrapper` (scrolled by
 * `scrollTableWrapperToLeft`) and the editor scroll container (scrolled by `scrollEditorToTop`) are both ancestors that
 * `ancestorScroll: true` watches: same mechanism, same wait.
 */
async function waitForScrollEventsToSettle(page: Page) {
  await page.waitForTimeout(100);
}

/** Scrolls the editor's scroll container back to the top. The node chain is the same as in `NoteEditor.layout.test.tsx`
 * (that unit test guards the chain's classes; keep the two in sync): the note-editor's parent is the centring wrapper, and
 * the real scroll container (`overflow-y-auto`) is one level above it. */
async function scrollEditorToTop(page: Page) {
  await page.evaluate(() => {
    const editorRoot = document.querySelector('[data-testid="note-editor"]');
    const scrollWrapper = editorRoot?.closest(".overflow-y-auto") as HTMLElement | null | undefined;
    if (scrollWrapper) scrollWrapper.scrollTop = 0;
  });
  await waitForScrollEventsToSettle(page);
}

/**
 * Scrolls the table's own horizontal scroll container (BlockNote's `.tableWrapper`, a third scroll layer separate from the
 * vertical container `scrollEditorToTop` scrolls) back to the far left.
 *
 * After pasting a wide table the caret is in the last cell, and the browser auto-scrolls `.tableWrapper`'s `scrollLeft` near
 * the table's end to keep it visible (the same browser behaviour as "after the vertical paste you see the end of the table",
 * but horizontal and on the table's own wrapper, not the editor scroll container). Without scrolling back, the table's right
 * edge starts inside the viewport and the horizontal twin cannot show #160 (the precondition assertion goes red).
 */
async function scrollTableWrapperToLeft(page: Page) {
  await page.evaluate(() => {
    const tableEl = document.querySelector('[data-testid="note-editor"] table');
    const wrapper = tableEl?.closest(".tableWrapper") as HTMLElement | null;
    if (wrapper) wrapper.scrollLeft = 0;
  });
  await waitForScrollEventsToSettle(page);
}

test("hovering the last column of a table (bottom edge outside the viewport) does not create a page-wide scrollbar", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: E2E_ORIGIN });

  // Shrink the viewport height: a table's bottom edge reliably falls outside the viewport without typing dozens of filler
  // lines, and the width stays 1280 so the sidebar keeps its fixed layout (640-1279 it is a drawer, below 640 the list is its own screen; see 10-responsive.spec.ts).
  await page.setViewportSize({ width: 1280, height: 500 });

  await loginAs(page, ADMIN.email, ADMIN.password);
  await createNote(page, `E2E table hover ${Date.now()}`);

  const editor = editorLocator(page);
  await editor.click();

  await page.evaluate((text) => navigator.clipboard.writeText(text), buildMarkdownTable(TABLE_ROWS));
  await page.keyboard.press("ControlOrMeta+v");

  const table = editor.locator("table").first();
  await expect(table).toBeVisible({ timeout: 10_000 });
  await expect(editor.getByText(`R${TABLE_ROWS}C3`)).toBeVisible();

  await scrollEditorToTop(page);

  // Precondition: the table's bottom edge really is outside the viewport, otherwise this test cannot show #160.
  const { tableBottom, viewportHeight } = await page.evaluate(() => {
    const tableEl = document.querySelector('[data-testid="note-editor"] table');
    return {
      tableBottom: tableEl?.getBoundingClientRect().bottom ?? 0,
      viewportHeight: window.innerHeight,
    };
  });
  expect(tableBottom, "表格下緣必須在視窗外，測試才量得到 #160").toBeGreaterThan(viewportHeight);

  const before = await documentScrollGeometry(page);
  expect(before.scrollHeight, "hover 前 document 就不該溢出（高度）").toBeLessThanOrEqual(before.clientHeight);
  expect(before.scrollWidth, "hover 前 document 就不該溢出（寬度）").toBeLessThanOrEqual(before.clientWidth);

  const lastHeaderCell = editor.getByText(LAST_HEADER, { exact: true }).first();

  // Precondition: the hover target must already be inside the viewport so `.hover()` does not auto-scroll first: if
  // Playwright scrolls, it likely brings the table's bottom edge back into view too, and this test would measure a false
  // green on an unfixed build (the first version, hovering the last cell of the last row, hit exactly that; see the header).
  // This is only a cheap early exit (it should always hold under the known build conditions; red means the test's own
  // assumption broke, not #160). What really blocks the "auto-scroll scrolls the symptom away" false-green channel is the
  // recheck **after** the hover (`tableBottomAfterHover` below).
  const targetBox = await lastHeaderCell.boundingBox();
  expect(targetBox, "hover 目標必須有幾何（已渲染）").not.toBeNull();
  expect(
    targetBox!.y + targetBox!.height,
    "hover 目標本身必須已經在視窗內，否則 .hover() 會 auto-scroll、讓表格下緣跟著捲回可見範圍",
  ).toBeLessThan(viewportHeight);

  await lastHeaderCell.hover();

  // BlockNote's table hover buttons/handles are triggered by real DOM mousemove listeners (see `mouseMoveHandler` in
  // `TableHandles.ts`); `.hover()` sends real input events, which hit. Use `toBeAttached` (not `toBeVisible`): all that is
  // needed here is that the floating layer really mounted (the hover hit and `showAddOrRemoveColumnsButton` turned true);
  // whether it is on screen is not the property under test, and `toBeVisible` ignores ancestor overflow clipping (after the
  // fix the top half of this button is still visible), so it could not tell "mounted" from "leaked outside the document".
  await expect(page.locator(".bn-extend-button-add-remove-columns").first()).toBeAttached({ timeout: 5_000 });

  // Recheck: after hovering, the table's bottom edge must still be outside the viewport; if the hover itself scrolled the
  // table back into view, the "document does not overflow" assertion below would be green for any build and could not show #160.
  const tableBottomAfterHover = await page.evaluate(
    () => document.querySelector('[data-testid="note-editor"] table')?.getBoundingClientRect().bottom ?? 0,
  );
  expect(tableBottomAfterHover, "hover 不得把表格下緣捲回視窗內，否則本案退化成恆綠").toBeGreaterThan(
    viewportHeight,
  );

  const after = await documentScrollGeometry(page);
  expect(after.scrollHeight, "hover 後 document 不該多出一條全頁滾軸（#160）").toBeLessThanOrEqual(
    after.clientHeight,
  );
  // The fix must not turn the "page-wide scrollbar" into a "horizontal scrollbar on the content scroll container": this
  // measures the document itself, a different level from what the horizontal twin below measures on the scroll container;
  // they complement each other.
  expect(after.scrollWidth, "hover 後 document 不該多出橫向滾軸").toBeLessThanOrEqual(after.clientWidth);

  // This table is not wide (the vertical case makes it taller, not wider), so this hover must not add horizontal overflow to the scroll container; the horizontal twin covers the wide case.
  const scrollWrapperGeo = await page.evaluate(() => {
    const editorRoot = document.querySelector('[data-testid="note-editor"]');
    const scrollWrapper = editorRoot?.closest(".overflow-y-auto") as HTMLElement | null | undefined;
    return { scrollWidth: scrollWrapper?.scrollWidth ?? 0, clientWidth: scrollWrapper?.clientWidth ?? 0 };
  });
  expect(scrollWrapperGeo.scrollWidth, "修法不得把全頁滾軸換成內文的橫向滾軸").toBeLessThanOrEqual(
    scrollWrapperGeo.clientWidth,
  );
});

test("hovering the first cell of the last row (right edge outside the viewport, horizontal twin) does not create a page-wide scrollbar or a horizontal scrollbar in the content area", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: E2E_ORIGIN });

  await loginAs(page, ADMIN.email, ADMIN.password);
  await createNote(page, `E2E table hover wide ${Date.now()}`);

  // Create the note first, then shrink: at width 800 the sidebar collapses into a drawer, and the new-note button is in the fixed sidebar.
  await page.setViewportSize({ width: 800, height: 700 });

  const editor = editorLocator(page);
  await editor.click();

  await page.evaluate(
    (text) => navigator.clipboard.writeText(text),
    buildWideMarkdownTable(WIDE_TABLE_COLS, WIDE_TABLE_ROWS),
  );
  await page.keyboard.press("ControlOrMeta+v");

  const table = editor.locator("table").first();
  await expect(table).toBeVisible({ timeout: 10_000 });
  await expect(editor.getByText(WIDE_LAST_ROW_FIRST_CELL, { exact: true })).toBeVisible();

  await scrollTableWrapperToLeft(page);

  // Precondition: the table's right edge really is outside the viewport, otherwise this test cannot show the horizontal twin's symptom.
  const { tableRight, viewportWidth } = await page.evaluate(() => {
    const tableEl = document.querySelector('[data-testid="note-editor"] table');
    return {
      tableRight: tableEl?.getBoundingClientRect().right ?? 0,
      viewportWidth: window.innerWidth,
    };
  });
  expect(tableRight, "表格右緣必須在視窗外，測試才量得到水平孿生案").toBeGreaterThan(viewportWidth);

  const before = await documentScrollGeometry(page);
  expect(before.scrollHeight, "hover 前 document 就不該溢出（高度）").toBeLessThanOrEqual(before.clientHeight);
  expect(before.scrollWidth, "hover 前 document 就不該溢出（寬度）").toBeLessThanOrEqual(before.clientWidth);

  // Hovering the first cell of the last row turns on the "add row" button, stretched to the full table width (see the header)
  const lastRowFirstCell = editor.getByText(WIDE_LAST_ROW_FIRST_CELL, { exact: true });

  // Precondition (same spirit as the previous test, on the horizontal axis): the hover target must already be inside the
  // viewport so `.hover()` does not auto-scroll the table's right edge back into view.
  // This is only a cheap early exit; what really blocks the false-green channel is the recheck after the hover
  // (`tableRightAfterHover` below).
  const targetBox = await lastRowFirstCell.boundingBox();
  expect(targetBox, "hover 目標必須有幾何（已渲染）").not.toBeNull();
  expect(
    targetBox!.x + targetBox!.width,
    "hover 目標本身必須已經在視窗內，否則 .hover() 會 auto-scroll、讓表格右緣跟著捲回可見範圍",
  ).toBeLessThan(viewportWidth);

  await lastRowFirstCell.hover();

  await expect(page.locator(".bn-extend-button-add-remove-rows").first()).toBeAttached({ timeout: 5_000 });

  const tableRightAfterHover = await page.evaluate(
    () => document.querySelector('[data-testid="note-editor"] table')?.getBoundingClientRect().right ?? 0,
  );
  expect(tableRightAfterHover, "hover 不得把表格右緣捲回視窗內，否則本案退化成恆綠").toBeGreaterThan(
    viewportWidth,
  );

  const after = await documentScrollGeometry(page);
  expect(after.scrollHeight, "hover 後 document 不該多出全頁滾軸（高度）").toBeLessThanOrEqual(after.clientHeight);
  expect(after.scrollWidth, "hover 後 document 不該多出全頁滾軸（寬度）").toBeLessThanOrEqual(after.clientWidth);

  // (A) Computed `overflow-x`: guards that Tailwind's `overflow-x-clip` utility really produced the rule. This is a **static
  //     property** independent of hover (it would stay green even if the whole hover part above were removed). Do not assert
  //     `scrollWidth <= clientWidth`: in Chromium `scrollWidth` is unaffected by `overflow-x` being `auto` / `hidden` / `clip`
  //     (three `width:200px` divs with a `width:1000px` child all return 1000); it measures the content's own geometric
  //     extent, not whether scrollable/visible overflow exists, so it does not change between fixed and unfixed (an earlier
  //     version asserted it and went red even on the fixed build). What decides whether a horizontal scrollbar exists is the
  //     computed `overflow-x` itself: CSS Overflow Module Level 3 section 3.1
  //     (https://www.w3.org/TR/css-overflow-3/#overflow-properties) "The visible/clip values of overflow compute to
  //     auto/hidden (respectively) if one of overflow-x or overflow-y is neither visible nor clip". This layer's `overflow-y`
  //     is `auto`, so our `overflow-x: clip` computes to `hidden` (see the comment in `NoteEditor.tsx`). Without
  //     `overflow-x-clip` the computed value is `auto`.
  const scrollWrapperOverflowX = await page.evaluate(() => {
    const editorRoot = document.querySelector('[data-testid="note-editor"]');
    const scrollWrapper = editorRoot?.closest(".overflow-y-auto") as HTMLElement | null | undefined;
    return scrollWrapper ? getComputedStyle(scrollWrapper).overflowX : null;
  });
  expect(scrollWrapperOverflowX, "捲動容器必須有幾何（已渲染），否則下面兩條斷言恆綠").not.toBeNull();
  expect(
    scrollWrapperOverflowX,
    "#162：捲動容器的橫向 overflow 不該計算成 auto/scroll（有溢出時就會長捲軸）",
  ).not.toBe("auto");
  expect(
    scrollWrapperOverflowX,
    "#162：捲動容器的橫向 overflow 不該計算成 auto/scroll（有溢出時就會長捲軸）",
  ).not.toBe("scroll");

  // (B) Whether the user can actually reach it: (A) guards only that the class took effect, not whether the user can
  //     actually scroll after the hover. Move the cursor to a point inside the scroll container but in the blank area
  //     **below** `.tableWrapper` / the extend button (this table has only 2 short rows, so there is blank space below),
  //     send one horizontal wheel, and check whether `scrollWrapper.scrollLeft` moved. In a real browser, under `hidden` this
  //     leaves `scrollLeft` at 0, and under `auto` it moves (see the comment in `NoteEditor.tsx`).
  const scrollWrapperBox = await page.evaluate(() => {
    const editorRoot = document.querySelector('[data-testid="note-editor"]');
    const sw = editorRoot?.closest(".overflow-y-auto") as HTMLElement | null;
    const r = sw?.getBoundingClientRect();
    return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
  });
  const tableBoxForWheel = await table.boundingBox();
  const extendBtnBoxForWheel = await page.locator(".bn-extend-button-add-remove-rows").first().boundingBox();
  expect(scrollWrapperBox, "捲動容器必須有幾何（已渲染）").not.toBeNull();
  expect(tableBoxForWheel, "表格必須有幾何（已渲染）").not.toBeNull();
  // The extend button must have geometry: without it `wheelY` falls back to the table bottom + 20 and lands in
  // `.tableWrapper`'s 22px bottom padding (`--bn-table-widget-size` in `editor.css`), which swallows the wheel, and (B)
  // would be green for any build.
  expect(
    extendBtnBoxForWheel,
    "extend 按鈕必須有幾何——沒有的話 wheelY 會退回表格下緣+20，落進 .tableWrapper 的 22px 下內距而被它吃掉滾輪",
  ).not.toBeNull();
  if (scrollWrapperBox && tableBoxForWheel) {
    const lowestEdge = Math.max(
      tableBoxForWheel.y + tableBoxForWheel.height,
      extendBtnBoxForWheel ? extendBtnBoxForWheel.y + extendBtnBoxForWheel.height : 0,
    );
    let wheelY = lowestEdge + 20;
    if (wheelY >= scrollWrapperBox.y + scrollWrapperBox.height) {
      wheelY = scrollWrapperBox.y + scrollWrapperBox.height / 2;
    }
    // The wheel point is deliberately near the scroll container's left edge (`scrollWrapperBox.x + 8`), not horizontally
    // centred: a centred point falls inside the article column (the ARTICLE_COLUMN centring wrapper) and may step into
    // `.bn-editor` (pmView.dom), where the mechanism described below unmounts the extend button. In this test's 800px
    // viewport the article column's `clamp` minimum (680px) is wider than the scroll container's usable width (about 506px),
    // so the wrapper fills the container's full width (not narrowed and centred) and `.bn-editor` sits inside the wrapper's
    // own `px-4` padding (`ARTICLE_COLUMN_PADDING`, 16px); `+8` has not reached the `.bn-editor` inside the padding and hits
    // the wrapper itself (`elementFromPoint` returns the div whose class contains `max-w-[clamp(...)]` / `px-4`), neither a
    // descendant nor `.tableWrapper`.
    const wheelX = scrollWrapperBox.x + 8;
    expect(
      wheelY,
      "滾輪測試點必須落在捲動容器可視範圍內，才量得到使用者真的能不能滾",
    ).toBeLessThan(scrollWrapperBox.y + scrollWrapperBox.height);

    await page.mouse.move(wheelX, wheelY);

    // Precondition (checked with `document.elementFromPoint(wheelX, wheelY)`): this point must be outside pmView.dom
    // (`.bn-editor`) and not inside `.tableWrapper`. For a mousemove whose `event.target` is not inside `pmView.dom`,
    // `TableHandles.ts` simply `return`s without touching `show` / `showAddOrRemove*Button`, so the extend button stays.
    // Counter-example (a horizontally centred point): it hits TrailingNode's `.bn-trailing-block` widget (inside
    // `.bn-editor`; chain widget -> `.bn-block-group` -> `.bn-editor`), which goes into `domCellAround` returning `undefined`
    // and the unmount path in `TableHandles.ts`; the button really is unmounted, but not in the same tick: right after
    // `mouse.move()` it is still mounted, and it disappears from the DOM only after a wait (the re-render takes time).
    // Choosing the wrapper's own padding keeps this out of the `domCellAround` decision altogether, so it does not depend on
    // that narrow window.
    const wheelPointHit = await page.evaluate(
      ([x, y]) => {
        const el = document.elementFromPoint(x, y);
        const bnEditor = document.querySelector(".bn-editor");
        const tableWrapper = document.querySelector(".tableWrapper");
        return {
          tag: el?.tagName ?? null,
          className: el ? String((el as HTMLElement).className || "") : null,
          insideBnEditor: !!(el && bnEditor && bnEditor.contains(el)),
          insideTableWrapper: !!(el && tableWrapper && tableWrapper.contains(el)),
        };
      },
      [wheelX, wheelY],
    );
    // Debug aid: the element the wheel point actually hit
    console.log("wheel point hit:", wheelPointHit);
    expect(
      wheelPointHit.insideBnEditor,
      `滾輪測試點必須落在 pmView.dom 之外，否則 TableHandles.ts:230-238 會卸載按鈕、(B) 恆綠——命中元素 class="${wheelPointHit.className}"`,
    ).toBe(false);
    expect(
      wheelPointHit.insideTableWrapper,
      `滾輪測試點不得落在 .tableWrapper 內——命中元素 class="${wheelPointHit.className}"`,
    ).toBe(false);

    // Wait 300ms before asserting: this point is outside `.bn-editor`, so in theory the button is unaffected by this
    // mousemove and stays mounted however long we wait; compared with the counter-example above (a point inside `.bn-editor`
    // disappearing after 300ms), this tests "the point is outside" itself rather than betting on a timing window.
    await page.waitForTimeout(300);
    await expect(
      page.locator(".bn-extend-button-add-remove-rows").first(),
      "滑到滾輪測試點、等 300ms 後 extend 按鈕仍必須掛著，否則橫向溢出源已消失、(B) 會對任何 build 都恆綠",
    ).toBeAttached();

    await page.mouse.wheel(300, 0);
    await page.waitForTimeout(100);
  }
  const scrollLeftAfterWheel = await page.evaluate(() => {
    const editorRoot = document.querySelector('[data-testid="note-editor"]');
    const sw = editorRoot?.closest(".overflow-y-auto") as HTMLElement | null;
    return sw?.scrollLeft ?? -1;
  });
  expect(scrollLeftAfterWheel, "使用者不得能把內文區橫向捲走").toBe(0);
});
