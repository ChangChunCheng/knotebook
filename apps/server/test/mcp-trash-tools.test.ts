/**
 * REST through the same user's cookie is the oracle because both sides use the same service functions; trash state is created via
 * `DELETE /api/notes/:id` or `markTrashed`; large data and pathological strings are written directly to the DB; cases asserting the
 * `isDeleting` gate use real hooks.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { SESSION_COOKIE, type TokenScope, type TrashListDto } from "@knotebook/shared";
import { createCollabHooks } from "../src/collab/hooks-impl.js";
import type { Db } from "../src/db/index.js";
import { groupMembers, groupRoles } from "../src/db/schema.js";
import type { GroupTestHook } from "../src/groups/test-hook.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { folderPathCost } from "../src/mcp/folder-fields.js";
import { BAD_CURSOR_MESSAGE } from "../src/mcp/keyset-cursor.js";
import { MCP_PAGE_MAX, escapedLength } from "../src/mcp/limits.js";
import { DELETE_BUSY_MESSAGE, DELETE_FORBIDDEN_MESSAGE, DELETE_NOT_FOUND_MESSAGE } from "../src/mcp/tools/delete-note.js";
import { RESTORE_BUSY_MESSAGE, RESTORE_NOT_FOUND_MESSAGE } from "../src/mcp/tools/restore-note.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { folderRow, noteFolderCols, seedFolderChain, setNoteFolder } from "./folder-helpers.js";
import { cookieOf, seedGroup, seedNote, seedRole, seedShare, seedUser, waitForLockWaiters, type SeededUser } from "./group-helpers.js";
import { buildCollabTestApp } from "./helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import { inject, markTrashed, sixRoleScene, trashCols } from "./trash-helpers.js";

const R: TokenScope = "notes:read";
const RW: TokenScope = "notes:read notes:write";
const RWM: TokenScope = "notes:read notes:write notes:move";
const RWD: TokenScope = "notes:read notes:write notes:delete";
const RWMD: TokenScope = "notes:read notes:write notes:move notes:delete";

type Auth = { token: string } | { cookie: string };
type Result = {
  isError?: true;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown> & { code?: string; message?: string };
};
type TrashItemForModel = {
  id: string;
  title: string;
  titleTruncated?: true;
  deletedAt: string;
  purgeAt: string | null;
  deletedBy: { handle: string; displayName: string; displayNameTruncated?: true } | null;
  group: { id: string; name: string; nameTruncated?: true } | null;
  folderPath: string[];
  folderPathTruncated?: true;
};
type ListTrashOut = { retentionDays: number | null; items: TrashItemForModel[]; truncated: boolean; nextCursor: string | null; pageCutShort?: true };

async function call(app: FastifyInstance, auth: Auth, name: string, args?: unknown): Promise<Result> {
  const params = args === undefined ? { name } : { name, arguments: args };
  const res = await mcpPost(app, rpc("tools/call", params), auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().result as Result;
}
/** Fails the test if `list_trash` errors (unregistered on a read-only credential, or 42P18 mapped to internal). */
async function listTrashOf(app: FastifyInstance, auth: Auth, cursor?: string): Promise<ListTrashOut> {
  const r = await call(app, auth, "list_trash", cursor === undefined ? {} : { cursor });
  expect(r.isError, JSON.stringify(r.content)).toBeUndefined();
  return r.structuredContent as unknown as ListTrashOut;
}
async function listTrashAll(app: FastifyInstance, auth: Auth): Promise<ListTrashOut[]> {
  const pages: ListTrashOut[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i += 1) {
    const page = await listTrashOf(app, auth, cursor);
    expect(page.truncated).toBe(page.nextCursor !== null);
    pages.push(page);
    if (page.nextCursor === null) return pages;
    cursor = page.nextCursor;
  }
  throw new Error("list_trash 翻了 20 頁還沒到底");
}
/** Spaces trash times apart so ordering doesn't depend on microseconds (same-millisecond ties fall back to id order): sets `deleted_at` to the previous note's + 2 ms. */
async function spaceAfter(db: Db, noteId: string, prevId: string): Promise<void> {
  await db.$client.query(
    `update notes set deleted_at = (select deleted_at from notes where id = $2) + interval '2 milliseconds' where id = $1`,
    [noteId, prevId],
  );
}
async function restListOf(app: FastifyInstance, userId: string): Promise<TrashListDto> {
  const res = await inject(app, "GET", "/api/trash", userId);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as TrashListDto;
}
const tokenOf = async (ctx: { db: Db }, userId: string, scope: TokenScope): Promise<Auth> => ({ token: (await seedTokenForUser(ctx.db, userId, scope)).token });
const sessionOf = async (userId: string): Promise<Auth> => ({ cookie: (await cookieOf(userId))[SESSION_COOKIE]! });
async function trash(app: FastifyInstance, noteId: string, userId: string): Promise<void> {
  const res = await inject(app, "DELETE", `/api/notes/${noteId}`, userId);
  expect(res.statusCode, res.body).toBe(204);
}

describe("list_trash: scope and order are byte-identical to GET /api/trash", () => {
  it("two personal notes plus one group note (editDelete role); others' trash and live notes are absent -> items[].id equals REST (including order) for RW, R and session", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const groupAdmin = await seedUser(ctx.db);
    const other = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "LT1", [{ userId: groupAdmin.id, role: "admin" }]);
    const roleId = await seedRole(ctx.db, g.id, "edit-delete", { canRead: true, canEdit: true, canDelete: true });
    await ctx.db.insert(groupMembers).values({ groupId: g.id, userId: me.id, roleId });
    const a = await seedNote(ctx.db, { ownerId: me.id });
    const b = await seedNote(ctx.db, { ownerId: me.id });
    const gn = await seedNote(ctx.db, { groupId: g.id });
    const theirs = await seedNote(ctx.db, { ownerId: other.id });
    await seedNote(ctx.db, { ownerId: me.id }, { title: "live 1" });
    await seedNote(ctx.db, { groupId: g.id }, { title: "live 2" });
    await trash(ctx.app, a.id, me.id);
    await trash(ctx.app, gn.id, groupAdmin.id);
    await spaceAfter(ctx.db, gn.id, a.id);
    await trash(ctx.app, b.id, me.id);
    await spaceAfter(ctx.db, b.id, gn.id);
    await trash(ctx.app, theirs.id, other.id);
    await spaceAfter(ctx.db, theirs.id, b.id);

    const rest = (await restListOf(ctx.app, me.id)).items.map(i => i.id);
    expect(rest).toEqual([b.id, gn.id, a.id]); // precondition: REST order itself is correct
    for (const auth of [await tokenOf(ctx, me.id, RW), await tokenOf(ctx, me.id, R), await sessionOf(me.id)]) {
      expect((await listTrashOf(ctx.app, auth)).items.map(i => i.id)).toEqual(rest);
    }
  });
});

describe("list_trash: roles", () => {
  it("group trash note: listed for admin and editDelete; not for deleteOnly, editOnly, member, readOnly, outsider", async () => {
    const ctx = await buildCollabTestApp();
    const s = await sixRoleScene(ctx.db);
    const n = await seedNote(ctx.db, { groupId: s.groupId });
    await trash(ctx.app, n.id, s.admin.id);

    const roles = ["admin", "editDelete", "deleteOnly", "editOnly", "member", "readOnly", "outsider"] as const;
    const got: Record<string, string[]> = {};
    for (const r of roles) got[r] = (await listTrashOf(ctx.app, await tokenOf(ctx, s[r].id, R))).items.map(i => i.id);
    expect(got).toEqual({ admin: [n.id], editDelete: [n.id], deleteOnly: [], editOnly: [], member: [], readOnly: [], outsider: [] });
  });
});

describe("list_trash: 100 per page and paging", () => {
  // Personal and group batches interleaved in time (1 s apart); the keyset must carry both.
  const seedMany = (db: Db, u: SeededUser, n: number, offset = 0) =>
    db.$client.query(
      `insert into notes (owner_id, title, slug, deleted_at, deleted_by)
       select $1::uuid, 'T' || g, 'lt3-' || $3 || '-' || g, now() - make_interval(secs => 2 * g + $4::int), $1::uuid from generate_series(1, $2::int) g`,
      [u.id, n, u.id.slice(0, 8), offset],
    );
  const seedManyGroup = (db: Db, groupId: string, by: SeededUser, n: number) =>
    db.$client.query(
      `insert into notes (group_id, title, slug, deleted_at, deleted_by)
       select $1::uuid, 'G' || g, 'lt3g-' || $3 || '-' || g, now() - make_interval(secs => 2 * g + 1), $4::uuid from generate_series(1, $2::int) g`,
      [groupId, n, groupId.slice(0, 8), by.id],
    );

  it("101 notes (51 personal + 50 group, interleaved): page 1 has 100, truncated, nextCursor, no pageCutShort; page 2 has 1, truncated false, nextCursor null; both pages together equal REST in order", async () => {
    const ctx = await buildCollabTestApp();
    const big = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "LT3", [{ userId: big.id, role: "admin" }]);
    await seedMany(ctx.db, big, 51);
    await seedManyGroup(ctx.db, g.id, big, 50);

    const pages = await listTrashAll(ctx.app, await tokenOf(ctx, big.id, R));
    expect(pages).toHaveLength(2);
    expect([pages[0]!.items.length, pages[0]!.truncated, pages[0]!.nextCursor !== null, "pageCutShort" in pages[0]!]).toEqual([100, true, true, false]);
    expect([pages[1]!.items.length, pages[1]!.truncated, pages[1]!.nextCursor]).toEqual([1, false, null]);
    const restB = await restListOf(ctx.app, big.id);
    expect(restB.items).toHaveLength(101);
    expect(restB.items.some(i => i.group !== null)).toBe(true); // precondition: fixture includes group items
    expect(pages.flatMap(p => p.items.map(i => i.id))).toEqual(restB.items.map(i => i.id));
  });

  it("exactly 100 notes: 100 items, truncated false, nextCursor null", async () => {
    const ctx = await buildCollabTestApp();
    const exact = await seedUser(ctx.db);
    await seedMany(ctx.db, exact, 100);
    const e = await listTrashOf(ctx.app, await tokenOf(ctx, exact.id, R));
    expect([e.items.length, e.truncated, e.nextCursor]).toEqual([100, false, null]);
  });
});

describe("list_trash: fields", () => {
  it("7-day retention: retentionDays 7 and each purgeAt equals REST; set to NULL -> retentionDays and purgeAt are null in both MCP and REST", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "LT4", [{ userId: me.id, role: "admin" }]);
    const p = await seedNote(ctx.db, { ownerId: me.id });
    const gn = await seedNote(ctx.db, { groupId: g.id });
    await trash(ctx.app, p.id, me.id);
    await trash(ctx.app, gn.id, me.id);
    const auth = await tokenOf(ctx, me.id, R);

    const seven = await listTrashOf(ctx.app, auth);
    const rest7 = await restListOf(ctx.app, me.id);
    expect(seven.retentionDays).toBe(7);
    expect(seven.items.map(i => [i.id, i.purgeAt])).toEqual(rest7.items.map(i => [i.id, i.purgeAt]));
    expect(seven.items.every(i => i.purgeAt !== null)).toBe(true);

    await ctx.db.$client.query(`update site_settings set trash_retention_days = null`);
    const none = await listTrashOf(ctx.app, auth);
    expect(none.retentionDays).toBeNull();
    expect(none.items.map(i => i.purgeAt)).toEqual([null, null]);
    const restNone = await restListOf(ctx.app, me.id);
    expect(restNone.retentionDays).toBeNull();
    expect(restNone.items.map(i => i.purgeAt)).toEqual([null, null]);
  });

  it("deleter account deleted -> deletedBy null; personal note has group null; ordinary data has no *Truncated keys", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db, { displayName: "LT4 Me" });
    const x = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "LT4 Group", [{ userId: me.id, role: "admin" }, { userId: x.id, role: "admin" }]);
    const gn = await seedNote(ctx.db, { groupId: g.id }, { title: "LT4 G" });
    const p = await seedNote(ctx.db, { ownerId: me.id }, { title: "LT4 P" });
    const gx = await seedNote(ctx.db, { groupId: g.id }, { title: "LT4 X" });
    await trash(ctx.app, gn.id, me.id);
    await trash(ctx.app, p.id, me.id);
    await trash(ctx.app, gx.id, x.id);
    await ctx.db.$client.query(`delete from users where id = $1`, [x.id]);

    const out = await listTrashOf(ctx.app, await tokenOf(ctx, me.id, R));
    const byId = new Map(out.items.map(i => [i.id, i]));
    expect(byId.get(gx.id)!.deletedBy).toBeNull();
    expect(byId.get(p.id)!.group).toBeNull();
    expect(byId.get(p.id)).toMatchObject({ title: "LT4 P", deletedBy: { handle: me.handle, displayName: "LT4 Me" } });
    expect(byId.get(gn.id)).toMatchObject({ title: "LT4 G", group: { id: g.id, name: "LT4 Group" } });
    for (const item of out.items) {
      expect(Object.keys(item)).toEqual(["id", "title", "deletedAt", "purgeAt", "deletedBy", "group", "folderPath"]);
      if (item.deletedBy !== null) expect(Object.keys(item.deletedBy)).toEqual(["handle", "displayName"]);
      if (item.group !== null) expect(Object.keys(item.group)).toEqual(["id", "name"]);
    }
  });

  it("title of 300 \", deleter displayName of 300 \" and group name of 80 U+0001 -> three *Truncated: true, escaped length <= 200", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db, { displayName: '"'.repeat(300) });
    const g = await seedGroup(ctx.db, "LT4 trunc", [{ userId: me.id, role: "admin" }]);
    await ctx.db.$client.query(`update groups set name = $2 where id = $1`, [g.id, String.fromCharCode(1).repeat(80)]);
    const n = await seedNote(ctx.db, { groupId: g.id }, { title: '"'.repeat(300) });
    await trash(ctx.app, n.id, me.id);

    const [item] = (await listTrashOf(ctx.app, await tokenOf(ctx, me.id, R))).items;
    expect([item!.titleTruncated, item!.deletedBy!.displayNameTruncated, item!.group!.nameTruncated]).toEqual([true, true, true]);
    expect(escapedLength(item!.title)).toBeLessThanOrEqual(200);
    expect(escapedLength(item!.deletedBy!.displayName)).toBeLessThanOrEqual(200);
    expect(escapedLength(item!.group!.name)).toBeLessThanOrEqual(200);
    expect(item!.title).toBe('"'.repeat(100)); // precondition: really truncated (an escaped " counts 2)
  });
});

describe("list_trash: input", () => {
  it("{} succeeds; { limit: 5 } -> SDK input validation error (no structuredContent, message mentions limit); no arguments -> SDK \"Required\"", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const auth = await tokenOf(ctx, me.id, R);
    expect((await call(ctx.app, auth, "list_trash", {})).isError).toBeUndefined();
    const extra = await call(ctx.app, auth, "list_trash", { limit: 5 });
    expect(extra.isError).toBe(true);
    expect(extra.structuredContent).toBeUndefined();
    expect(extra.content[0]!.text).toContain("limit");
    const bare = await call(ctx.app, auth, "list_trash");
    expect(bare.isError).toBe(true);
    expect(bare.content[0]!.text).toContain("Required");
  });
});

describe("list_trash: mirror and model-facing strings", () => {
  it("content[0].text is exactly the JSON of structuredContent; description/truncated explain paging and folderPath (old sentence absent), retentionDays says admins can change the setting", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id });
    await trash(ctx.app, n.id, me.id);
    const auth = await tokenOf(ctx, me.id, R);
    const r = await call(ctx.app, auth, "list_trash", {});
    expect(r.content[0]!.text).toBe(JSON.stringify(r.structuredContent));
    expect((r.structuredContent!.items as unknown[]).length).toBe(1);

    const tools = (await mcpPost(ctx.app, rpc("tools/list"), auth)).json().result.tools as Array<{
      name: string;
      description: string;
      outputSchema: { properties: Record<string, { description?: string }> };
    }>;
    const t = tools.find(x => x.name === "list_trash")!;
    // Folders added the cursor: the new sentence is present and the old "no pagination" one absent; folderPath is defined as the restore destination (the old anchor must not return).
    expect(t.description).toContain("pass `nextCursor` back as `cursor`");
    expect(t.description).toContain(`up to ${MCP_PAGE_MAX} per call`);
    expect(t.description).not.toContain("only the newest");
    expect(t.description).not.toContain("there is no paging");
    expect(t.description).toContain("`folderPath` is where the note usually goes back to when restored");
    expect(t.description).not.toContain("`folderPath` names the folders");
    expect(t.description).toContain("While the note's folder still exists, the path follows renames and moves");
    expect(t.description).not.toContain("It follows renames and moves of folders that still exist");
    expect(t.description).not.toContain("keeps the names it had then");
    expect(t.description).toContain("once that folder is deleted, the path no longer follows renames");
    expect(t.outputSchema.properties.truncated!.description).toContain("the same as `nextCursor` not being null");
    expect(t.outputSchema.properties.truncated!.description).not.toContain("older ones were left out");
    expect(t.outputSchema.properties.items!.description).toContain("`deletedBy` is null when the account that moved it there no longer exists");
    // Cleanup uses the current setting, so purgeAt and retention days are not fixed facts.
    expect(t.description).toContain("an admin can change it");
    expect(t.outputSchema.properties.retentionDays!.description).toContain("an admin can change it");
  });
});

describe("list_trash: site settings row missing", () => {
  it("call after DELETE FROM site_settings -> isError, code internal (runTool catches the exception)", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const auth = await tokenOf(ctx, me.id, R);
    await ctx.db.$client.query(`delete from site_settings`);
    const r = await call(ctx.app, auth, "list_trash", {});
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.code).toBe("internal");
  });
});


describe("list_trash: folderPath (restore destination)", () => {
  it("folder exists -> live path (follows renames and moves meanwhile); folder deleted -> snapshot from trash time; root level -> []", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const pool = ctx.db.$client;
    const [a, b] = await seedFolderChain(ctx.db, { personal: me.id }, ["A", "B"]);
    const [c] = await seedFolderChain(ctx.db, { personal: me.id }, ["C"]);
    const [d] = await seedFolderChain(ctx.db, { personal: me.id }, ["D"]);
    const live = await seedNote(ctx.db, { ownerId: me.id }, { title: "LT8 live" });
    const gone = await seedNote(ctx.db, { ownerId: me.id }, { title: "LT8 gone" });
    const root = await seedNote(ctx.db, { ownerId: me.id }, { title: "LT8 root" });
    await setNoteFolder(pool, live.id, b!);
    await setNoteFolder(pool, gone.id, d!);
    for (const n of [live, gone, root]) await trash(ctx.app, n.id, me.id);
    const auth = await tokenOf(ctx, me.id, R);
    const pathOf = async (id: string) => (await listTrashOf(ctx.app, auth)).items.find(i => i.id === id)!.folderPath;

    expect(await pathOf(live.id)).toEqual(["A", "B"]);
    await pool.query(`update folders set name = 'A2' where id = $1`, [a]);
    expect(await pathOf(live.id)).toEqual(["A2", "B"]);
    await pool.query(`update folders set parent_id = $2 where id = $1`, [b, c]);
    expect(await pathOf(live.id)).toEqual(["C", "B"]);

    await pool.query(`delete from folders where id = $1`, [d]); // notes.folder_id -> NULL (FK set null), snapshot stays
    expect((await noteFolderCols(pool, gone.id))!.folder_id).toBeNull();
    expect(await pathOf(gone.id)).toEqual(["D"]);
    expect(await pathOf(root.id)).toEqual([]);
    const item = (await listTrashOf(ctx.app, auth)).items.find(i => i.id === root.id)!;
    expect("folderPathTruncated" in item).toBe(false);
  });

  it("eight levels of 27 \" each (written directly to the DB) -> last 7 segments kept, folderPathTruncated, cost <= 400; five levels [33,40,40,40,41] \" -> all 5 segments kept, last cut to 40, cost exactly 400", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const eight = await seedFolderChain(ctx.db, { personal: me.id }, Array.from({ length: 8 }, () => '"'.repeat(27)));
    const five = await seedFolderChain(ctx.db, { personal: me.id }, [33, 40, 40, 40, 41].map(n => '"'.repeat(n)));
    const n8 = await seedNote(ctx.db, { ownerId: me.id }, { title: "LT8 eight" });
    const n5 = await seedNote(ctx.db, { ownerId: me.id }, { title: "LT8 five" });
    await setNoteFolder(ctx.db.$client, n8.id, eight.at(-1)!);
    await setNoteFolder(ctx.db.$client, n5.id, five.at(-1)!);
    await trash(ctx.app, n8.id, me.id);
    await trash(ctx.app, n5.id, me.id);

    const byId = new Map((await listTrashOf(ctx.app, await tokenOf(ctx, me.id, R))).items.map(i => [i.id, i]));
    const i8 = byId.get(n8.id)!;
    expect(i8.folderPath).toEqual(Array.from({ length: 7 }, () => '"'.repeat(27)));
    expect(i8.folderPathTruncated).toBe(true);
    expect(folderPathCost(i8.folderPath)).toBeLessThanOrEqual(400);
    const i5 = byId.get(n5.id)!;
    expect(i5.folderPath).toEqual([33, 40, 40, 40, 40].map(n => '"'.repeat(n)));
    expect(i5.folderPathTruncated).toBe(true);
    expect(folderPathCost(i5.folderPath)).toBe(400);
  });
});

describe("list_trash: bad cursor", () => {
  it("{ cursor: \"x\" }, a list_notes cursor, NUL after t|, id not a UUID, time not a date, out-of-range year -> invalid_body with BAD_CURSOR_MESSAGE; listing works afterwards", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "LT9" });
    await seedNote(ctx.db, { ownerId: me.id }, { title: "LT9 live a" });
    await seedNote(ctx.db, { ownerId: me.id }, { title: "LT9 live b" });
    await trash(ctx.app, n.id, me.id);
    const auth = await tokenOf(ctx, me.id, R);
    const notesCursor = ((await call(ctx.app, auth, "list_notes", { limit: 1 })).structuredContent!.nextCursor as string | null)!;
    expect(notesCursor).not.toBeNull(); // precondition: really got a list_notes cursor
    const enc = (s: string) => Buffer.from(s, "utf8").toString("base64url");
    const withNul = enc(`t|${new Date().toISOString()}${String.fromCharCode(0)}|${n.id}`);
    // Forged two-part cursors (id not a UUID, time not a date) and an out-of-range year that JS accepts but pg rejects: all must be invalid_body, not internal.
    const badId = enc(`t|${new Date().toISOString()}|zzz`);
    const badDate = enc(`t|not-a-date|${n.id}`);
    const farYear = enc(`t|+275760-09-13T00:00:00.000Z|${n.id}`);
    for (const [label, cursor] of [["x", "x"], ["list_notes", notesCursor], ["NUL", withNul], ["id", badId], ["date", badDate], ["year", farYear]] as const) {
      const r = await call(ctx.app, auth, "list_trash", { cursor });
      expect(r.isError, label).toBe(true);
      expect(r.structuredContent, label).toEqual({ code: "invalid_body", message: BAD_CURSOR_MESSAGE });
    }
    expect((await listTrashOf(ctx.app, auth)).items.map(i => i.id)).toEqual([n.id]);
  });
});

describe("list_trash: millisecond boundary", () => {
  it("101 notes: the 100th and 101st share a millisecond and differ by 1 us, with us order opposite to id order (larger us has the smaller id) -> two pages total 101 with no duplicates, same sequence as REST", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const pool = ctx.db.$client;
    await pool.query(
      `insert into notes (owner_id, title, slug, deleted_at, deleted_by)
       select $1::uuid, 'K' || g, 'ltk-' || $2 || '-' || g, now() - make_interval(secs => g), $1::uuid from generate_series(1, 101) g`,
      [me.id, me.id.slice(0, 8)],
    );
    const before = (await restListOf(ctx.app, me.id)).items.map(i => i.id);
    const [small, large] = [before[99]!, before[100]!].sort() as [string, string];
    const { rows } = await pool.query<{ ms: string }>(`select to_char((date_trunc('milliseconds', min(deleted_at)) - interval '1 second') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as ms from notes where owner_id = $1`, [me.id]);
    const ms = rows[0]!.ms;
    await pool.query(`update notes set deleted_at = $2::timestamptz + interval '501 microseconds' where id = $1`, [small, ms]);
    await pool.query(`update notes set deleted_at = $2::timestamptz + interval '500 microseconds' where id = $1`, [large, ms]);
    const same = await pool.query<{ n: number }>(`select count(*)::int as n from notes where date_trunc('milliseconds', deleted_at) = $1::timestamptz`, [ms]);
    expect(same.rows[0]!.n).toBe(2); // precondition: exactly two notes in this millisecond

    const rest = (await restListOf(ctx.app, me.id)).items.map(i => i.id);
    expect(rest.slice(99)).toEqual([large, small]); // same millisecond orders by id DESC (not us)
    const pages = await listTrashAll(ctx.app, await tokenOf(ctx, me.id, R));
    expect(pages.map(p => p.items.length)).toEqual([100, 1]);
    const ids = pages.flatMap(p => p.items.map(i => i.id));
    expect(new Set(ids).size).toBe(101);
    expect(ids).toEqual(rest);
  });
});


type DeleteOut = { id: string; title: string; titleTruncated?: true; purgeAt: string | null };
type NoteSummary = { id: string; title: string; owner: { kind: string }; url: string; role: string };

const realHooks = { collabHooks: createCollabHooks } as const;
/** Test-owned edit limiter: `remaining` still equal to EDIT_N after a call means the call didn't charge it. */
const EDIT_N = 5;
const editLimiter = () => new FixedWindowLimiter({ limit: EDIT_N, windowMs: 600_000 });
const emptyLimiter = () => new FixedWindowLimiter({ limit: 0, windowMs: 600_000 });
function remaining(l: FixedWindowLimiter, key: string): number {
  let n = 0;
  while (n <= 100 && l.consume(key)) n++;
  return n;
}
const isTrashed = async (db: Db, id: string) => (await trashCols(db.$client, id))!.deleted_at !== null;
const busyErr = () => Object.assign(new Error("serialization"), { code: "40001" });

async function deleteOk(app: FastifyInstance, auth: Auth, noteId: string): Promise<DeleteOut> {
  const r = await call(app, auth, "delete_note", { note_id: noteId });
  expect(r.isError, JSON.stringify(r.structuredContent)).toBeUndefined();
  return r.structuredContent as unknown as DeleteOut;
}
async function restoreOk(app: FastifyInstance, auth: Auth, noteId: string): Promise<NoteSummary> {
  const r = await call(app, auth, "restore_note", { note_id: noteId });
  expect(r.isError, JSON.stringify(r.structuredContent)).toBeUndefined();
  return (r.structuredContent as { note: NoteSummary }).note;
}
const listNotesIds = async (app: FastifyInstance, auth: Auth) =>
  ((await call(app, auth, "list_notes", {})).structuredContent!.notes as Array<{ id: string; url: string }>);

describe("delete_note: owner trashes a personal note", () => {
  it("RWD credential -> { id, title, purgeAt } (purgeAt equals the REST list entry); deleted_by is the owner; gate closed; list_notes no longer lists it", async () => {
    const ctx = await buildCollabTestApp(realHooks);
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "DN1 note" });
    const auth = await tokenOf(ctx, me.id, RWD);

    const out = await deleteOk(ctx.app, auth, n.id);
    expect(Object.keys(out)).toEqual(["id", "title", "purgeAt"]);
    expect(out).toMatchObject({ id: n.id, title: "DN1 note" });
    const rest = await restListOf(ctx.app, me.id);
    expect(rest.items.map(i => [i.id, i.purgeAt])).toEqual([[n.id, out.purgeAt]]);
    expect(out.purgeAt).not.toBeNull();
    expect((await trashCols(ctx.db.$client, n.id))!.deleted_by).toBe(me.id);
    expect(ctx.collab.isDeleting(n.id)).toBe(true);
    expect((await listNotesIds(ctx.app, auth)).map(x => x.id)).not.toContain(n.id);
  });
});

describe("delete_note: not_found has the same shape", () => {
  it("note already in trash, someone else's private note, random uuid -> structuredContent identical field by field", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const other = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id });
    const theirs = await seedNote(ctx.db, { ownerId: other.id });
    const auth = await tokenOf(ctx, me.id, RWD);
    await deleteOk(ctx.app, auth, n.id);

    const again = await call(ctx.app, auth, "delete_note", { note_id: n.id });
    const foreign = await call(ctx.app, auth, "delete_note", { note_id: theirs.id });
    const random = await call(ctx.app, auth, "delete_note", { note_id: randomUUID() });
    expect(random.isError).toBe(true);
    expect(random.structuredContent).toEqual({ code: "not_found", message: DELETE_NOT_FOUND_MESSAGE });
    expect(again).toEqual(random);
    expect(foreign).toEqual(random);
    expect(await isTrashed(ctx.db, theirs.id)).toBe(false);
  });
});

describe("delete_note: shared users", () => {
  it("viewer and editor shares -> forbidden with DELETE_FORBIDDEN_MESSAGE; deleted_at stays NULL", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: owner.id });
    for (const role of ["viewer", "editor"] as const) {
      const u = await seedUser(ctx.db);
      await seedShare(ctx.db, n.id, u.id, role);
      const r = await call(ctx.app, await tokenOf(ctx, u.id, RWD), "delete_note", { note_id: n.id });
      expect({ role, sc: r.structuredContent }).toEqual({ role, sc: { code: "forbidden", message: DELETE_FORBIDDEN_MESSAGE } });
      expect(await trashCols(ctx.db.$client, n.id)).toEqual({ deleted_at: null, deleted_by: null });
    }
  });
});

describe("delete_note: six roles", () => {
  it("admin, editDelete, deleteOnly succeed; member, editOnly, readOnly are forbidden; outsider equals random uuid field by field; after deleteOnly, list_trash excludes it and restore_note gives not_found", async () => {
    const ctx = await buildCollabTestApp();
    const s = await sixRoleScene(ctx.db);
    const roles = ["admin", "editDelete", "deleteOnly", "member", "editOnly", "readOnly", "outsider"] as const;
    const got: Record<string, unknown> = {};
    const notes: Record<string, string> = {};
    for (const r of roles) {
      const n = await seedNote(ctx.db, { groupId: s.groupId });
      notes[r] = n.id;
      const res = await call(ctx.app, await tokenOf(ctx, s[r].id, RWD), "delete_note", { note_id: n.id });
      got[r] = res.isError ? res.structuredContent : "ok";
      expect({ r, trashed: await isTrashed(ctx.db, n.id) }).toEqual({ r, trashed: !res.isError });
    }
    const random = (await call(ctx.app, await tokenOf(ctx, s.outsider.id, RWD), "delete_note", { note_id: randomUUID() })).structuredContent;
    const forbidden = { code: "forbidden", message: DELETE_FORBIDDEN_MESSAGE };
    expect(got).toEqual({ admin: "ok", editDelete: "ok", deleteOnly: "ok", member: forbidden, editOnly: forbidden, readOnly: forbidden, outsider: random });
    expect(random).toEqual({ code: "not_found", message: DELETE_NOT_FOUND_MESSAGE });

    const delOnly = await tokenOf(ctx, s.deleteOnly.id, RWD);
    expect((await listTrashOf(ctx.app, delOnly)).items.map(i => i.id)).not.toContain(notes.deleteOnly);
    const back = await call(ctx.app, delOnly, "restore_note", { note_id: notes.deleteOnly! });
    expect(back.structuredContent).toEqual({ code: "not_found", message: RESTORE_NOT_FOUND_MESSAGE });
    expect(await isTrashed(ctx.db, notes.deleteOnly!)).toBe(true);
  });
});

describe("delete_note: uppercase id", () => {
  it("all-uppercase note_id -> succeeds, response id is lowercase, DB row is trashed", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id });
    const out = await deleteOk(ctx.app, await tokenOf(ctx, me.id, RWD), n.id.toUpperCase());
    expect(out.id).toBe(n.id);
    expect(await isTrashed(ctx.db, n.id)).toBe(true);
  });
});

describe("delete_note: long title", () => {
  it("title of 300 \" -> titleTruncated true, escapedLength <= 200, trashed", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: '"'.repeat(300) });
    const out = await deleteOk(ctx.app, await tokenOf(ctx, me.id, RWD), n.id);
    expect(out.titleTruncated).toBe(true);
    expect(escapedLength(out.title)).toBeLessThanOrEqual(200);
    expect(out.title).toBe('"'.repeat(100)); // precondition: really truncated (an escaped " counts 2)
    expect(await isTrashed(ctx.db, n.id)).toBe(true);
  });
});

describe("delete_note: TOCTOU: role downgraded inside the transaction after the lock", () => {
  it("the note-trash-locked hook changes editDelete's role to one without delete -> forbidden, deleted_at stays NULL, gate closed", async () => {
    const holder: { db?: Db; roleId?: string } = {};
    const hook: GroupTestHook = async point => {
      if (point === "note-trash-locked" && holder.roleId) await holder.db!.update(groupRoles).set({ canDelete: false }).where(eq(groupRoles.id, holder.roleId));
    };
    const ctx = await buildCollabTestApp({ ...realHooks, groupTestHook: hook });
    holder.db = ctx.db;
    const s = await sixRoleScene(ctx.db);
    const [m] = await ctx.db.select({ roleId: groupMembers.roleId }).from(groupMembers).where(eq(groupMembers.userId, s.editDelete.id));
    holder.roleId = m!.roleId;
    const n = await seedNote(ctx.db, { groupId: s.groupId });

    const r = await call(ctx.app, await tokenOf(ctx, s.editDelete.id, RWD), "delete_note", { note_id: n.id });
    expect(r.structuredContent).toEqual({ code: "forbidden", message: DELETE_FORBIDDEN_MESSAGE });
    expect(await trashCols(ctx.db.$client, n.id)).toEqual({ deleted_at: null, deleted_by: null });
    await vi.waitFor(() => expect(ctx.collab.isDeleting(n.id)).toBe(false));
  });
});

describe("delete_note: edit limiter", () => {
  it("edit limiter with 0 slots: owner -> too_many_requests, deleted_at stays NULL; outsider -> not_found, viewer share -> forbidden (both checks run before the limiter is charged)", async () => {
    const ctx = await buildCollabTestApp({ limiters: { edit: emptyLimiter() } });
    const owner = await seedUser(ctx.db);
    const outsider = await seedUser(ctx.db);
    const viewer = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: owner.id });
    await seedShare(ctx.db, n.id, viewer.id, "viewer");

    expect((await call(ctx.app, await tokenOf(ctx, owner.id, RWD), "delete_note", { note_id: n.id })).structuredContent?.code).toBe("too_many_requests");
    expect(await isTrashed(ctx.db, n.id)).toBe(false);
    expect((await call(ctx.app, await tokenOf(ctx, outsider.id, RWD), "delete_note", { note_id: n.id })).structuredContent).toEqual({
      code: "not_found",
      message: DELETE_NOT_FOUND_MESSAGE,
    });
    expect((await call(ctx.app, await tokenOf(ctx, viewer.id, RWD), "delete_note", { note_id: n.id })).structuredContent).toEqual({
      code: "forbidden",
      message: DELETE_FORBIDDEN_MESSAGE,
    });
  });
});

describe("delete_note: token write budget (tokenWrite charging is live over HTTP)", () => {
  it("tokenWrite with 0 slots: RWD credential -> too_many_requests, deleted_at stays NULL, edit limiter not charged; session still succeeds", async () => {
    const edit = editLimiter();
    const ctx = await buildCollabTestApp({ limiters: { tokenWrite: emptyLimiter(), edit } });
    const me = await seedUser(ctx.db);
    const other = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id });
    const theirs = await seedNote(ctx.db, { ownerId: other.id });

    const r = await call(ctx.app, await tokenOf(ctx, me.id, RWD), "delete_note", { note_id: n.id });
    expect(r.structuredContent?.code).toBe("too_many_requests");
    expect(await trashCols(ctx.db.$client, n.id)).toEqual({ deleted_at: null, deleted_by: null });
    expect(remaining(edit, me.id)).toBe(EDIT_N);

    await deleteOk(ctx.app, await sessionOf(other.id), theirs.id);
    expect(await isTrashed(ctx.db, theirs.id)).toBe(true);
  });

  it("shared key: tokenWrite with 2 slots, edit_note append takes one and delete_note one, third delete_note -> too_many_requests (limiter key is token:${userId}, same as the other write tools)", async () => {
    const ctx = await buildCollabTestApp({ limiters: { tokenWrite: new FixedWindowLimiter({ limit: 2, windowMs: 600_000 }) } });
    const me = await seedUser(ctx.db);
    const a = await seedNote(ctx.db, { ownerId: me.id });
    const b = await seedNote(ctx.db, { ownerId: me.id });
    const c = await seedNote(ctx.db, { ownerId: me.id });
    const auth = await tokenOf(ctx, me.id, RWD);

    const appended = await call(ctx.app, auth, "edit_note", { note_id: a.id, op: "append", markdown: "DN8" });
    expect(appended.isError, JSON.stringify(appended.structuredContent)).toBeUndefined();
    await deleteOk(ctx.app, auth, b.id);
    const third = await call(ctx.app, auth, "delete_note", { note_id: c.id });
    expect(third.structuredContent?.code).toBe("too_many_requests");
    expect(await isTrashed(ctx.db, c.id)).toBe(false);
  });
});

describe("delete_note: transaction picked as a concurrency victim", () => {
  it("note-trash-locked throws 40001 -> server_busy with DELETE_BUSY_MESSAGE; deleted_at stays NULL; gate closed", async () => {
    const ctx = await buildCollabTestApp({
      ...realHooks,
      groupTestHook: async point => {
        if (point === "note-trash-locked") throw busyErr();
      },
    });
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id });
    const r = await call(ctx.app, await tokenOf(ctx, me.id, RWD), "delete_note", { note_id: n.id });
    expect(r.structuredContent).toEqual({ code: "server_busy", message: DELETE_BUSY_MESSAGE });
    expect(await trashCols(ctx.db.$client, n.id)).toEqual({ deleted_at: null, deleted_by: null });
    await vi.waitFor(() => expect(ctx.collab.isDeleting(n.id)).toBe(false));
  });

  // The busy sentence claims "not trashed" only for retryable transaction aborts; other exceptions go to runTool as internal (not always server_busy).
  it("note-trash-locked throws a plain Error -> internal (not server_busy); deleted_at stays NULL", async () => {
    const ctx = await buildCollabTestApp({
      groupTestHook: async point => {
        if (point === "note-trash-locked") throw new Error("boom");
      },
    });
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id });
    const r = await call(ctx.app, await tokenOf(ctx, me.id, RWD), "delete_note", { note_id: n.id });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.code).toBe("internal");
    expect(await trashCols(ctx.db.$client, n.id)).toEqual({ deleted_at: null, deleted_by: null });
  });
});

describe("delete_note: site settings row missing", () => {
  it("delete_note after DELETE FROM site_settings -> internal, deleted_at stays NULL, edit limiter not charged (settings are read before the charge and the trashing)", async () => {
    const edit = editLimiter();
    const ctx = await buildCollabTestApp({ limiters: { edit } });
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id });
    await ctx.db.$client.query(`delete from site_settings`);
    const r = await call(ctx.app, await tokenOf(ctx, me.id, RWD), "delete_note", { note_id: n.id });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.code).toBe("internal");
    expect(await trashCols(ctx.db.$client, n.id)).toEqual({ deleted_at: null, deleted_by: null });
    expect(remaining(edit, me.id)).toBe(EDIT_N);
  });
});

describe("delete_note: purgeAt follows the current setting", () => {
  it("retention 3 days -> purgeAt = deleted_at + 3 days (computed in SQL); NULL -> null; both equal the entry of the list_trash that follows", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const auth = await tokenOf(ctx, me.id, RWD);
    const sqlPurge = async (id: string, days: number) =>
      (await ctx.db.$client.query<{ p: Date }>(`select deleted_at + make_interval(days => $2::int) as p from notes where id = $1`, [id, days])).rows[0]!.p.toISOString();
    const itemPurge = async (id: string) => (await listTrashOf(ctx.app, auth)).items.find(i => i.id === id)!.purgeAt;

    await ctx.db.$client.query(`update site_settings set trash_retention_days = 3`);
    const a = await seedNote(ctx.db, { ownerId: me.id });
    const outA = await deleteOk(ctx.app, auth, a.id);
    expect(outA.purgeAt).toBe(await sqlPurge(a.id, 3));
    expect(outA.purgeAt).toBe(await itemPurge(a.id));

    await ctx.db.$client.query(`update site_settings set trash_retention_days = null`);
    const b = await seedNote(ctx.db, { ownerId: me.id });
    const outB = await deleteOk(ctx.app, auth, b.id);
    expect(outB.purgeAt).toBeNull();
    expect(await itemPurge(b.id)).toBeNull();
  });
});

describe("delete_note: failing only after authorization: re-read after commit and re-check inside the transaction", () => {
  it("site_settings row deleted while the trashing transaction holds the lock -> trashing still commits, loadTrashedMeta fails -> not_found with the same sentence", async () => {
    const holder: { db?: Db; armed?: boolean } = {};
    const hook: GroupTestHook = async point => {
      if (point === "note-trash-locked" && holder.armed) await holder.db!.$client.query(`delete from site_settings`);
    };
    const ctx = await buildCollabTestApp({ groupTestHook: hook });
    holder.db = ctx.db;
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id });
    holder.armed = true;
    const r = await call(ctx.app, await tokenOf(ctx, me.id, RWD), "delete_note", { note_id: n.id });
    expect(r.structuredContent).toEqual({ code: "not_found", message: DELETE_NOT_FOUND_MESSAGE });
    expect(await isTrashed(ctx.db, n.id)).toBe(true); // precondition: trashing did commit; what failed is the read after commit
  });

  it("re-check inside the transaction sees none (someone else trashed it after authorization) -> not_found with the same sentence; deleted_by stays the first trasher", async () => {
    let open!: () => void;
    const gate = new Promise<void>(r => { open = r; });
    let entered!: () => void;
    const inside = new Promise<void>(r => { entered = r; });
    let first = true;
    const hook: GroupTestHook = async point => {
      if (point !== "note-trash-locked" || !first) return;
      first = false;
      entered();
      await gate;
    };
    const ctx = await buildCollabTestApp({ groupTestHook: hook });
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id });
    const rest = inject(ctx.app, "DELETE", `/api/notes/${n.id}`, me.id);
    await inside;
    const mcp = call(ctx.app, await tokenOf(ctx, me.id, RWD), "delete_note", { note_id: n.id });
    try {
      await waitForLockWaiters(ctx.db.$client, 1);
    } finally {
      open();
    }
    expect((await rest).statusCode).toBe(204);
    expect((await mcp).structuredContent).toEqual({ code: "not_found", message: DELETE_NOT_FOUND_MESSAGE });
    expect((await trashCols(ctx.db.$client, n.id))!.deleted_by).toBe(me.id);
  });
});

describe("restore_note: owner restores", () => {
  it("delete_note then restore_note: role owner, url equals the pre-trash list_notes one; deleted_at/deleted_by NULL; gate open; list_notes lists it again", async () => {
    const ctx = await buildCollabTestApp(realHooks);
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "RN1" });
    const auth = await tokenOf(ctx, me.id, RWD);
    const before = (await listNotesIds(ctx.app, auth)).find(x => x.id === n.id)!;
    await deleteOk(ctx.app, auth, n.id);
    expect(ctx.collab.isDeleting(n.id)).toBe(true);

    const note = await restoreOk(ctx.app, auth, n.id);
    expect(note).toMatchObject({ id: n.id, title: "RN1", role: "owner", url: before.url, owner: { kind: "user" } });
    expect(await trashCols(ctx.db.$client, n.id)).toEqual({ deleted_at: null, deleted_by: null });
    await vi.waitFor(() => expect(ctx.collab.isDeleting(n.id)).toBe(false));
    expect((await listNotesIds(ctx.app, auth)).map(x => x.id)).toContain(n.id);
  });
});

describe("restore_note: not_found has the same shape", () => {
  it("already restored note, live note, random uuid, someone else's personal trash note -> structuredContent identical field by field", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const other = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id });
    const live = await seedNote(ctx.db, { ownerId: me.id });
    const theirs = await seedNote(ctx.db, { ownerId: other.id });
    await markTrashed(ctx.db.$client, n.id, me.id);
    await markTrashed(ctx.db.$client, theirs.id, other.id);
    const auth = await tokenOf(ctx, me.id, RWD);
    await restoreOk(ctx.app, auth, n.id);

    const random = await call(ctx.app, auth, "restore_note", { note_id: randomUUID() });
    expect(random.isError).toBe(true);
    expect(random.structuredContent).toEqual({ code: "not_found", message: RESTORE_NOT_FOUND_MESSAGE });
    for (const id of [n.id, live.id, theirs.id]) expect(await call(ctx.app, auth, "restore_note", { note_id: id })).toEqual(random);
    expect(await isTrashed(ctx.db, theirs.id)).toBe(true);
  });

  it("someone else restored it after the pre-check (not_in_trash inside the transaction) -> same not_found sentence", async () => {
    let open!: () => void;
    const gate = new Promise<void>(r => { open = r; });
    let entered!: () => void;
    const inside = new Promise<void>(r => { entered = r; });
    let first = true;
    const hook: GroupTestHook = async point => {
      if (point !== "note-restore-locked" || !first) return;
      first = false;
      entered();
      await gate;
    };
    const ctx = await buildCollabTestApp({ groupTestHook: hook });
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id });
    await markTrashed(ctx.db.$client, n.id, me.id);
    const rest = inject(ctx.app, "POST", "/api/trash/restore", me.id, { ids: [n.id] });
    await inside;
    const mcp = call(ctx.app, await tokenOf(ctx, me.id, RWD), "restore_note", { note_id: n.id });
    try {
      await waitForLockWaiters(ctx.db.$client, 1);
    } finally {
      open();
    }
    expect(((await rest).json() as { restored: Array<{ id: string }> }).restored.map(x => x.id)).toEqual([n.id]);
    expect((await mcp).structuredContent).toEqual({ code: "not_found", message: RESTORE_NOT_FOUND_MESSAGE });
  });
});

describe("restore_note: group", () => {
  it("editDelete restores a group note trashed by admin -> owner.kind group, role editor", async () => {
    const ctx = await buildCollabTestApp();
    const s = await sixRoleScene(ctx.db);
    const n = await seedNote(ctx.db, { groupId: s.groupId });
    await markTrashed(ctx.db.$client, n.id, s.admin.id);
    const note = await restoreOk(ctx.app, await tokenOf(ctx, s.editDelete.id, RWD), n.id);
    expect(note).toMatchObject({ id: n.id, role: "editor", owner: { kind: "group" } });
    expect(await isTrashed(ctx.db, n.id)).toBe(false);
  });
});

describe("restore_note: six roles", () => {
  it("admin and editDelete succeed; deleteOnly, editOnly, member, readOnly, outsider -> not_found identical to a random uuid field by field", async () => {
    const ctx = await buildCollabTestApp();
    const s = await sixRoleScene(ctx.db);
    const roles = ["admin", "editDelete", "deleteOnly", "editOnly", "member", "readOnly", "outsider"] as const;
    const got: Record<string, unknown> = {};
    for (const r of roles) {
      const n = await seedNote(ctx.db, { groupId: s.groupId });
      await markTrashed(ctx.db.$client, n.id, s.admin.id);
      const res = await call(ctx.app, await tokenOf(ctx, s[r].id, RWD), "restore_note", { note_id: n.id });
      got[r] = res.isError ? res.structuredContent : "ok";
      expect({ r, trashed: await isTrashed(ctx.db, n.id) }).toEqual({ r, trashed: !!res.isError });
    }
    const random = (await call(ctx.app, await tokenOf(ctx, s.outsider.id, RWD), "restore_note", { note_id: randomUUID() })).structuredContent;
    expect(random).toEqual({ code: "not_found", message: RESTORE_NOT_FOUND_MESSAGE });
    expect(got).toEqual({ admin: "ok", editDelete: "ok", deleteOnly: random, editOnly: random, member: random, readOnly: random, outsider: random });
  });
});

describe("restore_note: edit limiter", () => {
  it("edit limiter with 0 slots: owner -> too_many_requests, still in trash; caller without trash permission -> not_found (pre-check runs before the charge)", async () => {
    const ctx = await buildCollabTestApp({ limiters: { edit: emptyLimiter() } });
    const owner = await seedUser(ctx.db);
    const outsider = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: owner.id });
    await markTrashed(ctx.db.$client, n.id, owner.id);
    expect((await call(ctx.app, await tokenOf(ctx, owner.id, RWD), "restore_note", { note_id: n.id })).structuredContent?.code).toBe("too_many_requests");
    expect(await isTrashed(ctx.db, n.id)).toBe(true);
    expect((await call(ctx.app, await tokenOf(ctx, outsider.id, RWD), "restore_note", { note_id: n.id })).structuredContent).toEqual({
      code: "not_found",
      message: RESTORE_NOT_FOUND_MESSAGE,
    });
  });
});

describe("restore_note: token write budget", () => {
  it("tokenWrite with 0 slots: RWD credential restore_note -> too_many_requests, still in trash, edit limiter not charged; session still succeeds", async () => {
    const edit = editLimiter();
    const ctx = await buildCollabTestApp({ limiters: { tokenWrite: emptyLimiter(), edit } });
    const me = await seedUser(ctx.db);
    const other = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id });
    const theirs = await seedNote(ctx.db, { ownerId: other.id });
    await markTrashed(ctx.db.$client, n.id, me.id);
    await markTrashed(ctx.db.$client, theirs.id, other.id);

    const r = await call(ctx.app, await tokenOf(ctx, me.id, RWD), "restore_note", { note_id: n.id });
    expect(r.structuredContent?.code).toBe("too_many_requests");
    expect(await isTrashed(ctx.db, n.id)).toBe(true);
    expect(remaining(edit, me.id)).toBe(EDIT_N);

    await restoreOk(ctx.app, await sessionOf(other.id), theirs.id);
    expect(await isTrashed(ctx.db, theirs.id)).toBe(false);
  });
});

describe("restore_note: transaction picked as a concurrency victim", () => {
  it("note-restore-locked throws 40001 -> server_busy with RESTORE_BUSY_MESSAGE; still in trash", async () => {
    const ctx = await buildCollabTestApp({
      groupTestHook: async point => {
        if (point === "note-restore-locked") throw busyErr();
      },
    });
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id });
    await markTrashed(ctx.db.$client, n.id, me.id);
    const before = await trashCols(ctx.db.$client, n.id);
    const r = await call(ctx.app, await tokenOf(ctx, me.id, RWD), "restore_note", { note_id: n.id });
    expect(r.structuredContent).toEqual({ code: "server_busy", message: RESTORE_BUSY_MESSAGE });
    expect(await trashCols(ctx.db.$client, n.id)).toEqual(before);
  });

  // "was not restored" holds only for retryable transaction aborts; other exceptions are internal.
  it("note-restore-locked throws a plain Error -> internal (not server_busy); still in trash", async () => {
    const ctx = await buildCollabTestApp({
      groupTestHook: async point => {
        if (point === "note-restore-locked") throw new Error("boom");
      },
    });
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id });
    await markTrashed(ctx.db.$client, n.id, me.id);
    const before = await trashCols(ctx.db.$client, n.id);
    const r = await call(ctx.app, await tokenOf(ctx, me.id, RWD), "restore_note", { note_id: n.id });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.code).toBe("internal");
    expect(await trashCols(ctx.db.$client, n.id)).toEqual(before);
  });
});

describe("model-facing strings", () => {
  it("delete_note/restore_note descriptions and the purgeAt explanation: new clauses present, removed old wording absent", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const tools = (await mcpPost(ctx.app, rpc("tools/list"), await tokenOf(ctx, me.id, RWD))).json().result.tools as Array<{
      name: string;
      description: string;
      outputSchema: { properties: Record<string, { description?: string }> };
    }>;
    const del = tools.find(t => t.name === "delete_note")!;
    const res = tools.find(t => t.name === "restore_note")!;
    expect(del.description).toContain("or sooner if someone deletes it permanently in the web app");
    expect(del.description).toContain("an admin can change that setting");
    expect(del.description).toContain("without that list_trash won't show it either");
    expect(del.description).toContain("A note that is already in the trash answers not_found — use list_trash to check.");
    expect(del.description).not.toContain("as it was");
    expect(del.description).not.toContain("Nothing is deleted permanently:");
    expect(del.outputSchema.properties.purgeAt!.description).toContain("an admin can change it");
    expect(del.outputSchema.properties.purgeAt!.description).toContain("list_trash shows the current date");
    expect(res.description).toContain("a different owner and URL");
    expect(res.description).not.toContain("same URL");
    // The folderPath sentence is present and the response-shape sentence still is.
    expect(res.description).toContain(
      "It usually goes back into the folder that list_trash shows as its `folderPath`, re-creating folders on that path that are missing.",
    );
    expect(res.description).toContain("Replies with the note in the same shape list_notes returns.");
  });
});

describe("REST and MCP over the same fixture", () => {
  it("six roles + outsider + per-person shared viewer/editor x trash/list/restore: the REST and MCP result tables match cell by cell", async () => {
    const ctx = await buildCollabTestApp();
    const s = await sixRoleScene(ctx.db);
    // Per-person shares: another user's personal note shared to them.
    const shareOwner = await seedUser(ctx.db);
    const users: Record<string, SeededUser> = {
      admin: s.admin, editDelete: s.editDelete, deleteOnly: s.deleteOnly, member: s.member, editOnly: s.editOnly, readOnly: s.readOnly,
      outsider: s.outsider, shareViewer: await seedUser(ctx.db), shareEditor: await seedUser(ctx.db),
    };
    const shareRole = { shareViewer: "viewer", shareEditor: "editor" } as Record<string, "viewer" | "editor">;
    const roles = ["admin", "editDelete", "deleteOnly", "member", "editOnly", "readOnly", "outsider", "shareViewer", "shareEditor"] as const;
    const fresh = async (r: string, trashed: boolean) => {
      const role = shareRole[r];
      const n = role ? await seedNote(ctx.db, { ownerId: shareOwner.id }) : await seedNote(ctx.db, { groupId: s.groupId });
      if (role) await seedShare(ctx.db, n.id, users[r]!.id, role);
      if (trashed) await markTrashed(ctx.db.$client, n.id, role ? shareOwner.id : s.admin.id);
      return n.id;
    };
    const restDelete = { 204: "ok", 403: "forbidden", 404: "not_found" } as Record<number, string>;
    const table = { rest: {} as Record<string, string[]>, mcp: {} as Record<string, string[]> };
    for (const r of roles) {
      const u = users[r]!;
      const auth = await tokenOf(ctx, u.id, RWD);
      const mcpCode = (x: Result) => (x.isError ? String(x.structuredContent?.code) : "ok");

      const d1 = await fresh(r, false);
      const restDel = restDelete[(await inject(ctx.app, "DELETE", `/api/notes/${d1}`, u.id)).statusCode] ?? "other";
      const mcpDel = mcpCode(await call(ctx.app, auth, "delete_note", { note_id: await fresh(r, false) }));

      const l1 = await fresh(r, true);
      const restList = (await restListOf(ctx.app, u.id)).items.some(i => i.id === l1) ? "listed" : "absent";
      const l2 = await fresh(r, true);
      const mcpList = (await listTrashOf(ctx.app, auth)).items.some(i => i.id === l2) ? "listed" : "absent";

      const r1 = await fresh(r, true);
      const body = (await inject(ctx.app, "POST", "/api/trash/restore", u.id, { ids: [r1] })).json() as {
        restored: Array<{ id: string }>;
        skipped: Array<{ id: string; reason: string }>;
      };
      const restRes = body.restored.some(x => x.id === r1) ? "ok" : (body.skipped.find(x => x.id === r1)?.reason ?? "other");
      const mcpRes = mcpCode(await call(ctx.app, auth, "restore_note", { note_id: await fresh(r, true) }));

      table.rest[r] = [restDel, restList, restRes];
      table.mcp[r] = [mcpDel, mcpList, mcpRes];
    }
    expect(table.mcp).toEqual(table.rest);
    expect(table.rest).toEqual({
      admin: ["ok", "listed", "ok"],
      editDelete: ["ok", "listed", "ok"],
      deleteOnly: ["ok", "absent", "not_found"],
      member: ["forbidden", "absent", "not_found"],
      editOnly: ["forbidden", "absent", "not_found"],
      readOnly: ["forbidden", "absent", "not_found"],
      outsider: ["not_found", "absent", "not_found"],
      shareViewer: ["forbidden", "absent", "not_found"],
      shareEditor: ["forbidden", "absent", "not_found"],
    });
  });
});

describe("registration", () => {
  it("R/RW/RWM have no delete_note/restore_note/delete_folder but have list_trash; RWD/RWMD/session have all four; no name contains purge/empty/permanent; RWM calling delete_note -> Tool not found", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: me.id });
    const namesOf = async (auth: Auth) => ((await mcpPost(ctx.app, rpc("tools/list"), auth)).json().result.tools as Array<{ name: string }>).map(t => t.name);
    const has = (names: string[]) => ["list_trash", "delete_note", "restore_note", "delete_folder"].map(x => names.includes(x));
    const cases: Array<[string, Auth, boolean[]]> = [
      ["R", await tokenOf(ctx, me.id, R), [true, false, false, false]],
      ["RW", await tokenOf(ctx, me.id, RW), [true, false, false, false]],
      ["RWM", await tokenOf(ctx, me.id, RWM), [true, false, false, false]],
      ["RWD", await tokenOf(ctx, me.id, RWD), [true, true, true, true]],
      ["RWMD", await tokenOf(ctx, me.id, RWMD), [true, true, true, true]],
      ["session", await sessionOf(me.id), [true, true, true, true]],
    ];
    for (const [label, auth, want] of cases) {
      const names = await namesOf(auth);
      expect({ label, has: has(names) }).toEqual({ label, has: want });
      expect({ label, bad: names.filter(x => /purge|empty|permanent/i.test(x)) }).toEqual({ label, bad: [] });
    }
    const direct = await call(ctx.app, cases[2]![1], "delete_note", { note_id: n.id });
    expect(direct.isError).toBe(true);
    expect(direct.structuredContent).toBeUndefined();
    expect(direct.content[0]!.text).toContain("Tool delete_note not found");
    expect(await isTrashed(ctx.db, n.id)).toBe(false);
  });
});

describe("write tools never trash", () => {
  it("RWMD credential: after edit_note append, copy_note (personal, group), create_note (group), move_note_to_group, no note is in the trash", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "SC2", [{ userId: me.id, role: "admin" }]);
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "SC2" });
    const auth = await tokenOf(ctx, me.id, RWMD);
    const trashedCount = async () => (await ctx.db.$client.query<{ n: number }>(`select count(*)::int n from notes where deleted_at is not null`)).rows[0]!.n;
    const ok = async (name: string, args: Record<string, unknown>) => {
      const r = await call(ctx.app, auth, name, args);
      expect(await trashedCount(), `${name} 之後`).toBe(0);
      expect(r.isError, `${name} ${JSON.stringify(r.structuredContent)}`).toBeUndefined();
    };
    await ok("edit_note", { note_id: n.id, op: "append", markdown: "SC2 一段" });
    await ok("copy_note", { note_id: n.id });
    await ok("copy_note", { note_id: n.id, group_id: g.id });
    await ok("create_note", { title: "SC2 group", group_id: g.id });
    await ok("move_note_to_group", { note_id: n.id, group_id: g.id });
    const { rows } = await ctx.db.$client.query<{ n: number }>(`select count(*)::int n from notes`);
    expect(rows[0]!.n).toBe(4); // original, two copies, the newly created note
  });
});

async function folderPathOf(db: Db, folderId: string): Promise<string[]> {
  const out: string[] = [];
  let cur: string | null = folderId;
  while (cur !== null) {
    const f = await folderRow(db.$client, cur);
    expect(f, `folder ${cur}`).toBeDefined();
    out.unshift(f!.name);
    cur = f!.parent_id;
  }
  return out;
}

describe("notes in folders: delete_note -> restore_note (personal)", () => {
  it("trashing keeps folder_id and stores snapshot [A,B,C] (same as REST folderPath); restore_note returns to the same folder and clears the snapshot", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const [, , c] = await seedFolderChain(ctx.db, { personal: me.id }, ["A", "B", "C"]);
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "FD1" });
    await setNoteFolder(ctx.db.$client, n.id, c!);
    const auth = await tokenOf(ctx, me.id, RWD);

    await deleteOk(ctx.app, auth, n.id);
    expect(await noteFolderCols(ctx.db.$client, n.id)).toEqual({ folder_id: c, trash_folder_path: ["A", "B", "C"] });
    expect((await restListOf(ctx.app, me.id)).items.map(i => [i.id, i.folderPath])).toEqual([[n.id, ["A", "B", "C"]]]);

    await restoreOk(ctx.app, auth, n.id);
    expect(await noteFolderCols(ctx.db.$client, n.id)).toEqual({ folder_id: c, trash_folder_path: null });
  });
});

describe("folder deleted while the note is in trash: restore_note recreates the path", () => {
  it("personal: after DELETE /api/folders/A, folder_id is NULL and the snapshot stays; restore_note -> new A/B/C (personal space), note in C, snapshot cleared", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const [a, , c] = await seedFolderChain(ctx.db, { personal: me.id }, ["A", "B", "C"]);
    const n = await seedNote(ctx.db, { ownerId: me.id });
    await setNoteFolder(ctx.db.$client, n.id, c!);
    const auth = await tokenOf(ctx, me.id, RWD);
    await deleteOk(ctx.app, auth, n.id);
    const del = await inject(ctx.app, "DELETE", `/api/folders/${a}`, me.id);
    expect(del.statusCode, del.body).toBe(200);
    expect(await noteFolderCols(ctx.db.$client, n.id)).toEqual({ folder_id: null, trash_folder_path: ["A", "B", "C"] });

    await restoreOk(ctx.app, auth, n.id);
    const cols = (await noteFolderCols(ctx.db.$client, n.id))!;
    expect(cols.trash_folder_path).toBeNull();
    expect(cols.folder_id).not.toBeNull();
    expect(cols.folder_id).not.toBe(c);
    expect(await folderPathOf(ctx.db, cols.folder_id!)).toEqual(["A", "B", "C"]);
    expect(await folderRow(ctx.db.$client, cols.folder_id!)).toMatchObject({ kind: "personal", owner_id: me.id, group_id: null });
  });

  it("group: after admin deletes group folder X, restore_note -> new X/Y in the same group, note in Y", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "FD2", [{ userId: me.id, role: "admin" }]);
    const [x, y] = await seedFolderChain(ctx.db, { group: g.id }, ["X", "Y"]);
    const n = await seedNote(ctx.db, { groupId: g.id });
    await setNoteFolder(ctx.db.$client, n.id, y!);
    const auth = await tokenOf(ctx, me.id, RWD);
    await deleteOk(ctx.app, auth, n.id);
    expect(await noteFolderCols(ctx.db.$client, n.id)).toEqual({ folder_id: y, trash_folder_path: ["X", "Y"] });
    const del = await inject(ctx.app, "DELETE", `/api/folders/${x}`, me.id);
    expect(del.statusCode, del.body).toBe(200);

    await restoreOk(ctx.app, auth, n.id);
    const cols = (await noteFolderCols(ctx.db.$client, n.id))!;
    expect(cols.trash_folder_path).toBeNull();
    expect(cols.folder_id).not.toBeNull();
    expect(cols.folder_id).not.toBe(y);
    expect(await folderPathOf(ctx.db, cols.folder_id!)).toEqual(["X", "Y"]);
    expect(await folderRow(ctx.db.$client, cols.folder_id!)).toMatchObject({ kind: "group", owner_id: null, group_id: g.id });
  });
});

describe("folder fields in MCP responses (restore_note has folder, list_trash has folderPath, delete_note has neither)", () => {
  it("note in a folder: delete_note has no key containing folder; list_trash folderPath equals REST; restore_note note.folder is the original folder", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const [f] = await seedFolderChain(ctx.db, { personal: me.id }, ["F"]);
    const n = await seedNote(ctx.db, { ownerId: me.id }, { title: "FD3" });
    await setNoteFolder(ctx.db.$client, n.id, f!);
    const auth = await tokenOf(ctx, me.id, RWD);
    const keysOf = (v: unknown): string[] => {
      if (Array.isArray(v)) return v.flatMap(keysOf);
      if (v === null || typeof v !== "object") return [];
      return Object.entries(v).flatMap(([k, x]) => [k, ...keysOf(x)]);
    };
    const folderKeys = (v: unknown) => keysOf(v).filter(k => /folder/i.test(k));

    expect(folderKeys(await deleteOk(ctx.app, auth, n.id))).toEqual([]);
    const listed = await listTrashOf(ctx.app, auth);
    expect(listed.items.map(i => i.id)).toEqual([n.id]);
    expect(listed.items[0]!.folderPath).toEqual(["F"]);
    expect(folderKeys(listed)).toEqual(["folderPath"]);
    expect((await restListOf(ctx.app, me.id)).items[0]!.folderPath).toEqual(["F"]);
    const note = await restoreOk(ctx.app, auth, n.id);
    expect(note.id).toBe(n.id);
    expect((note as NoteSummary & { folder?: unknown }).folder).toEqual({ id: f, name: "F" });
    expect(folderKeys(note)).toEqual(["folder"]); // any extra key containing folder fails
    expect((await noteFolderCols(ctx.db.$client, n.id))!.folder_id).toBe(f);
  });
});
