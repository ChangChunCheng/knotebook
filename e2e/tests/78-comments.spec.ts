import { expect, test, type Locator, type Page } from "@playwright/test";
import { RUN, apiCreateNote, createAccount, openAs, openNote } from "./knowledge-helpers.js";

test.use({ actionTimeout: 15_000 });

const DESKTOP = { width: 1440, height: 900 };
const PASSAGE = `The passage to discuss ${RUN}.`;

function blockWithText(page: Page, text: string): Locator {
  return page.getByTestId("note-editor").locator(".bn-block-outer").filter({ has: page.locator(".bn-inline-content", { hasText: text }) }).last();
}

function commentsPanel(page: Page): Locator {
  return page.getByTestId("comments-panel");
}

test("78-1 a reader comments on a passage with a mention; the owner sees it live and the quote jumps to the passage", async ({ browser }) => {
  test.setTimeout(180_000);
  const alice = await createAccount(browser, "alice");
  const bob = await createAccount(browser, "bob");
  const a = await openAs(browser, alice, { viewport: DESKTOP });
  const b = await openAs(browser, bob, { viewport: DESKTOP });
  try {
    const title = `E2E passage comments ${RUN}`;
    // Enough text above the passage that it starts out of view in the owner's tab, so the jump has to scroll.
    const filler = Array.from({ length: 60 }, (_, i) => `Filler paragraph ${i + 1}.`).join("\n\n");
    const note = await apiCreateNote(a.page, title, `${filler}\n\n${PASSAGE}\n\nThe last paragraph.`);
    const aliceHandle = note.path.split("/")[2]!;
    const shared = await a.page.request.put(`/api/notes/${note.id}/shares`, { data: { email: bob.email, role: "viewer" } });
    expect(shared.status(), await shared.text()).toBe(200);

    await openNote(a.page, note, title);
    await a.page.getByTestId("comments-bubble").click();
    await expect(commentsPanel(a.page).getByText("No comments yet.")).toBeVisible({ timeout: 15_000 });
    const aliceBlock = blockWithText(a.page, PASSAGE);
    await expect(aliceBlock).not.toBeInViewport();

    // A reader's title is a heading, not the title box; it marks the note page past its lazy fallback shell all the same.
    await b.page.goto(note.path);
    await expect(b.page.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(b.page.getByRole("status").filter({ hasText: /^Read-only/ })).toBeVisible({ timeout: 15_000 });
    const bobBlock = blockWithText(b.page, PASSAGE);
    await bobBlock.scrollIntoViewIfNeeded();
    await bobBlock.locator(".bn-inline-content").selectText();
    await b.page.getByRole("button", { name: "Comment", exact: true }).click();

    const bobPanel = commentsPanel(b.page);
    const composer = bobPanel.getByRole("textbox", { name: "Comment" });
    await expect(composer).toBeFocused({ timeout: 15_000 });
    await expect(bobPanel.getByTestId("composer-anchor")).toContainText(PASSAGE);
    await b.page.keyboard.type(`@${aliceHandle} please check this ${RUN}`);
    await bobPanel.getByRole("button", { name: "Send", exact: true }).click();
    const bobComment = bobPanel.getByTestId("comment").filter({ hasText: `please check this ${RUN}` });
    await expect(bobComment).toBeVisible({ timeout: 15_000 });
    await expect(bobComment.getByTestId("comment-quote")).toContainText(PASSAGE);
    await expect(bobComment.getByTestId("mention-chip")).toHaveAttribute("title", `@${aliceHandle}`);

    // The owner's tab was never reloaded: the comment comes in over the note's live connection.
    const aliceComment = commentsPanel(a.page).getByTestId("comment").filter({ hasText: `please check this ${RUN}` });
    await expect(aliceComment).toBeVisible({ timeout: 20_000 });
    await expect(aliceComment.getByTestId("mention-chip")).toHaveAttribute("title", `@${aliceHandle}`);
    const blockId = await aliceBlock.getAttribute("data-id");
    expect(blockId).toBeTruthy();
    await aliceComment.getByTestId("comment-quote").click();
    await expect(aliceBlock).toBeInViewport({ timeout: 15_000 });
    await expect(a.page.locator(`.kn-anchor-flash[data-anchor-flash="${blockId}"]`)).toBeAttached({ timeout: 15_000 });
  } finally {
    await a.context.close();
    await b.context.close();
  }
});
