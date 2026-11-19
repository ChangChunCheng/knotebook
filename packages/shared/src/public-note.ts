/** `path` is always the alias form; the token form never appears. */
export interface PublicLinkDto {
  id: string;
  title: string;
  path: string;
}

/** Narrow to wide; must match DB `notes_public_width_chk` (note-width-check-sync.test.ts). */
export const NOTE_WIDTHS = ["standard", "wide", "full"] as const;
export type NoteWidth = (typeof NOTE_WIDTHS)[number];

/** Deliberately omits the note's id, token and updatedAt. */
export interface PublicNoteDto {
  title: string;
  ydoc: string;
  links: PublicLinkDto[];
  /** Optional for older servers; web treats absent as "standard". */
  width?: NoteWidth;
}
