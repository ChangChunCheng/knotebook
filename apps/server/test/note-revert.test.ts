import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import { SESSION_COOKIE, YDOC_FRAGMENT, topLevelContainers } from "@knotebook/shared";
import { apiTokens, noteAiEdits } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import type { EditingTestHooks } from "../src/notes/editing/apply.js";
import { EditorSession } from "../src/notes/editing/session.js";
import { buildCollabTestApp, testEditingRuntime, signTestSession } from "./helpers.js";
import { bearer, docText, getContent, seedContent, seedTokenForUser, waitFor } from "./editing-helpers.js";

const PASSWORD = "correct-horse-battery";
/** The retention (100-row trim) cases do 101 writes; the default limiters (`EDIT_LIMIT` 30/min, `TOKEN_WRITE_LIMIT` 60/10 min)
 *  would 429 at the 31st/61st. Both must be loosened, loosening one is useless: these two cases check the
 *  "99, not 100" arithmetic and can't reach the 101st write otherwise. */
const looseLimiters = () => ({
  edit: new FixedWindowLimiter({ limit: 1_000, windowMs: 600_000 }),
  tokenWrite: new FixedWindowLimiter({ limit: 1_000, windowMs: 600_000 }),
});
// The two headings are at the same level: `## B` would be merged into A's section by `sectionize()` and `outline[2]` would be undefined (#136).
async function setup(md = "# A\n\n第一段\n\n# B\n\n第二段", opts: Parameters<typeof buildCollabTestApp>[0] = {}) {
  const ctx = await buildCollabTestApp(opts);
  const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
  const note = await ctx.createNote(u.id);
  const session = await ctx.loginAs("a@example.com", PASSWORD);
  const client = md === "" ? await session.connect(note.id) : await seedContent(ctx, session, note.id, md);
  const { token, tokenId } = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write", "MCP CLI Proxy");
  const content = async () => (await getContent(ctx.app, note.id, token)).json();
  const post = (body: Record<string, unknown>) => ctx.app.inject({ method: "POST", url: `/api/notes/${note.id}/edits`, headers: bearer(token), payload: body });
  const list = async () => (await ctx.app.inject({ method: "GET", url: `/api/notes/${note.id}/edits`, headers: bearer(token) })).json().edits as Array<{ id: string; op: string; revertable: boolean; revertedAt: string | null; agentLabel: string | null; heading: string; byHandle: string }>;
  const revert = (editId: string) => ctx.app.inject({ method: "POST", url: `/api/notes/${note.id}/edits/${editId}/revert`, headers: bearer(token) });
  return { ctx, u, note, client, token, tokenId, content, post, list, revert };
}
type Setup = Awaited<ReturnType<typeof setup>>;
const ids = (doc: Y.Doc) => topLevelContainers(doc.getXmlFragment(YDOC_FRAGMENT)).map(c => c.getAttribute("id"));
/** Reads the raw Y top level directly (not shared's topLevelContainers) so the oracle doesn't break together with the function under test. */
const rawTop = (doc: Y.Doc) =>
  (doc.getXmlFragment(YDOC_FRAGMENT).get(0) as Y.XmlElement).toArray().map(n => `${(n as Y.XmlElement).nodeName}:${(n as Y.XmlElement).getAttribute("id")}`);
const cookieFor = async (userId: string) => `${SESSION_COOKIE}=${await signTestSession({ userId, tv: 0 })}`;
/** Text of the server's live doc (assert concurrency on this, never client.doc: client changes reach the server over WS). */
const serverText = (s: Setup) => docText(s.ctx.collab.hocuspocus.documents.get(s.note.id)!);
/** Simulates a human editing in a browser. `try { ... } finally { close() }` is mandatory: testEditingRuntime is a module-level
 *  singleton, a missing close leaks an in-flight slot permanently and, once the rebuild flag is set, the whole file silently times out (session.ts). */
async function humanEdit(s: Setup, fn: (ed: EditorSession["editor"]) => void) {
  const ses = await EditorSession.open(testEditingRuntime, s.client.doc);
  try {
    fn(ses.editor);
  } finally {
    ses.close();
  }
}
/** Waits after `client.disconnect()` before asserting documents.size or reading persisted results. */
const settled = (s: Setup) => waitFor("落盤並卸載", 10_000, () => s.ctx.collab.hocuspocus.documents.size === 0);

describe("revert", () => {
  it("replace_section revert restores content and ids to the original (BlockNote keeps supplied ids, pinned); the revert row exists and the original row has reverted_at; reverting again 409; reverting the revert row 409", async () => {
    const s = await setup();
    const before = await s.content(); const idsBefore = ids(s.client.doc);
    const a = before.outline[1];
    const r = await s.post({ op: "replace_section", section_id: a.sectionId, markdown: "# A\n\nAI 版", if_match: a.fingerprint });
    expect(r.statusCode).toBe(201);
    let edits = await s.list();
    expect(edits[0]).toMatchObject({ op: "replace_section", revertable: true, heading: "A", agentLabel: "mcp" });
    const rv = await s.revert(edits[0]!.id);
    expect(rv.statusCode).toBe(201);
    await waitFor("provider 收到還原", 3_000, () => docText(s.client.doc).includes("第一段"));
    expect(ids(s.client.doc)).toEqual(idsBefore);
    expect((await s.content()).fingerprint).toBe(before.fingerprint);
    edits = await s.list();
    expect(edits).toHaveLength(2);
    expect(edits[0]).toMatchObject({ op: "revert", revertable: false });
    expect(edits[1]).toMatchObject({ op: "replace_section", revertable: false });
    expect(edits[1]!.revertedAt).not.toBeNull();
    expect((await s.revert(edits[1]!.id)).json().error.code).toBe("already_reverted");
    expect((await s.revert(edits[0]!.id)).json().error.code).toBe("already_reverted");
  });

  it("append revert removes it; delete_section anchors in three forms (previous block after / next block before / empty paragraph before, removed after revert)", async () => {
    const s = await setup();
    let c = await s.content();
    expect((await s.post({ op: "append", markdown: "尾巴" })).statusCode).toBe(201);
    expect((await s.revert((await s.list())[0]!.id)).statusCode).toBe(201);
    expect((await s.content()).markdown).not.toContain("尾巴");
    c = await s.content();
    const b = c.outline[2]; // section B: the previous block is A's last block -> anchor after
    expect((await s.post({ op: "delete_section", section_id: b.sectionId, if_match: b.fingerprint })).statusCode).toBe(201);
    expect((await s.revert((await s.list())[0]!.id)).statusCode).toBe(201);
    expect((await s.content()).fingerprint).toBe(c.fingerprint);
    const t = await setup("# A\n\n一\n\n# B\n\n二"); // same-level heading (`## B` would merge into A's section, leaving no second section to delete)
    const ct = await t.content(); const a = ct.outline[1]; // section A comes first: no previous block -> anchor before (B's heading)
    expect((await t.post({ op: "delete_section", section_id: a.sectionId, if_match: a.fingerprint })).statusCode).toBe(201);
    expect((await t.revert((await t.list())[0]!.id)).statusCode).toBe(201);
    expect((await t.content()).fingerprint).toBe(ct.fingerprint);
    const f = await setup("只有一段");
    const cf = await f.content();
    expect((await f.post({ op: "delete_section", section_id: "_top", if_match: cf.outline[0].fingerprint })).statusCode).toBe(201);
    expect((await f.revert((await f.list())[0]!.id)).statusCode).toBe(201);
    const after = await f.content();
    expect(after.markdown.trim()).toBe("只有一段");
    // This waitFor is not decoration: `ids()` reads client.doc, while the revert merges on the server and reaches the client over WS.
    // Without it "1 block before the revert (empty paragraph) / 1 after" have equal length and the assertion passes before the
    // update arrived: deleting the empty-paragraph removal rule (2 blocks left after revert) would stay green too. Waiting for the text to return means that batch arrived.
    await waitFor("provider 收到還原", 3_000, () => docText(f.client.doc).includes("只有一段"));
    expect(ids(f.client.doc)).toHaveLength(1); // the empty paragraph is removed after revert
  });

  it("deleting the anchor block -> revertable:false, heading falls back to '' and revert 409 stale; a human editing the same section after the AI -> revertable:false + 409 stale", async () => {
    const s = await setup();
    const c = await s.content(); const b = c.outline[2];
    expect((await s.post({ op: "delete_section", section_id: b.sectionId, if_match: b.fingerprint })).statusCode).toBe(201);
    const [del] = await s.list();
    const anchorId = ids(s.client.doc).at(-1)!; // after section B is deleted the document's last block is the anchor (A's last block)
    await humanEdit(s, ed => ed.removeBlocks([anchorId]));
    await waitFor("server 收到刪除", 5_000, () => !serverText(s).includes(anchorId));
    const orphaned = (await s.list())[0]!;
    expect(orphaned.revertable).toBe(false);
    // For `delete_section` the `heading` probe is `anchor.block_id` (`after_block_ids` is empty). Once the anchor is deleted the probe
    // is found in no section and falls back to an empty string: the only reachable path of the `?? ""` branch (normally always found);
    // without this line, changing it to any constant stays green.
    expect(orphaned.heading).toBe("");
    const rv = await s.revert(del!.id);
    expect(rv.statusCode).toBe(409); expect(rv.json().error.code).toBe("stale"); expect(rv.json().current).toBeDefined();
    expect(rv.json().error.message).toBe("The note changed after this edit, so it can't be reverted. The response's current field has the content as it is now.");
    const t = await setup();
    const ct = await t.content(); const a = ct.outline[1];
    expect((await t.post({ op: "replace_section", section_id: a.sectionId, markdown: "# A\n\nAI 版", if_match: a.fingerprint })).statusCode).toBe(201);
    // The human must edit the block the AI just wrote (one of `after_block_ids`), otherwise the fingerprint doesn't change, `revertable`
    // stays true and the next two lines pass meaninglessly. The document is [0]=heading A', [1]=the "AI version" paragraph (in
    // after_block_ids), [2]=heading B, [3]=second paragraph, so use `document[1]`; `[2]` would be in section B, whose fingerprint doesn't change.
    await humanEdit(t, ed => ed.updateBlock(ed.document[1]!.id, { content: "人再改" }));
    await waitFor("server 收到人再改", 5_000, () => serverText(t).includes("人再改")); // observe the server, not the client
    expect((await t.list())[0]!.revertable).toBe(false);
    expect((await t.revert((await t.list())[0]!.id)).json().error.code).toBe("stale");
  });

  it("revert record insert failure (beforeRevertRecord throws) -> 500: content restored, record not written, so the row becomes unrevertable and a second revert is 409 stale (one cell each for replace_section and delete_section; delete relies on the idempotency guard, top-level ids must not duplicate)", async () => {
    // Failure shape (revert path): the record transaction runs after the merge, so a mid-way failure means content restored, no revert row,
    // original row not marked `reverted_at`. This case guards that the row therefore becomes unrevertable and a second press is 409 stale.
    // The two ops hold for different reasons, so both cells run:
    //   - the four non-delete ops: the criterion compares the fingerprint of `after_block_ids`, and the restore replaces exactly those
    //     blocks, so `revertable` turns false by itself.
    //   - `delete_section`: the criterion is "anchor still exists" and the restore does not remove the anchor. Without the condition that no `before_blocks` id is already at top level
    //     (`editRevertable`, revert-core.ts) the row would stay revertable, and a second revert
    //     would return 201 and insert the whole section again, creating duplicate top-level block ids (BlockNote keeps supplied ids)
    //     while section addressing, fingerprints and `after_block_ids` all assume unique top-level ids. Revert has no `if_match` to
    //     rely on, so idempotency has to live in the criterion: the last two lines of this cell (409 and unique ids) test that guard.
    for (const kind of ["replace_section", "delete_section"] as const) {
      let boom = true;
      const s = await setup(undefined, { editingTestHooks: { beforeRevertRecord: async () => { if (boom) throw new Error("boom"); } } });
      const c = await s.content();
      // replace_section targets section A; delete_section targets B (previous block is A's last -> anchor after).
      const target = kind === "replace_section" ? c.outline[1] : c.outline[2];
      const payload = kind === "replace_section"
        ? { op: "replace_section", section_id: target.sectionId, markdown: "# A\n\nAI 版", if_match: target.fingerprint }
        : { op: "delete_section", section_id: target.sectionId, if_match: target.fingerprint };
      expect((await s.post(payload)).statusCode, kind).toBe(201);
      const [edit] = await s.list();
      expect((await s.revert(edit!.id)).statusCode, kind).toBe(500);
      expect((await s.content()).fingerprint, kind).toBe(c.fingerprint);
      const failed = (await s.list())[0]!;
      expect(failed.revertable, kind).toBe(false); // failure-shape assertion: unrevertable (not "still revertable")
      expect(failed.revertedAt, kind).toBeNull();  // record not written: original row not marked
      expect(await s.list(), kind).toHaveLength(1); // revert row not written either
      boom = false;
      const second = await s.revert(edit!.id);
      expect(second.statusCode, kind).toBe(409);
      expect(second.json().error.code, kind).toBe("stale");
      // Direct evidence for the idempotency guard: the second revert did not insert `before_blocks` again. Look at the server's
      // live doc (the revert merges on the server), not client.doc.
      const top = ids(s.ctx.collab.hocuspocus.documents.get(s.note.id)!);
      expect(new Set(top).size, kind).toBe(top.length);
    }
  });

  it("/revert queue timeout -> 503 server_busy (not 500) and nothing touched", async () => {
    // Guards `/revert`'s `catch (err) { if (err instanceof QueueBusyError) ... 503 }`. The write endpoint has an equivalent case, revert
    // had none; removing this catch would turn "busy" into a 500, the code that induces external callers to retry, and a revert retry is
    // exactly the path the idempotency guard (the `before_blocks`-already-at-top-level condition in `editRevertable`, revert-core.ts) blocks. Two reachable things stacked, so the branch needs a guard.
    //
    // Shape follows the 503 section of note-edits.test.ts: pass an empty hooks object into setup first (same reference all the way to
    // `applyDeps.testHooks`; `beforeMerge` is read at call time), write once to get an editId, then attach `beforeMerge` to hold the
    // next write, so the revert hits `editingQueueWaitMs`.
    const hooks: EditingTestHooks = {};
    const s = await setup(undefined, { editingTestHooks: hooks, editingQueueWaitMs: 50 });
    const c = await s.content(); const a = c.outline[1];
    expect((await s.post({ op: "replace_section", section_id: a.sectionId, markdown: "# A\n\nAI 版", if_match: a.fingerprint })).statusCode).toBe(201);
    const [edit] = await s.list();
    let release!: () => void;
    let entered = false;
    const blocked = new Promise<void>(r => {
      release = r;
    });
    hooks.beforeMerge = () => {
      entered = true;
      return blocked;
    };
    const p1 = s.post({ op: "append", markdown: "卡住佇列" });
    // The first request must finish resolveRole/visibleNoteTitles/loadNoteDoc/mount before reaching beforeMerge, so polling a fixed
    // number of times can't wait for it; wait on the flag so the queue is really held and the revert hits the timeout.
    await waitFor("第一個寫入已占住佇列", 5_000, () => entered);
    const busy = await s.revert(edit!.id);
    expect(busy.statusCode).toBe(503);
    expect(busy.json().error.code).toBe("server_busy");
    // Hitting the timeout means `revertEdit` was never entered: the original row isn't marked and there is no revert row.
    const still = await s.list();
    expect(still).toHaveLength(1);
    expect(still[0]!.revertedAt).toBeNull();
    expect(still[0]!.revertable).toBe(true);
    release();
    expect((await p1).statusCode).toBe(201);
  });

  it("reverting an AI edit that introduced [[...]] -> target's backlinks no longer contain the source", async () => {
    const s = await setup();
    const target = await s.ctx.createNote(s.u.id, "目標");
    expect((await s.post({ op: "append", markdown: "看 [[目標]]" })).statusCode).toBe(201);
    // `/backlinks` is cookie-only (`app.authenticate`, not on #107's Bearer allowlist): Bearer gives 401 and an undefined
    // `body.backlinks` (same as two places in note-edits.test.ts).
    const back = async () => {
      const res = await s.ctx.app.inject({ method: "GET", url: `/api/notes/${target.id}/backlinks`, headers: { cookie: await cookieFor(s.u.id) } });
      return (res.json().backlinks as Array<{ id: string }>).map(b => b.id);
    };
    expect(await back()).toContain(s.note.id);
    expect((await s.revert((await s.list())[0]!.id)).statusCode).toBe(201);
    expect(await back()).not.toContain(s.note.id);
  });

  it("append on [paragraph p, columns row], then revert -> 201: the append is gone, the row and p remain, order unchanged", async () => {
    const s = await setup("");
    await humanEdit(s, ed => ed.replaceBlocks(ed.document, [
      { id: "p", type: "paragraph", content: "前段文字" },
      { id: "r", type: "columnList", children: [
        { id: "rc0", type: "column", props: { width: 1 }, children: [{ id: "ra", type: "paragraph", content: "左欄文字" }] },
        { id: "rc1", type: "column", props: { width: 1 }, children: [{ id: "rb", type: "paragraph", content: "右欄文字" }] },
      ] },
    ] as never));
    await waitFor("server 收到列", 5_000, () => serverText(s).includes("右欄文字"));
    expect((await s.post({ op: "append", markdown: "追加" })).statusCode).toBe(201);
    await waitFor("provider 收到追加", 3_000, () => docText(s.client.doc).includes("追加"));
    expect(rawTop(s.client.doc)).toEqual(["blockContainer:p", "columnList:r", expect.stringMatching(/^blockContainer:/)]);
    const rv = await s.revert((await s.list())[0]!.id);
    expect(rv.statusCode).toBe(201);
    await waitFor("provider 收到還原", 3_000, () => !docText(s.client.doc).includes("追加"));
    expect(rawTop(s.client.doc)).toEqual(["blockContainer:p", "columnList:r"]);
    expect(docText(s.client.doc)).toContain("左欄文字");
    s.client.disconnect();
  });

  it("[p, columns row r, # H, q] delete_section H (anchor = row r), then revert -> 201, top-level order p, r, H, q (oracle reads the raw Y)", async () => {
    const s = await setup("");
    await humanEdit(s, ed => ed.replaceBlocks(ed.document, [
      { id: "p", type: "paragraph", content: "前段文字" },
      { id: "r", type: "columnList", children: [
        { id: "rc0", type: "column", props: { width: 1 }, children: [{ id: "ra", type: "paragraph", content: "左欄文字" }] },
        { id: "rc1", type: "column", props: { width: 1 }, children: [{ id: "rb", type: "paragraph", content: "右欄文字" }] },
      ] },
      { id: "h", type: "heading", props: { level: 1 }, content: "標題文字" },
      { id: "q", type: "paragraph", content: "後段文字" },
    ] as never));
    await waitFor("server 收到", 5_000, () => serverText(s).includes("後段文字"));
    const c = await s.content();
    const sec = c.outline.find((o: { sectionId: string }) => o.sectionId === "h");
    expect(sec).toBeDefined();
    expect((await s.post({ op: "delete_section", section_id: "h", if_match: sec.fingerprint })).statusCode).toBe(201);
    await waitFor("provider 收到刪除", 3_000, () => !docText(s.client.doc).includes("標題文字"));
    expect(rawTop(s.client.doc)).toEqual(["blockContainer:p", "columnList:r"]);
    const rv = await s.revert((await s.list())[0]!.id);
    expect(rv.statusCode).toBe(201);
    await waitFor("provider 收到還原", 3_000, () => docText(s.client.doc).includes("標題文字"));
    expect(rawTop(s.client.doc)).toEqual(["blockContainer:p", "columnList:r", "blockContainer:h", "blockContainer:q"]);
    expect(docText(s.client.doc)).toContain("右欄文字");
    s.client.disconnect();
  });

  it("empty note replace_all/insert_after _top/append, then revert -> one empty paragraph left, valid structure, reads fine", async () => {
    for (const body of [{ op: "replace_all", markdown: "X" }, { op: "insert_after", section_id: "_top", markdown: "X" }, { op: "append", markdown: "X" }]) {
      const e = await setup("");
      const c0 = await e.content();
      // The three ops' `if_match` is not the same fingerprint: `replace_all`/`append` have `targetIds` null = compare the whole-note
      // fingerprint, `insert_after _top` compares that section's. On a truly empty document they are necessarily unequal (section =
      // `EMPTY_SECTION_FINGERPRINT`; whole-note = section fingerprints concatenated and hashed again), so sharing one value would give
      // `replace_all` a 409. The check is still done, each with the right baseline.
      const fp = body.op === "insert_after" ? c0.outline[0].fingerprint : c0.fingerprint;
      expect((await e.post({ ...body, if_match: fp })).statusCode, body.op).toBe(201);
      expect((await e.revert((await e.list())[0]!.id)).statusCode, body.op).toBe(201);
      const c = await e.content();
      expect(c.markdown.trim()).toBe("");
      // Same reason as the previous case: the revert merges on the server and client.doc only receives it over WS. Waiting for `X`
      // to disappear means that batch of updates arrived, so `toHaveLength(1)` (never empty, nothing left over) verifies the post-revert structure.
      await waitFor(`provider 收到還原（${body.op}）`, 3_000, () => !docText(e.client.doc).includes("X"));
      expect(ids(e.client.doc), body.op).toHaveLength(1);
      expect((await e.list())[0]!.op).toBe("revert");
    }
  });

  it("retention: the oldest of 101 is gone; reverting the oldest row removes both the original and the revert row, so the total is 99, not 100", async () => {
    // The 99 is computed, not a typo. In revertEdit's transaction order: insert the revert row (101 rows) -> mark the original
    // `reverted_at` -> keep = top 100 by (created_at desc, id desc) -> delete the one not in keep, which is `oldestKept` itself ->
    // `note_ai_edits.revert_of` is ON DELETE CASCADE, so the just-inserted revert row goes with it.
    // 101 - 1 (trimmed original) - 1 (revert row taken by CASCADE) = 99.
    // Meaning: reverting a record already on the trimming edge reduces the total by one: not data loss (the content is restored),
    // the pair just leaves the retention window together. Documented in docs/known-limitations.md.
    //
    // `looseLimiters()` is not superfluous, don't remove it: the default limiters are `EDIT_LIMIT` 30/min and `TOKEN_WRITE_LIMIT`
    // 60/10 min, so this loop would get a 429 at the 31st (61st once edit is loosened) iteration and the `toBe(201)` would fail.
    // The easy "fix" would be shrinking 101 or loosening the assertion, which leaves trimming (RETENTION) and the `revert_of`
    // CASCADE deletion unguarded. This case and the next each do 101 fork -> mount -> merge -> record rounds, slow
    // (about 100 mounts each, crossing the runtime's rebuildEvery=50 threshold twice); vitest `testTimeout` is 120 s, enough,
    // but don't add unrelated loops.
    const s = await setup(undefined, { limiters: looseLimiters() });
    for (let i = 0; i < 101; i += 1) expect((await s.post({ op: "append", markdown: `p${i}` })).statusCode).toBe(201);
    let rows = await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.note.id));
    expect(rows).toHaveLength(100);
    // The criterion must come from the same source as the trimming: trimming takes the top 100 by `orderBy(desc(created_at), desc(id))`,
    // so "the next row to be trimmed" is the last in this ordering, not "the row with the smallest created_at". Without the secondary
    // key `id`, two equal timestamps can sort differently in JS and SQL, this case would pick the wrong target and get 100 instead of 99
    // (very unlikely, but a criterion from a different source is itself a defect). A uuid's canonical lowercase hex string compares in
    // the same order as pg's uuid byte comparison (dashes at fixed positions), so compare strings directly.
    // Known residual misalignment, not going to be fixed: `Date.getTime()` has millisecond resolution while pg `timestamptz` sorts to
    // the microsecond, so two rows in the same ms but different us are decided by microseconds in SQL but by `id` in JS and may
    // differ. Practical risk is negligible: each write includes a fork + mount + direct-connection merge + DB transaction, so adjacent
    // rows are much more than a millisecond apart. Aligning would need comparing raw strings (drizzle already converted the column to
    // `Date`); the cost exceeds the benefit.
    const trimOrder = [...rows].sort((a, b) =>
      b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
    );
    const oldestKept = trimOrder.at(-1)!;
    expect((await s.revert(oldestKept.id)).statusCode).toBe(201); // revert row +1 -> trim
    rows = await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.note.id));
    expect(rows).toHaveLength(99);
    expect(rows.find(r => r.id === oldestKept.id)).toBeUndefined(); // original row trimmed
    expect(rows.find(r => r.revertOf === oldestKept.id)).toBeUndefined(); // revert row disappears via CASCADE
  });

  it("retention: reverting a row that is not on the edge keeps the total at 100 (contrast with the previous case: 99 comes from the trimming edge, not from revert itself)", async () => {
    const s = await setup(undefined, { limiters: looseLimiters() }); // as the previous case: both limiters must be loosened, see that case
    for (let i = 0; i < 101; i += 1) expect((await s.post({ op: "append", markdown: `p${i}` })).statusCode).toBe(201);
    const rows = await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.note.id));
    // Same ordering criterion as the previous case (trimming's `desc(created_at), desc(id)`): the first, i.e. newest, is farthest from the
    // trimming edge, so reverting it deletes nothing else. (The ms/us residual misalignment noted in the previous case applies equally and is unreachable for the same reason.)
    const newest = [...rows].sort((a, b) =>
      b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
    )[0]!;
    expect((await s.revert(newest.id)).statusCode).toBe(201);
    const after = await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.note.id));
    expect(after).toHaveLength(100); // one row inserted, the oldest trimmed (no FK relation with the revert row)
    expect(after.find(r => r.revertOf === newest.id)).toBeDefined();
  });

  it("GET /edits: newest first, heading taken from near the anchor, after the token is deleted the snapshot label is returned, cookie-written rows show only the handle (agentLabel null), no document reload", async () => {
    const s = await setup();
    const c = await s.content(); const b = c.outline[2];
    expect((await s.post({ op: "delete_section", section_id: b.sectionId, if_match: b.fingerprint })).statusCode).toBe(201);
    expect((await s.post({ op: "append", markdown: "尾巴" })).statusCode).toBe(201);
    // This request deliberately uses the cookie (not Bearer): `request.tokenId` is null, so the row's `token_id`/`agent_label` are
    // null and DTO assembly takes the "no token id -> use the snapshot (also null)" branch. All other writes in this case are Bearer;
    // without this one, changing that branch to any constant would stay green.
    const cookieWrite = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/edits`, headers: { cookie: await cookieFor(s.u.id) }, payload: { op: "append", markdown: "人寫的" } });
    expect(cookieWrite.statusCode).toBe(201);
    const edits = await s.list();
    expect(edits.map(e => e.op)).toEqual(["append", "append", "delete_section"]);
    expect(edits[0]!.agentLabel).toBeNull(); // cookie row: no token -> no agent signature, only handle
    expect(edits[0]!.byHandle).toBe(edits[1]!.byHandle); // same person: handle matches across the two paths
    expect(edits[2]!.heading).toBe("A"); // first heading near the anchor
    await s.ctx.db.delete(apiTokens).where(eq(apiTokens.id, s.tokenId));
    const { token: t2 } = await seedTokenForUser(s.ctx.db, s.u.id);
    const after = (await s.ctx.app.inject({ method: "GET", url: `/api/notes/${s.note.id}/edits`, headers: bearer(t2) })).json().edits;
    expect(after[0].agentLabel).toBeNull(); // cookie row is unaffected by token deletion
    expect(after[1].agentLabel).toBe("mcp"); // Bearer row: token deleted -> falls back to the snapshot
    // The handle can't be hardcoded as `"a"` (that is the email local part, not the handle): `ctx.createUser` passes no handle, so the
    // column takes the DB default `'user-' || substr(gen_random_uuid()::text, 1, 8)`, different every time, so read the real value. Not `expect.any(String)` either: this cell guards that the signature points at this
    // editor; if DTO assembly drops `innerJoin(users)`, `byHandle` would be an empty string, which a real-value comparison catches and `expect.any(String)` would miss.
    // `bearer(s.token)` can't be used here: `s.token` was deleted a few lines up, so the lookup would miss and return 401.
    const ownerHandle = (await s.ctx.app.inject({ method: "GET", url: `/api/notes/${s.note.id}`, headers: bearer(t2) })).json().ownerHandle;
    expect(after[0].byHandle).toBe(ownerHandle);
    s.client.disconnect(); await settled(s);
    await s.ctx.app.inject({ method: "GET", url: `/api/notes/${s.note.id}/edits`, headers: bearer(t2) });
    expect(s.ctx.collab.hocuspocus.documents.size).toBe(0); // GET /edits is a read path and must not make the document load again
  });

  it("after the user renames the agent, existing rows of GET /edits show the new name (current value, override first; not the snapshot at write time)", async () => {
    // Catches `agentLabelOf({ agentLabel: e.tokenLabel, ... })` in `listEdits` being changed to ignore `tokenLabel` (the pure-derived
    // form from before #138): a snapshot-only assertion would stay green. The case above guards "token deleted -> falls back
    // to the snapshot"; this one is the opposite direction (token alive, name changed).
    const s = await setup();
    const a = (await s.content()).outline[1];
    expect((await s.post({ op: "replace_section", section_id: a.sectionId, markdown: "# A\n\nAI 版", if_match: a.fingerprint })).statusCode).toBe(201);
    expect((await s.list())[0]!.agentLabel).toBe("mcp"); // derived from the token name "MCP CLI Proxy"
    const renamed = await s.ctx.app.inject({
      method: "PATCH",
      url: `/api/auth/tokens/${s.tokenId}`,
      headers: { cookie: await cookieFor(s.u.id) },
      payload: { agentLabel: "my-bot" },
    });
    expect(renamed.statusCode).toBe(200);
    expect((await s.list())[0]!.agentLabel).toBe("my-bot");
  });

  it("/revert four cells: nonexistent / another note's / malformed and NUL-containing editId -> 404 (not 500); viewer -> 403 and nothing touched", async () => {
    // Every endpoint needs a NUL case that gets the endpoint's normal error shape, not 500; `/revert` has no body, so
    // the NUL guard lands on the **path parameter**: `editId` goes through the route's
    // `UUID_RE` guard, normal shape 404 `not_found`.
    const s = await setup();
    const c = await s.content(); const a = c.outline[1];
    expect((await s.post({ op: "replace_section", section_id: a.sectionId, markdown: "# A\n\nAI 版", if_match: a.fingerprint })).statusCode).toBe(201);
    const [mine] = await s.list();

    // A well-formed uuid that doesn't exist
    expect((await s.revert("00000000-0000-4000-8000-000000000000")).statusCode).toBe(404);

    // Another note's record: the `eq(noteAiEdits.noteId, input.noteId)` in `revertEdit`'s first where is what blocks this; this cell fails if it is removed.
    const other = await s.ctx.createNote(s.u.id, "另一篇");
    const w = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${other.id}/edits`, headers: bearer(s.token), payload: { op: "append", markdown: "別篇" } });
    expect(w.statusCode).toBe(201);
    const cross = await s.revert(w.json().editId); // the path is s.note, the editId belongs to other
    expect(cross.statusCode).toBe(404);
    expect(cross.json().error.code).toBe("not_found");

    // Malformed / NUL-containing editId -> this endpoint's normal 404 shape (not 500, not escaping to the global errorHandler)
    const NUL = String.fromCharCode(0);
    for (const bad of ["nope", encodeURIComponent(`${mine!.id}${NUL}`)]) {
      const r = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/edits/${bad}/revert`, headers: bearer(s.token) });
      expect(r.statusCode, bad).toBe(404);
      expect(r.json().error.code).toBe("not_found");
    }

    // viewer -> 403; the original row stays revertable and content untouched (false-green guard: a rejection does nothing)
    const viewer = await s.ctx.createUser({ email: "v@example.com", password: PASSWORD });
    await s.ctx.share(s.note.id, viewer.id, "viewer");
    const { token: vt } = await seedTokenForUser(s.ctx.db, viewer.id);
    const forbidden = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${s.note.id}/edits/${mine!.id}/revert`, headers: bearer(vt) });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe("forbidden");
    expect((await s.list())[0]!.revertable).toBe(true);
    expect((await s.content()).markdown).toContain("AI 版");
  });

  it("GET /edits guards: non-member -> 404; CONTENT_READ_LIMIT is consumed only after the role check; exhausted -> 429", async () => {
    // The route claims three guards (scope, role, rate limit) with no assertion. The scope guard is deliberately not given its own
    // case: it is the shared `authenticateAny("notes:read")` mechanism, already pinned by `api-token-auth.test.ts` ("read token POST
    // /api/notes -> 403 insufficient_scope"), and every token in this file contains `notes:read`, so no meaningful variant exists.
    // This case guards the role and rate-limit ones.
    const s = await setup(undefined, { limiters: { contentRead: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) } });
    const get = (t: string, noteId = s.note.id) => s.ctx.app.inject({ method: "GET", url: `/api/notes/${noteId}/edits`, headers: bearer(t) });
    const stranger = await s.ctx.createUser({ email: "x@example.com", password: PASSWORD });
    const { token: st } = await seedTokenForUser(s.ctx.db, stranger.id);
    const outsider = await get(st);
    expect(outsider.statusCode).toBe(404); // non-member always 404 (doesn't leak the note's existence)
    expect(outsider.json().error.code).toBe("not_found");
    // The owner hits a nonexistent noteId -> 404. Bucket key = userId and quota is 1: if consume moved before the role check,
    // this request would eat the only quota and the next line's 200 would become 429.
    expect((await get(s.token, "00000000-0000-4000-8000-000000000000")).statusCode).toBe(404);
    expect((await get(s.token)).statusCode).toBe(200);
    expect((await get(s.token)).statusCode).toBe(429);
  });
});
