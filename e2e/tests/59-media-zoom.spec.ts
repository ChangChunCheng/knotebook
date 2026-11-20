import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { E2E_ORIGIN } from "../ports.js";
import { ADMIN, createUserViaInvite, editorLocator, loginAs, randomEmail, solidPng } from "./helpers.js";

/**
 * #462: zoomed view of images and mermaid diagrams.
 *
 * 59-2: the zoomed content is the same diagram's `<svg>` (not a bitmap, with a different root id) on the card background, so the light theme's lines and text are visible.
 * 59-5: touch devices have no hover, so the control group at the top right stays visible in a faint color (it must be visible to be tappable).
 *
 * Account and data: one account (alice) is created through an invite and each case creates its own note with an image and a mermaid diagram via the API.
 * Pinch zoom and the PWA safe area can't be measured and need a real device.
 */

// Playwright actions have no timeout by default: if something can't be clicked it waits until the whole case times out, and it isn't visible which step is stuck.
test.use({ actionTimeout: 15_000 });

const RUN = Date.now();
const PASSWORD = "e2e-media-zoom-pw";
const ORIGIN = E2E_ORIGIN;
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
const IMAGE = { width: 1600, height: 1000 };

let alice: { email: string; displayName: string };

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  alice = { email: randomEmail(), displayName: `alice ${RUN}` };
  const admin = await browser.newContext();
  try {
    const page = await admin.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await createUserViaInvite(page, { ...alice, password: PASSWORD });
  } finally {
    await admin.close();
  }
});

interface NoteRef {
  id: string;
  title: string;
  path: string;
}

/** Creates a note: first uploads a 1600x1000 image, then writes the whole note (a paragraph, that image shown at width 400, and a mermaid diagram). */
async function createZoomNote(page: Page, label: string): Promise<NoteRef> {
  const title = `E2E media zoom ${label} ${RUN}`;
  const res = await page.request.post("/api/notes", { headers: { Origin: ORIGIN }, data: { title } });
  expect(res.status(), await res.text()).toBe(201);
  const note = (await res.json()) as { id: string; slug: string; ownerHandle: string };
  const upload = await page.request.post(`/api/notes/${note.id}/uploads`, {
    headers: { Origin: ORIGIN },
    multipart: { file: { name: "box.png", mimeType: "image/png", buffer: solidPng(IMAGE.width, IMAGE.height) } },
  });
  expect(upload.status(), await upload.text()).toBe(201);
  const { url } = (await upload.json()) as { url: string };
  const current = await page.request.get(`/api/notes/${note.id}/content`);
  const { fingerprint } = (await current.json()) as { fingerprint: string };
  const markdown = [
    "lead words",
    "",
    `<figure><img alt="box" src="${url}" width="400"></figure>`,
    "",
    "```mermaid",
    "graph LR",
    "  A[ZoomStart] --> B[ZoomEnd]",
    "```",
    "",
    "tail words",
  ].join("\n");
  const written = await page.request.post(`/api/notes/${note.id}/edits`, {
    headers: { Origin: ORIGIN },
    data: { op: "replace_all", markdown, if_match: fingerprint },
  });
  expect(written.status(), await written.text()).toBeLessThan(300);
  return { id: note.id, title, path: `/n/${note.ownerHandle}/${note.slug}` };
}

async function openZoomNote(
  browser: Browser,
  label: string,
  options: { viewport: { width: number; height: number }; touch?: boolean },
): Promise<{ context: BrowserContext; page: Page; note: NoteRef }> {
  const context = await browser.newContext(
    options.touch ? { hasTouch: true, isMobile: true, viewport: options.viewport } : { viewport: options.viewport },
  );
  const page = await context.newPage();
  await loginAs(page, alice.email, PASSWORD);
  await expect(page).toHaveURL(/\/$/);
  const note = await createZoomNote(page, label);
  await page.goto(note.path);
  await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible({ timeout: 15_000 });
  await expect(editorLocator(page)).toBeVisible({ timeout: 15_000 });
  await expectLoaded(editorImage(page));
  return { context, page, note };
}

function editorImage(page: Page): Locator {
  return editorLocator(page).locator('[data-content-type="image"] img').first();
}

function mermaidBlock(page: Page): Locator {
  return editorLocator(page).locator('[data-content-type="mermaid"]').first();
}

function imageZoomButton(page: Page): Locator {
  return page.locator("[data-kb-zoom-layer]").getByRole("button", { name: "Zoom in", exact: true });
}

async function expectLoaded(img: Locator): Promise<void> {
  await expect(img).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 15_000 }).toBeGreaterThan(0);
}

async function widthOf(target: Locator): Promise<number> {
  const box = await target.boundingBox();
  expect(box, "元素要有版面").not.toBeNull();
  return box!.width;
}

async function expectWheelZoomsIn(page: Page, viewport: { width: number; height: number }, content: Locator): Promise<void> {
  const before = await widthOf(content);
  await page.mouse.move(viewport.width / 2, viewport.height / 2);
  await page.mouse.wheel(0, -400);
  await expect.poll(async () => widthOf(content)).toBeGreaterThan(before + 1);
}

test("59-1 desktop image: the zoom button appears on hover, clicking opens the zoom, the wheel zooms, Esc returns focus to the button; clicking the image itself selects it", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await openZoomNote(browser, "desktop image", { viewport: DESKTOP });
  try {
    const img = editorImage(page);
    const button = imageZoomButton(page);
    await expect(button).toHaveCount(0);
    await img.hover();
    await expect(button).toBeVisible();

    await button.click();
    const dialog = page.getByRole("dialog", { name: "box" });
    await expect(dialog).toBeVisible();
    const zoomed = dialog.locator("img");
    await expect(zoomed).toBeVisible();
    expect(await widthOf(zoomed)).toBeLessThanOrEqual(DESKTOP.width + 0.5);
    await expectWheelZoomsIn(page, DESKTOP, zoomed);

    // When Esc is pressed the pointer is at the mermaid diagram's position: after closing, what is under the pointer is another block and not the image, and focus must still return to the zoom button.
    const other = (await mermaidBlock(page).boundingBox())!;
    expect(other.y + other.height / 2, "前提：mermaid 圖在視窗內").toBeLessThan(DESKTOP.height);
    await page.mouse.move(other.x + other.width / 2, other.y + other.height / 2);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(button).toBeFocused();

    await img.click();
    await expect(page.locator(".bn-formatting-toolbar")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("59-2 desktop mermaid: the zoom button is right of Edit, the zoomed content is the same diagram's svg on the card background, Esc returns focus to the button; clicking the diagram enters the source", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await openZoomNote(browser, "desktop mermaid", { viewport: DESKTOP });
  try {
    const block = mermaidBlock(page);
    const pageSvg = block.locator("svg[aria-roledescription]");
    await expect(pageSvg).toBeVisible({ timeout: 20_000 });
    await expect(pageSvg).toContainText("ZoomStart");

    const group = block.locator(".block-control-group");
    await expect(group).toHaveCSS("opacity", "0");
    await block.hover();
    await expect(group).toHaveCSS("opacity", "1");
    const zoom = block.getByRole("button", { name: "Zoom in", exact: true });
    const edit = block.getByRole("button", { name: "Edit", exact: true });
    await expect(zoom).toBeVisible();
    await expect(edit).toBeVisible();
    expect((await zoom.boundingBox())!.x, "放大鈕在 Edit 右邊").toBeGreaterThan((await edit.boundingBox())!.x);

    await zoom.click();
    const dialog = page.getByRole("dialog", { name: "Diagram", exact: true });
    await expect(dialog).toBeVisible();
    const zoomedSvg = dialog.locator("svg[aria-roledescription]");
    await expect(zoomedSvg).toHaveCount(1);
    await expect(dialog.locator("img")).toHaveCount(0);
    await expect(zoomedSvg).toContainText("ZoomStart");
    const [pageId, zoomedId] = [await pageSvg.getAttribute("id"), await zoomedSvg.getAttribute("id")];
    expect(zoomedId, "放大的那份換了根 id").not.toBe(pageId);

    // The content sits on the card background: the light theme's mermaid draws lines and text in dark gray and the svg has no background, so on the dark backdrop it would be invisible.
    const colors = await zoomedSvg.evaluate((svg) => {
      const probe = document.createElement("div");
      probe.className = "bg-card";
      document.body.appendChild(probe);
      const card = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { content: getComputedStyle(svg.parentElement!).backgroundColor, card };
    });
    expect(colors.card).not.toBe("rgba(0, 0, 0, 0)");
    expect(colors.content, "放大內容的底色是卡面色").toBe(colors.card);

    await expectWheelZoomsIn(page, DESKTOP, zoomedSvg);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(zoom).toBeFocused();

    await pageSvg.click();
    await expect(page.getByRole("textbox", { name: "Mermaid source" })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("59-3 public page: clicking an image zooms directly and Esc returns focus to the image; a focused mermaid diagram zooms with Enter", async ({ browser }) => {
  test.setTimeout(120_000);
  let note: NoteRef;
  let token: string;
  const owner = await browser.newContext({ viewport: DESKTOP });
  try {
    const page = await owner.newPage();
    await loginAs(page, alice.email, PASSWORD);
    await expect(page).toHaveURL(/\/$/);
    note = await createZoomNote(page, "public");
    const res = await page.request.put(`/api/notes/${note.id}/public-link`, { headers: { Origin: ORIGIN } });
    expect(res.status(), await res.text()).toBe(200);
    token = ((await res.json()) as { token: string }).token;
    // The public endpoint reads the saved content: wait until it contains the upload URL (the image has been written) before opening.
    await expect(async () => {
      const pub = await page.request.get(`/api/public/notes/${token}`);
      expect(pub.status()).toBe(200);
      const body = (await pub.json()) as { ydoc: string };
      expect(Buffer.from(body.ydoc, "base64").toString("utf8")).toContain("/api/uploads/");
    }).toPass({ timeout: 20_000 });
  } finally {
    await owner.close();
  }

  const anonymous = await browser.newContext({ viewport: DESKTOP });
  try {
    const page = await anonymous.newPage();
    await page.goto(`/p/${token}`);
    await expect(page.getByRole("heading", { name: note.title, level: 1 })).toBeVisible({ timeout: 15_000 });
    const img = page.locator(`img[src*="/api/public/notes/${token}/uploads/"]`);
    await expectLoaded(img);

    await img.click();
    const imageDialog = page.getByRole("dialog", { name: "box" });
    await expect(imageDialog).toBeVisible();
    await expect(imageDialog.locator("img")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(imageDialog).toHaveCount(0);
    await expect(img).toBeFocused();

    // When read-only the whole mermaid diagram is one "Zoom in on diagram" button (the zoom button at the top right is hidden from assistive technology).
    await expect(page.locator("svg[aria-roledescription]")).toContainText("ZoomStart", { timeout: 20_000 });
    const diagram = page.getByRole("button", { name: "Zoom in on diagram", exact: true });
    await expect(diagram).toHaveCount(1);
    await diagram.focus();
    await page.keyboard.press("Enter");
    const diagramDialog = page.getByRole("dialog", { name: "Diagram", exact: true });
    await expect(diagramDialog).toBeVisible();
    await expect(diagramDialog.locator("svg[aria-roledescription]")).toContainText("ZoomStart");
    await page.keyboard.press("Escape");
    await expect(diagramDialog).toHaveCount(0);
    await expect(diagram).toBeFocused();
  } finally {
    await anonymous.close();
  }
});

test("59-4 editable on a phone: the zoom button only appears after tapping to select the image; the zoom view fills the viewport and the close button is inside it", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await openZoomNote(browser, "phone image", { viewport: PHONE, touch: true });
  try {
    const img = editorImage(page);
    const button = imageZoomButton(page);
    await img.scrollIntoViewIfNeeded();
    await expect(button).toHaveCount(0);
    await img.tap();
    await expect(button).toBeVisible({ timeout: 10_000 });

    await button.tap();
    const dialog = page.getByRole("dialog", { name: "box" });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("img")).toBeVisible();
    const viewport = (await dialog.locator("[data-zoom-viewport]").boundingBox())!;
    expect(viewport.x).toBeCloseTo(0, 0);
    expect(viewport.y).toBeCloseTo(0, 0);
    expect(viewport.width).toBeCloseTo(PHONE.width, 0);
    expect(viewport.height).toBeCloseTo(PHONE.height, 0);

    const close = dialog.getByRole("button", { name: "Close", exact: true });
    const box = (await close.boundingBox())!;
    expect(box.x, "關閉鈕左緣").toBeGreaterThanOrEqual(0);
    expect(box.y, "關閉鈕上緣").toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, "關閉鈕右緣").toBeLessThanOrEqual(PHONE.width);
    expect(box.y + box.height, "關閉鈕下緣").toBeLessThanOrEqual(PHONE.height);
    await close.tap();
    await expect(dialog).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("59-5 phone mermaid: without hover the control group at the top right is still visible (a faint persistent color)", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await openZoomNote(browser, "phone mermaid", { viewport: PHONE, touch: true });
  try {
    const block = mermaidBlock(page);
    await block.scrollIntoViewIfNeeded();
    await expect(block.locator("svg[aria-roledescription]")).toBeVisible({ timeout: 20_000 });
    const group = block.locator(".block-control-group");
    await expect(group.getByRole("button", { name: "Zoom in", exact: true })).toBeVisible();
    const opacity = Number(await group.evaluate((el) => getComputedStyle(el).opacity));
    expect(opacity, "淡色：看得到").toBeGreaterThan(0);
    expect(opacity, "淡色：不是全對比").toBeLessThan(1);
  } finally {
    await context.close();
  }
});
