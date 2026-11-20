import { randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { ADMIN, clickEndOfParagraph, createUserViaInvite, editorLocator, loginAs, randomEmail } from "./helpers.js";

/**
 * Bulk transfer (MCP batch read/write), six cases: while browser user A has a note open, the agent downloads, writes back and exports a whole bundle via a bulk token.
 *
 * Isolation:
 * - A dedicated user (`createUserViaInvite`), not ADMIN: ADMIN has many notes left by earlier specs, and the limits (`transferExport` 10 per user per hour,
 *   `contentRead` 120 per user per minute) are per user. One PAT for the whole file (notes:read notes:write = "Create and edit notes" in settings).
 * - Each case creates its own folder and notes and signs the bulk token with `folder_id` (scope covers only that case's notes); each case revokes its own
 *   token in `finally` with `DELETE /api/transfer/token` (one PAT can hold at most 3 tokens). Only E5 fetches the whole bundle. Marker strings are random (reruns and dirty stacks don't collide).
 *
 * The step order of every case is fixed: (download) bulk-token single-note download once (gives `base`), (edit) A edits in the browser, (poll) poll until the server has A's text,
 * (write) `PUT` (E5: the whole bundle). Since a note that was touched gets 409 note_changed: in E1-E3 the write is expected to be 409; after E1 and E2 download again before writing;
 * in E4 the edit and the poll come before the download.
 * Do not use `GET /api/transfer/notes/:id` for the poll: each call writes a base row (only 10 rows are kept per (user, note), which would push out the base from the download step).
 * Use A's cookie on `GET /api/notes/:id/content` instead: `loadNoteDoc` forks the live doc when there is one (does not read the persisted `note_states`), writes no base,
 * and a cookie reader does not touch presence; it spends `contentRead`, hence the 400 ms interval.
 *
 * After every `goto` of a note page wait for the "Note title" box (the lazy NotePage's fallback AppShell swaps shells); `openNote` does this in one place.
 * This file never reloads: that is what lets E1-E4 assert that A sees the change without a refresh.
 * Cases are independent (no serial): if one fails, the worker restarts and `beforeAll` creates another user and PAT, so later cases still run.
 *
 * Read paragraph text on screen with `editorBlocks` (strips remote cursor name tags): after a write-back the agent's cursor tag (`bn-collaboration-cursor__base`) sits
 * inside the paragraph it wrote, so `getByText(..., { exact: true })` would not find that paragraph.
 */

const POLL = { intervals: [400], timeout: 15_000 };

let userCtx: BrowserContext;
let page: Page;
let anon: BrowserContext;
let origin: string;
let pat: string;
let patId: string;

const rand = (): string => `${Date.now()}-${randomBytes(4).toString("hex")}`;

test.beforeAll(async ({ browser }) => {
  const email = randomEmail();
  const password = `bulk-e2e-${randomBytes(6).toString("hex")}`;
  const adminCtx = await browser.newContext();
  try {
    const admin = await adminCtx.newPage();
    await loginAs(admin, ADMIN.email, ADMIN.password);
    await createUserViaInvite(admin, { email, password, displayName: "bulk e2e" });
  } finally {
    await adminCtx.close();
  }
  userCtx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  page = await userCtx.newPage();
  await loginAs(page, email, password);
  origin = new URL(page.url()).origin;
  const created = await page.request.post("/api/auth/tokens", {
    data: { name: `bulk-e2e-${rand()}`, scope: "notes:read notes:write", expiresInDays: 30 },
  });
  expect(created.status(), await created.text()).toBe(201);
  const body = (await created.json()) as { id: string; token: string };
  pat = body.token;
  patId = body.id;
  // Cookie-less context: PAT and bulk-token requests are sent from here so cookies cannot authenticate them.
  anon = await browser.newContext();
});

test.afterAll(async () => {
  try {
    if (patId) await page.request.delete(`/api/auth/tokens/${patId}`);
  } finally {
    await anon?.close();
    await userCtx?.close();
  }
});

async function openNote(url: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible({ timeout: 15_000 });
  await editorLocator(page).waitFor({ timeout: 15_000 });
}

interface Case {
  noteId: string;
  url: string;
  paras: string[];
  token: string;
  bulk: APIRequestContext;
  auth: { Authorization: string };
}

/**
 * Case setup: create a folder at the personal space root -> create a note with `n` paragraphs in it (A's cookie) -> A opens it -> sign a bulk token with the PAT (with `folder_id`).
 * Paragraph texts `${label}-p${i}-${r}` are not substrings of one another (1-9 paragraphs).
 */
async function setupCase(label: string, n: number, opts: { extra?: string; open?: boolean } = {}): Promise<Case> {
  const r = rand();
  const folder = await page.request.post("/api/folders", { data: { name: `bulk ${label} ${r}`, space: { kind: "personal" } } });
  expect(folder.status(), await folder.text()).toBe(201);
  const folderId = ((await folder.json()) as { id: string }).id;
  const paras = Array.from({ length: n }, (_, i) => `${label}-p${i + 1}-${r}`);
  const content = opts.extra === undefined ? paras.join("\n\n") : `${paras.join("\n\n")}\n\n${opts.extra}`;
  const note = await page.request.post("/api/notes", { data: { title: `E2E bulk ${label} ${r}`, content, folderId } });
  expect(note.status(), await note.text()).toBe(201);
  const dto = (await note.json()) as { id: string; slug: string; ownerHandle: string };
  const url = `/n/${dto.ownerHandle}/${dto.slug}`;
  if (opts.open !== false) {
    await openNote(url);
    await expect(editorLocator(page)).toContainText(paras[n - 1]!);
  }

  const res = await anon.request.post(`${origin}/api/mcp`, {
    headers: { Authorization: `Bearer ${pat}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "open_notes_as_files", arguments: { folder_id: folderId } } },
  });
  expect(res.status()).toBe(200);
  const rpc = (await res.json()) as { result?: { isError?: boolean; structuredContent?: { token: string; access: string } } };
  expect(rpc.result?.isError, JSON.stringify(rpc)).not.toBe(true);
  const sc = rpc.result!.structuredContent!;
  expect(sc.token).toMatch(/^knbt_/);
  expect(sc.access).toBe("write");
  return { noteId: dto.id, url, paras, token: sc.token, bulk: anon.request, auth: { Authorization: `Bearer ${sc.token}` } };
}

/** Per-case finally: revokes this case's bulk token (204). A cleanup failure must not mask the original error. */
async function revokeBulk(c: Case | undefined): Promise<void> {
  if (!c) return;
  try {
    const res = await c.bulk.delete(`${origin}/api/transfer/token`, { headers: c.auth });
    expect(res.status()).toBe(204);
  } catch {
    // Best effort: if an earlier assertion already failed, an error here doesn't matter.
  }
}

async function download(c: Case): Promise<string> {
  const res = await c.bulk.get(`${origin}/api/transfer/notes/${c.noteId}`, { headers: c.auth });
  expect(res.status(), await res.text()).toBe(200);
  expect(res.headers()["content-type"]).toBe("text/markdown; charset=utf-8");
  const file = await res.text();
  expect(file).toContain(`\nid: ${c.noteId}\n`);
  expect(file).toMatch(/\nbase: [0-9a-f]{16}\n/);
  return file;
}

/** Writes one note back; the request shape must match `write.curl` in `apps/server/src/mcp/tools/open-notes-as-files.ts` (PUT, `text/markdown; charset=utf-8`, body = the whole file). */
async function writeBack(c: Case, file: string): Promise<Record<string, unknown>> {
  const res = await c.bulk.put(`${origin}/api/transfer/notes`, {
    headers: { ...c.auth, "Content-Type": "text/markdown; charset=utf-8" },
    data: Buffer.from(file, "utf8"),
  });
  const text = await res.text();
  expect(res.status(), text).toBe(200);
  return JSON.parse(text) as Record<string, unknown>;
}

function replaceLine(file: string, old: string, neu: string): string {
  const lines = file.split("\n");
  const hits = lines.flatMap((l, i) => (l === old ? [i] : []));
  expect(hits, `檔案裡「${old}」那一行應恰好一行`).toHaveLength(1);
  lines[hits[0]!] = neu;
  return lines.join("\n");
}

async function pollServer(noteId: string, needles: string[]): Promise<string> {
  let md = "";
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`/api/notes/${noteId}/content`);
        if (res.status() !== 200) return `HTTP ${res.status()}`;
        md = ((await res.json()) as { markdown: string }).markdown;
        return needles.every(s => md.includes(s)) ? "ok" : md;
      },
      { ...POLL, message: `server 的 live doc 要含 ${JSON.stringify(needles)}` },
    )
    .toBe("ok");
  return md;
}

/**
 * Text of the main editor's top-level blocks on A's screen, in order. Strips remote-cursor decorations (name tag nodes and the U+2060 around them) before taking text,
 * so assertions compare content regardless of which paragraph a name tag landed in.
 */
async function editorBlocks(): Promise<string[]> {
  return editorLocator(page).evaluate(root =>
    Array.from(root.querySelectorAll(":scope > .bn-block-group > .bn-block-outer")).map(outer => {
      const inline = outer.querySelector(".bn-inline-content");
      if (!inline) return "";
      const copy = inline.cloneNode(true) as Element;
      copy.querySelectorAll(".bn-collaboration-cursor__base").forEach(n => n.remove());
      return (copy.textContent ?? "").replace(/\u2060/g, "");
    }),
  );
}

async function expectEditorBlocks(expected: string[], message: string): Promise<void> {
  await expect.poll(editorBlocks, { timeout: 15_000, message }).toEqual(expected);
}

/**
 * A types at the end of a paragraph whose text is exactly `para`; `newParagraph` presses Enter first to start a new paragraph.
 * The caret is placed with `clickEndOfParagraph`: right after a note opens the editor has no focus, and after the click ProseMirror's focus timer can pull the caret that End moved
 * back to the click point (see the helper's comment); waiting for PM and DOM to align is not enough, the text would land mid-paragraph.
 */
async function typeAtEndOf(para: string, text: string, newParagraph = false): Promise<void> {
  await clickEndOfParagraph(page, editorLocator(page).getByText(para, { exact: true }));
  if (newParagraph) await page.keyboard.press("Enter");
  await page.keyboard.type(text);
}

/** Write-back expected to be rejected: 409 base_unavailable, reason note_changed (a touched note is rejected). */
async function writeBackRefused(c: Case, file: string): Promise<void> {
  const res = await c.bulk.put(`${origin}/api/transfer/notes`, {
    headers: { ...c.auth, "Content-Type": "text/markdown; charset=utf-8" },
    data: Buffer.from(file, "utf8"),
  });
  const text = await res.text();
  expect(res.status(), text).toBe(409);
  expect((JSON.parse(text) as { error: { code: string; reason: string } }).error).toMatchObject({ code: "base_unavailable", reason: "note_changed" });
}

test("E1 after A types in paragraph 2 the agent's stale copy is rejected with 409 and nothing is written; after downloading again and editing paragraph 5, A sees it without refreshing and A's text in paragraph 2 is intact", async () => {
  test.setTimeout(120_000);
  let c: Case | undefined;
  try {
    c = await setupCase("e1", 6);
    const [p1, p2, p3, p4, p5, p6] = c.paras as [string, string, string, string, string, string];
    const stale = await download(c); // (download)
    const aMark = `a-${rand()}`;
    await typeAtEndOf(p2, ` ${aMark}`); // (edit)
    await pollServer(c.noteId, [`${p2} ${aMark}`]); // (poll)
    const agentMark = `agent-${rand()}`;
    await writeBackRefused(c, replaceLine(stale, p5, `${p5} ${agentMark}`)); // stale copy -> 409
    await pollServer(c.noteId, [`${p1}\n\n${p2} ${aMark}\n\n${p3}\n\n${p4}\n\n${p5}\n\n${p6}`]);

    const file = await download(c); // download again (includes A's text)
    const out = await writeBack(c, replaceLine(file, p5, `${p5} ${agentMark}`)); // (write)
    expect(out).toMatchObject({ result: "applied", applied: 1, base: null });
    await expectEditorBlocks([p1, `${p2} ${aMark}`, p3, p4, `${p5} ${agentMark}`, p6], "A 不重整：第 5 段是 agent 的、第 2 段 A 打的字都在");
    await pollServer(c.noteId, [`${p1}\n\n${p2} ${aMark}\n\n${p3}\n\n${p4}\n\n${p5} ${agentMark}\n\n${p6}`]);
  } finally {
    await revokeBulk(c);
  }
});

test("E2 after A inserts a paragraph before paragraph 3 the agent's stale copy editing paragraph 3 gets 409; after downloading again and editing, the inserted paragraph is kept and no version is saved", async () => {
  test.setTimeout(120_000);
  let c: Case | undefined;
  try {
    c = await setupCase("e2", 5);
    const [p1, p2, p3, p4, p5] = c.paras as [string, string, string, string, string];
    const stale = await download(c); // (download)
    const inserted = `a-inserted-${rand()}`;
    await typeAtEndOf(p2, inserted, true); // Enter at the end of paragraph 2: the new paragraph lands before paragraph 3
    await pollServer(c.noteId, [`${p2}\n\n${inserted}\n\n${p3}`]); // confirm it is a separate paragraph before paragraph 3
    const agentMark = `agent-${rand()}`;
    await writeBackRefused(c, replaceLine(stale, p3, `${p3} ${agentMark}`)); // stale copy -> 409
    const file = await download(c);
    const out = await writeBack(c, replaceLine(file, p3, `${p3} ${agentMark}`));
    expect(out).toMatchObject({ result: "applied", applied: 1 });
    expect(out).not.toHaveProperty("version");
    expect(out).not.toHaveProperty("conflicts");
    await expectEditorBlocks([p1, p2, inserted, `${p3} ${agentMark}`, p4, p5], "A 不重整：A 插的段在、第 3 段是 agent 的");
    await pollServer(c.noteId, [`${p2}\n\n${inserted}\n\n${p3} ${agentMark}`]);
  } finally {
    await revokeBulk(c);
  }
});

test("E3 both sides edit the same paragraph: the agent's stale copy gets 409; A's text stays, the screen is unchanged and no version is saved", async () => {
  test.setTimeout(120_000);
  let c: Case | undefined;
  try {
    c = await setupCase("e3", 5);
    const [p1, p2, p3, p4, p5] = c.paras as [string, string, string, string, string];
    const file = await download(c); // (download)
    const aMark = `a-${rand()}`;
    await typeAtEndOf(p3, ` ${aMark}`); // (edit)
    await pollServer(c.noteId, [`${p3} ${aMark}`]); // (poll)
    const agentMark = `agent-${rand()}`;
    await writeBackRefused(c, replaceLine(file, p3, `${p3} ${agentMark}`)); // (write) refused
    await expectEditorBlocks([p1, p2, `${p3} ${aMark}`, p4, p5], "A 的字留著、agent 的沒寫進來");
    const md = await pollServer(c.noteId, [`${p3} ${aMark}`]);
    expect(md).not.toContain(agentMark);
    const listed = await page.request.get(`/api/notes/${c.noteId}/versions?limit=100`);
    expect(listed.status()).toBe(200);
    expect(((await listed.json()) as { versions: unknown[] }).versions).toHaveLength(0);
  } finally {
    await revokeBulk(c);
  }
});

test("E4 write-back changing two regions: the AI edit log lists two file_sync rows; undoing one row restores only that region", async () => {
  test.setTimeout(120_000);
  let c: Case | undefined;
  try {
    c = await setupCase("e4", 6);
    const [p1, p2, , , p5] = c.paras as [string, string, string, string, string];
    const aMark = `a-${rand()}`;
    await typeAtEndOf(p1, ` ${aMark}`); // A edits paragraph 1 (outside the agent's two regions): A edits first, the agent downloads afterwards (otherwise 409)
    await pollServer(c.noteId, [`${p1} ${aMark}`]); // (poll)
    const file = await download(c); // includes A's text
    const m2 = `agent2-${rand()}`;
    const m5 = `agent5-${rand()}`;
    const out = await writeBack(c, replaceLine(replaceLine(file, p2, `${p2} ${m2}`), p5, `${p5} ${m5}`)); // two regions (paragraphs 3 and 4 between them unchanged)
    expect(out).toMatchObject({ result: "applied", applied: 2 });
    const editIds = out.editIds as string[];
    expect(editIds).toHaveLength(2);

    const [, , p3, p4, , p6] = c.paras as [string, string, string, string, string, string];
    await expectEditorBlocks([`${p1} ${aMark}`, `${p2} ${m2}`, p3, p4, `${p5} ${m5}`, p6], "A 不重整：兩區都是 agent 的");

    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "AI edit history" }).click();
    const dialog = page.getByRole("dialog", { name: "AI edits on this note" });
    await expect(dialog).toBeVisible();
    // The list also has the row for the note creation (`POST /api/notes` with content = `replace_all`); the write-back contributes exactly two file_sync rows.
    const syncRows = dialog.locator('li[data-testid^="ai-edit-"]').filter({ has: page.locator("code", { hasText: /^file_sync$/ }) });
    await expect(syncRows).toHaveCount(2);
    const rowA = dialog.getByTestId(`ai-edit-${editIds[0]}`);
    const rowB = dialog.getByTestId(`ai-edit-${editIds[1]}`);
    await expect(rowA.locator("code")).toHaveText("file_sync");
    await expect(rowB.locator("code")).toHaveText("file_sync");

    // editIds follow document order (`record-file-sync.ts`: one multi-row INSERT ... RETURNING): [0] is the region in paragraph 2.
    await rowA.getByRole("button", { name: "Revert", exact: true }).click();
    await expect(page.getByText("Edit reverted.", { exact: true })).toBeVisible();
    await expectEditorBlocks([`${p1} ${aMark}`, p2, p3, p4, `${p5} ${m5}`, p6], "撤回一列只還原那一區");
    await expect(rowA.getByText("Already reverted", { exact: true })).toBeVisible();
    await expect(rowB.getByRole("button", { name: "Revert", exact: true })).toBeVisible();
    await pollServer(c.noteId, [`${p1} ${aMark}\n\n${p2}\n\n${p3}\n\n${p4}\n\n${p5} ${m5}\n\n${p6}`]);
  } finally {
    await revokeBulk(c);
  }
});

/** Rich content for the first-open case (table, nested list, checklist, code block, image, columns): if the browser's first open writes a normalisation into Yjs, the write-back is judged note_changed. */
const RICH = (r: string): string =>
  [
    `| h1-${r} | h2 |\n| --- | --- |\n| a | b |\n| c | d |`,
    `* outer-${r}\n  * inner\n    * deepest\n* outer two`,
    `- [ ] todo-${r}\n- [x] done`,
    "```js\nconst x = 1;\n```",
    "![alt](https://example.com/e6.png)",
    `<div data-kb-columns style="display:flex;gap:16px">\n<div data-kb-column style="flex:1">\n\nleft-${r}\n\n</div>\n<div data-kb-column style="flex:1">\n\nright-${r}\n\n</div>\n</div>`,
    `tail-${r}`,
  ].join("\n\n");

test("E6 opening in the browser for the first time only after the download, without typing, then writing back one paragraph gives 200 applied with correct content (opening a note does not count as touching it)", async () => {
  test.setTimeout(120_000);
  let c: Case | undefined;
  try {
    const r = rand();
    c = await setupCase("e6", 3, { extra: RICH(r), open: false });
    const [p1, p2, p3] = c.paras as [string, string, string];
    const file = await download(c); // nobody has opened it in a browser yet
    await openNote(c.url); // first open (waits for title box, connection, editor)
    await expect(editorLocator(page)).toContainText(`tail-${r}`);
    await page.waitForTimeout(2_000); // no typing: let any write caused by opening reach the server first
    const agentMark = `agent-${rand()}`;
    const out = await writeBack(c, replaceLine(file, p2, `${p2} ${agentMark}`)); // expected not to be 409
    expect(out).toMatchObject({ result: "applied", applied: 1 });
    const md = await pollServer(c.noteId, [`${p1}\n\n${p2} ${agentMark}\n\n${p3}`]);
    for (const part of [`h1-${r}`, `outer-${r}`, "deepest", `todo-${r}`, "const x = 1;", "e6.png", `left-${r}`, `right-${r}`, `tail-${r}`]) expect(md, part).toContain(part);
    await expect(editorLocator(page)).toContainText(`${p2} ${agentMark}`);
  } finally {
    await revokeBulk(c);
  }
});

test("E5 whole-bundle export while A types a marker continuously (not yet persisted): the note in the bundle contains the marker (read from the live doc)", async () => {
  test.setTimeout(120_000);
  let c: Case | undefined;
  let typing = false;
  let typer: Promise<void> | undefined;
  try {
    c = await setupCase("e5", 4);
    const [, p2] = c.paras as [string, string];
    // Time boundary: start from idle. Opening a note may trigger one normalisation write and the store's debounce is 2 s - wait 3 s so it persists first;
    // the first character typed afterwards restarts maxDebounce (about 10 s), before which note_states has no marker.
    await page.waitForTimeout(3_000);
    const mark = `mk-${rand()}`;
    // Not just click -> End -> wait for PM and DOM to align: the editor has no focus yet, and the focus timer may pull the caret back to the click point so the marker lands mid-paragraph
    // (CI once got "e5-p2-17948518 mk-...zzz68016-..."). clickEndOfParagraph confirms the caret is really at the end of this paragraph.
    await clickEndOfParagraph(page, editorLocator(page).getByText(p2, { exact: true }));
    const t0 = Date.now();
    await page.keyboard.type(` ${mark}`);
    // Type continuously (one character per 200 ms) until the export response completes: the store's 2 s debounce keeps being pushed back, so persistence happens only at about t0 + 10 s (maxDebounce).
    typing = true;
    typer = (async () => {
      while (typing) {
        await page.keyboard.type("z");
        await new Promise(r => setTimeout(r, 200));
      }
    })();
    await pollServer(c.noteId, [`${p2} ${mark}`]); // the live doc already has the marker

    const res = await c.bulk.get(`${origin}/api/transfer/export`, { headers: c.auth }); // whole bundle (the only call in this file)
    const gz = await res.body();
    const tEnd = Date.now();
    typing = false;
    await typer;
    expect(res.status(), gz.toString("utf8").slice(0, 300)).toBe(200);
    expect(res.headers()["content-type"]).toBe("application/gzip");
    expect(
      tEnd - t0,
      "不承重：匯出在 t0＋8 s 之後才完成——live doc 可能已經落盤（store debounce 最長約 10 s），綠也證明不了讀的是 live",
    ).toBeLessThanOrEqual(8_000);
    // The response has no Content-Encoding (the body itself is application/gzip), so Playwright does not decompress it.
    const tar = gunzipSync(gz);
    expect(tar.includes(Buffer.from(`id: ${c.noteId}\n`, "utf8")), "包裡要有這一篇").toBe(true);
    expect(tar.includes(Buffer.from(`${p2} ${mark}`, "utf8")), "包裡那篇要含 A 還沒落盤的標記").toBe(true);
  } finally {
    typing = false;
    await typer?.catch(() => undefined);
    await revokeBulk(c);
  }
});
