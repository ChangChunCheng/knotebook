import { and, inArray, isNotNull } from "drizzle-orm";
import type { TrashSkipDto } from "@knotebook/shared";
import type { CollabHooks } from "../collab/hooks.js";
import type { Db } from "../db/index.js";
import { notes } from "../db/schema.js";
import { folderSpaceLockKey, noteFolderSpace, type FolderSpace } from "../folders/space.js";
import type { GroupTestHook } from "../groups/test-hook.js";
import { resolveTrashedNoteAccess } from "../notes/service.js";
import {
  purgeTrashedNotesInTx,
  restoreNotesInTx,
  trashNotesInTx,
  type TrashBatchOutcome,
  type TrashIdsInput,
  type TrashNotesOutcome,
  type TrashRestoreInput,
} from "../notes/tx/trash.js";
import { deleteUploadFiles, type UploadDeleteLogger } from "../uploads/service.js";

export interface TrashServiceDeps {
  db: Db;
  collabHooks: CollabHooks;
  uploadsDir: string;
  storageLockTimeoutMs: number;
  groupTestHook?: GroupTestHook;
}

export type TrashNoteOutcome = "trashed" | "not_found" | "forbidden";

/** `noteId` must already pass UUID_RE and is lowercased here because the transaction's result ids are lowercase (an uppercase input would read as not_found after a successful trash). The caller authorizes; the transaction re-checks (TOCTOU). The gate is released synchronously. */
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
  // The in-tx recheck failed: release the gate, or new connections are told "deleted" for two minutes.
  gate.release();
  return out.forbidden.includes(noteId) ? "forbidden" : "not_found";
}

export interface TrashBatchResult { done: string[]; skipped: TrashSkipDto[] }

/** Load-bearing: the transaction's classification order is an existence oracle for arbitrary ids, so only ids that pass here may enter it. */
async function prejudge(db: Db, input: { ids: readonly string[]; by: string }): Promise<{ ok: string[]; denied: Set<string> }> {
  const ok: string[] = [];
  const denied = new Set<string>();
  for (const id of input.ids) {
    if (await resolveTrashedNoteAccess(db, input.by, id)) ok.push(id);
    else denied.add(id);
  }
  return { ok, denied };
}

function mergeSkipped(ids: readonly string[], denied: ReadonlySet<string>, inTx: readonly TrashSkipDto[]): TrashSkipDto[] {
  const byId = new Map(inTx.map(s => [s.id, s]));
  const out: TrashSkipDto[] = [];
  for (const id of ids) {
    if (denied.has(id)) out.push({ id, reason: "not_found" });
    else {
      const s = byId.get(id);
      if (s) out.push(s);
    }
  }
  return out;
}

/** `ids` must already be UUID_RE-valid, lowercase and deduplicated. No capacity check (trashed notes still count toward the quota). Groups and spaces are pre-read outside the transaction without locks; a note whose ownership changes after the pre-read isn't rebuilt. `onNotesRestored` is called synchronously after commit with the restored ids only. */
export async function restoreTrashed(deps: TrashServiceDeps, input: { ids: readonly string[]; by: string }): Promise<TrashBatchResult> {
  const { ok, denied } = await prejudge(deps.db, input);
  let out: TrashBatchOutcome = { done: [], skipped: [] };
  if (ok.length > 0) {
    const owners = await deps.db
      .select({ id: notes.id, ownerId: notes.ownerId, groupId: notes.groupId })
      .from(notes)
      .where(and(inArray(notes.id, ok), isNotNull(notes.deletedAt)));
    const groupIds = [...new Set(owners.flatMap(r => (r.groupId === null ? [] : [r.groupId])))].sort();
    const spaces = new Map<string, FolderSpace>();
    for (const r of owners) {
      const space = noteFolderSpace(r);
      spaces.set(folderSpaceLockKey(space), space);
    }
    await deps.groupTestHook?.("trash-restore-prejudged", { noteId: ok[0]! });
    const txInput: TrashRestoreInput = {
      ids: ok, by: input.by, groupIds, spaces: [...spaces.values()], lockTimeoutMs: deps.storageLockTimeoutMs,
    };
    out = await deps.db.transaction(tx => restoreNotesInTx(tx, txInput, deps.groupTestHook));
    if (out.done.length > 0) deps.collabHooks.onNotesRestored(out.done);
  }
  return { done: out.done, skipped: mergeSkipped(input.ids, denied, out.skipped) };
}

/** `ids` have the same precondition as `restoreTrashed`. Files are deleted only after commit (best-effort; none if the transaction throws); no collab gate. */
export async function purgeTrashed(
  deps: TrashServiceDeps,
  input: { ids: readonly string[]; by: string },
  log: UploadDeleteLogger,
): Promise<TrashBatchResult> {
  const { ok, denied } = await prejudge(deps.db, input);
  let out: TrashBatchOutcome = { done: [], skipped: [] };
  if (ok.length > 0) {
    const txInput: TrashIdsInput = { ids: ok, by: input.by };
    const purged = await deps.db.transaction(tx => purgeTrashedNotesInTx(tx, txInput, deps.groupTestHook));
    await deleteUploadFiles(deps.uploadsDir, purged.uploadIds, log);
    out = purged;
  }
  return { done: out.done, skipped: mergeSkipped(input.ids, denied, out.skipped) };
}
