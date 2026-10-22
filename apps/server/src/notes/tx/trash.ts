/**
 * #181 垃圾桶的交易本體（spec 2026-10-21 §6.3.2-3、§6.3.3-2、§6.3.4-2、§6.6-1）。S14：只收 `tx`、純資料與測試縫；
 * 共編閘門、刪附件檔、`onNotesRestored` 一律由呼叫端（`trash/service.ts`、清理工作）在交易之外做。
 *
 * - `trashNotesInTx` 是**唯一**把 `deleted_at` 寫成非 NULL 的函式，`restoreNotesInTx` 是唯一把它清回 NULL 的函式（AG6）。
 *   兩者都用 DB `now()`／NULL，不碰 `updated_at`（它的語意是標題／網址變更）、不碰子表、不刪檔。
 *   步驟 3：移入要在這裡加資料夾路徑快照（spec §9-5），還原要在這裡加「原資料夾不在就照路徑重建」。
 * - 三支單篇路徑（移入／還原／永久刪除）第一步一律 `lockNotes`：不論狀態先 `FOR UPDATE`（依 id 升冪，與
 *   `deleteNotesInTx` 同鎖序，多 id 不互鎖成環；spec §6.3.2 M5），之後才重判。移入只改非鍵欄，普通 UPDATE 取的是
 *   `FOR NO KEY UPDATE`，與上傳／複製來源／索引的 `FOR KEY SHARE` 不互斥——顯式 `FOR UPDATE` 才讓它們序列化（讀碼發現 7）。
 * - 交易內的權限重判寫成 `noteAccessFromRow((await accessQuery(tx, …))[0], …)`／`trashRightFromRow(trashedAccessQuery(…))`：
 *   S14 守衛不准 tx/ 檔出現單篇授權函式的字面呼叫，這是同一個查詢形與同一份推導（spec rev 4.2，讀碼發現 3）。
 */
import { and, asc, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { TrashSkipDto } from "@knotebook/shared";
import type { Tx } from "../../db/tx.js";
import { notes } from "../../db/schema.js";
import type { GroupTestHook } from "../../groups/test-hook.js";
import { accessQuery, noteAccessFromRow, trashedAccessQuery, trashRightFromRow } from "../service.js";
import { deleteNotesInTx } from "./delete-notes.js";

/** ids：已過 UUID_RE、已轉小寫、已去重（呼叫端負責）。by：操作者 userId。 */
export interface TrashIdsInput { ids: readonly string[]; by: string }
export interface TrashNotesOutcome { trashed: string[]; notFound: string[]; forbidden: string[] }
export interface TrashBatchOutcome { done: string[]; skipped: TrashSkipDto[] }

/** 鎖住 ids 裡存在的筆記列（不論在不在垃圾桶），回 id → deleted_at。 */
async function lockNotes(tx: Tx, ids: readonly string[]): Promise<Map<string, Date | null>> {
  const rows = await tx
    .select({ id: notes.id, deletedAt: notes.deletedAt })
    .from(notes)
    .where(inArray(notes.id, [...ids]))
    .orderBy(asc(notes.id))
    .for("update");
  return new Map(rows.map(r => [r.id, r.deletedAt]));
}

/**
 * ⚠ 呼叫端必須先在交易外預判（單篇授權，並以 `beforeNoteDeleted` 開好共編閘門）才呼叫——這裡的鎖內重判只擋「授權之後、
 * 鎖之前」的變化；分類本身不是存在性 oracle（看不到的與不存在的同為 `notFound`）。唯一呼叫端是 `trash/service.ts`。
 *
 * 移到垃圾桶。鎖完後依 id 升冪逐篇重判：none（含已在垃圾桶、列不在）→ `notFound`；沒有刪除權 → `forbidden`；
 * 其餘一句 UPDATE 移入。三個陣列都依 id 升冪。ids 空 → 不發任何語句。
 */
export async function trashNotesInTx(tx: Tx, input: TrashIdsInput, hook?: GroupTestHook): Promise<TrashNotesOutcome> {
  const out: TrashNotesOutcome = { trashed: [], notFound: [], forbidden: [] };
  if (input.ids.length === 0) return out;
  await lockNotes(tx, input.ids);
  await hook?.("note-trash-locked", { noteId: input.ids[0]! });

  const ok: string[] = [];
  for (const id of [...input.ids].sort()) {
    const access = noteAccessFromRow((await accessQuery(tx, input.by, id))[0], input.by);
    if (access.role === "none") out.notFound.push(id);
    else if (!access.permissions.delete) out.forbidden.push(id);
    else ok.push(id);
  }
  if (ok.length === 0) return out;
  const rows = await tx
    .update(notes)
    .set({ deletedAt: sql`now()`, deletedBy: input.by })
    .where(and(inArray(notes.id, ok), isNull(notes.deletedAt)))
    .returning({ id: notes.id });
  const hit = new Set(rows.map(r => r.id));
  out.trashed = ok.filter(id => hit.has(id));
  return out;
}

/** restore／purge 共用的分類：沒鎖到 → not_found；活筆記 → not_in_trash；沒有垃圾桶權 → not_found。 */
async function classifyTrashed(tx: Tx, input: TrashIdsInput, locked: Map<string, Date | null>): Promise<{ ok: string[]; skipped: TrashSkipDto[] }> {
  const ok: string[] = [];
  const skipped: TrashSkipDto[] = [];
  for (const id of input.ids) {
    if (!locked.has(id)) skipped.push({ id, reason: "not_found" });
    else if (locked.get(id) === null) skipped.push({ id, reason: "not_in_trash" });
    else if (!trashRightFromRow((await trashedAccessQuery(tx, input.by, id))[0], input.by)) skipped.push({ id, reason: "not_found" });
    else ok.push(id);
  }
  return { ok, skipped };
}

/**
 * ⚠ 呼叫端必須先以 `resolveTrashedNoteAccess` 預判、只把有垃圾桶權的 id 傳進來——本函式的分類順序（不在 → `not_found`、
 * 活著 → `not_in_trash`、才看垃圾桶權）對任意 id 而言是存在性 oracle（AG2）。唯一呼叫端是 `trash/service.ts`。
 *
 * 還原：鎖完逐篇分類，其餘一句 UPDATE 清 `deleted_at`／`deleted_by`。`done`、`skipped` 都照輸入順序。ids 空 → 不發任何語句。
 */
export async function restoreNotesInTx(tx: Tx, input: TrashIdsInput, hook?: GroupTestHook): Promise<TrashBatchOutcome> {
  if (input.ids.length === 0) return { done: [], skipped: [] };
  const locked = await lockNotes(tx, input.ids);
  await hook?.("note-restore-locked", { noteId: input.ids[0]! });

  const { ok, skipped } = await classifyTrashed(tx, input, locked);
  if (ok.length === 0) return { done: [], skipped };
  const rows = await tx
    .update(notes)
    .set({ deletedAt: null, deletedBy: null })
    .where(and(inArray(notes.id, ok), isNotNull(notes.deletedAt)))
    .returning({ id: notes.id });
  const hit = new Set(rows.map(r => r.id));
  return { done: ok.filter(id => hit.has(id)), skipped };
}

/**
 * ⚠ 呼叫端必須先以 `resolveTrashedNoteAccess` 預判、只把有垃圾桶權的 id 傳進來——本函式的分類順序（不在 → `not_found`、
 * 活著 → `not_in_trash`、才看垃圾桶權）對任意 id 而言是存在性 oracle（AG2）。唯一呼叫端是 `trash/service.ts`。
 *
 * 永久刪除：分類同還原（活筆記一律 `not_in_trash`、不刪，AG5），其餘交給 `deleteNotesInTx`（同交易）。回被刪的 upload id，
 * 磁碟檔由呼叫端在 commit 之後刪。`done`、`skipped` 照輸入順序。ids 空 → 不發任何語句。
 */
export async function purgeTrashedNotesInTx(tx: Tx, input: TrashIdsInput, hook?: GroupTestHook): Promise<TrashBatchOutcome & { uploadIds: string[] }> {
  if (input.ids.length === 0) return { done: [], skipped: [], uploadIds: [] };
  const locked = await lockNotes(tx, input.ids);
  await hook?.("note-purge-locked", { noteId: input.ids[0]! });

  const { ok, skipped } = await classifyTrashed(tx, input, locked);
  if (ok.length === 0) return { done: [], skipped, uploadIds: [] };
  const uploadIds = await deleteNotesInTx(tx, ok);
  return { done: ok, skipped, uploadIds };
}

/**
 * 保留期清理的一批（spec §6.6-1）：`deleted_at` 嚴格早於 `now() - retentionDays 天` 的垃圾桶筆記，依 `deleted_at, id`
 * 升冪取至多 `limit` 篇、`FOR UPDATE SKIP LOCKED`（不等正在還原或手動永久刪除的列，下一輪再處理），同交易
 * `deleteNotesInTx`。時間全在 DB 端算。
 */
export async function purgeExpiredBatchInTx(
  tx: Tx,
  input: { retentionDays: number; limit: number },
  hook?: GroupTestHook,
): Promise<{ noteIds: string[]; uploadIds: string[] }> {
  const rows = await tx
    .select({ id: notes.id })
    .from(notes)
    .where(and(isNotNull(notes.deletedAt), sql`${notes.deletedAt} < now() - make_interval(days => ${input.retentionDays})`))
    .orderBy(asc(notes.deletedAt), asc(notes.id))
    .limit(input.limit)
    .for("update", { skipLocked: true });
  await hook?.("trash-purge-locked", rows[0] ? { noteId: rows[0].id } : {});
  if (rows.length === 0) return { noteIds: [], uploadIds: [] };
  const noteIds = rows.map(r => r.id);
  return { noteIds, uploadIds: await deleteNotesInTx(tx, noteIds) };
}
