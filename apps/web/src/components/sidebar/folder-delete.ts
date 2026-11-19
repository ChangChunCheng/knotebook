import "@/i18n/folder-strings";
import type { FolderDto, NoteDto } from "@knotebook/shared";
import { liveNotesUnder, subtreeFolderIds, type FolderIndex, type FolderSpaceKey } from "./folder-index";

/** Pure functions; import only through the FolderLazy chain and tests. Counts come from the cache (client-side; the server is authoritative). */

type Translate = (key: string, options?: Record<string, unknown>) => string;

export interface FolderDeleteFacts {
  /** Subfolders, not counting the folder itself. */
  subfolders: number;
  liveNotes: NoteDto[];
  shared: boolean;
  containsOpen: boolean;
}

export function folderDeleteFacts(
  index: FolderIndex,
  folder: FolderDto,
  notes: readonly NoteDto[],
  openNoteId: string | null,
  spaceOf: (note: NoteDto) => FolderSpaceKey,
): FolderDeleteFacts {
  const liveNotes = liveNotesUnder(index, folder.id, notes, spaceOf);
  return {
    subfolders: subtreeFolderIds(index, folder.id).length - 1,
    liveNotes,
    shared: folder.space.kind === "shared",
    containsOpen: openNoteId !== null && liveNotes.some((note) => note.id === openNoteId),
  };
}

function joinParts(parts: readonly string[]): string {
  return parts.reduce((acc, part) => (acc === "" ? part : /[，。]$/u.test(acc) ? acc + part : `${acc} ${part}`), "");
}

/** `retentionDays`: null = never purged automatically, undefined = not loaded yet (generic sentence). Split into segments, each with its own `count`: three inflected quantities in one sentence. */
export function folderDeleteBody(facts: FolderDeleteFacts, retentionDays: number | null | undefined, t: Translate): string {
  const count = facts.liveNotes.length;
  if (facts.shared) return count > 0 ? t("folderDialogs.removeBody", { count }) : t("folderDialogs.removeBodyEmpty");
  if (count === 0) return facts.subfolders > 0 ? t("folderDialogs.emptyWithSub", { count: facts.subfolders }) : t("folderDialogs.empty");
  const purge =
    retentionDays === undefined
      ? t("folderDialogs.purgeUnknown")
      : retentionDays === null
        ? t("folderDialogs.purgeNever")
        : t("folderDialogs.purgeDays", { count: retentionDays });
  return joinParts([
    facts.subfolders > 0 ? t("folderDialogs.subfoldersPart", { count: facts.subfolders }) : t("folderDialogs.noSubfoldersPart"),
    t("folderDialogs.notesPart", { count }),
    purge,
    t("folderDialogs.restoreRebuilds"),
  ]);
}
