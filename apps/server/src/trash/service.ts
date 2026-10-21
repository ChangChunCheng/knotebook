/**
 * #181 垃圾桶的服務層（spec 2026-10-21 §6.3.2–§6.3.4）：REST 與 PR-2d 的 MCP 共用的唯一入口（gate r1 I4）。
 * 每支的形一律是「共編閘門／預判 → 交易（`notes/tx/trash.ts`，S14：callback 整段一個 `xInTx`）→ commit 後的 hook／刪檔」；
 * 交易本體只收 `tx` 與純資料，閘門、刪檔、`onNotesRestored` 都在這裡、在交易之外。
 */
import type { CollabHooks } from "../collab/hooks.js";
import type { Db } from "../db/index.js";
import type { GroupTestHook } from "../groups/test-hook.js";
import { trashNotesInTx, type TrashIdsInput, type TrashNotesOutcome } from "../notes/tx/trash.js";

export interface TrashServiceDeps {
  db: Db;
  collabHooks: CollabHooks;
  /** 永久刪除 commit 後刪附件檔用（T9）；移入不刪檔。 */
  uploadsDir: string;
  groupTestHook?: GroupTestHook;
}

export type TrashNoteOutcome = "trashed" | "not_found" | "forbidden";

/**
 * 單篇移入（spec §6.3.2 第 2～4 步）：`beforeNoteDeleted`（交易外）→ `trashNotesInTx` → 結果不是 trashed、或交易 throw，一律 `gate.release()`（throw 時 release 後原樣再丟）。
 * 呼叫端先做自己的授權與錯誤形（REST：`resolveNoteAccess` none → 404、無刪除權 → 403；PR-2d 的 MCP：not_found／forbidden）；本函式在交易內再判一次（TOCTOU）。
 * `noteId` 須已過 UUID；這裡一律轉小寫（交易本體的結果陣列是小寫 id，大寫輸入不轉會在移入成功後誤判成 not_found 並收門）。
 * release 在回傳之前同步呼叫（不延到呼叫端回應之後）。
 */
export async function trashNote(deps: TrashServiceDeps, input: { noteId: string; by: string }): Promise<TrashNoteOutcome> {
  const noteId = input.noteId.toLowerCase();
  const gate = await deps.collabHooks.beforeNoteDeleted(noteId);
  const txInput: TrashIdsInput = { ids: [noteId], by: input.by };
  let out: TrashNotesOutcome;
  try {
    out = await deps.db.transaction(tx => trashNotesInTx(tx, txInput, deps.groupTestHook));
  } catch (err) {
    gate.release();
    throw err;
  }
  if (out.trashed.includes(noteId)) return "trashed";
  // 交易內重判沒過（授權之後被降權、被別人先移入或刪掉）：閘門收回去，否則接下來兩分鐘新連線都會被告知「已刪除」。
  gate.release();
  return out.forbidden.includes(noteId) ? "forbidden" : "not_found";
}
