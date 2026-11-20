import type { TrashItemDto, TrashListDto } from "@knotebook/shared";
import { DAY_MS } from "@/lib/trash-display";

/** Matches the session fixture in each test file (used only to compare `deletedBy.handle`). */
export const TRASH_ME = { handle: "tester", displayName: "Tester" };

/**
 * Trash item (#181). purgeAt / deletedAt are derived from Date.now() at call time (no fake clock: react-query's waitFor clashes with fake clocks).
 * `daysLeft` defaults to 3 (an integer: now is slightly later at display time, so ceil of 3 days minus epsilon is always 3); `null` -> `purgeAt: null`. `deletedBy` defaults to `TRASH_ME`, `group` to null.
 */
export function trashItem(
  overrides: Partial<TrashItemDto> & { id: string; title: string },
  opts: { daysLeft?: number | null; deletedDaysAgo?: number } = {},
): TrashItemDto {
  const now = Date.now();
  const daysLeft = opts.daysLeft === undefined ? 3 : opts.daysLeft;
  return {
    deletedAt: new Date(now - (opts.deletedDaysAgo ?? 0) * DAY_MS).toISOString(),
    purgeAt: daysLeft === null ? null : new Date(now + daysLeft * DAY_MS).toISOString(),
    deletedBy: TRASH_ME,
    group: null,
    folderPath: [],
    ...overrides,
  };
}

export function trashList(items: TrashItemDto[], opts: { retentionDays?: number | null; truncated?: boolean } = {}): TrashListDto {
  return {
    retentionDays: opts.retentionDays === undefined ? 7 : opts.retentionDays,
    items,
    truncated: opts.truncated ?? false,
  };
}
