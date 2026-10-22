import type { NoteDto, TrashItemDto } from "@knotebook/shared";
import { noteLocationSegments } from "@/components/sidebar/tree";
import { selectionKey } from "@/lib/sidebar-selection";

/** #181 垃圾桶列的顯示純函式（spec 2026-10-21 §6.10.1、§6.10.3、§6.10.7）。 */

type Translate = (key: string, options?: Record<string, unknown>) => string;

export const DAY_MS = 86_400_000;

/**
 * 「剩 N 天」：N＝max(1, ⌈(purgeAt − now)／1 天⌉)（總管裁定 2026-10-22：沒有「不到 1 天」）——剛移入（保留 7 天）是「剩 7 天」，
 * 與底部說明一致；不到一天、或已過 purgeAt 等下一輪清理，都是「剩 1 天」。null＝保留天數為 NULL（不自動刪）。
 */
export function remainingLabel(purgeAt: string | null, now: number, t: Translate): string | null {
  if (purgeAt === null) return null;
  return t("trash.daysLeft", { count: Math.max(1, Math.ceil((Date.parse(purgeAt) - now) / DAY_MS)) });
}

/** 列的第二行：個人「剩 N 天」；工作坊「群組名 · X 刪除 · 剩 N 天」。保留天數 NULL 時時間段改成刪除日期。 */
export function trashDetailLine(item: TrashItemDto, ctx: { now: number; t: Translate; locale: string }): string {
  const { now, t, locale } = ctx;
  const remaining = remainingLabel(item.purgeAt, now, t);
  const date = new Date(item.deletedAt).toLocaleDateString(locale);
  const segments = noteLocationSegments(item);
  if (item.group === null) return [...segments, remaining ?? t("trash.deletedOn", { date })].join(" · ");
  const deletedBy = t("trash.deletedByName", { name: item.deletedBy?.displayName ?? t("trash.unknownUser") });
  // 前面已有「X 刪除」，NULL 保留天數時只放日期、不重複「刪除」
  return [...segments, deletedBy, remaining ?? date].join(" · ");
}

/** 列的 `title`：移入時間與預計永久刪除時間。 */
export function trashItemTitle(item: TrashItemDto, ctx: { t: Translate; locale: string }): string {
  const fmt = (iso: string) => new Date(iso).toLocaleString(ctx.locale, { dateStyle: "short", timeStyle: "short" });
  return item.purgeAt !== null
    ? ctx.t("trash.titleTimes", { deletedAt: fmt(item.deletedAt), purgeAt: fmt(item.purgeAt) })
    : ctx.t("trash.titleTimesNoPurge", { deletedAt: fmt(item.deletedAt) });
}

export interface TrashSections {
  personal: TrashItemDto[];
  workspace: TrashItemDto[];
  /** 選取鍵，個人在前（Shift 範圍跨兩區連續計）。 */
  order: string[];
}

/** 保留輸入順序（server 已 `deleted_at DESC, id DESC`）。 */
export function splitTrashSections(items: readonly TrashItemDto[]): TrashSections {
  const personal = items.filter((item) => item.group === null);
  const workspace = items.filter((item) => item.group !== null);
  const order = [...personal, ...workspace].map((item) => selectionKey({ kind: "note", id: item.id }));
  return { personal, workspace, order };
}

/** spec §6.10.7：個人筆記恆可；群組筆記要 edit 且 delete。 */
export function canRestoreAfterTrash(note: Pick<NoteDto, "group" | "permissions">): boolean {
  if (note.group === null) return true;
  return note.permissions.edit && note.permissions.delete;
}

export function trashResultMessage(kind: "restore" | "purge", done: number, skipped: number, t: Translate): string {
  const head = t(kind === "restore" ? "trash.restored" : "trash.purged", { count: done });
  return skipped > 0 ? head + t("trash.skippedSuffix", { count: skipped }) : head;
}
