import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../src/db/index.js";
import { noteAiEdits, transferBases } from "../src/db/schema.js";
import { recordFileSyncInTx } from "../src/transfer/tx/record-file-sync.js";
import { buildCollabTestApp, freshDb } from "./helpers.js";
import { bearer, seedTokenForUser } from "./editing-helpers.js";
import { seedNote, seedUser } from "./group-helpers.js";
import { bulkPut, downloadNote, editBody, humanEdit, issueBulkDirect, liveMarkdown, seedBlocks, seedMd, topIdsOf } from "./bulk-transfer-helpers.js";

const SHA = Buffer.alloc(32, 9);
async function scene() {
  const { db } = await freshDb();
  const u = await seedUser(db);
  const note = await seedNote(db, { ownerId: u.id }, { title: "N" });
  const other = await seedNote(db, { ownerId: u.id }, { title: "Bystander" });
  const key = "0123456789abcdef";
  await db.insert(transferBases).values({
    key,
    userId: u.id,
    noteId: note.id,
    salt: Buffer.alloc(16, 1),
    keyId: "deadbeef",
    bodySha: Buffer.alloc(32, 2),
    titleSha: Buffer.alloc(32, 3),
    lineHashes: Buffer.alloc(0),
    lineKinds: Buffer.alloc(0),
    segments: [],
  });
  await db.execute(sql`update transfer_bases set last_used_at = now() - interval '3 days' where key = ${key}`);
  return { db, u, note, other, key };
}
type Row = typeof noteAiEdits.$inferInsert;
const rewriteRow = (noteId: string, userId: string, n = 0): Row => ({
  noteId,
  userId,
  op: "file_sync",
  sectionId: null,
  beforeBlocks: [{ id: `old${n}`, type: "paragraph", content: [] }],
  afterBlockIds: [`new${n}`],
  afterFingerprint: "0123456789abcdef",
  anchor: null,
});
const deleteRow = (noteId: string, userId: string): Row => ({
  noteId,
  userId,
  op: "file_sync",
  sectionId: null,
  beforeBlocks: [{ id: "gone", type: "paragraph", content: [] }],
  afterBlockIds: [],
  afterFingerprint: null,
  anchor: { block_id: "prev", position: "after" },
});
const insertRow = (noteId: string, userId: string): Row => ({
  noteId,
  userId,
  op: "file_sync",
  sectionId: null,
  beforeBlocks: [],
  afterBlockIds: ["ins"],
  afterFingerprint: "fedcba9876543210",
  anchor: null,
});
const record = (db: Db, input: Parameters<typeof recordFileSyncInTx>[1]) => db.transaction(tx => recordFileSyncInTx(tx, input));
const editsOf = (db: Db, noteId: string) => db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, noteId));
const baseOf = async (db: Db, key: string) => (await db.select().from(transferBases).where(eq(transferBases.key, key)))[0]!;

describe("three kinds of rows + base update", () => {
  it("rewrite, delete and insert rows -> all CHECKs pass; applied_body_sha and last_used_at updated; returned ids are in document order", async () => {
    const s = await scene();
    const before = await baseOf(s.db, s.key);
    const ids = await record(s.db, { noteId: s.note.id, baseKey: s.key, appliedBodySha: SHA, rows: [rewriteRow(s.note.id, s.u.id), deleteRow(s.note.id, s.u.id), insertRow(s.note.id, s.u.id)] });
    expect(ids).toHaveLength(3);
    const rows = await editsOf(s.db, s.note.id);
    const byId = new Map(rows.map(r => [r.id, r]));
    expect(ids.map(id => byId.get(id)!.afterBlockIds)).toEqual([["new0"], [], ["ins"]]);
    expect(ids.map(id => byId.get(id)!.anchor)).toEqual([null, { block_id: "prev", position: "after" }, null]);
    // created_at strictly increases in document order (now() + i microseconds).
    const t = await s.db.execute<{ id: string; us: string }>(sql`select id, (extract(epoch from created_at) * 1000000)::bigint::text as us from note_ai_edits where note_id = ${s.note.id}`);
    const us = new Map(t.rows.map(r => [r.id, BigInt(r.us)]));
    expect(us.get(ids[0]!)! < us.get(ids[1]!)!).toBe(true);
    expect(us.get(ids[1]!)! < us.get(ids[2]!)!).toBe(true);
    const after = await baseOf(s.db, s.key);
    expect(Buffer.from(after.appliedBodySha!).equals(SHA)).toBe(true);
    expect(after.lastUsedAt.getTime()).toBeGreaterThan(before.lastUsedAt.getTime());
  });
  it("zero rows (call shape where every region is same) -> no record written, only the base updated", async () => {
    const s = await scene();
    expect(await record(s.db, { noteId: s.note.id, baseKey: s.key, appliedBodySha: SHA, rows: [] })).toEqual([]);
    expect(await editsOf(s.db, s.note.id)).toHaveLength(0);
    expect((await baseOf(s.db, s.key)).appliedBodySha).not.toBeNull();
  });
  it("control: a delete row without anchor -> blocked by note_ai_edits_anchor_chk", async () => {
    const s = await scene();
    const bad = { ...deleteRow(s.note.id, s.u.id), anchor: null };
    await expect(record(s.db, { noteId: s.note.id, baseKey: s.key, appliedBodySha: SHA, rows: [bad] })).rejects.toMatchObject({ cause: { constraint: "note_ai_edits_anchor_chk" } });
  });
});

describe("one transaction (failure after the INSERT)", () => {
  it("the before-update trigger of transfer_bases throws -> this note has 0 note_ai_edits rows and applied_body_sha is still NULL", async () => {
    const s = await scene();
    await s.db.execute(sql.raw(`create function kn_r2_fail() returns trigger language plpgsql as $$ begin raise exception 'r2 boom'; end $$`));
    await s.db.execute(sql.raw(`create trigger kn_r2 before update on transfer_bases for each row execute function kn_r2_fail()`));
    try {
      await expect(record(s.db, { noteId: s.note.id, baseKey: s.key, appliedBodySha: SHA, rows: [rewriteRow(s.note.id, s.u.id), insertRow(s.note.id, s.u.id)] })).rejects.toThrow();
      expect(await editsOf(s.db, s.note.id)).toHaveLength(0);
      expect((await baseOf(s.db, s.key)).appliedBodySha).toBeNull();
    } finally {
      await s.db.execute(sql.raw(`drop trigger if exists kn_r2 on transfer_bases`));
      await s.db.execute(sql.raw(`drop function if exists kn_r2_fail()`));
    }
  });
  it("multi-row INSERT fails (trigger) -> 0 rows, base not written", async () => {
    const s = await scene();
    await s.db.execute(sql.raw(`create function kn_r2b_fail() returns trigger language plpgsql as $$ begin if new.after_block_ids = array['ins'] then raise exception 'r2b boom'; end if; return new; end $$`));
    await s.db.execute(sql.raw(`create trigger kn_r2b before insert on note_ai_edits for each row execute function kn_r2b_fail()`));
    try {
      await expect(record(s.db, { noteId: s.note.id, baseKey: s.key, appliedBodySha: SHA, rows: [rewriteRow(s.note.id, s.u.id), insertRow(s.note.id, s.u.id)] })).rejects.toThrow();
      expect(await editsOf(s.db, s.note.id)).toHaveLength(0);
      expect((await baseOf(s.db, s.key)).appliedBodySha).toBeNull();
    } finally {
      await s.db.execute(sql.raw(`drop trigger if exists kn_r2b on note_ai_edits`));
      await s.db.execute(sql.raw(`drop function if exists kn_r2b_fail()`));
    }
  });
});

describe("trimmed to 100", () => {
  async function seedOld(db: Db, noteId: string, userId: string, n: number) {
    for (let i = 0; i < n; i++) {
      await db.insert(noteAiEdits).values({ ...rewriteRow(noteId, userId, 1000 + i), createdAt: sql`now() - interval '1 day' + ${i}::int * interval '1 second'` });
    }
  }
  it("seed 99 rows, write 3 -> exactly 100, the oldest 2 are deleted; a bystander's rows (another note) are unaffected", async () => {
    const s = await scene();
    await seedOld(s.db, s.note.id, s.u.id, 99);
    await seedOld(s.db, s.other.id, s.u.id, 5);
    const ids = await record(s.db, { noteId: s.note.id, baseKey: s.key, appliedBodySha: SHA, rows: [rewriteRow(s.note.id, s.u.id, 1), rewriteRow(s.note.id, s.u.id, 2), rewriteRow(s.note.id, s.u.id, 3)] });
    expect(ids).toHaveLength(3);
    const rows = await editsOf(s.db, s.note.id);
    expect(rows).toHaveLength(100);
    const olds = rows.map(r => (r.beforeBlocks as Array<{ id: string }>)[0]!.id).filter(x => x.startsWith("old1"));
    expect(olds).not.toContain("old1000");
    expect(olds).not.toContain("old1001");
    expect(olds).toContain("old1002");
    expect(await editsOf(s.db, s.other.id)).toHaveLength(5);
  });
  it("writing 105 regions at once -> the later 100 rows of this request stay, the returned editIds contain only the surviving 100 (document order)", async () => {
    const s = await scene();
    const rows = Array.from({ length: 105 }, (_, i) => rewriteRow(s.note.id, s.u.id, i));
    const ids = await record(s.db, { noteId: s.note.id, baseKey: s.key, appliedBodySha: SHA, rows });
    expect(ids).toHaveLength(100);
    const left = await editsOf(s.db, s.note.id);
    expect(left).toHaveLength(100);
    const byId = new Map(left.map(r => [r.id, r]));
    expect(ids.map(id => byId.get(id)!.afterBlockIds[0])).toEqual(Array.from({ length: 100 }, (_, i) => `new${i + 5}`));
  });
});

type Opts = Parameters<typeof buildCollabTestApp>[0];
type EditItem = { id: string; op: string; revertable: boolean; revertedAt: string | null };
async function writeScene(md: string, opts: Opts = {}) {
  const ctx = await buildCollabTestApp(opts);
  const u = await seedUser(ctx.db);
  const pat = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
  const bulk = await issueBulkDirect(ctx.db, pat.tokenId, { access: "write" });
  const note = await seedNote(ctx.db, { ownerId: u.id }, { title: "T" });
  if (md !== "") await seedMd(ctx.db, note.id, md);
  const list = async () =>
    ((await ctx.app.inject({ method: "GET", url: `/api/notes/${note.id}/edits`, headers: bearer(pat.token) })).json() as { edits: EditItem[] }).edits;
  const revert = (editId: string) => ctx.app.inject({ method: "POST", url: `/api/notes/${note.id}/edits/${editId}/revert`, headers: bearer(pat.token) });
  const md0 = async () => (await liveMarkdown(ctx, note.id)).replace(/\n+$/, "");
  const top = () => topIdsOf(ctx, note.id);
  return { ctx, u, pat, bulk, note, list, revert, md: md0, top };
}
const PARAS5 = "Para 0\n\nPara 1\n\nPara 2\n\nPara 3\n\nPara 4";
const threeRegions = (b: string) => b.replace("Para 1", "Rewritten").replace("Para 3\n\n", "").replace(/\n*$/, "\n\nInserted\n");
const errCode = (r: { json(): unknown }) => (r.json() as { error: { code: string } }).error.code;

describe("reverting file_sync", () => {
  it("three rows listed via GET .../edits, op file_sync, revertable; reverting row by row: rewrite restored, delete re-inserted (reverting again -> already_reverted), insert removed -> back to the original text", async () => {
    const s = await writeScene(PARAS5);
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const w = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, threeRegions));
    expect(w.json()).toMatchObject({ result: "applied", applied: 3 });
    const edits = await s.list();
    expect(edits).toHaveLength(3);
    for (const e of edits) expect(e).toMatchObject({ op: "file_sync", revertable: true, revertedAt: null });
    const [ins, del, rew] = edits; // the list is newest first; the three rows of one request are written by id in document order
    const rows = await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.noteId, s.note.id));
    const byId = new Map(rows.map(r => [r.id, r]));
    expect(byId.get(rew!.id)!.beforeBlocks).toHaveLength(1);
    expect(byId.get(del!.id)!.anchor).not.toBeNull();
    expect(byId.get(ins!.id)!.beforeBlocks).toEqual([]);

    expect((await s.revert(rew!.id)).statusCode).toBe(201);
    expect(await s.md()).toBe("Para 0\n\nPara 1\n\nPara 2\n\nPara 4\n\nInserted");
    expect((await s.revert(del!.id)).statusCode).toBe(201);
    expect(await s.md()).toBe("Para 0\n\nPara 1\n\nPara 2\n\nPara 3\n\nPara 4\n\nInserted");
    const again = await s.revert(del!.id);
    expect(again.statusCode).toBe(409);
    expect(errCode(again)).toBe("already_reverted");
    expect((await s.revert(ins!.id)).statusCode).toBe(201);
    expect(await s.md()).toBe(PARAS5);
    const t = await s.top();
    expect(new Set(t).size).toBe(t.length);
  });

  it("insert row of an empty note -> revert -> exactly one empty paragraph at top level", async () => {
    const s = await writeScene("");
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    expect((await bulkPut(s.ctx.app, s.bulk.token, `${d.text}First para\n\nSecond para`)).statusCode).toBe(200);
    const [e] = await s.list();
    expect(e).toMatchObject({ op: "file_sync", revertable: true });
    expect((await s.revert(e!.id)).statusCode).toBe(201);
    expect(await s.top()).toHaveLength(1);
    expect(await s.md()).toBe("");
  });

  it("a human changed the written block -> that row is revertable false, revert is 409 stale", async () => {
    const s = await writeScene(PARAS5);
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    expect((await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para 1", "Rewritten")))).statusCode).toBe(200);
    await humanEdit(s.ctx, s.note.id, ed => ed.updateBlock(ed.document[1]!.id, { content: "Human touched" }));
    const [e] = await s.list();
    expect(e).toMatchObject({ op: "file_sync", revertable: false });
    const r = await s.revert(e!.id);
    expect(r.statusCode).toBe(409);
    expect(errCode(r)).toBe("stale");
  });

  it("hit a delete row again after reverting it -> no duplicate insert; beforeRevertRecord throws -> 500 (content restored, record not written) -> revert again 409 stale, top-level ids unique, before_blocks only one copy", async () => {
    let boom = true;
    const s = await writeScene(PARAS5, { editingTestHooks: { beforeRevertRecord: async () => { if (boom) throw new Error("boom"); } } });
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    expect((await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para 3\n\n", "")))).statusCode).toBe(200);
    const [e] = await s.list();
    expect(e).toMatchObject({ op: "file_sync", revertable: true });
    expect((await s.revert(e!.id)).statusCode).toBe(500);
    expect(await s.md()).toBe(PARAS5);
    const failed = await s.list();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ revertable: false, revertedAt: null });
    boom = false;
    const second = await s.revert(e!.id);
    expect(second.statusCode).toBe(409);
    expect(errCode(second)).toBe("stale");
    const t = await s.top();
    expect(new Set(t).size).toBe(t.length);
    expect((await s.md()).split("Para 3").length - 1).toBe(1);
  });

  it("pure base shape: base [B, empty paragraph, A, C], file deletes A -> anchor = the user's own empty paragraph (after, not a placeholder) -> after revert A returns behind it and the empty paragraph stays", async () => {
    const s = await writeScene("");
    await seedBlocks(s.ctx.db, s.note.id, [{ type: "paragraph", content: "B" }, { type: "paragraph" }, { type: "paragraph", content: "A" }, { type: "paragraph", content: "C" }]);
    const [, userEmpty] = await s.top();
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    expect(d.body).toContain("B\n\n\n\nA\n\nC");
    const w = await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("A\n\nC", "C")));
    expect(w.statusCode).toBe(200);
    expect(w.json()).toMatchObject({ result: "applied", applied: 1 });
    const t1 = await s.top();
    expect(t1).toHaveLength(3);
    expect(t1[1]).toBe(userEmpty);
    const [e] = await s.list();
    const row = (await s.ctx.db.select().from(noteAiEdits).where(eq(noteAiEdits.id, e!.id)))[0]!;
    expect(row.anchor).toEqual({ block_id: userEmpty, position: "after" });
    expect((await s.revert(e!.id)).statusCode).toBe(201);
    const t2 = await s.top();
    expect(t2).toHaveLength(4);
    expect(t2[1]).toBe(userEmpty);
    expect(await s.md()).toMatch(/^B\n\n\n\nA\n\nC$/);
  });

  it("hit a delete row again after a normal revert -> already_reverted, top-level ids unique", async () => {
    const s = await writeScene(PARAS5);
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    expect((await bulkPut(s.ctx.app, s.bulk.token, editBody(d.text, b => b.replace("Para 3\n\n", "")))).statusCode).toBe(200);
    const [e] = await s.list();
    expect((await s.revert(e!.id)).statusCode).toBe(201);
    expect(errCode(await s.revert(e!.id))).toBe("already_reverted");
    const t = await s.top();
    expect(new Set(t).size).toBe(t.length);
    expect(await s.md()).toBe(PARAS5);
  });
});
