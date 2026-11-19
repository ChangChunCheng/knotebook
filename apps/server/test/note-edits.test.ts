import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as Y from "yjs";
import { SESSION_COOKIE, YDOC_FRAGMENT, topLevelContainers } from "@knotebook/shared";
import { docClock } from "../src/collab/store.js";
import { noteAiEdits, noteLinks, noteStates, notes } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import type { EditingTestHooks } from "../src/notes/editing/apply.js";
import { EditorSession } from "../src/notes/editing/session.js";
import { buildCollabTestApp, testEditingRuntime, signTestSession } from "./helpers.js";
import { bearer, docText, getContent, seedContent, seedTokenForUser, waitFor } from "./editing-helpers.js";

const PASSWORD = "correct-horse-battery";
type Setup = Awaited<ReturnType<typeof setup>>;

// The two headings are at the same level (`# A` / `# B`). With `## B`, `sectionize()` merges B into A's section (the new-section
// condition `level <= current.level` fails), `outline[2]` becomes undefined and the "last block" is no longer another section, so
// the two concurrency guards below would silently test something else.
async function setup(md: string | null = "# A\n\n第一段\n\n# B\n\n第二段", opts: Parameters<typeof buildCollabTestApp>[0] = {}) {
  const ctx = await buildCollabTestApp(opts);
  const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
  const note = await ctx.createNote(u.id);
  const session = await ctx.loginAs("a@example.com", PASSWORD);
  const client = md === null ? await session.connect(note.id) : await seedContent(ctx, session, note.id, md);
  const { token, tokenId } = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write", "Claude Code (knotebook)");
  const content = async () => (await getContent(ctx.app, note.id, token)).json();
  const post = (body: Record<string, unknown>, t = token) =>
    ctx.app.inject({ method: "POST", url: `/api/notes/${note.id}/edits`, headers: bearer(t), payload: body });
  const rows = () => ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, note.id));
  const stateBytes = async () => Buffer.from((await ctx.db.select().from(noteStates).where(eq(noteStates.noteId, note.id)))[0]?.ydoc ?? Buffer.alloc(0));
  // Each rejection case asserts three things; the third is that `last_edited_*` is unchanged, alongside `stateBytes`: one
  // debounce hits both (persisting must be a settled event before taking the baseline, see the cases).
  const lastEdited = async () =>
    (await ctx.db.select({ at: notes.lastEditedAt, by: notes.lastEditedBy, tokenId: notes.lastEditedTokenId, label: notes.lastEditedAgentLabel })
      .from(notes).where(eq(notes.id, note.id)))[0]!;
  return { ctx, u, note, session, client, token, tokenId, content, post, rows, stateBytes, lastEdited };
}
const ids = (doc: Y.Doc) => topLevelContainers(doc.getXmlFragment(YDOC_FRAGMENT)).map(c => c.getAttribute("id"));
const cookieFor = async (userId: string) => `${SESSION_COOKIE}=${await signTestSession({ userId, tv: 0 })}`;
/**
 * Both steps are required: (1) `try { ... } finally { s.close() }`: `testEditingRuntime` is a module-level singleton shared by all
 * integration tests in a worker; a throw would leak an in-flight slot permanently, and once the rebuild flag is set (every 50 mounts,
 * easily exceeded in this file) every later `acquire()` never settles and the file ends in a silent timeout (`session.ts` says so).
 * (2) `waitFor` watches the server's doc, not client.doc: the change reaches the server over WebSocket, so it hasn't arrived when
 * the function returns; without it the key guard "fingerprint recomputed inside transact blocks concurrent overwrite" would
 * rely on a race and sometimes pass falsely.
 */
async function humanEdit(ctx: Setup["ctx"], noteId: string, client: Setup["client"], sentinel: string, fn: (ed: EditorSession["editor"]) => void) {
  const s = await EditorSession.open(testEditingRuntime, client.doc);
  try {
    fn(s.editor);
  } finally {
    s.close();
  }
  await waitFor(`server 收到併發編輯（${sentinel}）`, 5_000, () =>
    docText(ctx.collab.hocuspocus.documents.get(noteId)!).includes(sentinel)
  );
}
/** Waits after `client.disconnect()` before reading note_states/notes or asserting documents.size. */
const settled = (ctx: Setup["ctx"]) => waitFor("落盤並卸載", 10_000, () => ctx.collab.hocuspocus.documents.size === 0);

describe("POST /api/notes/:id/edits: the five ops", () => {
  it("replace_section: content replaced, ids outside the section unchanged, provider receives it live, one record, note_states updated, reply fingerprint equals the one read afterwards, agentLabel snapshot", async () => {
    const { note, client, content, post, rows, stateBytes } = await setup();
    const before = await content();
    const idsBefore = ids(client.doc);
    const sec = before.outline[2]; // section B (outline[0]=_top, [1]=A, [2]=B; holds only because both headings are at the same level)
    // The heading written back must also be same-level (`# B2`): with `## B2` the new content would merge into A's section
    // and this case would no longer test replace_section's semantics.
    const res = await post({ op: "replace_section", section_id: sec.sectionId, markdown: "# B2\n\n新的第二段", if_match: sec.fingerprint });
    expect(res.statusCode).toBe(201);
    expect(res.json().unboundWikilinks).toBe(0);
    await waitFor("provider 收到", 3_000, () => docText(client.doc).includes("新的第二段"));
    expect(ids(client.doc).slice(0, 2)).toEqual(idsBefore.slice(0, 2));
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ op: "replace_section", sectionId: sec.sectionId, agentLabel: "claude", noteId: note.id });
    expect(r[0]!.afterBlockIds.length).toBeGreaterThan(0);
    expect((r[0]!.beforeBlocks as unknown[]).length).toBe(2);
    expect((await content()).fingerprint).toBe(res.json().fingerprint);
    // Persisted data is a Yjs binary update: substring matching on `Buffer.toString()` is unreliable (at length-prefix bytes the UTF-8
    // decoder eats adjacent CJK bytes), so decode back to a Y.Doc and look at the text (same as the fork-side 409 case).
    const persisted = new Y.Doc();
    Y.applyUpdate(persisted, await stateBytes());
    expect(docText(persisted)).toContain("新的第二段");
  });

  it("replace_all/insert_after/append/delete_section semantics; with nobody online documents.size returns to 0 after writing; append needs no if_match", async () => {
    const { ctx, client, content, post } = await setup();
    client.disconnect();
    await settled(ctx);
    let c = await content();
    expect((await post({ op: "append", markdown: "尾巴" })).statusCode).toBe(201);
    c = await content();
    expect(c.markdown.trimEnd().endsWith("尾巴")).toBe(true);
    const a = c.outline[1];
    expect((await post({ op: "insert_after", section_id: a.sectionId, markdown: "插入的", if_match: a.fingerprint })).statusCode).toBe(201);
    c = await content();
    expect(c.markdown.indexOf("插入的")).toBeGreaterThan(c.markdown.indexOf("第一段"));
    expect(c.markdown.indexOf("插入的")).toBeLessThan(c.markdown.indexOf("# B"));
    const b = c.outline.find((o: { heading: string }) => o.heading === "B");
    expect((await post({ op: "delete_section", section_id: b.sectionId, if_match: b.fingerprint })).statusCode).toBe(201);
    c = await content();
    expect(c.markdown).not.toContain("第二段");
    expect((await post({ op: "replace_all", markdown: "全新", if_match: c.fingerprint })).statusCode).toBe(201);
    c = await content();
    expect(c.markdown.trim()).toBe("全新");
    await settled(ctx);
    expect(ctx.collab.hocuspocus.documents.size).toBe(0);
  });

  it("never-opened empty note: read, write with the if_match just read, succeeds, and the reply fingerprint equals the next read's", async () => {
    const { content, post } = await setup(null);
    const first = await content();
    expect(first.outline).toEqual([expect.objectContaining({ sectionId: "_top", chars: 0 })]);
    const res = await post({ op: "replace_all", markdown: "從無到有", if_match: first.fingerprint });
    expect(res.statusCode).toBe(201);
    expect((await content()).fingerprint).toBe(res.json().fingerprint);
  });

  it("_top: insert_after _top inserts before the first heading; replace_section on a zero-block _top likewise; delete_section on a zero-block _top -> 400 empty_section", async () => {
    const { content, post } = await setup("# A\n\n內文");
    let c = await content();
    const top = c.outline[0];
    expect(top.chars).toBe(0);
    expect((await post({ op: "delete_section", section_id: "_top", if_match: top.fingerprint })).json().error.code).toBe("empty_section");
    expect((await post({ op: "insert_after", section_id: "_top", markdown: "前言", if_match: top.fingerprint })).statusCode).toBe(201);
    c = await content();
    expect(c.markdown.indexOf("前言")).toBeLessThan(c.markdown.indexOf("# A"));
    // Seed is `# A title` (not `# A`): seedContent's sentinel is the last line's visible text, and a one-char ASCII sentinel
    // (`"A"`) would be hit by random block-id characters, waiting for nothing. `indexOf("# A")` below still holds.
    const h = await setup("# A 標題");
    const topEmpty = (await h.content()).outline[0];
    expect((await h.post({ op: "replace_section", section_id: "_top", markdown: "前言二", if_match: topEmpty.fingerprint })).statusCode).toBe(201);
    expect((await h.content()).markdown.indexOf("前言二")).toBeLessThan((await h.content()).markdown.indexOf("# A"));
  });

  it("delete_section _top on a note with no heading -> only one empty paragraph left, the record's after is empty, the anchor points to it", async () => {
    const flat = await setup("只有一段");
    const t = (await flat.content()).outline[0];
    expect((await flat.post({ op: "delete_section", section_id: "_top", if_match: t.fingerprint })).statusCode).toBe(201);
    const after = await flat.content();
    expect(after.outline).toHaveLength(1);
    expect(after.outline[0].chars).toBe(0);
    expect(ids(flat.client.doc)).toHaveLength(1);
    const [row] = await flat.rows();
    expect(row!.afterBlockIds).toEqual([]);
    expect(row!.afterFingerprint).toBeNull();
    expect(row!.anchor).toEqual({ block_id: ids(flat.client.doc)[0], position: "before" });
  });

  it("truly empty document: replace_section/insert_after _top/append give the same result as replace_all; delete_section -> 400", async () => {
    for (const body of [
      { op: "replace_section", section_id: "_top", markdown: "X" },
      { op: "insert_after", section_id: "_top", markdown: "X" },
      { op: "append", markdown: "X" },
    ]) {
      const e = await setup(null);
      const c0 = await e.content();
      // `append`'s `if_match` is compared against the whole-note fingerprint (`targetIds === null`), the other two against the
      // `_top` section's. On a truly empty document the two differ (whole-note = section fingerprints concatenated then hashed);
      // sharing one value would give append a 409, a wrong input rather than wrong behaviour, so pick the right one per op.
      const fp = body.op === "append" ? c0.fingerprint : c0.outline[0].fingerprint;
      expect((await e.post({ ...body, if_match: fp })).statusCode, body.op).toBe(201);
      const c = await e.content();
      expect(c.markdown.trim()).toBe("X");
      expect(c.outline).toHaveLength(1);
      expect(ids(e.client.doc)).toHaveLength(1);
    }
    const d = await setup(null);
    expect((await d.post({ op: "delete_section", section_id: "_top", if_match: (await d.content()).outline[0].fingerprint })).json().error.code).toBe("empty_section");
  });

  it("cookie write -> record has token_id and agent_label both NULL", async () => {
    const { ctx, u, note, content, rows } = await setup();
    const c = await content();
    const res = await ctx.app.inject({ method: "POST", url: `/api/notes/${note.id}/edits`, headers: { cookie: await cookieFor(u.id) }, payload: { op: "append", markdown: "by cookie" } });
    expect(res.statusCode).toBe(201);
    expect(c.fingerprint).not.toBe(res.json().fingerprint);
    const [row] = await rows();
    expect(row).toMatchObject({ tokenId: null, agentLabel: null, userId: u.id });
  });

  it("#240 Bearer POST /edits with an uppercase id: append writes into the lowercase live doc", async () => {
    const s = await setup("# Head\n\n人寫的一行");
    const Y_TEXT = `Y-${Date.now()}`;
    const res = await s.ctx.app.inject({
      method: "POST", url: `/api/notes/${s.note.id.toUpperCase()}/edits`, headers: bearer(s.token), payload: { op: "append", markdown: Y_TEXT },
    });
    expect(docText(s.ctx.collab.hocuspocus.documents.get(s.note.id)!)).toContain(Y_TEXT);
    expect(res.statusCode).toBe(201);
    expect(docText(s.ctx.collab.hocuspocus.documents.get(s.note.id)!)).toContain("人寫的一行");
    await waitFor("client 收到", 5_000, () => docText(s.client.doc).includes(Y_TEXT));
    s.client.disconnect();
  });
});

describe("side by side", () => {
  it("append doesn't replace the columns when the document has only one columns row (isEmptyDoc doesn't treat a columns row as empty)", async () => {
    const s = await setup(null);
    await humanEdit(s.ctx, s.note.id, s.client, "右欄文字", ed => ed.replaceBlocks(ed.document, [
      { id: "r", type: "columnList", children: [
        { id: "rc0", type: "column", props: { width: 1 }, children: [{ id: "ra", type: "paragraph", content: "左欄文字" }] },
        { id: "rc1", type: "column", props: { width: 1 }, children: [{ id: "rb", type: "paragraph", content: "右欄文字" }] },
      ] },
    ] as never));
    const res = await s.post({ op: "append", markdown: "追加" });
    expect(res.statusCode).toBe(201);
    await waitFor("provider 收到追加", 3_000, () => docText(s.client.doc).includes("追加"));
    const top = topLevelContainers(s.client.doc.getXmlFragment(YDOC_FRAGMENT));
    expect(top.map(c => c.nodeName)).toEqual(["columnList", "blockContainer"]);
    expect(top[0]!.getAttribute("id")).toBe("r");
    expect(docText(s.client.doc)).toContain("左欄文字");
    s.client.disconnect();
  });
});

describe("if_match and concurrency", () => {
  it("whole-note mismatch 409 with current showing the new content; section mismatch 409; another section edited by a human still succeeds", async () => {
    const { ctx, note, client, content, post } = await setup();
    const c = await content();
    const stale = await post({ op: "replace_all", markdown: "x", if_match: "0000000000000000" });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("fingerprint_mismatch");
    expect(stale.json().error.message).toBe("The content changed since you read it, so nothing was written. The response's current field has the content as it is now.");
    expect(stale.json().current.fingerprint).toBe(c.fingerprint);
    const a = c.outline[1];
    expect((await post({ op: "replace_section", section_id: a.sectionId, markdown: "# A\n\nx", if_match: "0000000000000000" })).statusCode).toBe(409);
    // `document.at(-1)` is the second paragraph, in section B (needs same-level headings in the fixture; with `## B` it would land
    // in A, turning "another section edited" into "same section edited", the expected 201 would become 409 and this key guard
    // would be tested backwards).
    await humanEdit(ctx, note.id, client, "第二段（人改）", ed => ed.updateBlock(ed.document.at(-1)!.id, { content: "第二段（人改）" }));
    expect((await post({ op: "replace_section", section_id: a.sectionId, markdown: "# A\n\nAI 改的", if_match: a.fingerprint })).statusCode).toBe(201);
    expect((await content()).markdown).toContain("人改");
    expect((await content()).markdown).toContain("AI 改的");
  });

  it("provider types in the same section between fork and merge -> 409 inside transact; persisted doc has the concurrent edit and no AI block id; record empty; documents.size returns to 0 after the provider disconnects", async () => {
    // The hook must return only after the server received the concurrent edit (humanEdit has a built-in waitFor), otherwise the
    // merge transact finishes before the edit arrives, the fingerprint check never sees the concurrency and the case passes only by
    // timing. The hook needs `setup()`'s result yet must be handed to the app before `setup()`: pass an empty object (same reference
    // all the way to `applyDeps.testHooks`) and attach `beforeMerge` afterwards; `deps.testHooks?.beforeMerge` is read at call time,
    // so attaching after setup works.
    const hooks: EditingTestHooks = {};
    const s = await setup(undefined, { editingTestHooks: hooks });
    hooks.beforeMerge = async () => {
      await humanEdit(s.ctx, s.note.id, s.client, "第一段（併發）", ed => ed.updateBlock(ed.document[1]!.id, { content: "第一段（併發）" }));
    };
    const c = await s.content();
    const a = c.outline[1];
    const svBefore = new Set(Y.decodeStateVector(Y.encodeStateVector(s.client.doc)).keys());
    const res = await s.post({ op: "replace_section", section_id: a.sectionId, markdown: "# A\n\nAI 版", if_match: a.fingerprint });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("fingerprint_mismatch");
    expect(res.json().current.markdown).toContain("併發");
    expect(await s.rows()).toHaveLength(0);
    // The live doc is no longer the worker's base: retry before merging (no direct connection; `mergeAtBase`'s pre-comparison),
    // and on the retry the worker compares fingerprints on the new state -> 409. This path opens no direct connection and persists
    // nothing; the concurrent edit is persisted by ordinary collab persistence, so check after the client disconnects and persisting completes.
    s.client.disconnect();
    await settled(s.ctx);
    expect(s.ctx.collab.hocuspocus.documents.size).toBe(0);
    const persisted = new Y.Doc();
    Y.applyUpdate(persisted, await s.stateBytes());
    expect(docText(persisted)).toContain("併發");
    expect(docText(persisted)).not.toContain("AI 版");
    const svAfter = new Set(Y.decodeStateVector(Y.encodeStateVector(persisted)).keys());
    for (const k of svAfter) expect(svBefore.has(k) || k === s.client.doc.clientID).toBe(true);
    // The AI wrote nothing, so the signature must not be the AI's.
    expect(await s.lastEdited()).toMatchObject({ tokenId: null, label: null });
  });

  it("provider types in another section between fork and merge -> both edits present", async () => {
    // Same as above (including why an empty hooks object is passed first and `beforeMerge` attached after setup): `at(-1)` is
    // the second paragraph, in section B (the AI edits A). Same-level headings in the fixture are what make this case hold.
    const hooks: EditingTestHooks = {};
    const s = await setup(undefined, { editingTestHooks: hooks });
    hooks.beforeMerge = async () => {
      await humanEdit(s.ctx, s.note.id, s.client, "第二段（併發）", ed => ed.updateBlock(ed.document.at(-1)!.id, { content: "第二段（併發）" }));
    };
    const a = (await s.content()).outline[1];
    expect((await s.post({ op: "replace_section", section_id: a.sectionId, markdown: "# A\n\nAI 版", if_match: a.fingerprint })).statusCode).toBe(201);
    const md = (await s.content()).markdown;
    expect(md).toContain("AI 版");
    expect(md).toContain("第二段（併發）");
  });

  it("concurrency: exactly one of the same-section requests succeeds (replace_section loser 404, insert_after loser 409); different sections both 201; queue timeout 503 server_busy and nothing written", async () => {
    const s = await setup();
    const c = await s.content();
    const a = c.outline[1];
    const [r1, r2] = await Promise.all([
      s.post({ op: "replace_section", section_id: a.sectionId, markdown: "# A\n\n一", if_match: a.fingerprint }),
      s.post({ op: "replace_section", section_id: a.sectionId, markdown: "# A\n\n二", if_match: a.fingerprint }),
    ]);
    // The loser gets 404 `section_not_found`, not 409: the queue serializes the two, the second forks after the first merged, and
    // `replace_section` replaces the heading block too, so the section's sectionId (the heading's block id) no longer exists. What is
    // guarded is the same (exactly one succeeds, the loser writes nothing), only the code differs; "section still present but
    // fingerprint changed -> 409" is covered by the insert_after group below.
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([201, 404]);
    expect(await s.rows()).toHaveLength(1); // the losing request leaves no record
    const c2 = await s.content();
    const a2 = c2.outline[1];
    const b2 = c2.outline[2];
    const [r3, r4] = await Promise.all([
      s.post({ op: "replace_section", section_id: a2.sectionId, markdown: "# A\n\n三", if_match: a2.fingerprint }),
      s.post({ op: "replace_section", section_id: b2.sectionId, markdown: "# B\n\n四", if_match: b2.fingerprint }),
    ]);
    expect([r3.statusCode, r4.statusCode]).toEqual([201, 201]);
    // Same section but the sectionId still exists (`insert_after` doesn't touch the heading): the loser gets 409 `fingerprint_mismatch`:
    // the first request's inserted block joins the section and changes its fingerprint, so the second's old fingerprint no longer matches.
    const cIns = await s.content();
    const aIns = cIns.outline[1];
    const [ri1, ri2] = await Promise.all([
      s.post({ op: "insert_after", section_id: aIns.sectionId, markdown: "五", if_match: aIns.fingerprint }),
      s.post({ op: "insert_after", section_id: aIns.sectionId, markdown: "六", if_match: aIns.fingerprint }),
    ]);
    expect([ri1.statusCode, ri2.statusCode].sort()).toEqual([201, 409]);
    expect([ri1, ri2].find(r => r.statusCode === 409)!.json().error.code).toBe("fingerprint_mismatch");
    // 503: queue wait forced to 0 (editingTestHooks.beforeMerge holds the first request)
    let release!: () => void;
    let entered = false;
    const blocked = new Promise<void>(r => {
      release = r;
    });
    const t = await setup(undefined, { editingTestHooks: { beforeMerge: () => { entered = true; return blocked; } }, editingQueueWaitMs: 50 });
    // Shared with the rejection cases: persisting must be a settled event before taking the baseline. Both requests here stop before
    // merging (`p1` held by the hook, `r5` hitting the queue timeout), so nothing persists immediately to replace `seedContent`'s
    // pending debounced store (the 429 case is safe because a successful write precedes it). Without disconnecting, the baseline
    // is taken while `note_states` has no row, and if mount and waitFor drag past two seconds the seed's store lands and the
    // `bytes` equality fails falsely. After disconnect + unload nothing persists here again, so equality is deterministic.
    t.client.disconnect();
    await settled(t.ctx);
    const c3 = await t.content();
    const bytes = await t.stateBytes();
    const p1 = t.post({ op: "append", markdown: "一" });
    // The first request must finish resolveRole/visibleNoteTitles/loadNoteDoc/mount before reaching beforeMerge, so polling a fixed
    // number of setImmediate ticks can't wait for it; wait on the flag so the queue is really held and the second request times out.
    await waitFor("第一個請求已占住佇列", 5_000, () => entered);
    const r5 = await t.post({ op: "append", markdown: "二" });
    expect(r5.statusCode).toBe(503);
    expect(r5.json().error.code).toBe("server_busy");
    expect((await t.stateBytes()).equals(bytes)).toBe(true);
    expect(await t.rows()).toHaveLength(0);
    release();
    expect((await p1).statusCode).toBe(201);
    expect((await t.content()).fingerprint).not.toBe(c3.fingerprint);
  });
});

describe("false-green guard for rejection cases", () => {
  // Every rejection case must assert: note_states.ydoc bytes unchanged and zero note_ai_edits rows. This case is the shared
  // implementation of that list: add any new rejection code to `cases` rather than a separate guard-less `it`.
  // The whitelist branch of `unsupported_block` is unreachable at integration level: the headless schema is the full
  // `defaultBlockSpecs` plus mermaid/codeBlock (see shared's `createHeadlessNoteSchema`), so every type BlockNote's markdown/HTML
  // parser produces is in the whitelist; that branch is covered by `test/unit/editing-markdown.test.ts` with a narrowed fake schema.
  // The other two branches are reachable and are in `cases` below: core parse throwing (as in mcp-write-guards) and HTML with an
  // event-handler attribute (syntax check). The side-by-side codes `unsupported_columns`/`unsupported_size` are in `cases` too.
  it("403 viewer, empty_content, empty_section, too_many_blocks, unsupported_block/columns/size, NUL, unknown field, fork-side 409, 413 content_too_large -> note_states bytes unchanged, zero records", async () => {
    const s = await setup();
    const viewer = await s.ctx.createUser({ email: "v@example.com", password: PASSWORD });
    await s.ctx.share(s.note.id, viewer.id, "viewer");
    const { token: vt } = await seedTokenForUser(s.ctx.db, viewer.id);
    // The baseline must be taken only after persisting is a settled event; this line is not a redundant cleanup, it's what makes the
    // case valid. Without disconnecting, `note_states` has no row yet (`stateBytes()` returns an empty buffer) while `seedContent`'s
    // edits hang a 2 s debounced store; the dozen cases below plus one content read plus the 413 run longer than two seconds, so the
    // store would land midway, seed content would appear in the table and the final bytes-equal assertion would fail by timing.
    // After disconnect + unload no online client queues another store, and every request below stops before merging (the definition
    // of a rejection case): no direct connection, nothing persisted, so baseline and end are necessarily equal.
    // Later reads use the DB snapshot (`loadNoteDoc` decodes `note_states` with no live doc), byte-identical in content to before the disconnect.
    s.client.disconnect();
    await settled(s.ctx);
    const before = await s.stateBytes();
    // A strict all-four-columns-equal check works because of the disconnect + unload above: the four columns are already a human
    // signature and no store will happen again (every request stops before merging), so "unchanged" is deterministic, not a bet on
    // timing. Remove the disconnect and this line becomes randomly red (two faces of the same debounce).
    const lastBefore = await s.lastEdited();
    const topFp = (await s.content()).outline[0].fingerprint; // the document starts with a heading, so _top has zero blocks
    const NUL = String.fromCharCode(0);
    const cases: Array<[Record<string, unknown>, number, string, string?]> = [
      [{ op: "append", markdown: "x" }, 403, "forbidden", vt],
      [{ op: "append", markdown: "   \n" }, 400, "empty_content"],
      [{ op: "append", markdown: "\n\n" }, 400, "empty_content"],
      [{ op: "delete_section", section_id: "_top", if_match: topFp }, 400, "empty_section"],
      [{ op: "append", markdown: Array.from({ length: 2001 }, (_, i) => `p${i}`).join("\n\n") }, 400, "too_many_blocks"],
      [{ op: "append", markdown: '<div style="display:flex"><p>a</p></div>' }, 400, "unsupported_columns"],
      [{ op: "append", markdown: '<div data-kb-columns style="display:flex;gap:16px">\n<div data-kb-column style="flex:1">\n\na\n\n</div>\n</div>' }, 400, "unsupported_columns"],
      [{ op: "append", markdown: '<img src="/x" width="300">' }, 400, "unsupported_size"],
      [{ op: "append", markdown: '<div data-content-type="paragraph">x</div>' }, 400, "unsupported_block"],
      [{ op: "append", markdown: '<details><summary>s</summary><img src="x" onerror="alert(1)"></details>' }, 400, "unsupported_block"],
      [{ op: "append", markdown: "段落\n\n<script>alert(1)</script>" }, 400, "unsupported_block"],
      [{ op: "append", markdown: "x" + NUL }, 400, "invalid_body"],
      [{ op: "append", markdown: "x", extra: 1 }, 400, "invalid_body"],
      [{ op: "replace_section", section_id: "a" + NUL, markdown: "x", if_match: "0000000000000000" }, 400, "invalid_body"],
      [{ op: "replace_all", markdown: "x", if_match: "0000000000000000" + NUL }, 400, "invalid_body"],
      [{ op: "replace_all", markdown: "x", if_match: "0000000000000000" }, 409, "fingerprint_mismatch"],
      [{ op: "replace_section", section_id: "nope", markdown: "x", if_match: "0000000000000000" }, 404, "section_not_found"],
    ];
    for (const [body, status, code, t] of cases) {
      const r = await s.post(body, t);
      expect(r.statusCode, code).toBe(status);
      expect(r.json().error.code).toBe(code);
    }
    const big = await s.ctx.app.inject({
      method: "POST",
      url: `/api/notes/${s.note.id}/edits`,
      headers: { ...bearer(s.token), "content-type": "application/json" },
      payload: JSON.stringify({ op: "append", markdown: "a".repeat(300_000) }),
    });
    expect(big.statusCode).toBe(413);
    expect(big.json().error.code).toBe("content_too_large");
    expect((await s.stateBytes()).equals(before)).toBe(true);
    expect(await s.rows()).toHaveLength(0);
    expect(await s.lastEdited()).toEqual(lastBefore);
  });

  it("429 is also a rejection case: a request after EDIT_LIMIT is exhausted -> note_states bytes unchanged, zero records", async () => {
    // 429 also needs the false-green guard but has its own limiter, hence a separate case. Guards that the rate limit blocks before
    // any mount/direct connection: if consume later moves after merging, the bytes and zero-rows assertions fail.
    const s = await setup(undefined, { limiters: { edit: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) } });
    expect((await s.post({ op: "append", markdown: "第一次" })).statusCode).toBe(201);
    const before = await s.stateBytes();
    // The strict four-column-equal check works here too: the successful append above merges with `disconnect()` as an immediate
    // store that replaces the pending debounced store, so no other writer touches the four columns afterwards. The baseline is a
    // settled event, not "probably in time".
    const lastBefore = await s.lastEdited();
    const rowsBefore = (await s.rows()).length;
    const r = await s.post({ op: "append", markdown: "第二次" });
    expect(r.statusCode).toBe(429);
    expect(r.json().error.code).toBe("too_many_requests");
    expect((await s.stateBytes()).equals(before)).toBe(true);
    expect(await s.rows()).toHaveLength(rowsBefore);
    expect(await s.lastEdited()).toEqual(lastBefore);
    expect((await s.content()).markdown).not.toContain("第二次");
  });

  // Deliberately no `last_edited_*`-unchanged assertion here: this isn't a rejection case, the content is already merged and
  // persisted (`expect(content).toContain(...)`), so the signature should update; adding "unchanged" would test correct behaviour as wrong.
  it("record insert failure (beforeRecord throws) -> 500, content still present, zero records", async () => {
    const s = await setup(undefined, { editingTestHooks: { beforeRecord: async () => { throw new Error("boom"); } } });
    const c = await s.content();
    const r = await s.post({ op: "replace_all", markdown: "內容在", if_match: c.fingerprint });
    expect(r.statusCode).toBe(500);
    expect((await s.content()).markdown).toContain("內容在");
    expect(await s.rows()).toHaveLength(0);
  });
});

describe("write order: record before links", () => {
  // Different from the beforeRecord-throw case above, which guards "persist (merge) before record": this guards the `record`
  // (insertEditRecord) -> `links` (updateNoteLinks) order: the afterRecord hook sits between them, where note_ai_edits already
  // has the row and note_links isn't updated yet; it appears after release.
  it("afterRecord hook: record written, note_links not yet updated; after release note_links is updated", async () => {
    let seen: { edits: number; links: number } | null = null;
    let sctx: Setup | null = null;
    const s = await setup(undefined, {
      editingTestHooks: {
        afterRecord: async () => {
          const c = sctx!;
          seen = {
            edits: (await c.rows()).length,
            links: (await c.ctx.db.select().from(noteLinks).where(eq(noteLinks.sourceNoteId, c.note.id))).length,
          };
        },
      },
    });
    sctx = s;
    await s.ctx.createNote(s.u.id, "目標筆記");
    const c = await s.content();
    const r = await s.post({ op: "append", markdown: "看 [[目標筆記]]", if_match: c.fingerprint });
    expect(r.statusCode).toBe(201);
    expect(seen).toEqual({ edits: 1, links: 0 });
    expect(await s.ctx.db.select().from(noteLinks).where(eq(noteLinks.sourceNoteId, s.note.id))).toHaveLength(1);
  });
});

describe("rate limits", () => {
  it("EDIT_LIMIT limit 3: 4th request 429; a viewer's 4 requests all 403 (charged only after the role check)", async () => {
    const s = await setup(undefined, { limiters: { edit: new FixedWindowLimiter({ limit: 3, windowMs: 60_000 }) } });
    const viewer = await s.ctx.createUser({ email: "v@example.com", password: PASSWORD });
    await s.ctx.share(s.note.id, viewer.id, "viewer");
    const { token: vt } = await seedTokenForUser(s.ctx.db, viewer.id);
    for (let i = 0; i < 4; i += 1) expect((await s.post({ op: "append", markdown: "x" }, vt)).statusCode).toBe(403);
    for (let i = 0; i < 3; i += 1) expect((await s.post({ op: "append", markdown: "x" })).statusCode).toBe(201);
    expect((await s.post({ op: "append", markdown: "x" })).statusCode).toBe(429);
  });

  it("token TOKEN_WRITE_LIMIT: a viewer's 403 also consumes (charged in preHandler)", async () => {
    const s = await setup(undefined, { limiters: { tokenWrite: new FixedWindowLimiter({ limit: 2, windowMs: 60_000 }) } });
    const viewer = await s.ctx.createUser({ email: "v@example.com", password: PASSWORD });
    await s.ctx.share(s.note.id, viewer.id, "viewer");
    const { token: vt } = await seedTokenForUser(s.ctx.db, viewer.id);
    expect((await s.post({ op: "append", markdown: "x" }, vt)).statusCode).toBe(403);
    expect((await s.post({ op: "append", markdown: "x" }, vt)).statusCode).toBe(403);
    expect((await s.post({ op: "append", markdown: "x" }, vt)).statusCode).toBe(429);
  });
});

describe("note_links and media", () => {
  it("AI write of a paragraph with [[...]] -> target's backlinks include the source immediately; unboundWikilinks counted", async () => {
    const s = await setup();
    const target = await s.ctx.createNote(s.u.id, "目標筆記");
    const c = await s.content();
    const r = await s.post({ op: "append", markdown: "看 [[目標筆記]] 與 [[不存在]]", if_match: c.fingerprint });
    expect(r.statusCode).toBe(201);
    expect(r.json().unboundWikilinks).toBe(1);
    // `/backlinks` is cookie-only (`app.authenticate`, not on #107's Bearer allowlist): Bearer would give 401 and an undefined
    // `body.backlinks`, so a session cookie is used.
    const back = await s.ctx.app.inject({ method: "GET", url: `/api/notes/${target.id}/backlinks`, headers: { cookie: await cookieFor(s.u.id) } });
    expect(back.json().backlinks.map((b: { id: string }) => b.id)).toContain(s.note.id);
  });

  it("note_links clock comes from the live doc before applyUpdate (the pre-write docClock, and < the post-write one)", async () => {
    // CAS correctness depends on this: `mergeAtBase` reads `docClock` before `Y.applyUpdate`. Moving that line after applyUpdate
    // leaves the two backlinks cases in this file green, since writeNoteLinks's CAS is `links_clock <= $clock` and a larger clock is still
    // accepted. The failure is silent: the AI claims a clock newer than the state it saw, the browser's later (smaller-clock) index
    // updates are judged no-ops, and the note's wikilink index lags permanently and silently. So query the column itself.
    const s = await setup();
    await s.ctx.createNote(s.u.id, "目標筆記");
    const live = () => s.ctx.collab.hocuspocus.documents.get(s.note.id)!;
    const clockBefore = docClock(live());
    const c = await s.content();
    expect((await s.post({ op: "append", markdown: "看 [[目標筆記]]", if_match: c.fingerprint })).statusCode).toBe(201);
    const clockAfter = docClock(live());
    const [row] = await s.ctx.db.select({ linksClock: notes.linksClock }).from(notes).where(eq(notes.id, s.note.id));
    expect(row!.linksClock).toBe(clockBefore); // moving it after applyUpdate makes this line fail
    expect(row!.linksClock).toBeLessThan(clockAfter); // and the merge really advanced the doc clock (the guard isn't idle)
    expect(clockBefore).toBeGreaterThan(0); // a seeded note, not 0 compared with 0
  });

  it("note_links write failure (DB fault) -> still 201, record written, only the index lags (a successful write must not become 500)", async () => {
    // `updateNoteLinks` runs after the content is persisted and note_ai_edits written. `writeNoteLinks` returns "busy" as a value
    // rather than throwing, so a real throw means a DB fault: letting it escape would turn a fully successful write into a 500,
    // which an external AI almost always retries, applying the same edit twice and adding a note_ai_edits row. Every other failure
    // on this chain has explicit semantics (record insert failure = content present, no record, 500); this one is downgraded to a
    // warn, the index just lags. The fault is created the repo's usual way: the `sql` template, never string concatenation.
    const s = await setup();
    const target = await s.ctx.createNote(s.u.id, "目標筆記");
    await s.ctx.db.execute(sql`create or replace function knb_links_boom() returns trigger as $$ begin raise exception 'boom'; end $$ language plpgsql`);
    await s.ctx.db.execute(sql`create trigger knb_links_boom_trg before insert on note_links for each row execute function knb_links_boom()`);
    try {
      const c = await s.content();
      const r = await s.post({ op: "append", markdown: "看 [[目標筆記]]", if_match: c.fingerprint });
      expect(r.statusCode).toBe(201); // removing the try/catch around updateNoteLinks makes this 500 and fail
      expect(await s.rows()).toHaveLength(1); // the record is already written: a 500 would make the AI retry and duplicate this row
      expect((await s.content()).markdown).toContain("目標筆記"); // the content is persisted too
    } finally {
      await s.ctx.db.execute(sql`drop trigger knb_links_boom_trg on note_links`);
    }
    // The only cost is a lagging index (documented in docs/known-limitations.md): backlinks weren't built this time.
    // `/backlinks` is cookie-only (`app.authenticate`, not on #107's Bearer allowlist): Bearer would give 401 and an undefined
    // `body.backlinks`, so a session cookie is used.
    const back = await s.ctx.app.inject({ method: "GET", url: `/api/notes/${target.id}/backlinks`, headers: { cookie: await cookieFor(s.u.id) } });
    expect(back.json().backlinks).toHaveLength(0);
  });

  it("note with an uploaded image: read, write back with replace_section, image url unchanged", async () => {
    // The trailing caption line is not decoration, don't delete it: seedContent's sentinel is the last line's visible text, and
    // `![pic](...)` is parsed into an image block (the Y doc stores `url` as an attribute) whose markdown syntax never appears in
    // docText()'s XML string; without the caption this case runs into its 5 s timeout, and the easy fix (loosening or shortening
    // seedContent's wait) would silently break the premise of about 25 other cases.
    const s = await setup("# A\n\n![pic](/api/uploads/abc123)\n\n圖說");
    const c = await s.content();
    expect(c.markdown).toContain("/api/uploads/abc123");
    const a = c.outline[1];
    const sec = (await getContent(s.ctx.app, s.note.id, s.token, a.sectionId)).json().section;
    expect((await s.post({ op: "replace_section", section_id: a.sectionId, markdown: sec.markdown + "\n\n補一句", if_match: a.fingerprint })).statusCode).toBe(201);
    // The two assertions below look at client.doc, and the merge result reaches the client over WebSocket: when `post()` returns
    // the client hasn't got it. Without this `waitFor`, the "not sanitized to about:blank" assertion would only test something
    // when the timing happens to line up (same reason as (2) of `humanEdit`); the url assertion above is always true because the seed already contains
    // that url, and can't detect the missing wait.
    await waitFor("provider 收到", 3_000, () => docText(s.client.doc).includes("補一句"));
    expect(docText(s.client.doc)).toContain("/api/uploads/abc123");
    expect(docText(s.client.doc)).not.toContain("about:blank");
  });
});
