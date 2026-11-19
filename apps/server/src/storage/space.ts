import { eq, sql, type SQL } from "drizzle-orm";
import { notes, uploads, userAvatars } from "../db/schema.js";

export type StorageSpace = { kind: "user"; id: string } | { kind: "group"; id: string };

export const STORAGE_QUOTA_EXCEEDED_MESSAGE = "This space's storage quota is full.";

export function spaceOfNote(n: { ownerId: string | null; groupId: string | null }): StorageSpace {
  if (n.groupId !== null) return { kind: "group", id: n.groupId };
  if (n.ownerId !== null) return { kind: "user", id: n.ownerId };
  throw new Error("spaceOfNote: owner_id 與 group_id 皆為 NULL（違反 notes_owner_xor_group_chk）");
}

export function spaceLockKey(space: StorageSpace): string {
  return `knotebook.storage:${space.kind}:${space.id.toLowerCase()}`;
}

/** `mapWith(Number)`: node-postgres returns int8 as a string. Built per call (drizzle fragments can't be reused). */
export function sumUploadSizeSql(): SQL<number> {
  return sql<number>`coalesce(sum(${uploads.size}), 0)::bigint`.mapWith(Number);
}

/** Personal space only: a group space's usage excludes avatars. */
export function sumAvatarBytesSql(userId: string): SQL<number> {
  return sql<number>`(select coalesce(sum(${userAvatars.originalSize} + ${userAvatars.displaySize}), 0)::bigint from ${userAvatars} where ${userAvatars.userId} = ${userId})`.mapWith(Number);
}

export function spaceNotesWhere(space: StorageSpace): SQL {
  return space.kind === "user" ? eq(notes.ownerId, space.id) : eq(notes.groupId, space.id);
}
