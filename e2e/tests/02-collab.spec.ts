import { test, expect } from "@playwright/test";
import { ADMIN, createNote, editorLocator, loginAs } from "./helpers.js";

/**
 * Two contexts with the same admin account (separate cookie jars, like two devices); sharing and a second user are out of
 * scope here. `ADMIN.password` is the stack's only admin password.
 */
test("two browser contexts co-edit in real time: text syncs both ways", async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  try {
    const pageA = await contextA.newPage();
    await loginAs(pageA, ADMIN.email, ADMIN.password);
    await expect(pageA).toHaveURL(/\/$/);

    const title = `E2E collab ${Date.now()}`;
    await createNote(pageA, title);
    const noteUrl = pageA.url();

    const pageB = await contextB.newPage();
    await loginAs(pageB, ADMIN.email, ADMIN.password);
    await pageB.goto(noteUrl);

    const editorA = editorLocator(pageA);
    const editorB = editorLocator(pageB);
    await editorB.waitFor({ timeout: 15_000 });

    await editorA.click();
    await editorA.pressSequentially("Hello from A");
    await expect(editorB).toContainText("Hello from A", { timeout: 10_000 });

    // Typing must append after the synced content, not overwrite it: click only focuses, leaving the caret position
    // arbitrary, so End moves it to the end of this block first.
    await editorB.click();
    await editorB.press("End");
    await editorB.pressSequentially(" and B");
    await expect(editorA).toContainText("Hello from A and B", { timeout: 10_000 });
  } finally {
    // try/finally: close both contexts even when an assertion fails, so failed runs do not leave browser contexts piling up
    // in the same worker and slowing later specs (a known deferred item).
    await contextA.close();
    await contextB.close();
  }
});
