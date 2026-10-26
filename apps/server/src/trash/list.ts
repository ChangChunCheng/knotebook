/**
 * #181 `GET /api/trash` 的查詢（spec 2026-10-21 §6.3.1、§6.7）：呼叫者有垃圾桶權（D-W9）的項目＝個人（owner）∪ 群組
 * （角色 `can_edit AND can_delete`）。兩支結構性互斥（個人支 `owner_id = $u`、群組支 INNER JOIN 群組；`owner_id` 與 `group_id`
 * 恰一個非 NULL，`notes_owner_xor_group_chk`），`unionAll`。
 * 垃圾桶權的推導與單篇的 `trashRightFromRow` 同規則（`trash-routes.test.ts` TR-L3／TR-M1 逐角色比對）。
 * #181 PR-2d：MCP `list_trash` 共用 `listTrash`（`opts.limit`）與 `readTrashRetentionDays`；`delete_note` 移入後以 `loadTrashedMeta` 重讀。
 */
import { and, desc, eq, isNotNull, sql, type SQL } from "drizzle-orm";
import { alias, unionAll, type AnyPgColumn } from "drizzle-orm/pg-core";
import { TRASH_LIST_LIMIT, type TrashItemDto, type TrashListDto } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { groupMembers, groupRoles, groups, notes, siteSettings, users } from "../db/schema.js";
import { folderPathJsonSql, NOTES_FOLDER_ID } from "../folders/sql.js";

/** 刪除者（`notes.deleted_by`）。一律 LEFT JOIN：帳號已刪時欄位是 NULL，那一列仍要列出（`deletedBy: null`）。 */
const deleter = alias(users, "deleter");

/**
 * 到期時間（清單與 `loadTrashedMeta` 共用）。與清理的到期式（`notes/tx/trash.ts` 的 `purgeExpiredBatchInTx`）同一類，要改一起改。
 * 兩式都受 session TimeZone 影響（跨 DST 時「天」不是 24 h），但同一個 pool 下兩邊算出來一致。
 * ⚠ 真正的陷阱是對無型別 bind 參數寫 `CASE WHEN ${x} IS NULL`／`${x} IS NULL`：pg 推不出參數型別，parse 階段 42P18。所以不寫 CASE——
 * `make_interval` 是 STRICT，天數 NULL 時整式就是 NULL。參數側的 `::int` 目前不影響行為（`make_interval` 的簽名已把參數定成 int），
 * 是防禦性的：日後有人包上 `CASE`／`IS NULL` 時參數已有型別（同 `password-reset.ts` 的 `make_interval(hours => …::int)`）。
 * raw `sql` 一定要 `.mapWith(notes.deletedAt)`——不然拿到 pg 的原始字串，`toISOString()` 直接 throw（`mcp/queries.ts` 檔頭）。
 */
function purgeAtExpr(days: SQL | AnyPgColumn) {
  return sql<Date | null>`${notes.deletedAt} + make_interval(days => ${days})`.mapWith(notes.deletedAt);
}

/** 兩支共用的前段欄位（每次現造：builder 單次使用）。 */
function baseColumns(retentionDays: number | null) {
  return {
    id: notes.id,
    title: notes.title,
    deletedAt: notes.deletedAt,
    purgeAt: purgeAtExpr(sql`${retentionDays}::int`).as("purge_at"),
    deleterHandle: deleter.handle,
    deleterName: deleter.displayName,
    // 資料夾（spec 2026-10-22 §5.8）：`folder_id` 非 NULL → 即時路徑（資料夾期間改名、搬動也跟著），否則快照；NULL → []。
    // 外層欄一律帶表名字面（單表 SELECT 直接插欄位會渲染成裸名，`NOTES_FOLDER_ID` 檔頭）。node-postgres 把 jsonb 解成陣列。
    folderPath: sql<string[]>`coalesce(case when "notes"."folder_id" is not null then ${folderPathJsonSql(NOTES_FOLDER_ID())} else "notes"."trash_folder_path" end, '[]'::jsonb)`.as("folder_path"),
  };
}

/**
 * 呼叫者有垃圾桶權的項目，`deleted_at DESC, id DESC`，至多 `opts.limit`（預設 `TRASH_LIST_LIMIT`）筆（多取一筆判 truncated）。
 * retentionDays 由呼叫端讀好傳入（`readTrashRetentionDays`）。MCP `list_trash` 傳 `MCP_PAGE_MAX`。
 */
export async function listTrash(db: Db, userId: string, retentionDays: number | null, opts: { limit?: number } = {}): Promise<TrashListDto> {
  const limit = opts.limit ?? TRASH_LIST_LIMIT;
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
    .limit(limit + 1);

  const items: TrashItemDto[] = rows.slice(0, limit).map(r => ({
    id: r.id,
    title: r.title,
    deletedAt: r.deletedAt!.toISOString(),
    purgeAt: r.purgeAt?.toISOString() ?? null,
    deletedBy: r.deleterHandle === null ? null : { handle: r.deleterHandle, displayName: r.deleterName ?? "" },
    group: r.groupId === null ? null : { id: r.groupId, name: r.groupName ?? "" },
    folderPath: r.folderPath,
  }));
  return { retentionDays, items, truncated: rows.length > limit };
}

/**
 * site_settings 單列的保留天數；列不存在 → undefined（呼叫端：REST 記 `SITE_SETTINGS_MISSING_MESSAGE` 回 500；MCP 丟例外給
 * `runTool` → internal；`delete_note` 拿它當移入前的存在性守衛）。
 */
export async function readTrashRetentionDays(db: Db): Promise<{ retentionDays: number | null } | undefined> {
  const [row] = await db
    .select({ retentionDays: siteSettings.trashRetentionDays })
    .from(siteSettings)
    .where(eq(siteSettings.singleton, true))
    .limit(1);
  return row === undefined ? undefined : { retentionDays: row.retentionDays };
}

/**
 * `delete_note` 移入 commit 後的一讀（交易外單句 SELECT）：只看垃圾桶；`purgeAt` 與清單同一運算式，同一句裡 join
 * site_settings 取**這一刻**的保留天數。commit 之後被還原或永久刪除、或 site_settings 列不在 → 0 列 → undefined
 * （呼叫端照「重讀落空」處理）。
 */
export async function loadTrashedMeta(db: Db, noteId: string): Promise<{ title: string; purgeAt: Date | null } | undefined> {
  const [row] = await db
    .select({ title: notes.title, purgeAt: purgeAtExpr(siteSettings.trashRetentionDays) })
    .from(notes)
    .innerJoin(siteSettings, eq(siteSettings.singleton, true))
    .where(and(eq(notes.id, noteId), isNotNull(notes.deletedAt)))
    .limit(1);
  return row;
}
