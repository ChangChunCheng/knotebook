import { expect, test } from "@playwright/test";
import { ADMIN, createNote, editorLocator, loginAs } from "./helpers.js";

/**
 * #106 (with #136, #137, #138): an external AI edits a note through a PAT while a browser has it open.
 * The name tag assertion uses an attribute, not visibility: when not lit, BlockNote's CSS squeezes the label to
 * `max-width:4px; max-height:5px; color:transparent`, and that 4x5 transparent box still counts as "visible", so
 * `toBeVisible()` would be a false green here.
 */
test("external AI edits a section: new content without reload, remote cursor name tag, last-edit attribution; revert from the More menu AI edit history -> content restored", async ({
  page,
  browser,
  baseURL,
}) => {
  await loginAs(page, ADMIN.email, ADMIN.password);

  const title = `E2E ai ${Date.now()}`;
  await createNote(page, title);
  const noteUrl = page.url();

  const editor = editorLocator(page);
  await editor.click();
  // All headings at the same level: `sectionize()` opens a new section only for a heading at the same level or shallower, so
  // `## B` would be merged into the previous section. There is a single `# Section A` here, and the rewrite restates a same-level heading too.
  await editor.pressSequentially("Intro line");
  await editor.press("Enter");
  await editor.pressSequentially("# Section A");
  await editor.press("Enter");
  await editor.pressSequentially("Original body");
  await expect(editor).toContainText("Original body");

  // Randomized: specs share one stack and a failed run deliberately leaves it up; a fixed name would collide on re-run in strict mode.
  // Randomizing changes the derived agent name: `deriveAgentLabel` takes the first whitespace-delimited word -> NFKC ->
  //   lowercase -> filters out `[^A-Za-z0-9._-]` -> truncates to 32. The name is deliberately whitespace-free, all lowercase,
  //   only `-` and digits, 23 characters, so the derived value equals the name itself and everything below asserts with the
  //   same variable instead of hard-coding it.
  const tokenName = `e2e-agent-${Date.now()}`;

  await page.goto("/settings/authorization");
  await page.getByRole("button", { name: "Create API token" }).click();
  // `getByLabel` defaults to a case-insensitive substring match; keep exact (reason as in 12).
  await page.getByLabel("Name", { exact: true }).fill(tokenName);
  // Turning on "Edit" grants notes:read notes:write (as in 12)
  await page.getByRole("switch", { name: "Create and edit notes", exact: true }).click();
  await page.getByRole("button", { name: "Create token" }).click();
  const token = await page.getByLabel("New API token", { exact: true }).inputValue();
  expect(token).toMatch(/^knb_/);
  await page.getByRole("button", { name: "Done" }).click();

  // Back to the note and wait for the editor to mount: a match on `editorLocator` implies "connected and first sync done" (see
  // `createNote` in helpers.ts). presence is attached only to an **already loaded** document, so this is a precondition for every assertion below.
  await page.goto(noteUrl);
  await editor.waitFor();

  // A **context without cookies**: a browser context would pass through the session cookie, which gives no discrimination
  // against Bearer. try/finally as in 02 / 12: release on assertion failure, otherwise failed runs leave contexts piling up
  // in the same worker.
  const anonymous = await browser.newContext();
  try {
    const api = anonymous.request;
    const auth = { Authorization: `Bearer ${token}` };

    // Find the note id via the list endpoint: the route that resolves a note by handle / slug is cookie-only and not on #107's
    //   Bearer allowlist, so an anonymous context gets 401 (`.id` is undefined and every later call is 404). `GET /api/notes`
    //   is on the list.
    const listRes = await api.get(`${baseURL}/api/notes`, { headers: auth });
    expect(listRes.status()).toBe(200);
    const notes = (await listRes.json()) as Array<{ id: string; title: string; ownerHandle: string }>;
    const mine = notes.find(n => n.title === title)!;
    expect(mine).toBeTruthy();
    // handle comes from a DB default (`user-<8hex>`) and must not be hard-coded; the name tag assertion needs the real one.
    const handle = mine.ownerHandle;

    const contentRes = await api.get(`${baseURL}/api/notes/${mine.id}/content`, { headers: auth });
    expect(contentRes.status()).toBe(200);
    const content = (await contentRes.json()) as {
      outline: Array<{ sectionId: string; heading: string; fingerprint: string }>;
    };
    const sec = content.outline.find(o => o.heading === "Section A")!;
    expect(sec).toBeTruthy();

    // Use a **different** heading: `replace_section` replaces the heading too, and only a new title proves the cursor lands on
    //   "the first thing written this time" rather than falling back to the document start (here `Section A` is the document
    //   start, so reusing the old title could not tell the two apart).
    const res = await api.post(`${baseURL}/api/notes/${mine.id}/edits`, {
      headers: auth,
      data: {
        op: "replace_section",
        section_id: sec.sectionId,
        markdown: "# Section B\n\nRewritten by AI",
        if_match: sec.fingerprint,
      },
    });
    expect(res.status()).toBe(201);
    const applied = (await res.json()) as { outline: Array<{ sectionId: string; heading: string }> };

    await expect(editor).toContainText("Rewritten by AI", { timeout: 10_000 });

    const cursor = page.locator(".bn-collaboration-cursor__base").filter({
      has: page.locator(`.bn-collaboration-cursor__label:text-is("${handle} (${tokenName})")`),
    });

    // 2a. The decoration really exists (the name tag may still be collapsed: the first appearance goes through awareness
    //      `added`, while BlockNote's handler that sets the lit attribute watches only `updated`).
    await expect(cursor).toHaveCount(1, { timeout: 15_000 });

    // 2b. The name tag really lights up. **Reading again here is not to "produce" a change event**: the write above already sent
    //      one `updated`, so the lighting window was opened long ago. The real reason is **timing**: the two earlier waits have
    //      10s and 15s timeouts, and when they run close to the limit the two-second window left by the write has already
    //      closed and the assertion lands outside it - the mechanism did not fail, the assertion was placed at the wrong time.
    //      Reading **the same section** again (the section id comes straight from the outline of the 201 above, no need for
    //      another whole-note read) leaves the cursor position unchanged while a monotonically increasing field of the presence
    //      state advances -> old and new states differ in a deep compare -> the provider emits `change` -> a fresh two-second
    //      window opens right before the assertion, without betting on how long the earlier waits took.
    const secB = applied.outline.find(o => o.heading === "Section B")!;
    expect(secB).toBeTruthy();
    const reread = await api.get(`${baseURL}/api/notes/${mine.id}/content?section=${secB.sectionId}`, { headers: auth });
    expect(reread.status()).toBe(200);
    await expect(cursor).toHaveAttribute("data-active", "", { timeout: 10_000 });

    // 3. Last-edited attribution in the title bar (`useCollab` receives a remote update -> 3 s debounce -> invalidates the note query)
    await expect(page.getByTestId("last-edited")).toContainText(`(${tokenName})`, { timeout: 15_000 });

    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "AI edit history" }).click();
    await page.getByRole("button", { name: "Revert", exact: true }).first().click();
    await expect(editor).toContainText("Original body", { timeout: 10_000 });
    await expect(editor).not.toContainText("Rewritten by AI");
    // The success toast text (`aiEdits.revertOk`) and the "reverted" marker on the row (`aiEdits.reverted`) are two strings
    //   that are not substrings of each other; otherwise both nodes match while the dialog is open, a strict mode violation.
    //   `exact: true` also avoids Radix Toast's `role="status"` live region (same trap as in 03).
    await expect(page.getByText("Edit reverted.", { exact: true })).toBeVisible();
    await expect(page.getByText("Already reverted", { exact: true })).toBeVisible();
  } finally {
    await anonymous.close();
  }
});
