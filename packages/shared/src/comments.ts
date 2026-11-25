import type { AvatarRef } from "./avatar.js";

/** Code points, on the body as written (mentions included). Must equal the CHECK on note_comments.body. */
export const COMMENT_BODY_MAX = 4000;
/** Code points, including the "…" added when a selection is cut. Must equal the CHECK on note_comments.anchor_quote. */
export const COMMENT_QUOTE_MAX = 200;
/** Distinct mention targets per comment; the parser still returns every candidate, the cap applies at resolution. */
export const COMMENT_MENTIONS_MAX = 20;

export interface MentionSpan {
  /** Code-point offset of the `@` in the body. */
  start: number;
  /** Code points, `@` included. */
  length: number;
  /** Lowercased. */
  handle: string;
  /** As written; null when there is no `/label`. */
  label: string | null;
}

const isAsciiAlnum = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isHandleChar = (c: number): boolean => isAsciiAlnum(c) || c === 45;
const isLabelChar = (c: number): boolean => isAsciiAlnum(c) || c === 45 || c === 46 || c === 95;

/**
 * Candidates only: whether a handle or label exists is decided at write time. For `@alice/xyz` the span covers the label;
 * the resolver shortens it to `@alice` when `xyz` doesn't resolve.
 */
export function parseMentionSpans(body: string): MentionSpan[] {
  const cps = [...body].map(ch => ch.codePointAt(0)!);
  const out: MentionSpan[] = [];
  let i = 0;
  while (i < cps.length) {
    // `@` binds only at the start or after a char outside ASCII [A-Za-z0-9._-]: `a@b.com` is not a mention, `請@bob看` is.
    if (cps[i] !== 64 || (i > 0 && isLabelChar(cps[i - 1]!))) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < cps.length && isHandleChar(cps[j]!)) j++;
    // No handle is longer than 32, so a longer run names nobody (and must not mention whoever owns its prefix).
    if (j - (i + 1) > 32) {
      i = j;
      continue;
    }
    const runEnd = j;
    while (j > i + 1 && cps[j - 1] === 45) j--;
    if (j === i + 1) {
      i++;
      continue;
    }
    const handle = String.fromCodePoint(...cps.slice(i + 1, j)).toLowerCase();
    let end = j;
    let label: string | null = null;
    // A stripped trailing `-` ends the mention there, so `/label` only follows an unstripped handle.
    if (j === runEnd && cps[j] === 47) {
      let k = j + 1;
      while (k < cps.length && isLabelChar(cps[k]!)) k++;
      // A label over 32 resolves to nothing: the mention falls back to the bare handle, as for an unknown label.
      if (k > j + 1 && k - (j + 1) <= 32) {
        label = String.fromCodePoint(...cps.slice(j + 1, k));
        end = k;
      }
    }
    out.push({ start: i, length: end - i, handle, label });
    i = end;
  }
  return out;
}

export interface CommentMentionDto {
  start: number;
  length: number;
  userId: string;
  handle: string;
  displayName: string;
  avatar: AvatarRef | null;
  agentLabel: string | null;
}

export interface CommentAnchorDto {
  blockId: string;
  /** Null when the anchor has a block but no quote. */
  quote: string | null;
}

export interface CommentDto {
  id: string;
  noteId: string;
  authorId: string;
  authorHandle: string;
  authorDisplayName: string;
  authorAvatar: AvatarRef | null;
  /** Snapshot at write time; null for a person's own comment. */
  agentLabel: string | null;
  replyToId: string | null;
  /** Null when the comment doesn't answer another, or the one it answered was deleted (see `replyToId`). */
  replyTo: { id: string; authorHandle: string; excerpt: string } | null;
  anchor: CommentAnchorDto | null;
  body: string;
  mentions: CommentMentionDto[];
  createdAt: string;
  editedAt: string | null;
  canEdit: boolean;
  canDelete: boolean;
}

export interface CommentListDto {
  comments: CommentDto[];
  /** Cursors for the next older / newer page; null when that end is reached. */
  olderCursor: string | null;
  newerCursor: string | null;
}

export interface NotificationDto {
  id: string;
  kind: "mention" | "reply";
  /** Null = addressed to the person; set = to that person's agent with this label. */
  agentLabel: string | null;
  actor: { userId: string; handle: string; displayName: string; avatar: AvatarRef | null; agentLabel: string | null };
  createdAt: string;
  /** False when the caller can no longer read the note: then `noteId`, `noteTitle`, `commentId` and `excerpt` are null too. */
  canOpen: boolean;
  noteId: string | null;
  noteTitle: string | null;
  commentId: string | null;
  excerpt: string | null;
  isNew: boolean;
}

export interface NotificationListDto {
  notifications: NotificationDto[];
  nextCursor: string | null;
}

export interface NotificationSettingsDto {
  /** Null = never delete. */
  retentionDays: number | null;
}
