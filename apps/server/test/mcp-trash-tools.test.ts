/**
 * #181 PR-2d：MCP 垃圾桶工具（spec 2026-10-21 §6.8.1、§9-11、A2-13）。本檔 T4 寫 `list_trash`（LT 段）；`delete_note`／
 * `restore_note`（DN、RN、PX、SC 段）由 T5 續寫。
 * 比對對象一律是同一人 cookie 的 `GET /api/trash`（兩條路同一支查詢 `trash/list.ts`）。造垃圾桶狀態打 `DELETE /api/notes/:id`；
 * 大量資料與病態字串直改 DB。
 */
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { SESSION_COOKIE, type TokenScope, type TrashListDto } from "@knotebook/shared";
import type { Db } from "../src/db/index.js";
import { groupMembers } from "../src/db/schema.js";
import { escapedLength } from "../src/mcp/limits.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { cookieOf, seedGroup, seedNote, seedRole, seedUser, type SeededUser } from "./group-helpers.js";
import { buildCollabTestApp } from "./helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import { inject, sixRoleScene } from "./trash-helpers.js";

const R: TokenScope = "notes:read";
const RW: TokenScope = "notes:read notes:write";

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
};
type ListTrashOut = { retentionDays: number | null; items: TrashItemForModel[]; truncated: boolean };

async function call(app: FastifyInstance, auth: Auth, name: string, args?: unknown): Promise<Result> {
  const params = args === undefined ? { name } : { name, arguments: args };
  const res = await mcpPost(app, rpc("tools/call", params), auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().result as Result;
}
/** `list_trash` 必須成功（唯讀憑證上沒註冊、或 42P18 收成 internal 時這裡就紅）。 */
async function listTrashOf(app: FastifyInstance, auth: Auth): Promise<ListTrashOut> {
  const r = await call(app, auth, "list_trash", {});
  expect(r.isError, JSON.stringify(r.content)).toBeUndefined();
  return r.structuredContent as unknown as ListTrashOut;
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

describe("LT1 範圍與順序：與 GET /api/trash 逐字相同", () => {
  it("個人兩篇＋群組（編輯＋刪除角色）一篇；別人的垃圾桶與活筆記不出現 → RW、R、session 的 items[].id 都等於 REST（含順序）", async () => {
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
    await trash(ctx.app, b.id, me.id);
    await trash(ctx.app, theirs.id, other.id);

    const rest = (await restListOf(ctx.app, me.id)).items.map(i => i.id);
    expect(rest).toEqual([b.id, gn.id, a.id]); // 前提：REST 本身是對的
    for (const auth of [await tokenOf(ctx, me.id, RW), await tokenOf(ctx, me.id, R), await sessionOf(me.id)]) {
      expect((await listTrashOf(ctx.app, auth)).items.map(i => i.id)).toEqual(rest);
    }
  });
});

describe("LT2 角色（D-W9）", () => {
  it("群組垃圾桶筆記：admin、editDelete 列得到；deleteOnly、editOnly、member、readOnly、outsider 列不到", async () => {
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

describe("LT3 上限 100", () => {
  const seedMany = (db: Db, u: SeededUser, n: number) =>
    db.$client.query(
      `insert into notes (owner_id, title, slug, deleted_at, deleted_by)
       select $1::uuid, 'T' || g, 'lt3-' || $3 || '-' || g, now() - make_interval(secs => g), $1::uuid from generate_series(1, $2::int) g`,
      [u.id, n, u.id.slice(0, 8)],
    );

  it("101 篇 → 100 筆、truncated true、第 100 筆等於 REST 的第 100 筆；剛好 100 篇 → 100 筆、truncated false", async () => {
    const ctx = await buildCollabTestApp();
    const big = await seedUser(ctx.db);
    const exact = await seedUser(ctx.db);
    await seedMany(ctx.db, big, 101);
    await seedMany(ctx.db, exact, 100);

    const b = await listTrashOf(ctx.app, await tokenOf(ctx, big.id, R));
    expect([b.items.length, b.truncated]).toEqual([100, true]);
    const restB = await restListOf(ctx.app, big.id);
    expect(restB.items).toHaveLength(101);
    expect(b.items[99]!.id).toBe(restB.items[99]!.id);
    expect(b.items.map(i => i.id)).toEqual(restB.items.slice(0, 100).map(i => i.id));

    const e = await listTrashOf(ctx.app, await tokenOf(ctx, exact.id, R));
    expect([e.items.length, e.truncated]).toEqual([100, false]);
  });
});

describe("LT4 欄位", () => {
  it("保留 7 天：retentionDays 7、每項 purgeAt 等於 REST；改成 NULL → MCP 與 REST 的 retentionDays、purgeAt 全是 null", async () => {
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

  it("刪除者帳號被刪 → deletedBy null；個人筆記 group null；一般資料沒有任何 *Truncated 鍵", async () => {
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
      expect(Object.keys(item)).toEqual(["id", "title", "deletedAt", "purgeAt", "deletedBy", "group"]);
      if (item.deletedBy !== null) expect(Object.keys(item.deletedBy)).toEqual(["handle", "displayName"]);
      if (item.group !== null) expect(Object.keys(item.group)).toEqual(["id", "name"]);
    }
  });

  it("標題 300 個 \"、刪除者 displayName 300 個 \"、群組名 80 個 U+0001 → 三個 *Truncated: true，逃脫後長度都 ≤ 200", async () => {
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
    expect(item!.title).toBe('"'.repeat(100)); // 前提：真的被截了（一個 " 逃脫後算 2）
  });
});

describe("LT5 輸入", () => {
  it("{} 成功；{ limit: 5 } → SDK 輸入驗證錯誤（無 structuredContent、訊息含 limit）；不帶 arguments → SDK 的 Required（同 X-241b）", async () => {
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

describe("LT6 鏡像與模型面字串", () => {
  it("content[0].text 逐字是 structuredContent 的 JSON；description／truncated／retentionDays 的說明不暗示分頁、講明管理員可改設定", async () => {
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
    // PR-2d 沒有 cursor：不得暗示可以再翻（PR-3d 加 cursor 時一起改）。
    expect(t.description).toContain("there is no paging");
    expect(t.description).not.toContain("per call");
    expect(t.outputSchema.properties.truncated!.description).toContain("older ones were left out");
    expect(t.outputSchema.properties.items!.description).toContain("`deletedBy` is null when the account that moved it there no longer exists");
    // 清理用的是當下的設定：purgeAt／保留天數都不是固定事實。
    expect(t.description).toContain("an admin can change it");
    expect(t.outputSchema.properties.retentionDays!.description).toContain("an admin can change it");
  });
});

describe("LT7 站台設定列不在", () => {
  it("DELETE FROM site_settings 後呼叫 → isError、code internal（runTool 收例外）", async () => {
    const ctx = await buildCollabTestApp();
    const me = await seedUser(ctx.db);
    const auth = await tokenOf(ctx, me.id, R);
    await ctx.db.$client.query(`delete from site_settings`);
    const r = await call(ctx.app, auth, "list_trash", {});
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.code).toBe("internal");
  });
});
