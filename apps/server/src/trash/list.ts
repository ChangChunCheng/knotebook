/**
 * #181 `GET /api/trash` 的查詢（spec 2026-10-21 §6.3.1、§6.7）：呼叫者有垃圾桶權（D-W9）的項目＝個人（owner）∪ 群組
 * （角色 `can_edit AND can_delete`）。兩支結構性互斥（個人支 `owner_id = $u`、群組支 INNER JOIN 群組；`owner_id` 與 `group_id`
 * 恰一個非 NULL，`notes_owner_xor_group_chk`），`unionAll`。
 * 垃圾桶權的推導與單篇的 `trashRightFromRow` 同規則（`trash-routes.test.ts` TR-L3／TR-M1 逐角色比對）。
 */
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { alias, unionAll } from "drizzle-orm/pg-core";
import { TRASH_LIST_LIMIT, type TrashItemDto, type TrashListDto } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { groupMembers, groupRoles, groups, notes, users } from "../db/schema.js";

/** 刪除者（`notes.deleted_by`）。一律 LEFT JOIN：帳號已刪時欄位是 NULL，那一列仍要列出（`deletedBy: null`）。 */
const deleter = alias(users, "deleter");

/**
 * 兩支共用的前段欄位（每次現造：builder 單次使用）。`purgeAt` 是 raw `sql`，一定要 `.mapWith(notes.deletedAt)`——
 * 不然拿到 pg 的原始字串，`toISOString()` 直接 throw（`mcp/queries.ts` 檔頭）。
 */
function baseColumns(retentionDays: number | null) {
  // 與清理的到期式（`notes/tx/trash.ts` 的 `purgeExpiredBatchInTx`）同一類，要改一起改。兩式都受 session TimeZone 影響（跨 DST
  // 時「天」不是 24 h），但同一個 pool 下兩邊算出來一致。
  const purgeAt = retentionDays === null
    ? sql<Date | null>`null::timestamptz`
    : sql<Date | null>`${notes.deletedAt} + make_interval(days => ${retentionDays})`;
  return {
    id: notes.id,
    title: notes.title,
    deletedAt: notes.deletedAt,
    purgeAt: purgeAt.mapWith(notes.deletedAt).as("purge_at"),
    deleterHandle: deleter.handle,
    deleterName: deleter.displayName,
  };
}

/** 呼叫者有垃圾桶權的項目，`deleted_at DESC, id DESC`，至多 `TRASH_LIST_LIMIT` 筆（多取一筆判 truncated）。retentionDays 由路由讀好傳入。 */
export async function listTrash(db: Db, userId: string, retentionDays: number | null): Promise<TrashListDto> {
  // 群組兩欄寫成 `sql<… | null>`：union 後面各支的列型別要可指派給第一支（同 `list-query.ts` 的 `nullGroupColumns`）。
  const personal = db
    .select({
      ...baseColumns(retentionDays),
      groupId: sql<string | null>`null::uuid`.as("group_id"),
      groupName: sql<string | null>`null::text`.as("group_name"),
    })
    .from(notes)
    .leftJoin(deleter, eq(deleter.id, notes.deletedBy))
    .where(and(eq(notes.ownerId, userId), isNotNull(notes.deletedAt)));
  const grouped = db
    .select({
      ...baseColumns(retentionDays),
      groupId: sql<string | null>`${notes.groupId}`.as("group_id"),
      groupName: sql<string | null>`${groups.name}`.as("group_name"),
    })
    .from(notes)
    .innerJoin(groupMembers, and(eq(groupMembers.groupId, notes.groupId), eq(groupMembers.userId, userId)))
    .innerJoin(groupRoles, and(eq(groupRoles.id, groupMembers.roleId), eq(groupRoles.canEdit, true), eq(groupRoles.canDelete, true)))
    .innerJoin(groups, eq(groups.id, notes.groupId))
    .leftJoin(deleter, eq(deleter.id, notes.deletedBy))
    .where(isNotNull(notes.deletedAt));
  // 集合運算的 ORDER BY 只收輸出欄名（drizzle 對 union 的欄位參照渲染成裸欄名 deleted_at／id）。
  const rows = await unionAll(personal, grouped)
    .orderBy(desc(notes.deletedAt), desc(notes.id))
    .limit(TRASH_LIST_LIMIT + 1);

  const items: TrashItemDto[] = rows.slice(0, TRASH_LIST_LIMIT).map(r => ({
    id: r.id,
    title: r.title,
    deletedAt: r.deletedAt!.toISOString(),
    purgeAt: r.purgeAt?.toISOString() ?? null,
    deletedBy: r.deleterHandle === null ? null : { handle: r.deleterHandle, displayName: r.deleterName ?? "" },
    group: r.groupId === null ? null : { id: r.groupId, name: r.groupName ?? "" },
  }));
  return { retentionDays, items, truncated: rows.length > TRASH_LIST_LIMIT };
}
