import { describe, expect, it } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import { folders, notes, transferCreates } from "../src/db/schema.js";
import { TRANSFER_WRITE_BODY_LIMIT } from "../src/http/body-limits.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import type { BulkRange } from "../src/auth/transfer-token.js";
import { FOLDER_NOT_FOUND_MESSAGE, NOTE_FOLDER_ROLE_FORBIDDEN_MESSAGE } from "../src/folders/messages.js";
import {
  CREATE_IN_SHARED_FORBIDDEN_MESSAGE,
  DEST_NOT_IN_RANGE_MESSAGE,
  GROUP_CREATE_FORBIDDEN_MESSAGE,
  SHARED_FOLDER_CREATE_FORBIDDEN_MESSAGE,
} from "../src/transfer/create-file.js";
import { buildCollabTestApp, testConfig, type CollabTestCtx } from "./helpers.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { seedFolder } from "./folder-helpers.js";
import { seedGroup, seedNote, seedRole, seedShare, seedUser, setMemberRole } from "./group-helpers.js";
import { bulkPut, issueBulkDirect, liveMarkdown } from "./bulk-transfer-helpers.js";

type Opts = Parameters<typeof buildCollabTestApp>[0];

async function scene(opts: Opts = {}, range: BulkRange = { kind: "all" }) {
  const ctx = await buildCollabTestApp(opts);
  const u = await seedUser(ctx.db);
  const pat = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
  const bulk = await issueBulkDirect(ctx.db, pat.tokenId, { access: "write", range });
  return { ctx, u, pat, bulk };
}
const fileOf = (fm: Record<string, string>, body: string) =>
  `---\nknotebook: 1\n${Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}\n---\n${body}\n`;
const errOf = (r: { json(): unknown }) => (r.json() as { error: { code: string; message: string } }).error;
const liveNotes = (ctx: CollabTestCtx) => ctx.db.select().from(notes).where(isNull(notes.deletedAt));
const createsOf = (ctx: CollabTestCtx) => ctx.db.select().from(transferCreates);
const noteRow = async (ctx: CollabTestCtx, id: string) => (await ctx.db.select().from(notes).where(eq(notes.id, id)))[0]!;
const norm = (s: string) => s.replace(/\n+$/, "");

describe("create", () => {
  it("knotebook: without id -> 201, content = body, title = title; no title line -> Untitled + untitled-<uuid8>; a file with no frontmatter at all -> 201", async () => {
    const s = await scene();
    const r = await bulkPut(s.ctx.app, s.bulk.token, fileOf({ title: "Fresh" }, "Para A\n\nPara B"));
    expect(r.statusCode).toBe(201);
    const j = r.json() as { id: string };
    expect(r.json()).toEqual({ id: j.id, created: true, result: "created", base: null, unboundWikilinks: 0 });
    expect((await noteRow(s.ctx, j.id)).title).toBe("Fresh");
    expect(norm(await liveMarkdown(s.ctx, j.id))).toBe("Para A\n\nPara B");
    expect((await noteRow(s.ctx, j.id)).ownerId).toBe(s.u.id);

    const r2 = await bulkPut(s.ctx.app, s.bulk.token, fileOf({}, "No title body"));
    expect(r2.statusCode).toBe(201);
    const n2 = await noteRow(s.ctx, (r2.json() as { id: string }).id);
    expect(n2.title).toBe("Untitled");
    expect(n2.slug).toMatch(/^untitled-[0-9a-f]{8}$/);

    const r3 = await bulkPut(s.ctx.app, s.bulk.token, "Plain file without front matter\n");
    expect(r3.statusCode).toBe(201);
    expect(norm(await liveMarkdown(s.ctx, (r3.json() as { id: string }).id))).toBe("Plain file without front matter");
  });

  it("resending the same file -> 200 unchanged with the same id, does not charge transferWrite, charges tokenRead", async () => {
    const transferWrite = new FixedWindowLimiter({ limit: 2, windowMs: 60_000 });
    const tokenRead = new FixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    const s = await scene({ limiters: { transferWrite, tokenRead } });
    const text = fileOf({ title: "Dup" }, "Dup body");
    const r1 = await bulkPut(s.ctx.app, s.bulk.token, text);
    expect(r1.statusCode).toBe(201);
    const id = (r1.json() as { id: string }).id;
    const r2 = await bulkPut(s.ctx.app, s.bulk.token, text);
    expect(r2.statusCode).toBe(200);
    expect(r2.json()).toEqual({ id, created: false, result: "unchanged", base: null });
    // A hit charges tokenRead (limit 1 already used up) -> the second hit is 429.
    expect((await bulkPut(s.ctx.app, s.bulk.token, text)).statusCode).toBe(429);
    expect(await liveNotes(s.ctx)).toHaveLength(1);
    // transferWrite was charged only once: another create is still 201.
    expect((await bulkPut(s.ctx.app, s.bulk.token, fileOf({ title: "Other" }, "Other body"))).statusCode).toBe(201);
  });

  it("the same file with CRLF + trailing blank lines -> dedupe hit", async () => {
    const s = await scene();
    const text = fileOf({ title: "Dup" }, "Dup body");
    const id = ((await bulkPut(s.ctx.app, s.bulk.token, text)).json() as { id: string }).id;
    const r = await bulkPut(s.ctx.app, s.bulk.token, `${text.replace(/\n/g, "\r\n")}\r\n\r\n`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id, created: false });
  });

  it("after restart (same DB, second app) the same id; after key rotation a resend -> created anew", async () => {
    const s = await scene();
    const text = fileOf({ title: "Restart" }, "Restart body");
    const id = ((await bulkPut(s.ctx.app, s.bulk.token, text)).json() as { id: string }).id;
    await s.ctx.destroy();
    const ctx2 = await buildCollabTestApp({ db: s.ctx.db });
    const r = await bulkPut(ctx2.app, s.bulk.token, text);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id, created: false });
    await ctx2.destroy();
    const ctx3 = await buildCollabTestApp({ db: s.ctx.db, config: { ...testConfig, appSecret: `${testConfig.appSecret}-rotated` } });
    const r3 = await bulkPut(ctx3.app, s.bulk.token, text);
    expect(r3.statusCode).toBe(201);
    expect((r3.json() as { id: string }).id).not.toBe(id);
    expect(await liveNotes(ctx3)).toHaveLength(2);
  });

  it("dedupe row's key_id is not the current key (row left by an old key) -> treated as absent, created anew", async () => {
    // On key rotation file_sha changes too (the HMAC includes K), so removing the key_id comparison stays green in the rotation case; this case marks the row as an old key directly to guard the key_id comparison.
    const s = await scene();
    const text = fileOf({ title: "Stale key" }, "Stale key body");
    const id = ((await bulkPut(s.ctx.app, s.bulk.token, text)).json() as { id: string }).id;
    await s.ctx.db.update(transferCreates).set({ keyId: "0000000000000000" });
    const r = await bulkPut(s.ctx.app, s.bulk.token, text);
    expect(r.statusCode).toBe(201);
    expect((r.json() as { id: string }).id).not.toBe(id);
  });

  it("two requests at once -> exactly one note (create: queue key)", async () => {
    const s = await scene();
    const text = fileOf({ title: "Race" }, "Race body");
    const [a, b] = await Promise.all([bulkPut(s.ctx.app, s.bulk.token, text), bulkPut(s.ctx.app, s.bulk.token, text)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    expect((a.json() as { id: string }).id).toBe((b.json() as { id: string }).id);
    expect(await liveNotes(s.ctx)).toHaveLength(1);
  });

  it("outside the TTL (created_at moved to 31 minutes ago) -> created anew, upsert does not hit the PK", async () => {
    const s = await scene();
    const text = fileOf({ title: "Old" }, "Old body");
    const id = ((await bulkPut(s.ctx.app, s.bulk.token, text)).json() as { id: string }).id;
    await s.ctx.db.update(transferCreates).set({ createdAt: sql`now() - interval '31 minutes'` });
    const r = await bulkPut(s.ctx.app, s.bulk.token, text);
    expect(r.statusCode).toBe(201);
    const id2 = (r.json() as { id: string }).id;
    expect(id2).not.toBe(id);
    expect((await createsOf(s.ctx)).map(c => c.noteId)).toEqual([id2]);
  });

  it("original note goes to trash, then resend -> created anew", async () => {
    const s = await scene();
    const text = fileOf({ title: "Trash" }, "Trash body");
    const id = ((await bulkPut(s.ctx.app, s.bulk.token, text)).json() as { id: string }).id;
    await s.ctx.db.update(notes).set({ deletedAt: new Date() }).where(eq(notes.id, id));
    const r = await bulkPut(s.ctx.app, s.bulk.token, text);
    expect(r.statusCode).toBe(201);
    expect((r.json() as { id: string }).id).not.toBe(id);
    expect(await createsOf(s.ctx)).toHaveLength(1);
  });

  it("four placement forms + folder_id pointing at a folder within range", async () => {
    const sAll = await scene();
    const rAll = await bulkPut(sAll.ctx.app, sAll.bulk.token, fileOf({ title: "A" }, "a"));
    expect(await noteRow(sAll.ctx, (rAll.json() as { id: string }).id)).toMatchObject({ ownerId: sAll.u.id, groupId: null, folderId: null });
    const fP = await seedFolder(sAll.ctx.db, { personal: sAll.u.id });
    const pat2 = await seedTokenForUser(sAll.ctx.db, sAll.u.id, "notes:read notes:write");
    const personal = await issueBulkDirect(sAll.ctx.db, pat2.tokenId, { access: "write", range: { kind: "personal" } });
    const rP = await bulkPut(sAll.ctx.app, personal.token, fileOf({ title: "P", folder_id: fP.id.toUpperCase() }, "p"));
    expect(rP.statusCode).toBe(201);
    expect(await noteRow(sAll.ctx, (rP.json() as { id: string }).id)).toMatchObject({ ownerId: sAll.u.id, groupId: null, folderId: fP.id });
    const child = await seedFolder(sAll.ctx.db, { personal: sAll.u.id }, { parentId: fP.id });
    const pat3 = await seedTokenForUser(sAll.ctx.db, sAll.u.id, "notes:read notes:write");
    const fb = await issueBulkDirect(sAll.ctx.db, pat3.tokenId, { access: "write", range: { kind: "folder", folderId: fP.id } });
    const rF = await bulkPut(sAll.ctx.app, fb.token, fileOf({ title: "F" }, "f"));
    expect(await noteRow(sAll.ctx, (rF.json() as { id: string }).id)).toMatchObject({ folderId: fP.id });
    const rC = await bulkPut(sAll.ctx.app, fb.token, fileOf({ title: "C", folder_id: child.id }, "c"));
    expect(rC.statusCode).toBe(201);
    expect(await noteRow(sAll.ctx, (rC.json() as { id: string }).id)).toMatchObject({ folderId: child.id });
    const g = await seedGroup(sAll.ctx.db, "G", [{ userId: sAll.u.id, role: "member" }]);
    const pat4 = await seedTokenForUser(sAll.ctx.db, sAll.u.id, "notes:read notes:write");
    const gb = await issueBulkDirect(sAll.ctx.db, pat4.tokenId, { access: "write", range: { kind: "group", groupId: g.id } });
    const rG = await bulkPut(sAll.ctx.app, gb.token, fileOf({ title: "G" }, "g"));
    expect(rG.statusCode).toBe(201);
    expect(await noteRow(sAll.ctx, (rG.json() as { id: string }).id)).toMatchObject({ ownerId: null, groupId: g.id, folderId: null });
  });

  it("front matter with only title + folder_id and no knotebook:/id: line does not count as front matter: Untitled, created at the top of the token's scope, those lines go into the body; the same file with a knotebook: line added -> follows title/folder_id", async () => {
    const s = await scene();
    const top = await seedFolder(s.ctx.db, { personal: s.u.id });
    const sub = await seedFolder(s.ctx.db, { personal: s.u.id }, { parentId: top.id });
    const pat = await seedTokenForUser(s.ctx.db, s.u.id, "notes:read notes:write");
    const fb = await issueBulkDirect(s.ctx.db, pat.tokenId, { access: "write", range: { kind: "folder", folderId: top.id } });
    const bare = `---\ntitle: "Ignored title"\nfolder_id: ${sub.id}\n---\nBody of bare file\n`;
    const r = await bulkPut(s.ctx.app, fb.token, bare);
    expect(r.statusCode).toBe(201);
    const id = (r.json() as { id: string }).id;
    expect(await noteRow(s.ctx, id)).toMatchObject({ title: "Untitled", folderId: top.id });
    const md = await liveMarkdown(s.ctx, id);
    expect(md).toContain('title: "Ignored title"');
    expect(md).toContain("Body of bare file");
    const withLine = bare.replace("---\n", "---\nknotebook: 1\n");
    const r2 = await bulkPut(s.ctx.app, fb.token, withLine);
    expect(r2.statusCode).toBe(201);
    const id2 = (r2.json() as { id: string }).id;
    expect(await noteRow(s.ctx, id2)).toMatchObject({ title: "Ignored title", folderId: sub.id });
    expect(norm(await liveMarkdown(s.ctx, id2))).toBe("Body of bare file");
  });

  it("rejection shapes (each with its own constant message): shared scope 403 CREATE_IN_SHARED_FORBIDDEN_MESSAGE; invisible folder_id 404 FOLDER_NOT_FOUND_MESSAGE; shared-space folder 403 SHARED_FOLDER_CREATE_FORBIDDEN_MESSAGE; folder out of range 403 DEST_NOT_IN_RANGE_MESSAGE; create-only role: group top level 201, group folder 403 NOTE_FOLDER_ROLE_FORBIDDEN_MESSAGE; read-only role: group top level 403 GROUP_CREATE_FORBIDDEN_MESSAGE", async () => {
    const s = await scene({}, { kind: "shared" });
    const r1 = await bulkPut(s.ctx.app, s.bulk.token, fileOf({ title: "S" }, "s"));
    expect(r1.statusCode).toBe(403);
    expect(errOf(r1)).toEqual({ code: "forbidden", message: CREATE_IN_SHARED_FORBIDDEN_MESSAGE });

    const pat = await seedTokenForUser(s.ctx.db, s.u.id, "notes:read notes:write");
    const all = await issueBulkDirect(s.ctx.db, pat.tokenId, { access: "write" });
    const stranger = await seedUser(s.ctx.db);
    const hidden = await seedFolder(s.ctx.db, { personal: stranger.id });
    const r2 = await bulkPut(s.ctx.app, all.token, fileOf({ title: "H", folder_id: hidden.id }, "h"));
    expect(r2.statusCode).toBe(404);
    expect(errOf(r2)).toEqual({ code: "folder_not_found", message: FOLDER_NOT_FOUND_MESSAGE });

    // Folder inside the space shared with me (I filed a note shared by someone else into a folder of my own shared space).
    const sharedFolder = await seedFolder(s.ctx.db, { shared: s.u.id });
    const sn = await seedNote(s.ctx.db, { ownerId: stranger.id }, { title: "SN" });
    await seedShare(s.ctx.db, sn.id, s.u.id, "editor");
    const r3 = await bulkPut(s.ctx.app, all.token, fileOf({ title: "SF", folder_id: sharedFolder.id }, "sf"));
    expect(r3.statusCode).toBe(403);
    expect(errOf(r3)).toEqual({ code: "forbidden", message: SHARED_FOLDER_CREATE_FORBIDDEN_MESSAGE });

    const inF = await seedFolder(s.ctx.db, { personal: s.u.id });
    const outF = await seedFolder(s.ctx.db, { personal: s.u.id });
    const pat2 = await seedTokenForUser(s.ctx.db, s.u.id, "notes:read notes:write");
    const fb = await issueBulkDirect(s.ctx.db, pat2.tokenId, { access: "write", range: { kind: "folder", folderId: inF.id } });
    const r4 = await bulkPut(s.ctx.app, fb.token, fileOf({ title: "O", folder_id: outF.id }, "o"));
    expect(r4.statusCode).toBe(403);
    expect(errOf(r4)).toEqual({ code: "forbidden", message: DEST_NOT_IN_RANGE_MESSAGE });
    const g = await seedGroup(s.ctx.db, "G", [{ userId: s.u.id, role: "member" }]);
    const gf = await seedFolder(s.ctx.db, { group: g.id });
    const pat3 = await seedTokenForUser(s.ctx.db, s.u.id, "notes:read notes:write");
    const pb = await issueBulkDirect(s.ctx.db, pat3.tokenId, { access: "write", range: { kind: "personal" } });
    const r5 = await bulkPut(s.ctx.app, pb.token, fileOf({ title: "PG", folder_id: gf.id }, "pg"));
    expect(r5.statusCode).toBe(403);
    expect(errOf(r5)).toEqual({ code: "forbidden", message: DEST_NOT_IN_RANGE_MESSAGE });

    const co = await seedRole(s.ctx.db, g.id, "create-only", { canRead: true, canCreate: true });
    await setMemberRole(s.ctx.db, g.id, s.u.id, co);
    const pat4 = await seedTokenForUser(s.ctx.db, s.u.id, "notes:read notes:write");
    const gb = await issueBulkDirect(s.ctx.db, pat4.tokenId, { access: "write", range: { kind: "group", groupId: g.id } });
    expect((await bulkPut(s.ctx.app, gb.token, fileOf({ title: "CO" }, "co"))).statusCode).toBe(201);
    const r6 = await bulkPut(s.ctx.app, gb.token, fileOf({ title: "COF", folder_id: gf.id }, "cof"));
    expect(r6.statusCode).toBe(403);
    expect(errOf(r6)).toEqual({ code: "forbidden", message: NOTE_FOLDER_ROLE_FORBIDDEN_MESSAGE });
    const g2 = await seedGroup(s.ctx.db, "G2", [{ userId: s.u.id, role: "member" }]);
    await setMemberRole(s.ctx.db, g2.id, s.u.id, await seedRole(s.ctx.db, g2.id, "read-only", { canRead: true }));
    const pat5 = await seedTokenForUser(s.ctx.db, s.u.id, "notes:read notes:write");
    const g2b = await issueBulkDirect(s.ctx.db, pat5.tokenId, { access: "write", range: { kind: "group", groupId: g2.id } });
    const r7 = await bulkPut(s.ctx.app, g2b.token, fileOf({ title: "RO" }, "ro"));
    expect(r7.statusCode).toBe(403);
    expect(errOf(r7)).toEqual({ code: "forbidden", message: GROUP_CREATE_FORBIDDEN_MESSAGE });
    expect(await createsOf(s.ctx)).toHaveLength(1);
  });

  it("parse failure (unsupported_color) -> 400, no extra notes, no extra transfer_creates", async () => {
    const s = await scene();
    // A bystander note first: on a parse failure there is no new note to point at, and "still write the dedupe row" needs an existing note to write (otherwise the FK blocks it, which is equivalent).
    await seedNote(s.ctx.db, { ownerId: s.u.id }, { title: "Existing" });
    const r = await bulkPut(s.ctx.app, s.bulk.token, fileOf({ title: "Bad" }, 'x <span style="color:tomato">orange-ish</span>'));
    expect(r.statusCode).toBe(400);
    expect(errOf(r).code).toBe("unsupported_color");
    expect(await s.ctx.db.select().from(notes)).toHaveLength(1);
    expect(await createsOf(s.ctx)).toHaveLength(0);
  });

  it("a parse failure also charges transferWrite (charged before parsing, as edit_note): limit 1 -> create with a bad color value 400 -> a valid create 429, not created", async () => {
    const s = await scene({ limiters: { transferWrite: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) } });
    const bad = await bulkPut(s.ctx.app, s.bulk.token, fileOf({ title: "Bad" }, 'x <span style="color:tomato">orange-ish</span>'));
    expect(bad.statusCode).toBe(400);
    expect(errOf(bad).code).toBe("unsupported_color");
    const good = await bulkPut(s.ctx.app, s.bulk.token, fileOf({ title: "Good" }, "good body"));
    expect(good.statusCode).toBe(429);
    expect(await liveNotes(s.ctx)).toHaveLength(0);
  });

  it("20 000 paragraphs within the 256 KiB write-back limit -> 400 too_many_blocks, blocked by the pre-check (no full parse), charges transferWrite; four requests in a row never stall the event loop for over 1 second", async () => {
    const transferWrite = new FixedWindowLimiter({ limit: 4, windowMs: 60_000 });
    const s = await scene({ limiters: { transferWrite } });
    for (let i = 0; i < 4; i++) {
      const md = Array.from({ length: 20_000 }, (_, k) => `p${i} ${k}`).join("\n\n");
      expect(Buffer.byteLength(fileOf({ title: `Huge ${i}` }, md)), "前提：在寫回上限內（不是被 413 擋下）").toBeLessThanOrEqual(TRANSFER_WRITE_BODY_LIMIT);
      let maxGap = 0;
      let last = performance.now();
      const iv = setInterval(() => {
        const n = performance.now();
        maxGap = Math.max(maxGap, n - last);
        last = n;
      }, 5);
      const r = await bulkPut(s.ctx.app, s.bulk.token, fileOf({ title: `Huge ${i}` }, md));
      await new Promise(res => setTimeout(res, 20));
      clearInterval(iv);
      expect(r.statusCode, `#${i}`).toBe(400);
      expect(errOf(r).code, `#${i}`).toBe("too_many_blocks");
      // The pre-check leaves only body decoding, frontmatter, HMAC and the line scan; without it each request took seconds on a ~1 MB, 27 000-paragraph body.
      expect(maxGap, `#${i} 事件迴圈最長停頓`).toBeLessThan(1_000);
    }
    expect(transferWrite.isBlocked(s.u.id)).toBe(true);
    expect((await bulkPut(s.ctx.app, s.bulk.token, fileOf({ title: "After" }, "ok body"))).statusCode).toBe(429);
    expect(await liveNotes(s.ctx)).toHaveLength(0);
  }, 120_000);

  it("transferWrite limit 1 -> second create 429", async () => {
    const s = await scene({ limiters: { transferWrite: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) } });
    expect((await bulkPut(s.ctx.app, s.bulk.token, fileOf({ title: "1" }, "one"))).statusCode).toBe(201);
    const r = await bulkPut(s.ctx.app, s.bulk.token, fileOf({ title: "2" }, "two"));
    expect(r.statusCode).toBe(429);
    expect(r.headers["retry-after"]).toBeDefined();
    expect(await liveNotes(s.ctx)).toHaveLength(1);
  });

  it("charge before parsing: with the quota used up, a new file without a dedupe hit is 429 straight away without parsing (a file that would fail to parse is 429, not 400); a resend with a dedupe hit is still 200", async () => {
    const s = await scene({ limiters: { transferWrite: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) } });
    const first = fileOf({ title: "1" }, "one");
    expect((await bulkPut(s.ctx.app, s.bulk.token, first)).statusCode).toBe(201);
    const bad = await bulkPut(s.ctx.app, s.bulk.token, fileOf({ title: "Bad" }, 'x <span style="color:tomato">orange-ish</span>'));
    expect(bad.statusCode).toBe(429);
    expect(errOf(bad).code).toBe("too_many_requests");
    expect(bad.headers["retry-after"]).toBeDefined();
    const again = await bulkPut(s.ctx.app, s.bulk.token, first);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ created: false, result: "unchanged" });
    expect(await liveNotes(s.ctx)).toHaveLength(1);
  });

  it("TTL cleanup: rows from 31 minutes ago are deleted, another user's new rows stay (bystander)", async () => {
    const s = await scene();
    const other = await seedUser(s.ctx.db);
    const opat = await seedTokenForUser(s.ctx.db, other.id, "notes:read notes:write");
    const ob = await issueBulkDirect(s.ctx.db, opat.tokenId, { access: "write" });
    expect((await bulkPut(s.ctx.app, ob.token, fileOf({ title: "Bystander" }, "keep"))).statusCode).toBe(201);
    expect((await bulkPut(s.ctx.app, s.bulk.token, fileOf({ title: "Old" }, "old"))).statusCode).toBe(201);
    await s.ctx.db.update(transferCreates).set({ createdAt: sql`now() - interval '31 minutes'` }).where(eq(transferCreates.userId, s.u.id));
    expect((await bulkPut(s.ctx.app, s.bulk.token, fileOf({ title: "New" }, "new"))).statusCode).toBe(201);
    let rows: Awaited<ReturnType<typeof createsOf>> = [];
    const poll = async () => {
      rows = await createsOf(s.ctx);
    };
    await poll();
    for (let i = 0; i < 50 && rows.length !== 2; i++) {
      await new Promise(r => setTimeout(r, 50));
      await poll();
    }
    expect(rows).toHaveLength(2);
    expect(rows.filter(r => r.userId === other.id)).toHaveLength(1);
    expect(rows.filter(r => r.userId === s.u.id)).toHaveLength(1);
  });

  it("row-creation failure mapping: the target folder is deleted just before createWithContent -> 404 folder_not_found, transfer_creates unchanged; the 201's unboundWikilinks = number of invisible wikilinks", async () => {
    const hold: { act?: () => Promise<void> } = {};
    const s = await scene({ editingTestHooks: { beforeCreateFromFile: async () => { if (hold.act) { const f = hold.act; hold.act = undefined; await f(); } } } });
    const f = await seedFolder(s.ctx.db, { personal: s.u.id });
    hold.act = async () => { await s.ctx.db.delete(folders).where(eq(folders.id, f.id)); };
    const r = await bulkPut(s.ctx.app, s.bulk.token, fileOf({ title: "Doomed", folder_id: f.id }, "doomed"));
    expect(r.statusCode).toBe(404);
    expect(errOf(r).code).toBe("folder_not_found");
    expect(await createsOf(s.ctx)).toHaveLength(0);
    expect(await s.ctx.db.select().from(notes).where(and(eq(notes.title, "Doomed")))).toHaveLength(0);

    await seedNote(s.ctx.db, { ownerId: s.u.id }, { title: "Known target" });
    const r2 = await bulkPut(s.ctx.app, s.bulk.token, fileOf({ title: "Links" }, "see [[Known target]] and [[Missing one]] and [[Missing two]]"));
    expect(r2.statusCode).toBe(201);
    expect(r2.json()).toMatchObject({ unboundWikilinks: 2 });
  });
});
