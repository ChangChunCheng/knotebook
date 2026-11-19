import { expect, test, type Locator, type Page } from "@playwright/test";
import { ADMIN, createUserViaInvite, loginAs, openListOnCompact, randomEmail } from "./helpers.js";

/**
 * #93: the sidebar search's merged result list in a real browser (title hits and body hits in one list, one item per body hit, three lines each: title / folder path / snippet). Clicking an item opens the note, scrolls to the first block containing the query inside that section's range, centers it and highlights it (the block flashes, not the section heading).
 *
 * - The e2e package does not import `@knotebook/shared`, so URLs are built by hand (same as the header of `27-site-links.spec.ts`).
 * - Each test uses its own new user: the search limiter allows 60 per minute per user and is shared with the UI; ADMIN only issues invites.
 * - Notes are created with `POST /api/notes` carrying markdown (only requests with content count against the edit limiter, 30 per minute); indexing lags, so poll
 *   `GET /api/search` until it hits before typing.
 * - After a full page load of a note page, wait for the "Note title" box before touching the sidebar (the lazy NotePage's fallback carries its own AppShell and swaps
 *   shells); after a click navigation, `waitForURL` and then wait for state specific to the new page (title box value, highlight overlay), not just the URL.
 */

const PASSWORD = "e2e-fulltext-pw";
type Created = { id: string; title: string; slug: string; ownerHandle: string };
type SearchHit = { note: { id: string }; matches: Array<{ sectionId: string; heading: string }> };

async function asNewUser(page: Page, displayName: string): Promise<void> {
  await loginAs(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/$/);
  const email = randomEmail();
  await createUserViaInvite(page, { email, password: PASSWORD, displayName });
  await page.context().clearCookies();
  await loginAs(page, email, PASSWORD);
  await expect(page).toHaveURL(/\/$/);
}

async function createNoteViaApi(page: Page, title: string, content?: string): Promise<Created> {
  const res = await page.request.post("/api/notes", { data: content === undefined ? { title } : { title, content } });
  expect(res.status(), `POST /api/notes → ${res.status()} ${await res.text()}`).toBe(201);
  return (await res.json()) as Created;
}
const pathOf = (n: Created) => `/n/${n.ownerHandle}/${n.slug}`;

async function waitIndexed(page: Page, q: string, noteId: string): Promise<{ sectionId: string; heading: string }> {
  let found: { sectionId: string; heading: string } | null = null;
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`/api/search?q=${encodeURIComponent(q)}&match=body`);
        if (res.status() !== 200) return null;
        const hit = ((await res.json()) as { hits: SearchHit[] }).hits.find((h) => h.note.id === noteId);
        found = hit?.matches[0] ?? null;
        return found?.sectionId ?? null;
      },
      { intervals: [500, 1000], timeout: 20_000 },
    )
    .not.toBeNull();
  return found!;
}

/** Highlight overlay for a section anchor (the main part of `expectAnchorFlash` in `27-site-links.spec.ts`): appears, covers the block, sits outside the editable DOM. */
async function expectAnchorFlash(page: Page, blockId: string): Promise<void> {
  const overlay = page.locator(`.kn-anchor-flash[data-anchor-flash="${blockId}"]`);
  await expect(overlay).toBeAttached({ timeout: 15_000 });
  const geo = await overlay.evaluate((el, id) => {
    const block = document.querySelector(`.bn-block-outer[data-id="${id}"]`)!.getBoundingClientRect();
    const o = el.getBoundingClientRect();
    return { dTop: Math.abs(o.top - block.top), dHeight: Math.abs(o.height - block.height), inEditable: el.closest('[contenteditable="true"], .ProseMirror') !== null };
  }, blockId);
  expect(geo.inEditable).toBe(false);
  expect(geo.dTop).toBeLessThanOrEqual(1);
  expect(geo.dHeight).toBeLessThanOrEqual(1);
}

const block = (page: Page, id: string) => page.locator(`.bn-block-outer[data-id="${id}"]`);
/**
 * A search jump scrolls to mid-viewport: the block's center is within 25%-75% of the viewport height. There must be enough content below the hit to scroll that far (each test's data ensures it).
 * Uses poll because layout may still be settling after the scroll.
 */
async function expectBlockCentered(page: Page, id: string): Promise<void> {
  const ratio = () =>
    block(page, id).evaluate((el) => {
      const r = el.getBoundingClientRect();
      return (r.top + r.height / 2) / window.innerHeight;
    });
  await expect
    .poll(async () => {
      const r = await ratio();
      return r >= 0.25 && r <= 0.75;
    }, { timeout: 10_000, message: `block ${id} 的中心點應在視窗高度的 25%–75%` })
    .toBe(true);
}
/** Id of the innermost block on the page whose own text contains kw (waits for it to appear). The hit block's id is read from the DOM, not from the server (the server only records the section). */
async function matchBlockId(page: Page, kw: string): Promise<string> {
  const handle = await page.waitForFunction(
    (k) => {
      const hit = Array.from(document.querySelectorAll<HTMLElement>(".bn-block-outer[data-id]")).find((o) =>
        (o.querySelector(":scope > .bn-block > .bn-block-content")?.textContent ?? "").includes(k),
      );
      return hit?.getAttribute("data-id") ?? null;
    },
    kw,
    { timeout: 15_000 },
  );
  return (await handle.jsonValue()) as string;
}
const titleBox = (page: Page) => page.getByRole("textbox", { name: "Note title" });
const bodyRegion = (scope: Page | Locator) => scope.getByRole("region", { name: "Search results" });
function snippetOf(scope: Page | Locator, href: string): Locator {
  return bodyRegion(scope).locator(`a[href="${href}"]`);
}
function filler(prefix: string, n: number): string {
  return Array.from({ length: n }, (_, i) => `${prefix} filler ${i + 1}`).join("\n\n");
}

test("E1+E2: wide screen, Ctrl+K from home and clicking the snippet scrolls to Gamma and highlights it; clicking again in the same note only scrolls, no reload, and back works", async ({ page }) => {
  test.setTimeout(120_000);
  await asNewUser(page, "E2E Fulltext E1");
  const stamp = Date.now();
  const kw = `kw${stamp}`;
  const md = `## Alpha\n\n${filler("alpha", 20)}\n\n## Beta\n\n${filler("beta", 20)}\n\n## Gamma\n\nthe ${kw} lives here\n\n${filler("gamma", 40)}\n`;
  const a = await createNoteViaApi(page, `E2E ft A ${stamp}`, md);
  const hit = await waitIndexed(page, kw, a.id);
  expect(hit.heading).toBe("Gamma");
  const gammaId = hit.sectionId;

  await page.goto("/");
  const search = page.getByRole("complementary").getByRole("textbox", { name: "Search notes" });
  // The Ctrl+K listener is on AppShell: press only after the login check's Loading is over and the search box is visible, otherwise nothing receives the key.
  await expect(search).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(search).toBeFocused();
  await search.fill(kw);
  const snippet = snippetOf(page.getByRole("complementary"), `${pathOf(a)}#b-${gammaId}`);
  await expect(snippet).toBeVisible({ timeout: 15_000 });
  await expect(snippet.locator("mark")).toHaveText(kw);
  await snippet.click();
  await page.waitForURL((u) => u.pathname === pathOf(a) && u.hash === `#b-${gammaId}`, { timeout: 15_000 });
  await expect(titleBox(page)).toHaveValue(a.title, { timeout: 15_000 });
  const hitId = await matchBlockId(page, kw);
  expect(hitId, "閃的是含字的 block，不是段落標題").not.toBe(gammaId);
  await expectAnchorFlash(page, hitId);
  await expect(page.locator(`.kn-anchor-flash[data-anchor-flash="${gammaId}"]`)).toHaveCount(0);
  await expect(block(page, hitId)).toBeInViewport();
  await expectBlockCentered(page, hitId);

  await page.goto(pathOf(a));
  await expect(titleBox(page)).toHaveValue(a.title, { timeout: 15_000 });
  await expect(block(page, hitId)).not.toBeInViewport();
  await page.evaluate(() => {
    (window as unknown as { __kbMarker?: number }).__kbMarker = 1;
  });
  const search2 = page.getByRole("complementary").getByRole("textbox", { name: "Search notes" });
  await search2.fill(kw);
  const same = snippetOf(page.getByRole("complementary"), `${pathOf(a)}#b-${gammaId}`);
  await expect(same).toBeVisible({ timeout: 15_000 });
  await same.click();
  await page.waitForURL((u) => u.pathname === pathOf(a) && u.hash === `#b-${gammaId}`, { timeout: 10_000 });
  await expect(block(page, hitId)).toBeInViewport({ timeout: 5_000 });
  await expectAnchorFlash(page, hitId);
  expect(await page.evaluate(() => (window as unknown as { __kbMarker?: number }).__kbMarker)).toBe(1);
  await page.goBack();
  await page.waitForURL((u) => u.pathname === pathOf(a) && u.hash === "", { timeout: 10_000 });
  expect(await page.evaluate(() => (window as unknown as { __kbMarker?: number }).__kbMarker)).toBe(1);
});

test("E1b nested headings: under # Top everything is ## - the snippet's section heading is Top, but the flash is on the line under ## Sub that contains the text", async ({ page }) => {
  test.setTimeout(120_000);
  await asNewUser(page, "E2E Fulltext E1b");
  const stamp = Date.now();
  const kx = `kx${stamp}`;
  const md = `# Top\n\n${filler("top", 10)}\n\n## Sub\n\n${filler("sub", 20)}\n\nwhere ${kx} is\n`;
  const c = await createNoteViaApi(page, `E2E ft C ${stamp}`, md);
  const hit = await waitIndexed(page, kx, c.id);
  expect(hit.heading).toBe("Top");
  const topId = hit.sectionId;

  await page.goto("/");
  const sidebar = page.getByRole("complementary");
  await sidebar.getByRole("textbox", { name: "Search notes" }).fill(kx);
  const snippet = snippetOf(sidebar, `${pathOf(c)}#b-${topId}`);
  await expect(snippet).toBeVisible({ timeout: 15_000 });
  await expect(snippet.locator(":scope > div")).toHaveCount(3);
  await expect(snippet.locator(":scope > div").nth(1)).toContainText("My notes");
  await expect(snippet.locator(":scope > div").nth(2)).toContainText(kx);
  await snippet.click();
  await page.waitForURL((u) => u.pathname === pathOf(c) && u.hash === `#b-${topId}`, { timeout: 15_000 });
  await expect(titleBox(page)).toHaveValue(c.title, { timeout: 15_000 });
  const hitId = await matchBlockId(page, kx);
  expect(hitId).not.toBe(topId);
  await expectAnchorFlash(page, hitId);
  await expect(block(page, hitId)).toContainText(kx);
  await expect(block(page, hitId)).toBeInViewport();
  await expect(page.locator(`.kn-anchor-flash[data-anchor-flash="${topId}"]`)).toHaveCount(0);
});

test("E3+E4 phone list: clicking a snippet of another note or the same note returns to the note screen and scrolls to the block with the text", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await asNewUser(page, "E2E Fulltext E3");
  const stamp = Date.now();
  const kw = `kn${stamp}`;
  const md = `## Alpha\n\n${filler("alpha", 20)}\n\n## Beta\n\n${filler("beta", 20)}\n\n## Gamma\n\nthe ${kw} lives here\n\n${filler("gamma", 10)}\n`;
  const a = await createNoteViaApi(page, `E2E ft A ${stamp}`, md);
  const b = await createNoteViaApi(page, `E2E ft B ${stamp}`);
  const gammaId = (await waitIndexed(page, kw, a.id)).sectionId;
  const href = `${pathOf(a)}#b-${gammaId}`;

  async function searchInDrawer(): Promise<Locator> {
    const list = await openListOnCompact(page);
    const input = list.getByRole("textbox", { name: "Search notes" });
    if (!(await input.isVisible())) await list.getByRole("button", { name: "Search notes", exact: true }).click();
    await input.fill(kw);
    const s = snippetOf(list, href);
    await expect(s).toBeVisible({ timeout: 15_000 });
    return s;
  }

  await page.goto(pathOf(b));
  await expect(titleBox(page)).toHaveValue(b.title, { timeout: 15_000 });
  await (await searchInDrawer()).click();
  await expect(page.getByRole("textbox", { name: "Search notes" })).toBeHidden();
  await page.waitForURL((u) => u.pathname === pathOf(a) && u.hash === `#b-${gammaId}`, { timeout: 15_000 });
  await expect(titleBox(page)).toHaveValue(a.title, { timeout: 15_000 });
  const hitId = await matchBlockId(page, kw);
  expect(hitId).not.toBe(gammaId);
  await expect(block(page, hitId)).toBeInViewport({ timeout: 15_000 });
  await expectAnchorFlash(page, hitId);

  await page.goto(pathOf(a));
  await expect(titleBox(page)).toHaveValue(a.title, { timeout: 15_000 });
  await expect(block(page, hitId)).not.toBeInViewport();
  await (await searchInDrawer()).click();
  await expect(page.getByRole("textbox", { name: "Search notes" })).toBeHidden();
  await expect(block(page, hitId)).toBeInViewport({ timeout: 15_000 });
  await expectAnchorFlash(page, hitId);
});

test("E5 layout and load more: 22 title hits first; scrolled to the bottom: 22 + 20 rows + load more -> 44 rows and the button disappears; clicking the last note's snippet navigates there", async ({ page }) => {
  test.setTimeout(180_000);
  await asNewUser(page, "E2E Fulltext E5");
  const stamp = Date.now();
  const ky = `ky${stamp}`;
  for (let i = 0; i < 22; i += 1) await createNoteViaApi(page, `E2E ft title ${ky} ${String(i).padStart(2, "0")}`);
  const bodies: Created[] = [];
  for (let i = 0; i < 22; i += 1) bodies.push(await createNoteViaApi(page, `E2E ft body ${stamp} ${String(i).padStart(2, "0")}`, `has ${ky} inside ${i}\n`));
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`/api/search?q=${ky}&limit=50&match=body`);
        return res.status() === 200 ? ((await res.json()) as { hits: SearchHit[] }).hits.length : -1;
      },
      { intervals: [500, 1000], timeout: 30_000 },
    )
    .toBe(22);

  // Reload after creating: the content area is cross-checked against the ["notes"] list, so if the page loaded the list before the notes were created they would be filtered out.
  await page.goto("/");
  const sidebar = page.getByRole("complementary");
  await sidebar.getByRole("textbox", { name: "Search notes" }).fill(ky);
  const results = sidebar.getByTestId("sidebar-search");
  const region = bodyRegion(sidebar);
  const hits = region.getByTestId("search-hit");
  // Merged list: 22 title hits first, then the first page of 20 notes that only hit in the body; the count is of listed (loaded) items.
  await expect(results.getByRole("status")).toHaveText("42 results loaded, more available", { timeout: 15_000 });
  await expect(hits).toHaveCount(42, { timeout: 15_000 });
  // One scroll container holds the whole list: scrolled to the bottom, Load more is in view.
  await region.evaluate((el) => el.closest(".overflow-y-auto")!.scrollTo({ top: 1e6 }));
  const more = region.getByRole("button", { name: "Load more" });
  await expect(more).toBeInViewport();
  await more.click();
  await expect(hits).toHaveCount(44, { timeout: 15_000 });
  await expect(results.getByRole("status")).toHaveText("44 results");
  await expect(more).toHaveCount(0);
  const last = hits.last().getByTestId("body-match");
  await last.scrollIntoViewIfNeeded();
  const href = await last.getAttribute("href");
  expect(href).not.toBeNull();
  const lastNote = bodies.find((n) => href!.startsWith(pathOf(n)));
  expect(lastNote, `片段 href ${href} 對得到某篇內文筆記`).toBeDefined();
  await last.click();
  await page.waitForURL((u) => u.pathname === pathOf(lastNote!), { timeout: 15_000 });
  await expect(titleBox(page)).toHaveValue(lastNote!.title, { timeout: 15_000 });
});

test("E6 other note, hit deep in a long section: clicking the snippet brings the block with the text into view and flashes it, the section heading does not flash", async ({ page }) => {
  test.setTimeout(120_000);
  await asNewUser(page, "E2E Fulltext E6");
  const stamp = Date.now();
  const kz = `kz${stamp}`;
  const md = `## Long\n\n${filler("long", 60)}\n\ndeep inside ${kz} here\n\n${filler("tail", 40)}\n`;
  const a = await createNoteViaApi(page, `E2E ft L ${stamp}`, md);
  const b = await createNoteViaApi(page, `E2E ft M ${stamp}`);
  const hit = await waitIndexed(page, kz, a.id);
  expect(hit.heading).toBe("Long");

  await page.goto(pathOf(b));
  await expect(titleBox(page)).toHaveValue(b.title, { timeout: 15_000 });
  const sidebar = page.getByRole("complementary");
  await sidebar.getByRole("textbox", { name: "Search notes" }).fill(kz);
  const snippet = snippetOf(sidebar, `${pathOf(a)}#b-${hit.sectionId}`);
  await expect(snippet).toBeVisible({ timeout: 15_000 });
  await snippet.click();
  await page.waitForURL((u) => u.pathname === pathOf(a) && u.hash === `#b-${hit.sectionId}`, { timeout: 15_000 });
  expect(page.url()).not.toContain(kz);
  await expect(titleBox(page)).toHaveValue(a.title, { timeout: 15_000 });
  const hitId = await matchBlockId(page, kz);
  expect(hitId).not.toBe(hit.sectionId);
  await expectAnchorFlash(page, hitId);
  await expect(block(page, hitId)).toBeInViewport();
  await expect(block(page, hit.sectionId)).not.toBeInViewport();
  await expectBlockCentered(page, hitId);
  await expect(page.locator(`.kn-anchor-flash[data-anchor-flash="${hit.sectionId}"]`)).toHaveCount(0);

  // Reload: navigation state stays in the history entry, so it jumps again like `#b-` does (known-limitations is written to match).
  await page.reload();
  await expect(titleBox(page)).toBeVisible({ timeout: 15_000 });
  await expect(titleBox(page)).toHaveValue(a.title, { timeout: 15_000 });
  await expectAnchorFlash(page, hitId);
});

test("E7 table cell: a hit returns the table's block and flashes it (a cell is <td><p>, without .bn-inline-content)", async ({ page }) => {
  test.setTimeout(120_000);
  await asNewUser(page, "E2E Fulltext E7");
  const stamp = Date.now();
  const kt = `kt${stamp}`;
  const md = `## Sec

${filler("sec", 20)}

| col a | col b |
| --- | --- |
| plain | ${kt} |

${filler("mid", 20)}
`;
  const a = await createNoteViaApi(page, `E2E ft T ${stamp}`, md);
  const hit = await waitIndexed(page, kt, a.id);
  const idOfType = async (type: string) =>
    page.locator(`.bn-block-outer:has(> .bn-block > .bn-block-content[data-content-type="${type}"])`).first().getAttribute("data-id");

  await page.goto("/");
  const sidebar = page.getByRole("complementary");
  const search = sidebar.getByRole("textbox", { name: "Search notes" });
  await search.fill(kt);
  const snippet = snippetOf(sidebar, `${pathOf(a)}#b-${hit.sectionId}`);
  await expect(snippet).toBeVisible({ timeout: 15_000 });
  await snippet.click();
  await expect(titleBox(page)).toHaveValue(a.title, { timeout: 15_000 });
  const tableId = await idOfType("table");
  expect(tableId).not.toBeNull();
  await expectAnchorFlash(page, tableId!);
  await expect(block(page, tableId!)).toBeInViewport();
});

test("E8 hit in a collapsed toggle child: the flash is on the toggle block (the child is hidden) and it is inside the viewport", async ({ page }) => {
  test.setTimeout(120_000);
  await asNewUser(page, "E2E Fulltext E8");
  const stamp = Date.now();
  const kg = `kg${stamp}`;
  const a = await createNoteViaApi(page, `E2E ft G ${stamp}`, `## Sec

${filler("sec", 25)}

last paragraph
`);
  await page.goto(pathOf(a));
  await expect(titleBox(page)).toHaveValue(a.title, { timeout: 15_000 });
  await page.getByText("last paragraph").click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/toggle list");
  await page.keyboard.press("Enter");
  await page.keyboard.type("toggle parent");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type(`child ${kg}`);
  const hit = await waitIndexed(page, kg, a.id);

  await page.goto("/");
  await page.goto(pathOf(a));
  await expect(titleBox(page)).toHaveValue(a.title, { timeout: 15_000 });
  const parent = page.locator(".bn-block-outer:has(> .bn-block > .bn-block-content .bn-toggle-wrapper)").first();
  const toggleId = await parent.getAttribute("data-id");
  expect(toggleId).not.toBeNull();
  await parent.locator("> .bn-block > .bn-block-content .bn-toggle-button").click();
  await expect(parent.locator('> .bn-block > .bn-block-content .bn-toggle-wrapper')).toHaveAttribute("data-show-children", "false");
  await expect(page.locator(".bn-block-outer", { hasText: `child ${kg}` }).last()).toBeHidden();
  await page.evaluate(() => document.querySelector(".overflow-y-auto")?.scrollTo({ top: 0 }));

  const sidebar = page.getByRole("complementary");
  await sidebar.getByRole("textbox", { name: "Search notes" }).fill(kg);
  const snippet = snippetOf(sidebar, `${pathOf(a)}#b-${hit.sectionId}`);
  await expect(snippet).toBeVisible({ timeout: 15_000 });
  await snippet.click();
  await expectAnchorFlash(page, toggleId!);
  await expect(block(page, toggleId!)).toBeInViewport();
  await expect(page.locator(".bn-block-outer", { hasText: `child ${kg}` }).last()).toBeHidden();
});

test("E9 several hits in one note give several items: three hits, three items (three lines each); clicking item 2 jumps to the second hit's block and lands mid-viewport; a plain #b- link still scrolls to the top", async ({ page }) => {
  test.setTimeout(120_000);
  await asNewUser(page, "E2E Fulltext E9");
  const stamp = Date.now();
  const km = `km${stamp}`;
  // One hit in each of three paragraphs; each has >= 25 paragraphs above and below so it can scroll to mid-viewport.
  const sec = (n: number) => `## Sec ${n}

${filler(`s${n}a`, 25)}

the ${km} hit ${n}

${filler(`s${n}b`, 25)}
`;
  const md = `${sec(1)}
${sec(2)}
${sec(3)}`;
  const a = await createNoteViaApi(page, `E2E ft M9 ${stamp}`, md);
  let sections: string[] = [];
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`/api/search?q=${encodeURIComponent(km)}&match=body`);
        if (res.status() !== 200) return 0;
        const h = ((await res.json()) as { hits: SearchHit[] }).hits.find((x) => x.note.id === a.id);
        sections = h?.matches.map((m) => m.sectionId) ?? [];
        return sections.length;
      },
      { intervals: [500, 1000], timeout: 20_000 },
    )
    .toBe(3);

  await page.goto("/");
  const sidebar = page.getByRole("complementary");
  await sidebar.getByRole("textbox", { name: "Search notes" }).fill(km);
  const items = bodyRegion(sidebar).getByTestId("body-match");
  await expect(items).toHaveCount(3, { timeout: 15_000 });
  await expect(bodyRegion(sidebar).getByTestId("search-hit")).toHaveCount(3);
  await expect(sidebar.getByTestId("sidebar-search").getByRole("status")).toHaveText("3 results");
  for (let i = 0; i < 3; i += 1) {
    const item = items.nth(i);
    await expect(item).toHaveAttribute("href", `${pathOf(a)}#b-${sections[i]}`);
    await expect(item.locator(":scope > div")).toHaveCount(3);
    await expect(item.locator(":scope > div").nth(0)).toHaveText(a.title);
    await expect(item.locator(":scope > div").nth(1)).toContainText("My notes");
    await expect(item.locator(":scope > div").nth(2)).toContainText(`hit ${i + 1}`);
    await expect(item).not.toContainText(`Sec ${i + 1}`); // the section heading is not shown
  }

  await items.nth(1).click();
  await page.waitForURL((u) => u.pathname === pathOf(a) && u.hash === `#b-${sections[1]}`, { timeout: 15_000 });
  await expect(titleBox(page)).toHaveValue(a.title, { timeout: 15_000 });
  const secondId = await matchBlockId(page, `${km} hit 2`);
  expect(secondId).not.toBe(sections[1]);
  await expectAnchorFlash(page, secondId);
  await expect(block(page, secondId)).toContainText(`hit 2`);
  await expectBlockCentered(page, secondId);

  // Contrast: a plain #b- link without kbFind (a copied section link) still scrolls the heading to the top (upper part of the viewport, not the middle).
  await page.goto("/"); // leave first: a goto that differs only by hash is a same-document navigation, which neither reloads nor scrolls again
  await page.goto(`${pathOf(a)}#b-${sections[1]}`);
  await expect(titleBox(page)).toHaveValue(a.title, { timeout: 15_000 });
  await expectAnchorFlash(page, sections[1]!);
  await expect
    .poll(async () => block(page, sections[1]!).evaluate((el) => el.getBoundingClientRect().top / window.innerHeight), { timeout: 10_000 })
    .toBeLessThan(0.25);
});

test("E10 block taller than the viewport (a list parent wrapping many children): centers on the parent's own line; the hit line is inside the viewport and mid-viewport", async ({ page }) => {
  test.setTimeout(120_000);
  await asNewUser(page, "E2E Fulltext E10");
  const stamp = Date.now();
  const kq = `kq${stamp}`;
  const children = Array.from({ length: 60 }, (_, i) => `  - child ${i + 1} text`).join(String.fromCharCode(10));
  const md = `## Sec

${filler("pre", 25)}

- parent ${kq} line
${children}

${filler("post", 25)}
`;
  const a = await createNoteViaApi(page, `E2E ft P10 ${stamp}`, md);
  const hit = await waitIndexed(page, kq, a.id);

  await page.goto("/");
  const sidebar = page.getByRole("complementary");
  await sidebar.getByRole("textbox", { name: "Search notes" }).fill(kq);
  const snippet = snippetOf(sidebar, `${pathOf(a)}#b-${hit.sectionId}`);
  await expect(snippet).toBeVisible({ timeout: 15_000 });
  await snippet.click();
  await expect(titleBox(page)).toHaveValue(a.title, { timeout: 15_000 });
  const parentId = await matchBlockId(page, kq);
  await expectAnchorFlash(page, parentId);
  // Precondition: the whole parent block (with its children) is taller than the viewport, otherwise this test measures nothing.
  const outerHeight = await block(page, parentId).evaluate((el) => el.getBoundingClientRect().height);
  expect(outerHeight, "父項 block 要比視窗高").toBeGreaterThan(page.viewportSize()!.height);
  const line = block(page, parentId).locator(":scope > .bn-block > .bn-block-content");
  await expect(line).toContainText(kq);
  await expect(line).toBeInViewport({ ratio: 1 });
  await expect
    .poll(async () =>
      line.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const c = (r.top + r.height / 2) / window.innerHeight;
        return c >= 0.25 && c <= 0.75;
      }), { timeout: 10_000, message: "命中那一行的中心應在視窗高度的 25%–75%" })
    .toBe(true);
});

test("E11 persistent marker: after two flashes it stays lit (still there after 3 s) -> Esc clears it; jumping again -> clearing the query clears it", async ({ page }) => {
  test.setTimeout(120_000);
  await asNewUser(page, "E2E Fulltext E11");
  const stamp = Date.now();
  const kk = `kk${stamp}`;
  const md = `## Alpha\n\n${filler("alpha", 25)}\n\n## Beta\n\nthe ${kk} is here\n\n${filler("beta", 40)}\n`;
  const a = await createNoteViaApi(page, `E2E ft K ${stamp}`, md);
  const hit = await waitIndexed(page, kk, a.id);

  await page.goto("/");
  const sidebar = page.getByRole("complementary");
  const search = sidebar.getByRole("textbox", { name: "Search notes" });
  await search.fill(kk);
  const snippet = snippetOf(sidebar, `${pathOf(a)}#b-${hit.sectionId}`);
  await expect(snippet).toBeVisible({ timeout: 15_000 });
  await snippet.click();
  await expect(titleBox(page)).toHaveValue(a.title, { timeout: 15_000 });
  const hitId = await matchBlockId(page, kk);
  await expectAnchorFlash(page, hitId);
  const mark = page.locator(`.kn-anchor-flash.kn-anchor-mark[data-anchor-flash="${hitId}"]`);
  await expect(mark).toBeAttached();

  // Stays lit: after the flash time (2 s) plus one more second the marker is still there, still on that block, and its background is lit (not the transparent end of an animation).
  await page.waitForTimeout(3_000);
  await expect(mark).toBeAttached();
  await expectAnchorFlash(page, hitId);
  expect(await mark.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);

  // The first jump from home swaps shells (home AppShell -> note page AppShell); the query is not reset (#369: the query lives in the App layer).
  await expect(sidebar.getByRole("textbox", { name: "Search notes" })).toHaveValue(kk);

  // Esc with focus in the editor (real BlockNote: OverrideEscape blurs first, then preventDefault): it clears in one press, not two (#369).
  await page.locator(".bn-editor").first().click();
  await page.keyboard.press("Escape");
  await expect(mark).toHaveCount(0);

  await expect(snippet).toBeVisible({ timeout: 15_000 });
  await snippet.click();
  await expect(mark).toBeAttached({ timeout: 15_000 });
  await page.waitForTimeout(2_500);
  await expect(mark).toBeAttached();
  await sidebar.getByRole("button", { name: "Clear search" }).click();
  await expect(mark).toHaveCount(0);
});


for (const motion of ["no-preference", "reduce"] as const) {
  test(`E11b marker flashes visibly twice (prefers-reduced-motion: ${motion}): sampling the background during the animation shows at least two dim->lit rises, ending lit at the same strength as the persistent state`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.emulateMedia({ reducedMotion: motion });
    await asNewUser(page, `E2E Fulltext E11b ${motion}`);
    const stamp = Date.now();
    const kk = `kb${stamp}`;
    const md = `## Alpha\n\n${filler("alpha", 25)}\n\n## Beta\n\nthe ${kk} is here\n\n${filler("beta", 40)}\n`;
    const a = await createNoteViaApi(page, `E2E ft KB ${stamp}`, md);
    const hit = await waitIndexed(page, kk, a.id);

    await page.goto("/");
    const sidebar = page.getByRole("complementary");
    await sidebar.getByRole("textbox", { name: "Search notes" }).fill(kk);
    const snippet = snippetOf(sidebar, `${pathOf(a)}#b-${hit.sectionId}`);
    await expect(snippet).toBeVisible({ timeout: 15_000 });
    // Install the sampler before clicking (every 30 ms it reads the overlay's computed background alpha and class); records null until the overlay appears.
    await page.evaluate(() => {
      // The computed value may be oklab()/oklch()/rgba()/transparent.
      const alphaOf = (c: string): number => {
        if (c === "transparent") return 0;
        const m = /\/\s*([\d.]+)\s*\)/.exec(c);
        return m ? Number(m[1]) : 1;
      };
      const log: Array<{ t: number; a: number | null; mark: boolean }> = [];
      (window as unknown as { __markLog: typeof log }).__markLog = log;
      const t0 = performance.now();
      setInterval(() => {
        const o = document.querySelector<HTMLElement>(".kn-anchor-flash");
        log.push({ t: Math.round(performance.now() - t0), a: o ? alphaOf(getComputedStyle(o).backgroundColor) : null, mark: o?.classList.contains("kn-anchor-mark") ?? false });
      }, 30);
    });
    await snippet.click();
    await expect(titleBox(page)).toHaveValue(a.title, { timeout: 15_000 });
    await page.waitForTimeout(4_000);
    const log = await page.evaluate(() => (window as unknown as { __markLog: Array<{ t: number; a: number | null; mark: boolean }> }).__markLog);

    // The animation starts after the mark class (once scrolling settles): only take samples after mark=true.
    const firstMark = log.findIndex((s) => s.mark);
    expect(firstMark, "應該出現過 .kn-anchor-mark").toBeGreaterThanOrEqual(0);
    const seq = log.slice(firstMark).map((s) => s.a ?? 0);
    const DARK = 0.12;
    const LIGHT = 0.3;
    let rises = 0;
    let dark = false;
    for (const v of seq) {
      if (v < DARK) dark = true;
      else if (v > LIGHT && dark) {
        rises++;
        dark = false;
      }
    }
    expect(rises, `應該有至少兩次 淡→亮（取樣：${seq.map((v) => v.toFixed(2)).join(" ")}）`).toBeGreaterThanOrEqual(2);
    const last = seq.at(-1)!;
    // Ends lit at the persistent strength (brand 38%).
    expect(last).toBeGreaterThan(0.33);
    expect(last).toBeLessThan(0.43);
    // The flash lasts about 1.2-1.6 s: from the first mark sample to the last change.
    const settledAt = log.slice(firstMark).findIndex((_, i, arr) => arr.slice(i).every((s) => Math.abs((s.a ?? 0) - last) < 0.005));
    const dur = log[firstMark + settledAt]!.t - log[firstMark]!.t;
    expect(dur).toBeGreaterThan(1_100);
    expect(dur).toBeLessThan(2_000);
  });
}

test("E11c home search -> click a result (shell swap) -> clearing the query on the note page clears the marker; the query is still there after the swap", async ({ page }) => {
  test.setTimeout(120_000);
  await asNewUser(page, "E2E Fulltext E11c");
  const stamp = Date.now();
  const kk = `kc${stamp}`;
  const md = `## Alpha\n\n${filler("alpha", 25)}\n\n## Beta\n\nthe ${kk} is here\n\n${filler("beta", 40)}\n`;
  const a = await createNoteViaApi(page, `E2E ft KC ${stamp}`, md);
  const hit = await waitIndexed(page, kk, a.id);

  await page.goto("/");
  const sidebar = page.getByRole("complementary");
  const search = sidebar.getByRole("textbox", { name: "Search notes" });
  await search.fill(kk);
  await snippetOf(sidebar, `${pathOf(a)}#b-${hit.sectionId}`).click();
  await expect(titleBox(page)).toHaveValue(a.title, { timeout: 15_000 });
  const hitId = await matchBlockId(page, kk);
  const mark = page.locator(`.kn-anchor-flash.kn-anchor-mark[data-anchor-flash="${hitId}"]`);
  await expect(mark).toBeAttached({ timeout: 15_000 });
  await expect(search).toHaveValue(kk);
  await sidebar.getByRole("button", { name: "Clear search" }).click();
  await expect(search).toHaveValue("");
  await expect(mark).toHaveCount(0);
});
