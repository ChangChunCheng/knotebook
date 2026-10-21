/**
 * #181 PR-2a T4：交易內存活重讀（spec §6.2-11 表前五列、A2-16 的循序案）。在「授權之後、交易之前」的測試縫裡以
 * `trashNotesInTx` 把筆記移入垃圾桶——繞過路由授權（M-E）——再讓操作跑完：回該處原本的 not_found，筆記沒被改到。
 * 每案配一個對照：同一縫裡不移入 → 操作照常成功（縫本身沒弄壞流程）。
 */
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Db } from "../src/db/index.js";
import { noteRedirects, notes, uploads } from "../src/db/schema.js";
import type { GroupRacePoint, GroupTestHook } from "../src/groups/test-hook.js";
import type { SlugPatchTestHook } from "../src/notes/tx/patch-slug.js";
import { trashNotesInTx, type TrashNotesOutcome } from "../src/notes/tx/trash.js";
import { buildTestApp } from "./helpers.js";
import { cookieOf, noteState, seedGroup, seedNote, seedShare, seedUser, sharesOf } from "./group-helpers.js";
import { filesIn, upload } from "./storage-helpers.js";
import { trashCols } from "./trash-helpers.js";

const NOT_FOUND = { error: { code: "not_found", message: "找不到此筆記" } };

/** 縫的狀態：`target` 有值時，縫第一次觸發就把那篇移入垃圾桶（新交易，commit 後才放行操作）。 */
interface Seam {
  db?: Db;
  target?: { id: string; by: string };
  hits: number;
  ctxNoteId?: string;
  trashed?: TrashNotesOutcome;
}

async function fireSeam(s: Seam, noteId: string | undefined): Promise<void> {
  s.hits++;
  s.ctxNoteId = noteId;
  if (s.target && s.hits === 1) {
    const t = s.target;
    s.trashed = await s.db!.transaction(tx => trashNotesInTx(tx, { ids: [t.id], by: t.by }));
  }
}

const groupSeam = (point: GroupRacePoint, s: Seam): GroupTestHook => async (p, ctx) => {
  if (p === point) await fireSeam(s, ctx.noteId);
};
const slugSeam = (s: Seam): SlugPatchTestHook => async (p, ctx) => {
  if (p === "authorized") await fireSeam(s, ctx.noteId);
};

/** 縫恰觸發一次、ctx 是本篇；有移入的話，移入成功。 */
function expectSeam(s: Seam, noteId: string, trashed: boolean): void {
  expect(s.hits).toBe(1);
  expect(s.ctxNoteId).toBe(noteId);
  if (trashed) expect(s.trashed).toEqual({ trashed: [noteId], notFound: [], forbidden: [] });
}

const noteCount = async (db: Db) => (await db.select({ n: sql<number>`count(*)::int` }).from(notes))[0]!.n;
const req = async (app: FastifyInstance, method: "POST" | "PUT" | "PATCH", url: string, userId: string, payload: unknown) =>
  app.inject({ method, url, cookies: await cookieOf(userId), payload: payload as Record<string, unknown> });

describe("#181 交易內存活重讀：授權之後被移入垃圾桶", () => {
  for (const trash of [true, false]) {
    const tag = trash ? "授權後移入 → 404 not_found，筆記沒被搬、分享與公開欄位不變" : "對照：縫裡不移入 → 200 照常搬移";
    it(`RR-MV 搬移（note-move-authorized）：${tag}`, async () => {
      const s: Seam = { hits: 0 };
      const built = await buildTestApp({ groupTestHook: groupSeam("note-move-authorized", s) });
      s.db = built.db;
      const { app, db } = built;
      const [owner, friend] = await Promise.all([seedUser(db), seedUser(db)]);
      const g = await seedGroup(db, "G", [{ userId: owner.id, role: "member" }]);
      const n = await seedNote(db, { ownerId: owner.id }, { slug: "plan", publicToken: "m".repeat(43), publicSlug: "alias-mv" });
      await seedShare(db, n.id, friend.id, "editor");
      const before = await noteState(db.$client, n.id);
      if (trash) s.target = { id: n.id, by: owner.id };

      const res = await req(app, "POST", `/api/notes/${n.id}/move`, owner.id, { groupId: g.id });

      expectSeam(s, n.id, trash);
      if (trash) {
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual(NOT_FOUND);
        expect(await noteState(db.$client, n.id)).toEqual(before);
        expect(await sharesOf(db, n.id)).toEqual([{ userId: friend.id, role: "editor" }]);
        expect(await db.select().from(noteRedirects)).toEqual([]);
        expect((await trashCols(db.$client, n.id))?.deleted_at).not.toBeNull();
      } else {
        expect(res.statusCode).toBe(200);
        expect(await noteState(db.$client, n.id)).toMatchObject({ owner_id: null, group_id: g.id, public_token: null, public_slug: null });
        expect(await sharesOf(db, n.id)).toEqual([]);
      }
    });
  }

  for (const trash of [true, false]) {
    const tag = trash ? "授權後移入 → 404 not_found，uploads 0 列、磁碟不多檔" : "對照：縫裡不移入 → 201，uploads 1 列、磁碟多一檔";
    it(`RR-UP 上傳（upload-authorized）：${tag}`, async () => {
      const s: Seam = { hits: 0 };
      const built = await buildTestApp({ groupTestHook: groupSeam("upload-authorized", s) });
      s.db = built.db;
      const { app, db, uploadsDir } = built;
      const owner = await seedUser(db);
      const n = await seedNote(db, { ownerId: owner.id });
      const filesBefore = await filesIn(uploadsDir);
      if (trash) s.target = { id: n.id, by: owner.id };

      const res = await upload(app, n.id, owner.id, 8);

      expectSeam(s, n.id, trash);
      const rows = await db.select({ id: uploads.id }).from(uploads).where(eq(uploads.noteId, n.id));
      if (trash) {
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual(NOT_FOUND);
        expect(rows).toEqual([]);
        expect(await filesIn(uploadsDir)).toEqual(filesBefore);
      } else {
        expect(res.statusCode).toBe(201);
        expect(rows).toHaveLength(1);
        expect(await filesIn(uploadsDir)).toHaveLength(filesBefore.length + 1);
      }
    });
  }

  for (const trash of [true, false]) {
    const tag = trash ? "授權後移入 → 404 not_found，notes 總數不變" : "對照：縫裡不移入 → 201，notes 多一篇";
    it(`RR-CP 複製（note-copy-authorized）：${tag}`, async () => {
      const s: Seam = { hits: 0 };
      const built = await buildTestApp({ groupTestHook: groupSeam("note-copy-authorized", s) });
      s.db = built.db;
      const { app, db } = built;
      const owner = await seedUser(db);
      const n = await seedNote(db, { ownerId: owner.id });
      const countBefore = await noteCount(db);
      if (trash) s.target = { id: n.id, by: owner.id };

      const res = await req(app, "POST", `/api/notes/${n.id}/copy`, owner.id, {});

      expectSeam(s, n.id, trash);
      if (trash) {
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual(NOT_FOUND);
        expect(await noteCount(db)).toBe(countBefore);
      } else {
        expect(res.statusCode).toBe(201);
        expect(await noteCount(db)).toBe(countBefore + 1);
      }
    });
  }

  for (const trash of [true, false]) {
    const tag = trash ? "授權後移入 → 404 not_found，分享不變" : "對照：縫裡不移入 → 200，多一筆分享";
    it(`RR-SH 分享（share-authorized）：${tag}`, async () => {
      const s: Seam = { hits: 0 };
      const built = await buildTestApp({ groupTestHook: groupSeam("share-authorized", s) });
      s.db = built.db;
      const { app, db } = built;
      const [owner, friend, other] = await Promise.all([seedUser(db), seedUser(db), seedUser(db)]);
      const n = await seedNote(db, { ownerId: owner.id });
      await seedShare(db, n.id, other.id, "viewer");
      const before = await sharesOf(db, n.id);
      if (trash) s.target = { id: n.id, by: owner.id };

      const res = await req(app, "PUT", `/api/notes/${n.id}/shares`, owner.id, { email: friend.email, role: "editor" });

      expectSeam(s, n.id, trash);
      if (trash) {
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual(NOT_FOUND);
        expect(await sharesOf(db, n.id)).toEqual(before);
      } else {
        expect(res.statusCode).toBe(200);
        expect(await sharesOf(db, n.id)).toEqual(
          [...before, { userId: friend.id, role: "editor" }].sort((a, b) => (a.userId < b.userId ? -1 : 1)),
        );
      }
    });
  }

  const cells: Array<[string, { slug: string | null }]> = [["格 1 自訂 slug", { slug: "x-new" }], ["格 4 slug:null", { slug: null }]];
  for (const [cell, body] of cells) {
    for (const trash of [true, false]) {
      const tag = trash ? "授權後移入 → 404 not_found（不是 409），slug／prev_slug／updated_at 不變" : "對照：縫裡不移入 → 200，slug 改了";
      it(`RR-PS 改網址 ${cell}（slugPatchTestHook authorized）：${tag}`, async () => {
        const s: Seam = { hits: 0 };
        const built = await buildTestApp({ slugPatchTestHook: slugSeam(s) });
        s.db = built.db;
        const { app, db } = built;
        const owner = await seedUser(db);
        const n = await seedNote(db, { ownerId: owner.id }, { title: "Hello World", slug: "old-custom", slugIsCustom: true });
        const before = await noteState(db.$client, n.id);
        if (trash) s.target = { id: n.id, by: owner.id };

        const res = await req(app, "PATCH", `/api/notes/${n.id}`, owner.id, body);

        expectSeam(s, n.id, trash);
        if (trash) {
          expect(res.statusCode).toBe(404);
          expect(res.json()).toEqual(NOT_FOUND);
          expect(await noteState(db.$client, n.id)).toEqual(before);
        } else {
          expect(res.statusCode).toBe(200);
          expect((await noteState(db.$client, n.id)).slug).not.toBe("old-custom");
        }
      });
    }
  }
});
