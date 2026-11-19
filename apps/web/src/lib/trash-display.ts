import type { NoteDto, TrashItemDto } from "@knotebook/shared";
import { noteLocationSegments } from "@/components/sidebar/tree";
import { selectionKey } from "@/lib/sidebar-selection";

type Translate = (key: string, options?: Record<string, unknown>) => string;

export const DAY_MS = 86_400_000;

/** Rounds up and never shows under 1 day: just trashed = full retention; under a day or past purgeAt awaiting the next purge = 1 day. null purgeAt = never auto-deleted. */
export function remainingLabel(purgeAt: string | null, now: number, t: Translate): string | null {
  if (purgeAt === null) return null;
  return t("trash.daysLeft", { count: Math.max(1, Math.ceil((Date.parse(purgeAt) - now) / DAY_MS)) });
}

/** One `Intl.DateTimeFormat` per locale per format (building one per row costs about 70 ms per 1000 rows). */
const DATE_FORMATS = { date: {}, dateTime: { dateStyle: "short", timeStyle: "short" } } as const;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatDate(iso: string, kind: keyof typeof DATE_FORMATS, locale: string): string {
  const key = `${kind}|${locale}`;
  let formatter = formatters.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(locale, DATE_FORMATS[kind]);
    formatters.set(key, formatter);
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? String(date) : formatter.format(date);
}

export function trashDetailLine(item: TrashItemDto, ctx: { now: number; t: Translate; locale: string }): string {
  const { now, t, locale } = ctx;
  const remaining = remainingLabel(item.purgeAt, now, t);
  const date = () => formatDate(item.deletedAt, "date", locale);
  const location = trashLocationLine(item);
  const segments = location === "" ? [] : [location];
  if (item.group === null) return [...segments, remaining ?? t("trash.deletedOn", { date: date() })].join(" · ");
  const deletedBy = t("trash.deletedByName", { name: item.deletedBy?.displayName ?? t("trash.unknownUser") });
  // "X deleted" already appears before; with NULL retention only the date is shown, without repeating "deleted".
  return [...segments, deletedBy, remaining ?? date()].join(" · ");
}

/** Personal root level = empty string (callers pass `|| undefined` so no title is set). */
export function trashLocationLine(item: TrashItemDto): string {
  return noteLocationSegments(item, item.folderPath).join(" › ");
}

export function trashItemTitle(item: TrashItemDto, ctx: { t: Translate; locale: string }): string {
  const fmt = (iso: string) => formatDate(iso, "dateTime", ctx.locale);
  return item.purgeAt !== null
    ? ctx.t("trash.titleTimes", { deletedAt: fmt(item.deletedAt), purgeAt: fmt(item.purgeAt) })
    : ctx.t("trash.titleTimesNoPurge", { deletedAt: fmt(item.deletedAt) });
}

export interface TrashSections {
  personal: TrashItemDto[];
  workspace: TrashItemDto[];
  order: string[];
}

export function splitTrashSections(items: readonly TrashItemDto[]): TrashSections {
  const personal = items.filter((item) => item.group === null);
  const workspace = items.filter((item) => item.group !== null);
  const order = [...personal, ...workspace].map((item) => selectionKey({ kind: "note", id: item.id }));
  return { personal, workspace, order };
}

/** Counts only keys still in the list (those that vanished after a refetch are not sent). */
export function selectedTrashIds(items: readonly TrashItemDto[], keys: ReadonlySet<string>): string[] {
  const { personal, workspace } = splitTrashSections(items);
  return [...personal, ...workspace].filter((item) => keys.has(selectionKey({ kind: "note", id: item.id }))).map((item) => item.id);
}

export function canRestoreAfterTrash(note: Pick<NoteDto, "group" | "permissions">): boolean {
  if (note.group === null) return true;
  return note.permissions.edit && note.permissions.delete;
}

export function trashResultMessage(kind: "restore" | "purge", done: number, skipped: number, t: Translate): string {
  const head = t(kind === "restore" ? "trash.restored" : "trash.purged", { count: done });
  return skipped > 0 ? head + t("trash.skippedSuffix", { count: skipped }) : head;
}
