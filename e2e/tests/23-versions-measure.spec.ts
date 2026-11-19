import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { E2E_ORIGIN } from "../ports.js";
import { ADMIN, editorLocator, loginAs, setAutoWait, waitForEditorSelection } from "./helpers.js";

/**
 * Measurement (not a functional assertion): whether the first keystroke / opening and closing on an old note cuts an extra
 * version; how long a 2000-block preview takes in a real browser.
 * Numbers are printed as `MEASURE-...` lines. The expectation (no extra version) is a product requirement: if it holds this
 * stays as a guard; if it does not, that is a finding to report.
 */
const COMPOSE = ["compose", "-p", process.env.E2E_PROJECT || "knotebook-e2e", "-f", "../docker-compose.yml", "-f", "../docker-compose.e2e.yml"];
const ORIGIN = E2E_ORIGIN;
/** 40x40 grey PNG (a 1x1 cannot be clicked in the editor). */
const PNG_40 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAIAAAADnC86AAAAK0lEQVR4nO3NMQ0AAAwDoMqv7JpYsgcMkD6JWCwWi8VisVgsFovFYrFYfGcPqfaI6W3y9QAAAABJRU5ErkJggg==",
  "base64",
);
const SEED = readFileSync(fileURLToPath(new URL("./fixtures/seed-legacy-note.cjs", import.meta.url)), "utf8");

async function versionCount(request: APIRequestContext, id: string): Promise<number> {
  const res = await request.get(`/api/notes/${id}/versions?limit=100`);
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { versions: unknown[] }).versions.length;
}

/**
 * #272: wait for that note's version count to settle - after leaving, persistence (debounce 2 s) marks it pending, and after
 * the idle wait X (test hook, 2 s) the scanner (one pass per second on the e2e stack) cuts it; settled = unchanged for 6
 * consecutive seconds (X 2 + scan 1 + persist 2 + margin).
 */
async function settledCount(request: APIRequestContext, id: string): Promise<number> {
  let last = -1;
  let stableSince = Date.now();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const n = await versionCount(request, id);
    if (n !== last) {
      last = n;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= 6_000) return n;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`settledCount: 版本數 30 秒內沒有穩定（最後一次 ${last}）`);
}

// #272: 23a uses a test hook to shrink the wait X to 2 seconds; after every case always set it back to the site setting (also when it failed midway - the setting is shared by the whole stack).
test.afterEach(async ({ page }) => {
  await setAutoWait(page, null).catch(() => undefined);
});

async function openAndWait(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible({ timeout: 15_000 });
  await editorLocator(page).waitFor({ timeout: 15_000 });
}

test("23a: old-schema note - open and close, type and delete one character in each of heading / paragraph / list item, change an image caption and clear it: how many extra versions each cuts", async ({ page }) => {
  test.setTimeout(240_000);
  await loginAs(page, ADMIN.email, ADMIN.password);
  await setAutoWait(page, 2);
  const created = await page.request.post("/api/notes", { data: { title: `E2E legacy ${Date.now()}` } });
  expect(created.ok()).toBe(true);
  const note = (await created.json()) as { id: string; ownerHandle: string; slug: string };
  const upload = await page.request.post(`/api/notes/${note.id}/uploads`, {
    headers: { Origin: ORIGIN },
    multipart: { file: { name: "legacy.png", mimeType: "image/png", buffer: PNG_40 } },
  });
  expect(upload.status()).toBe(201);
  const { url: imageUrl } = (await upload.json()) as { url: string };
  execFileSync("docker", [...COMPOSE, "exec", "-T", "-e", `NOTE_ID=${note.id}`, "-e", `IMAGE_URL=${imageUrl}`, "app", "node", "-e", SEED], {
    stdio: "inherit",
  });
  const path = `/n/${note.ownerHandle}/${note.slug}`;
  expect(await settledCount(page.request, note.id)).toBe(0);

  await openAndWait(page, path);
  await expect(editorLocator(page)).toContainText("Legacy paragraph");
  await expect(editorLocator(page).locator(`img[src*="${imageUrl}"]`)).toBeVisible({ timeout: 15_000 });
  // Wait for the WS to deliver the update to the server before leaving (there is no signal to wait on, so a fixed wait).
  await page.waitForTimeout(3_000);
  await page.goto("/");
  const openClose = await settledCount(page.request, note.id);

  let before = openClose;
  /** Opens the note, does something that nets out to no change, leaves, and returns how many extra versions that round cut. */
  async function roundTrip(act: () => Promise<void>): Promise<number> {
    await openAndWait(page, path);
    await act();
    // Wait for the WS to deliver the update to the server before leaving (there is no signal to wait on, so a fixed wait).
    await page.waitForTimeout(3_000);
    await page.goto("/");
    const after = await settledCount(page.request, note.id);
    const delta = after - before;
    before = after;
    return delta;
  }
  const typeAndDelete = (text: string) => async () => {
    await editorLocator(page).getByText(text).click();
    await page.keyboard.press("End");
    await waitForEditorSelection(page);
    await page.keyboard.type("x");
    await page.keyboard.press("Backspace");
  };
  const heading = await roundTrip(typeAndDelete("Legacy heading"));
  const paragraph = await roundTrip(typeAndDelete("Legacy paragraph"));
  const numbered = await roundTrip(typeAndDelete("Legacy numbered"));
  const image = await roundTrip(async () => {
    const editCaption = async (value: string) => {
      await editorLocator(page).locator(`img[src*="${imageUrl}"]`).click();
      await page.getByRole("button", { name: "Edit caption" }).click();
      const input = page.getByPlaceholder("Edit caption");
      await input.fill(value);
      await input.press("Enter");
    };
    await editCaption("x");
    await expect(editorLocator(page).getByText("x", { exact: true })).toBeVisible();
    await editCaption("");
    await expect(editorLocator(page).getByText("x", { exact: true })).toHaveCount(0);
  });
  const typeDelete = heading + paragraph + numbered + image;

  console.log(
    `MEASURE-13-9 openClose=${openClose} typeDelete=${typeDelete} heading=${heading} paragraph=${paragraph} numberedListItem=${numbered} image=${image}`,
  );
  expect(openClose).toBe(0);
  expect(typeDelete).toBe(0);
});

test("23b: 2000-block note, time from clicking a version row to the diff marks appearing (real browser)", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1500, height: 900 });
  await loginAs(page, ADMIN.email, ADMIN.password);
  const content = Array.from({ length: 2000 }, (_, i) => `第 ${i} 段 measure 內容內容內容內容`).join("\n\n");
  const created = await page.request.post("/api/notes", { data: { title: `E2E 2000 ${Date.now()}`, content } });
  expect(created.ok()).toBe(true);
  const note = (await created.json()) as { id: string; ownerHandle: string; slug: string };
  // #272: creating with content no longer cuts v1 right away - first save one version "created" manually, as the version of "the content at creation".
  const saved = await page.request.post(`/api/notes/${note.id}/versions`, { headers: { Origin: ORIGIN }, data: { name: "created" } });
  expect(saved.status()).toBe(201);
  await openAndWait(page, `/n/${note.ownerHandle}/${note.slug}`);
  await editorLocator(page).getByText("第 0 段 measure", { exact: false }).click();
  await page.keyboard.type(" edited");
  await page.keyboard.press("Control+s");
  const dialog = page.getByRole("dialog", { name: "Save current version" });
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByTestId("versions-bubble").click();
  const panel = page.getByTestId("versions-panel");
  // Click created, not the version just saved: the comparison is a left/right pair, clicking a row changes only the left, and the
  // right defaults to the current state. The version just saved has the same content as the current state, so there is no
  // difference; created (the content at creation) differs from the current state in paragraph 0.
  const row = panel.getByRole("button", { name: /^created \(/ });
  await expect(row).toBeVisible({ timeout: 15_000 });
  const t0 = Date.now();
  await row.click();
  // Look at side-by-side (diff-split), not single column: with the panel open in a 1500 px window the preview area is about 810 px,
  // past the 720 px threshold, so it goes side by side automatically and the DOM has no diff-single.
  // Wait for the first non-context data-diff mark in the side-by-side columns to be visible (both sides are marked independently, not necessarily "changed").
  await expect(page.locator('[data-testid="diff-split"] [data-diff]:not([data-diff="context"])').first()).toBeVisible({
    timeout: 60_000,
  });
  const previewMs = Date.now() - t0;
  console.log(`MEASURE-13-5 blocks=2000 previewMs=${previewMs} mode=split left=created right=current`);
  expect(previewMs).toBeGreaterThan(0);
});
