import { test, expect, type Locator, type Page } from "@playwright/test";
import { E2E_ORIGIN } from "../ports.js";
import { ADMIN, createNote, editorLocator, loginAs, waitForEditorSelection } from "./helpers.js";

/**
 * issue #94: end-to-end coverage of the mermaid diagram block, for what unit tests structurally cannot see:
 * 1. mermaid itself cannot run in jsdom (`render()` inserts a hidden div into body for text measurement, and jsdom has no
 *    layout / `getBBox`), so unit tests always mock it; whether a diagram actually draws is checked only here.
 * 2. The lazy chunk really loads (`import("mermaid")` is split into its own chunk in the production build).
 * 3. **Paste conversion**: whether a plain-text paste of ```mermaid becomes a diagram. A synthetic `ClipboardEvent` was
 *    unstable (the caret position changes the result); only a real browser with the real clipboard counts.
 */

const DIAGRAM_SOURCE = "graph TD\n    A[Start] --> B[End]";
const PASTED_SOURCE = "```mermaid\ngraph LR\n    P[Pasted] --> Q[Diagram]\n```\n";

/** Sentinel host used only to observe whether a request is made; `.invalid` is a reserved TLD that never resolves. */
const BEACON_HOST = "beacon.invalid";
/**
 * Three directive attack surfaces in one diagram: CSS resources in themeCSS, `<img srcset>` once htmlLabels is on, and a
 * `fontFamily` that smuggles in declarations (the fontFamily route does reach out).
 */
const BEACON_DIAGRAM = [
  `%%{init: {"themeCSS": "* { background: url(http://${BEACON_HOST}/css.png) }", "htmlLabels": true, "fontFamily": "monospace; background-image: url(http://${BEACON_HOST}/ff.png)"}}%%`,
  "graph TD",
  `    A["Start<img src='#' srcset='http://${BEACON_HOST}/label.png 1x'>"] --> B[End]`,
].join("\n");
function diagramLocator(page: Page) {
  return editorLocator(page).locator("svg[aria-roledescription]").first();
}

test.describe.configure({ mode: "serial" });

test("/diagram inserts a block -> source typed -> diagram drawn -> edit button opens source, Esc returns to the diagram", async ({ page }) => {
  await loginAs(page, ADMIN.email, ADMIN.password);
  await createNote(page, `E2E mermaid ${Date.now()}`);

  const editor = editorLocator(page);
  await editor.click();

  await editor.pressSequentially("/diagram");
  await page.getByText("Flowcharts and diagrams with Mermaid").click();

  await expect(page.getByText("Click to add diagram source")).toBeVisible();
  await expect(diagramLocator(page)).toHaveCount(0);

  await page.getByRole("button", { name: "Edit diagram source" }).click();
  const source = page.getByRole("textbox", { name: "Mermaid source" });
  await source.fill(DIAGRAM_SOURCE);
  await source.press("Escape");

  await expect(diagramLocator(page)).toBeVisible({ timeout: 20_000 });
  await expect(diagramLocator(page)).toContainText("Start");

  // No error state may leak: on a parse failure mermaid injects a "Syntax error in text" diagram into `document.body`;
  // `lib/mermaid.ts` blocks that with `suppressErrorRendering: true`. This also checks the normal path shows no such text.
  await expect(page.getByText("Syntax error in text")).toHaveCount(0);

  // The toolbar "Edit" button is the second way into the source (the first is clicking the diagram). A way out must always
  // exist: the first version swapped the block for BlockNote's codeBlock and there was no way back; this guards that dead
  // end, and the way out is Esc.
  // `exact` is required: Playwright's `name` defaults to substring, so "Edit" would also match "Edit diagram source".
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Mermaid source" })).toHaveValue(DIAGRAM_SOURCE);
  await expect(diagramLocator(page)).toHaveCount(0);

  await page.getByRole("textbox", { name: "Mermaid source" }).press("Escape");
  await expect(diagramLocator(page)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Mermaid source" })).toHaveCount(0);
});

test("syntax error: shows the error message and the source, and does not inject mermaid's own error diagram", async ({ page }) => {
  await loginAs(page, ADMIN.email, ADMIN.password);
  await createNote(page, `E2E mermaid error ${Date.now()}`);

  const editor = editorLocator(page);
  await editor.click();
  await editor.pressSequentially("/diagram");
  await page.getByText("Flowcharts and diagrams with Mermaid").click();

  // Error again: a redraw must not add another diagram
  await page.getByRole("button", { name: "Edit diagram source" }).click();
  const source = page.getByRole("textbox", { name: "Mermaid source" });
  await source.fill("graph TD\n    A --> ((((");
  await source.press("Escape");

  // Our own error state: message plus a **readable source** (without it the user cannot fix the diagram).
  // The assertion must target `<pre>`: mermaid's error message also echoes the source, so a plain text selector matches both
  // the `role="alert"` message and the `<pre>` and trips Playwright's strict mode.
  await expect(page.getByRole("alert")).toContainText("Diagram error");
  await expect(editor.locator("pre")).toContainText("A --> ((((");

  // Regression guard: mermaid's bomb error diagram must not appear anywhere on the page. It is injected into body by the
  // `render()` throw path and escapes the component boundary; `lib/mermaid.ts` relies on `suppressErrorRendering: true`
  // so render clears its temporary container before throwing (no pre-parse since #344). A failure here means that setting
  // was removed.
  await expectNoMermaidLeftovers(page);

  await page.getByRole("button", { name: "Edit diagram source" }).click();
  await page.getByRole("textbox", { name: "Mermaid source" }).fill("graph TD\n    B --> ))))");
  await page.getByRole("textbox", { name: "Mermaid source" }).press("Escape");
  await expect(editor.locator("pre")).toContainText("B --> ))))");
  await expectNoMermaidLeftovers(page);
});

/** Asserts mermaid left nothing behind: no error diagram (`aria-roledescription="error"`), no temporary measuring container (`#dmermaid-N`), and no mermaid svg outside the editor. */
async function expectNoMermaidLeftovers(page: Page): Promise<void> {
  await expect(page.getByText("Syntax error in text")).toHaveCount(0);
  await expect(page.locator('svg[aria-roledescription="error"]')).toHaveCount(0);
  await expect(page.locator('[id^="dmermaid-"]')).toHaveCount(0);
  const stray = await page.evaluate(
    () => Array.from(document.querySelectorAll("svg[aria-roledescription]")).filter((svg) => svg.closest('[data-testid="note-editor"]') === null).length,
  );
  expect(stray, "編輯器外不得有 mermaid 的 svg").toBe(0);
}

async function pasteMarkdown(page: Page, markdown: string): Promise<void> {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: E2E_ORIGIN });
  const editor = editorLocator(page);
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await waitForEditorSelection(page);
  await page.evaluate((text) => navigator.clipboard.writeText(text), markdown);
  await page.keyboard.press("ControlOrMeta+v");
}

/**
 * Distance from the target's top to the bottom edge of the note scroll container's visible box (the note page scrolls an
 * inner container, not the window); positive = below the edge. The search starts from outside the editor: a side-by-side
 * column `.bn-block-column` also has computed overflowY auto but is not the scroll container.
 */
async function gapBelowFold(target: Locator): Promise<number> {
  return target.evaluate((el) => {
    let scroller = el.closest(".bn-editor")?.parentElement ?? el.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    const bottom = scroller ? scroller.getBoundingClientRect().bottom : window.innerHeight;
    return el.getBoundingClientRect().top - bottom;
  });
}

test("#344 long note: diagrams within 600px of the viewport draw without scrolling; farther ones stay a placeholder until scrolled to, then draw", async ({ page }) => {
  await loginAs(page, ADMIN.email, ADMIN.password);
  await createNote(page, `E2E mermaid lazy ${Date.now()}`);
  const filler = (from: number, n: number) => Array.from({ length: n }, (_, i) => `Filler paragraph ${from + i}\n`);
  await pasteMarkdown(
    page,
    [
      "```mermaid", "graph TD\n    T1[TopNode] --> T2[TopEnd]", "```", "",
      ...filler(0, 25),
      "```mermaid", "graph TD\n    N1[NearNode] --> N2[NearEnd]", "```", "",
      ...filler(25, 60),
      "```mermaid", "graph TD\n    F1[FarAwayNode] --> F2[FarEnd]", "```", "",
    ].join("\n"),
  );

  const blocks = page.locator('[data-content-type="mermaid"]');
  await expect(blocks).toHaveCount(3, { timeout: 15_000 });
  await expect(editorLocator(page).getByText("Filler paragraph 84")).toBeVisible();
  // Wait for the save to land, then reopen: after the paste the caret is at the bottom and the bottom diagram was already drawn in view; the case under test is opening a note.
  await page.waitForTimeout(1500);
  await page.reload();

  const top = blocks.first().locator("svg[aria-roledescription]");
  const near = blocks.nth(1);
  const far = blocks.nth(2);
  await expect(top).toBeVisible({ timeout: 20_000 });
  await expect(top).toContainText("TopNode");

  // Middle diagram: below the visible box's bottom edge but inside the 600px pre-range, so it draws without scrolling
  // (guards `MermaidView` using the scroll container as `root`: with the default viewport as root, rootMargin has no effect and this one would stay a placeholder).
  const nearGap = await gapBelowFold(near);
  expect(nearGap, "前提：中間那張在可見框之外").toBeGreaterThan(0);
  expect(nearGap, "前提：中間那張在 600px 預先範圍內").toBeLessThan(500);
  await expect(near.locator("svg[aria-roledescription]")).toHaveCount(1, { timeout: 20_000 });
  await expect(near.locator("svg[aria-roledescription]")).toContainText("NearNode");

  // The bottom diagram is outside the pre-range: wait a while longer, it must still not be drawn (placeholder).
  expect(await gapBelowFold(far), "前提：最底那張在可見框下方 600px 以外").toBeGreaterThan(600);
  await page.waitForTimeout(1500);
  await expect(far.locator("svg[aria-roledescription]")).toHaveCount(0);
  await expect(far.getByText("Rendering diagram…")).toBeAttached();

  await far.scrollIntoViewIfNeeded();
  await expect(far.locator("svg[aria-roledescription]")).toBeVisible({ timeout: 20_000 });
  await expect(far.locator("svg[aria-roledescription]")).toContainText("FarAwayNode");
  await expect(far.getByText("Rendering diagram…")).toHaveCount(0);
});

test("#344 far diagram inside a side-by-side column: also not drawn until scrolled to (the column's overflow-x:auto must not be taken as the scroll root)", async ({ page }) => {
  await loginAs(page, ADMIN.email, ADMIN.password);
  await createNote(page, `E2E mermaid lazy columns ${Date.now()}`);
  const filler = (from: number, n: number) => Array.from({ length: n }, (_, i) => `Column filler ${from + i}\n`);
  // The canonical shape from 34-columns: a long run of text in the right column, then the diagram.
  const column = (body: string) => ['<div data-kb-column style="flex:1">', "", body, "", "</div>"];
  await pasteMarkdown(
    page,
    [
      "```mermaid", "graph TD\n    T1[TopNode] --> T2[TopEnd]", "```", "",
      '<div data-kb-columns style="display:flex;gap:16px">',
      ...column("Left column"),
      ...column([...filler(0, 70), "```mermaid", "graph TD\n    C1[ColumnFarNode] --> C2[ColumnFarEnd]", "```"].join("\n")),
      "</div>",
      "",
    ].join("\n"),
  );

  const blocks = page.locator('[data-content-type="mermaid"]');
  await expect(blocks).toHaveCount(2, { timeout: 15_000 });
  const far = blocks.nth(1);
  // Precondition: that diagram really is inside the column.
  expect(await far.evaluate((el) => el.closest(".bn-block-column") !== null), "前提：第二張圖在並排欄裡").toBe(true);
  await page.waitForTimeout(1500);
  await page.reload();

  await expect(blocks.first().locator("svg[aria-roledescription]")).toBeVisible({ timeout: 20_000 });
  expect(await gapBelowFold(far), "前提：欄裡那張在可見框下方 600px 以外").toBeGreaterThan(600);
  await page.waitForTimeout(1500);
  await expect(far.locator("svg[aria-roledescription]"), "欄裡的遠處圖不得先畫").toHaveCount(0);

  await far.scrollIntoViewIfNeeded();
  await expect(far.locator("svg[aria-roledescription]")).toContainText("ColumnFarNode", { timeout: 20_000 });
});

test("#344 two diagrams with identical source on one page: both draw, ids do not collide, arrows and styles point at their own diagram", async ({ page }) => {
  await loginAs(page, ADMIN.email, ADMIN.password);
  await createNote(page, `E2E mermaid twins ${Date.now()}`);
  const twin = ["```mermaid", "graph LR\n    A[TwinStart] --> B[TwinEnd]", "```", ""].join("\n");
  await pasteMarkdown(page, [twin, "between", "", twin].join("\n"));

  const svgs = editorLocator(page).locator("svg[aria-roledescription]");
  await expect(svgs).toHaveCount(2, { timeout: 20_000 });
  await expect(svgs.nth(0)).toContainText("TwinStart");
  await expect(svgs.nth(1)).toContainText("TwinStart");

  // Check once when opening the note (the second diagram takes the cache-hit path with id rewriting) and once after navigating away and back (both take the cache).
  for (const step of ["reload", "spa-return"] as const) {
    if (step === "reload") {
      await page.waitForTimeout(1500);
      await page.reload();
    } else {
      await page.evaluate(() => {
        history.pushState(null, "", "/");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      await expect(page.locator('[data-content-type="mermaid"]')).toHaveCount(0, { timeout: 15_000 });
      await page.goBack();
    }
    await expect(svgs).toHaveCount(2, { timeout: 20_000 });
    await expect(svgs.nth(1)).toContainText("TwinEnd");

    const report = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('[data-testid="note-editor"] svg[aria-roledescription]')) as SVGSVGElement[];
      // Only ids with the `mermaid-N` prefix (the kind `rewriteMermaidId` handles). flowchart has no other kind of id; sankey /
      // sequence / architecture also have prefix-less ids from mermaid's global counter, which duplicate in cached copies, a known leftover (see `lib/mermaid.ts`).
      const ids = Array.from(document.querySelectorAll("[id]"), (el) => el.id).filter((id) => /mermaid-\d/.test(id));
      return {
        rootIds: all.map((svg) => svg.id),
        duplicateIds: ids.filter((id, i) => ids.indexOf(id) !== i),
        perSvg: all.map((svg) => {
          const refs = Array.from(svg.querySelectorAll("[marker-end], [marker-start]")).flatMap((el) =>
            ["marker-end", "marker-start"].map((a) => el.getAttribute(a)).filter((v): v is string => v !== null && v.startsWith("url(")),
          );
          const targets = refs.map((ref) => /url\(#([^)]+)\)/.exec(ref)?.[1] ?? "");
          const style = svg.querySelector("style")?.textContent ?? "";
          const rect = svg.querySelector(".node rect, .node polygon, .node path");
          return {
            markerRefs: targets.length,
            markersInOwnSvg: targets.every((id) => id !== "" && svg.querySelector(`[id="${id}"]`) !== null),
            styleScopedToSelf: style.includes(`#${svg.id}`),
            nodeFill: rect ? getComputedStyle(rect).fill : null,
          };
        }),
      };
    });
    expect(new Set(report.rootIds).size, `${step}：兩張的根 id 要不同 ${JSON.stringify(report.rootIds)}`).toBe(2);
    expect(report.duplicateIds, `${step}：頁面上不得有重複的 mermaid id`).toEqual([]);
    for (const svg of report.perSvg) {
      expect(svg.markerRefs, `${step}：每張圖都有箭頭`).toBeGreaterThan(0);
      expect(svg.markersInOwnSvg, `${step}：箭頭 marker 要指向自己那張圖裡的元素`).toBe(true);
      expect(svg.styleScopedToSelf, `${step}：樣式選擇器要指向自己那張圖`).toBe(true);
    }
    expect(report.perSvg[0]!.nodeFill).toBe(report.perSvg[1]!.nodeFill);
    expect(report.perSvg[0]!.nodeFill).not.toBe("rgb(0, 0, 0)");
  }
});

test("pasting ```mermaid plain text automatically becomes a diagram", async ({ page, context }) => {
  // The real clipboard needs permissions; `clipboard-read` is for `navigator.clipboard`, while the paste itself is a keyboard
  // event on the browser's native path (the same path as real use).
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: E2E_ORIGIN });

  await loginAs(page, ADMIN.email, ADMIN.password);
  await createNote(page, `E2E mermaid paste ${Date.now()}`);

  const editor = editorLocator(page);
  await editor.click();

  await page.evaluate((text) => navigator.clipboard.writeText(text), PASTED_SOURCE);
  await page.keyboard.press("ControlOrMeta+v");

  // `collab/mermaid-paste.ts`: the paste yields `codeBlock{language:"mermaid"}`, which we convert to a mermaid block
  // **after the paste completes** (and only the newly inserted one).
  await expect(diagramLocator(page)).toBeVisible({ timeout: 20_000 });
  await expect(diagramLocator(page)).toContainText("Pasted");
  await expect(editor.locator("pre code")).toHaveCount(0);
});

test("pasting ```mermaid with text/html (the shape copied from a GitHub README / AI chat) automatically becomes a diagram", async ({ page, context }) => {
  // Why this exists: `docs/diagrams.md` centres on the "copy from an AI chat or a GitHub README" case. That clipboard carries
  // **both text/plain and text/html** and takes the **default handler** exit in `collab/paste.ts` (`decideMarkdownPaste`
  // returns null), a different branch from the plain-text test above. Unit tests with a fake `defaultPasteHandler` check only
  // the wiring; the real clipboard shape needs this test.
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: E2E_ORIGIN });

  await loginAs(page, ADMIN.email, ADMIN.password);
  await createNote(page, `E2E mermaid html paste ${Date.now()}`);

  const editor = editorLocator(page);
  await editor.click();

  await page.evaluate(
    async ({ html, text }) => {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([text], { type: "text/plain" }),
        }),
      ]);
    },
    { html: '<pre><code class="language-mermaid">graph LR\n    H[Html] --&gt; P[Paste]</code></pre>', text: "graph LR\n    H[Html] --> P[Paste]" },
  );
  await page.keyboard.press("ControlOrMeta+v");

  await expect(diagramLocator(page)).toBeVisible({ timeout: 20_000 });
  await expect(diagramLocator(page)).toContainText("Html");
  await expect(editor.locator("pre code")).toHaveCount(0);
});

test("a diagram's init directive cannot make the browser request an external host", async ({ page }) => {
  // Needs a real browser, and is the most important of these: `mermaid.render()` inserts the diagram (including `<style>`)
  // into the live document for text measurement, so the browser applies the CSS and fires requests on the spot; sanitizing
  // the output is too late (even if the SVG is never inserted into the page afterwards, a url() in themeCSS still hits).
  // What blocks it is the `secure` lock list in `lib/mermaid.ts`: themeCSS / htmlLabels / flowchart do not accept overrides
  // from a directive inside the diagram.
  const requested: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes(BEACON_HOST)) requested.push(request.url());
  });

  await loginAs(page, ADMIN.email, ADMIN.password);
  await createNote(page, `E2E mermaid beacon ${Date.now()}`);

  const editor = editorLocator(page);
  await editor.click();
  await editor.pressSequentially("/diagram");
  await page.getByText("Flowcharts and diagrams with Mermaid").click();

  await page.getByRole("button", { name: "Edit diagram source" }).click();
  const source = page.getByRole("textbox", { name: "Mermaid source" });
  await source.fill(BEACON_DIAGRAM);
  await source.press("Escape");

  // The diagram must still draw: the directive is ignored, not the whole diagram
  await expect(diagramLocator(page)).toBeVisible({ timeout: 20_000 });
  await expect(diagramLocator(page)).toContainText("Start");

  expect(requested, `不該對 ${BEACON_HOST} 發任何請求`).toEqual([]);
});

test("a valid multi-line label still draws (not blocked by mistake by the image guard)", async ({ page }) => {
  // mermaid's lexer turns newlines inside double-quoted strings into `<br/>`, so this is **valid** syntax. An earlier version
  // pre-parsed the source before render, misjudged this as unparsable and blocked it with an external-image error for a
  // diagram that has no img. Since the guard moved to intercepting `new Image()`, the decision looks only at the URL that is
  // actually about to be requested, and this class of false block is gone.
  await loginAs(page, ADMIN.email, ADMIN.password);
  await createNote(page, `E2E mermaid multiline label ${Date.now()}`);

  const editor = editorLocator(page);
  await editor.click();
  await editor.pressSequentially("/diagram");
  await page.getByText("Flowcharts and diagrams with Mermaid").click();

  await page.getByRole("button", { name: "Edit diagram source" }).click();
  const source = page.getByRole("textbox", { name: "Mermaid source" });
  await source.fill('graph TD\n    A@{ shape: rect, label: "line one\n    line two" } --> B[End]');
  await source.press("Escape");

  await expect(diagramLocator(page)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a diagram with a click X href line still draws, and the link is kept", async ({ page }) => {
  // An earlier version blocked SVG `<a href>` as an external resource, so any diagram with a `click X href` failed to draw
  // at all and showed a mismatched error. Diagrams pasted from a GitHub README often carry this line; this guards that.
  await loginAs(page, ADMIN.email, ADMIN.password);
  await createNote(page, `E2E mermaid click href ${Date.now()}`);

  const editor = editorLocator(page);
  await editor.click();
  await editor.pressSequentially("/diagram");
  await page.getByText("Flowcharts and diagrams with Mermaid").click();

  await page.getByRole("button", { name: "Edit diagram source" }).click();
  const source = page.getByRole("textbox", { name: "Mermaid source" });
  await source.fill('graph TD\n    A[Start] --> B[End]\n    click A href \"https://example.com/page\"');
  await source.press("Escape");

  await expect(diagramLocator(page)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(diagramLocator(page).locator('a[*|href="https://example.com/page"]')).toHaveCount(1);
});
