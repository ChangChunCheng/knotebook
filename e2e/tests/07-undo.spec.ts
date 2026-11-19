import { test, expect } from "@playwright/test";
import { ADMIN, createNote, editorLocator, loginAs } from "./helpers.js";

/**
 * Regression guard for issue #97 (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y did nothing in collaborative mode). It needs e2e (unit
 * counterpart: `apps/web/src/collab/undo.test.tsx`): the defect triggers when the ProseMirror view is torn down and remounted
 * by `<BlockNoteView>`'s mount ref callback (depends on `editable`) at the moment `synced` arrives, which is real connection
 * timing; the original symptom was "unit tests green, Ctrl+Z does nothing in the browser, zero console errors".
 * All three shortcuts are bound to the same UndoManager, so pressing each shows which one is not wired.
 *
 * The #100 test deliberately undoes to empty and then redoes. Before the fix this failed deterministically (the sync plugin's
 * `view.update` writes the post-undo normalization back to the Y.Doc under the tracked origin `ySyncPluginKey`, so
 * `UndoManager` thinks the user edited again and clears the redoStack); after the fix (`guardEmptyDocNormalization` in
 * `collab/undo.ts`) it must stay green even after waiting past the race window, so the 1 second wait in it is part of the
 * test; do not remove it as a redundant sleep.
 */
test("collab note: Ctrl+Z undoes, Ctrl+Shift+Z and Ctrl+Y redo", async ({ page }) => {
  await loginAs(page, ADMIN.email, ADMIN.password);
  await createNote(page, `E2E undo ${Date.now()}`);

  const editor = editorLocator(page);
  // The two strings are chosen so the second is not a substring of the first, which `toContainText` needs to tell them apart:
  // after one undo the document is "alpha" (contains alpha, not beta); if undo failed it is still "alphabeta".
  await editor.click();
  await editor.pressSequentially("alpha");
  // Cross Yjs `UndoManager`'s `captureTimeout` (default 500ms) so the two inputs become **two** history entries; only then
  // can a later step undo one entry and leave the document at the non-empty "alpha".
  await page.waitForTimeout(900);
  await editor.pressSequentially("beta");
  await expect(editor).toContainText("alphabeta");

  await page.keyboard.press("Control+z");
  await expect(editor).not.toContainText("beta");
  // This is also the assertion that only one entry was undone: if the two inputs had merged into one, the document would
  // become empty and this goes red (instead of silently degrading to the flaky undo-to-empty shape).
  await expect(editor).toContainText("alpha");

  await page.keyboard.press("Control+Shift+z");
  await expect(editor).toContainText("alphabeta");

  await page.keyboard.press("Control+z");
  await expect(editor).not.toContainText("beta");

  await page.keyboard.press("Control+y");
  await expect(editor).toContainText("alphabeta");
});

test("redo still works after undoing to an empty document (issue #100)", async ({ page }) => {
  await loginAs(page, ADMIN.email, ADMIN.password);
  await createNote(page, `E2E undo empty ${Date.now()}`);

  const editor = editorLocator(page);
  await editor.click();
  await editor.pressSequentially("gamma");
  await expect(editor).toContainText("gamma");

  // The initial normalization is rejected by the discriminator and not pushed on the stack, so typing is normally a single
  // entry: one undo empties the document and one redo restores everything. On a slow CI, if typing is split in two by
  // captureTimeout (500ms), a single press goes only halfway. Both directions use a converging loop (extra presses on an
  // empty/full stack are no-ops, so they are safe) and the assertions are unchanged: reach fully empty, get back to gamma.
  const undoToEmpty = async (key: string) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      await page.keyboard.press(key);
      if (!(await editor.textContent())?.includes("g")) break;
    }
    await expect(editor).not.toContainText("g");
  };
  const redoUntilRestored = async (key: string) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      await page.keyboard.press(key);
      if ((await editor.textContent())?.includes("gamma")) break;
      // In the split case a normalization race window recurs between two redos, for the same reason as the main wait below.
      await page.waitForTimeout(1000);
    }
    await expect(editor).toContainText("gamma");
  };

  await undoToEmpty("Control+z");

  // This 1s wait is part of the test: the normalization write-back happens about 12ms after undo (triggered by the next PM
  // transaction), and before the fix waiting longer always failed. Redoing after the race window shows the fix addresses the
  // mechanism, not luck.
  await page.waitForTimeout(1000);
  await redoUntilRestored("Control+Shift+z");

  await undoToEmpty("Control+z");
  await page.waitForTimeout(1000);
  // Ctrl+Y is exercised here
  await redoUntilRestored("Control+y");
});
