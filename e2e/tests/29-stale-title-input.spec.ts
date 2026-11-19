import { expect, test } from "@playwright/test";
import { ADMIN, createNote, loginAs, noteIdFromUrl } from "./helpers.js";

/**
 * Note-switch gap: pressing New note in note A makes react-router change the URL first, and the screen swaps only inside
 * startTransition. During the gap A's title input still accepts typing; before the fix its blur saved the text into A (A got
 * renamed).
 * CPU throttling stretches the gap; a capture-phase input listener confirms the text really went into A's title input (if not,
 * the gap was not reproduced and the test fails directly, no false green).
 * Red at "gap not reproduced" = the environment is too fast and the throttle does not stretch the gap, not a product
 * regression (raise THROTTLE_RATE); a product regression goes red at the final read of A's title.
 */

const THROTTLE_RATE = 20;

test("29 note-switch gap: typing into the title and blurring right after pressing New note in A must not rename A; the new note is named as usual", async ({ page }) => {
  test.setTimeout(120_000);
  await loginAs(page, ADMIN.email, ADMIN.password);
  const stamp = Date.now();
  const titleA = `E2E stale title A ${stamp}`;
  await createNote(page, titleA);
  const idA = await noteIdFromUrl(page);

  const titleInput = page.getByLabel("Note title");
  await titleInput.evaluate((el) => {
    el.setAttribute("data-e2e-note-a", "");
    document.addEventListener(
      "input",
      (event) => {
        if ((event.target as Element | null)?.hasAttribute?.("data-e2e-note-a")) {
          (window as unknown as { __e2eTypedIntoA?: boolean }).__e2eTypedIntoA = true;
        }
      },
      true,
    );
  });

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE_RATE });
  try {
    await page.getByRole("button", { name: "New note", exact: true }).click();
    await page.waitForURL(/\/n\/[^/]+\/untitled-[0-9a-f]{8}$/, { timeout: 30_000 });
    await titleInput.fill(`E2E hijack ${stamp}`);
    await titleInput.blur();
  } finally {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  }

  const typedIntoA = await page.evaluate(() => (window as unknown as { __e2eTypedIntoA?: boolean }).__e2eTypedIntoA === true);
  expect(typedIntoA, "沒重現空窗：字沒打進 A 的標題框").toBe(true);

  const newInput = page.locator('input[aria-label="Note title"]:not([data-e2e-note-a])');
  await expect(newInput).toHaveValue("Untitled", { timeout: 15_000 });
  const titleB = `E2E stale title B ${stamp}`;
  await newInput.fill(titleB);
  await newInput.blur();
  await page.waitForURL(
    (url) => /^\/n\/[^/]+\/[^/]+$/.test(url.pathname) && !/\/untitled-[0-9a-f]{8}$/.test(url.pathname),
    { timeout: 15_000 },
  );
  const idB = await noteIdFromUrl(page);
  expect(idB).not.toBe(idA);
  const resB = await page.request.get(`/api/notes/${idB}`);
  expect(((await resB.json()) as { title: string }).title).toBe(titleB);

  // A's title is unchanged. Read after B is named: if the blur in the gap sent a PATCH, it would have landed well before B's save and the URL settling
  const resA = await page.request.get(`/api/notes/${idA}`);
  expect(resA.status()).toBe(200);
  expect(((await resA.json()) as { title: string }).title).toBe(titleA);
});
