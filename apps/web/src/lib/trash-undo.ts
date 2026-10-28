import type { QueryClient } from "@tanstack/react-query";
import type { NavigateFunction } from "react-router";
import { canonicalNotePath, type NoteDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { invalidateTrashRelated, restoreTrashIds, seedRestoredNotes, TrashBatchError, trashErrorCause } from "@/api/trash";
import { toast } from "@/components/ui/toast";
import { canRestoreAfterTrash, trashResultMessage } from "@/lib/trash-display";

export type Translate = (key: string, options?: Record<string, unknown>) => string;

/** ApiFail → errors.<code>；其餘 → errors.fallback（各檔各自一份，是既有慣例）。 */
function errorMessage(t: Translate, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

/**
 * 「已移到垃圾桶」toast（spec §6.10.4／§6.10.7）。`reopen`＝原本開著那篇——復原成功後導回它的 canonical 路徑。
 * 復原鈕的 handler 只用參數捕捉的 queryClient／navigate 與 api/trash.ts 的純函式：toast 常在選單卸載後才被按（讀碼發現 5）。
 * 後四欄給 PR-2c 多選刪除用，不給＝單篇的行為。
 */
export function showTrashedToast(args: {
  notes: ReadonlyArray<Pick<NoteDto, "id" | "group" | "permissions">>;
  queryClient: QueryClient;
  navigate: NavigateFunction;
  t: Translate;
  reopen: boolean;
  /** 預設 `t("trash.moved")`。 */
  title?: string;
  /** 不可復原時與 `trash.movedNoUndoHint` 以「 」接在後面（description 在前）。 */
  description?: string;
  variant?: "default" | "destructive";
  /** 給了就覆蓋由 `reopen` 推算的那篇（`reopen` 只在單篇時推出它）。 */
  reopenId?: string | null;
}): void {
  const { notes, queryClient, navigate, t, reopen, description, variant } = args;
  const title = args.title ?? t("trash.moved");
  if (!notes.every(canRestoreAfterTrash)) {
    // 群組筆記只有刪除權、沒有編輯權：自己還原不了，只說明誰可以（spec §6.10.7）。
    const hint = t("trash.movedNoUndoHint");
    toast({ title, description: description === undefined ? hint : `${description} ${hint}`, variant });
    return;
  }
  const ids = notes.map((note) => note.id);
  const reopenId = args.reopenId !== undefined ? args.reopenId : reopen && ids.length === 1 ? ids[0] : null;
  toast({
    title,
    description,
    variant,
    action: {
      label: t("trash.undo"),
      onClick: () => void undoTrash({ ids, queryClient, navigate, t, reopenId }),
    },
  });
}

/** 復原：還原 `ids`、toast 結果；`reopenId` 在 restored 裡才導回它。seed 必須早於 navigate（讀碼發現 27）。 */
export async function undoTrash(args: {
  ids: readonly string[];
  queryClient: QueryClient;
  navigate: NavigateFunction;
  t: Translate;
  reopenId: string | null;
}): Promise<void> {
  const { ids, queryClient, navigate, t, reopenId } = args;
  try {
    const result = await restoreTrashIds(ids);
    seedRestoredNotes(queryClient, result.restored);
    toast({
      title: trashResultMessage("restore", result.restored.length, result.skipped.length, t),
      variant: result.restored.length === 0 ? "destructive" : "default",
    });
    const back = reopenId !== null ? result.restored.find((note) => note.id === reopenId) : undefined;
    if (back) void navigate(canonicalNotePath(back));
  } catch (err) {
    // 分批中途失敗（PR-2c 多選刪除一次復原整批才會走到）：已成功的那幾篇照樣蓋回常駐層。
    if (err instanceof TrashBatchError) seedRestoredNotes(queryClient, (err as TrashBatchError<{ restored: NoteDto[] }>).partial.restored);
    toast({ title: errorMessage(t, trashErrorCause(err)), variant: "destructive" });
  } finally {
    invalidateTrashRelated(queryClient, ids);
  }
}
