import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { notes, transferBases } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { deriveTransferKey, hmacOf } from "../src/transfer/base-hash.js";
import { normalizeBody } from "../src/transfer/normalize.js";
import { buildCollabTestApp, testConfig, testEditingRuntime, type CollabTestCtx } from "./helpers.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { seedGroup, seedNote, seedUser } from "./group-helpers.js";
import { bulkPut, downloadNote, editBody, issueBulkDirect, renameIn, seedBlocks, seedMd } from "./bulk-transfer-helpers.js";

type Opts = Parameters<typeof buildCollabTestApp>[0];
async function scene(opts: Opts = {}, title = "Title") {
  const ctx = await buildCollabTestApp(opts);
  const u = await seedUser(ctx.db);
  const pat = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
  const bulk = await issueBulkDirect(ctx.db, pat.tokenId, { access: "write" });
  const note = await seedNote(ctx.db, { ownerId: u.id }, { title });
  await seedMd(ctx.db, note.id, "Para 0\n\nPara 1\n\nPara 2");
  return { ctx, u, pat, bulk, note };
}
const titleOf = async (ctx: CollabTestCtx, id: string) => (await ctx.db.select({ title: notes.title }).from(notes).where(eq(notes.id, id)))[0]!.title;
const baseOf = async (ctx: CollabTestCtx, key: string) => (await ctx.db.select().from(transferBases).where(eq(transferBases.key, key)))[0]!;
const one = () => new FixedWindowLimiter({ limit: 1, windowMs: 60_000 });

describe("rename", () => {
  it("title only -> 200 renamed, no mount (body change decided by structural comparison), transferWrite charged 1, applied_title_sha written; resending the same file -> unchanged, not charged", async () => {
    const transferWrite = new FixedWindowLimiter({ limit: 2, windowMs: 60_000 });
    const s = await scene({ limiters: { transferWrite } });
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const text = renameIn(d.text, "New title");
    const m0 = testEditingRuntime.mounts;
    const r = await bulkPut(s.ctx.app, s.bulk.token, text);
    expect(r.json()).toMatchObject({ result: "renamed", renamed: true, applied: 0 });
    expect(testEditingRuntime.mounts - m0).toBe(0);
    expect(await titleOf(s.ctx, s.note.id)).toBe("New title");
    expect((await baseOf(s.ctx, d.fm.base!)).appliedTitleSha).not.toBeNull();
    expect((await bulkPut(s.ctx.app, s.bulk.token, text)).json()).toMatchObject({ result: "unchanged", renamed: false });
    // limit 2: the first charged 1, the second (unchanged) did not -> 1 left (another rename-only still succeeds), the third is 429.
    expect((await bulkPut(s.ctx.app, s.bulk.token, renameIn(d.text, "Third title"))).statusCode).toBe(200);
    expect((await bulkPut(s.ctx.app, s.bulk.token, renameIn(d.text, "Fourth title"))).statusCode).toBe(429);
  });

  it("content + rename -> charged once, renamed: true, result applied", async () => {
    const transferWrite = one();
    const s = await scene({ limiters: { transferWrite } });
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const r = await bulkPut(s.ctx.app, s.bulk.token, renameIn(editBody(d.text, b => b.replace("Para 1", "x")), "Both"));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ result: "applied", renamed: true });
    expect(await titleOf(s.ctx, s.note.id)).toBe("Both");
  });

  it("ownership_changed (renameHook moves the note into a group before the UPDATE) -> 200, renamed: false + renameFailed, applied_title_sha not written; after moving back, resending the same file retries and renames", async () => {
    const hold: { act?: () => Promise<void> } = {};
    const s = await scene({ slugUpdateTestHook: async () => { if (hold.act) { const f = hold.act; hold.act = undefined; await f(); } } });
    const g = await seedGroup(s.ctx.db, "G", [{ userId: s.u.id, role: "admin" }]);
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    hold.act = async () => { await s.ctx.db.update(notes).set({ ownerId: null, groupId: g.id }).where(eq(notes.id, s.note.id)); };
    const text = renameIn(d.text, "Moved title");
    const r = await bulkPut(s.ctx.app, s.bulk.token, text);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ renamed: false, renameFailed: "ownership_changed" });
    expect(await titleOf(s.ctx, s.note.id)).toBe("Title");
    expect((await baseOf(s.ctx, d.fm.base!)).appliedTitleSha).toBeNull();
    await s.ctx.db.update(notes).set({ ownerId: s.u.id, groupId: null }).where(eq(notes.id, s.note.id));
    expect((await bulkPut(s.ctx.app, s.bulk.token, text)).json()).toMatchObject({ result: "renamed", renamed: true });
    expect(await titleOf(s.ctx, s.note.id)).toBe("Moved title");
  });

  it("gone (moved to trash after the merge record, before the rename) -> 200, renameFailed gone", async () => {
    const hold: { act?: () => Promise<void> } = {};
    const s = await scene({ editingTestHooks: { afterRecord: async () => { if (hold.act) { const f = hold.act; hold.act = undefined; await f(); } } } });
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    hold.act = async () => { await s.ctx.db.update(notes).set({ deletedAt: new Date() }).where(eq(notes.id, s.note.id)); };
    const r = await bulkPut(s.ctx.app, s.bulk.token, renameIn(editBody(d.text, b => b.replace("Para 1", "x")), "Gone title"));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ renamed: false, renameFailed: "gone" });
  });

  it("rename only, already in trash at rename time -> 404", async () => {
    const hold: { act?: () => Promise<void> } = {};
    const s = await scene({ slugUpdateTestHook: async () => { if (hold.act) { const f = hold.act; hold.act = undefined; await f(); } } });
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    hold.act = async () => { await s.ctx.db.update(notes).set({ deletedAt: new Date() }).where(eq(notes.id, s.note.id)); };
    expect((await bulkPut(s.ctx.app, s.bulk.token, renameIn(d.text, "Gone only"))).statusCode).toBe(404);
  });

  it("after a rename, change the title back to its original and resend (same base) -> renames (compared with applied_title_sha, not the title at download)", async () => {
    const s = await scene();
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    expect((await bulkPut(s.ctx.app, s.bulk.token, renameIn(d.text, "Changed"))).json()).toMatchObject({ result: "renamed" });
    const r = await bulkPut(s.ctx.app, s.bulk.token, d.text);
    expect(r.json()).toMatchObject({ result: "renamed" });
    expect(await titleOf(s.ctx, s.note.id)).toBe("Title");
  });

  it("a title with special characters resent verbatim -> does not trigger a rename", async () => {
    for (const title of ['a"b', "back\\slash", "it's", "# hash", "key: value", "- dash", "emoji 😀"]) {
      const s = await scene({}, title);
      const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
      expect((await bulkPut(s.ctx.app, s.bulk.token, d.text)).json(), title).toMatchObject({ result: "unchanged", renamed: false });
    }
  });

  it("not_mergeable note with only the title changed -> renamed", async () => {
    const s = await scene({ transferTestHooks: { forceUnmergeable: () => true } });
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    expect((await bulkPut(s.ctx.app, s.bulk.token, renameIn(d.text, "Renamed unmergeable"))).json()).toMatchObject({ result: "renamed" });
  });

  it("mergeable:false note downloaded before #393 with only the title changed -> 409 note_changed, not renamed (read format changed, so the whole-export comparison no longer matches)", async () => {
    const s = await scene({ transferTestHooks: { forceUnmergeable: () => true } });
    const note = await seedNote(s.ctx.db, { ownerId: s.u.id }, { title: "Title" });
    await seedBlocks(s.ctx.db, note.id, [{ type: "paragraph", content: "2*3*4 and 5*6" }]);
    const d = await downloadNote(s.ctx.app, s.bulk.token, note.id);
    // Build a copy of an "old-format export": since #393 reads escape `*`, older exports did not. The base's body_sha is replaced by the hash of the
    // old-version body (the base left by a download back then), and the file body is also the old-version body (the user's file).
    const oldBody = d.body.split("\\*").join("*");
    expect(oldBody, "前提：現行匯出有跳脫").not.toBe(d.body);
    const row = await baseOf(s.ctx, d.fm.base!);
    expect(row.segments, "前提：mergeable:false").toBeNull();
    const key = deriveTransferKey(testConfig.appSecret);
    await s.ctx.db.update(transferBases).set({ bodySha: hmacOf(key, Buffer.from(row.salt), normalizeBody(oldBody)) }).where(eq(transferBases.key, row.key));
    const r = await bulkPut(s.ctx.app, s.bulk.token, renameIn(editBody(d.text, () => oldBody), "Renamed old copy"));
    expect(r.statusCode).toBe(409);
    expect((r.json() as { error: { reason: string } }).error.reason).toBe("note_changed");
    expect(await titleOf(s.ctx, note.id)).toBe("Title");
  });

  it("transferWrite full, rename only -> 429, title unchanged", async () => {
    const transferWrite = new FixedWindowLimiter({ limit: 0, windowMs: 60_000 });
    const s = await scene({ limiters: { transferWrite } });
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    expect((await bulkPut(s.ctx.app, s.bulk.token, renameIn(d.text, "Blocked"))).statusCode).toBe(429);
    expect(await titleOf(s.ctx, s.note.id)).toBe("Title");
  });

  it("someone else made the same body change before the merge -> no merge, on retry judged note_changed -> 409, not renamed", async () => {
    const ref = {} as { ctx: CollabTestCtx };
    let noteRef = "";
    let n = 0;
    const s = await scene({
      limiters: { transferWrite: one() },
      editingTestHooks: {
        beforeMerge: async () => {
          if (noteRef === "" || n++ > 0) return;
          const { humanEdit } = await import("./bulk-transfer-helpers.js");
          await humanEdit(ref.ctx, noteRef, ed => ed.replaceBlocks([ed.document[1]!.id], [{ type: "paragraph", content: "Same" }]));
        },
      },
    });
    ref.ctx = s.ctx;
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    noteRef = s.note.id;
    const r = await bulkPut(s.ctx.app, s.bulk.token, renameIn(editBody(d.text, b => b.replace("Para 1", "Same")), "After retry"));
    expect(r.statusCode).toBe(409);
    expect((r.json() as { error: { reason: string } }).error.reason).toBe("note_changed");
    expect(await titleOf(s.ctx, s.note.id)).toBe("Title");
  });

  it("the same file sent twice at once with rename only -> renamed once: one renamed, one unchanged", async () => {
    // The first request stops 300 ms before the rename UPDATE: while in the queue the second must wait; if the rename moved outside the queue, the second would read the same base in that window and rename again.
    let first = true;
    const s = await scene({ slugUpdateTestHook: async () => { if (first) { first = false; await new Promise(r => setTimeout(r, 300)); } } });
    const d = await downloadNote(s.ctx.app, s.bulk.token, s.note.id);
    const text = renameIn(d.text, "Concurrent title");
    const rs = await Promise.all([bulkPut(s.ctx.app, s.bulk.token, text), bulkPut(s.ctx.app, s.bulk.token, text)]);
    expect(rs.map(r => r.statusCode)).toEqual([200, 200]);
    expect(rs.map(r => (r.json() as { result: string }).result).sort()).toEqual(["renamed", "unchanged"]);
    expect(await titleOf(s.ctx, s.note.id)).toBe("Concurrent title");
  });
});
