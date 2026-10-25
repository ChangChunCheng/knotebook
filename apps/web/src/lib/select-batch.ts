import type { QueryClient } from "@tanstack/react-query";
import type { NoteDto } from "@knotebook/shared";
import { api, ApiFail } from "@/api/client";
import { applyMovedNote, refetchAfterFailure } from "@/api/note-move";
import { destinationBody, type Destination } from "@/components/sidebar/select-model";
import type { SelectionNode } from "@/lib/sidebar-selection";

/**
 * 一般 tab 選取模式的批次執行（#181 PR-2c，spec §6.11「執行」、D-M4）。只准被 SelectLazy 鏈與測試 import。
 * - 不用 mutation hook：批次要能跑完整輪，即使中途動作列或抽屜卸載（換頁、關抽屜、Done）；結果由呼叫端依 session 決定要不要套用。
 * - 依序（await 完一篇才送下一篇）：不開批次端點（spec §6.11），沿用單篇端點的交易、權限與容量檢查；依序才停得住、才回報得出「已完成幾篇」。
 * - 分類（Willie 裁定）：403、404 `not_found` → 略過、繼續；其餘（429、404 `group_not_found`、409、400、5xx、網路錯誤、
 *   非 JSON 的 `internal`）→ 停下。move 的 409 `conflict`（授權之後、上鎖之前歸屬變了）是窄競態：停下安全、不掉資料。
 * - 複製扣寫入節流（`limiters.edit` 30 次／60 秒，有附件再扣 upload 桶）：一次複製約 30 篇以上會撞 429 而停下。
 * - 停下時的 `remaining` 是選取鍵形（`{ kind, id }`）：呼叫端直接 `setAll` 回選取；PR-3b 的資料夾項放 `{ kind: "folder", id }`。
 * - 整批的快取失效一律在 `finally`：hook 丟例外時整批 reject，已送出的仍要對帳。
 */

/** 403、404 not_found → 略過；其餘 → 停下（讀碼發現 13，Willie 裁定）。 */
export function classifyBatchError(err: unknown): "skip" | "stop" {
  if (err instanceof ApiFail && (err.status === 403 || (err.status === 404 && err.code === "not_found"))) return "skip";
  return "stop";
}

export interface BatchOutcome<R> {
  /** 依送出順序。 */
  done: R[];
  /** 只計 server 回的略過（client 預先排除的由呼叫端加）。 */
  skipped: number;
  /** 停下那篇（含）之後全部未成功的項目，以選取鍵形回傳（gate r1 m13）：PR-3b 的資料夾項直接放 `{ kind: "folder", id }`。 */
  stopped: { cause: unknown; remaining: SelectionNode[] } | null;
}

type BatchHooks = { onProgress?: (processed: number, total: number) => void };

/** 依序（await 完一項才送下一項）。`beforeEach` 在送出前同步呼叫；`onProgress(processed, total)` 在每項結束（成功、略過）後呼叫。
 * hook 不得丟例外：丟了整批 reject、沒有 outcome（已完成篇數與「復原」都拿不到），只剩 finally 的失效。 */
export async function runSequential<T, R>(
  items: readonly T[],
  nodeOf: (item: T) => SelectionNode,
  run: (item: T) => Promise<R>,
  hooks: {
    beforeEach?: (item: T) => void;
    afterFailure?: (item: T, err: unknown, kind: "skip" | "stop") => void;
    onProgress?: (processed: number, total: number) => void;
  } = {},
): Promise<BatchOutcome<R>> {
  const done: R[] = [];
  let skipped = 0;
  for (const [index, item] of items.entries()) {
    hooks.beforeEach?.(item);
    try {
      done.push(await run(item));
    } catch (err) {
      const kind = classifyBatchError(err);
      hooks.afterFailure?.(item, err, kind);
      if (kind === "stop") return { done, skipped, stopped: { cause: err, remaining: items.slice(index).map(nodeOf) } };
      skipped += 1;
    }
    hooks.onProgress?.(index + 1, items.length);
  }
  return { done, skipped, stopped: null };
}

const noteNode = (note: NoteDto): SelectionNode => ({ kind: "note", id: note.id });
const notePath = (id: string): string => `/api/notes/${encodeURIComponent(id)}`;

/** `DELETE /api/notes/:id`（移到垃圾桶）；`done` 收原 NoteDto。失效同單篇 `useDeleteNote`。 */
export async function trashNotesInOrder(
  notes: readonly NoteDto[],
  deps: {
    queryClient: QueryClient;
    beforeEach?: (n: NoteDto) => void;
    afterFailure?: (n: NoteDto, err: unknown, kind: "skip" | "stop") => void;
  } & BatchHooks,
): Promise<BatchOutcome<NoteDto>> {
  const { queryClient } = deps;
  const doneIds: string[] = [];
  try {
    return await runSequential(
      notes,
      noteNode,
      async (note) => {
        await api<void>(notePath(note.id), { method: "DELETE" });
        doneIds.push(note.id);
        return note;
      },
      { beforeEach: deps.beforeEach, afterFailure: deps.afterFailure, onProgress: deps.onProgress },
    );
  } finally {
    void queryClient.invalidateQueries({ queryKey: ["notes"] });
    void queryClient.invalidateQueries({ queryKey: ["backlinks"] });
    void queryClient.invalidateQueries({ queryKey: ["trash"] });
    for (const id of doneIds) void queryClient.invalidateQueries({ queryKey: ["note", id] });
  }
}

/** `POST /api/notes/:id/move`；成功逐篇 `applyMovedNote`，失敗（略過或停下）逐篇 `refetchAfterFailure`（順序契約見 `api/note-move.ts`）。 */
export async function moveNotesInOrder(
  notes: readonly NoteDto[],
  groupId: string,
  deps: { queryClient: QueryClient } & BatchHooks,
): Promise<BatchOutcome<NoteDto>> {
  const { queryClient } = deps;
  try {
    return await runSequential(
      notes,
      noteNode,
      async (note) => {
        const moved = await api<NoteDto>(`${notePath(note.id)}/move`, { method: "POST", body: JSON.stringify({ groupId }) });
        applyMovedNote(queryClient, note.id, moved);
        return moved;
      },
      {
        afterFailure: (note) => {
          void refetchAfterFailure(queryClient, note.id);
        },
        onProgress: deps.onProgress,
      },
    );
  } finally {
    void queryClient.invalidateQueries({ queryKey: ["groups"] });
  }
}

/** `POST /api/notes/:id/copy`（body 見 `destinationBody`：我的筆記 → `{}`）；`done` 收副本，逐篇寫進 `["note", copy.id]`。 */
export async function copyNotesInOrder(
  notes: readonly NoteDto[],
  dest: Destination,
  deps: { queryClient: QueryClient } & BatchHooks,
): Promise<BatchOutcome<NoteDto>> {
  const { queryClient } = deps;
  const body = JSON.stringify(destinationBody(dest));
  try {
    return await runSequential(
      notes,
      noteNode,
      async (note) => {
        const copy = await api<NoteDto>(`${notePath(note.id)}/copy`, { method: "POST", body });
        queryClient.setQueryData(["note", copy.id], copy);
        return copy;
      },
      { onProgress: deps.onProgress },
    );
  } finally {
    void queryClient.invalidateQueries({ queryKey: ["notes"] });
  }
}
