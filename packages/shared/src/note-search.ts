import type { NoteDto } from "./note-dto.js";

/** Query length in UTF-16 code units after trim (what zod `.max` counts); web uses these to decide when to send. */
export const SEARCH_QUERY_MAX = 200;
export const SEARCH_LIMIT_DEFAULT = 20;
export const SEARCH_LIMIT_MAX = 50;

/** `sectionId` becomes the `#b-<sectionId>` anchor (except `_top`). */
export interface NoteSearchMatchDto {
  sectionId: string;
  heading: string;
  snippet: string;
}

export interface NoteSearchHitDto {
  note: NoteDto;
  matchedOn: "title" | "body" | "both";
  matches: NoteSearchMatchDto[];
}

export interface NoteSearchResultDto {
  hits: NoteSearchHitDto[];
  nextCursor: string | null;
}

export interface BacklinkDto {
  id: string;
  title: string;
  slug: string;
  ownerHandle: string | null;
  groupId: string | null;
}
