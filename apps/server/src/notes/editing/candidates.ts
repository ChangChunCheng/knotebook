import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { UUID_RE, type SiteLinkCandidate, type WikilinkTarget } from "@knotebook/shared";
import type { Db } from "../../db/index.js";
import { groupMembers, groupRoles, noteShares, notes, users } from "../../db/schema.js";

export type VisibleNoteTarget = SiteLinkCandidate;

/**
 * The three branches (owned, shared, grouped with `can_read`) are mutually exclusive: group notes have `owner_id` NULL and shared requires `group_id IS NULL` (leftover share rows on group notes don't count), so the id dedup is purely defensive. All three exclude trashed notes. With `ids`, each branch is restricted to them; an empty set (or all non-uuid) issues no query. `ownerHandle` is NULL for group notes. Doesn't reuse `visibleNoteBranches`: different column set, and that one is on the wikilink rebind path.
 */
export async function visibleNoteTargets(db: Db, userId: string, ids?: readonly string[]): Promise<VisibleNoteTarget[]> {
  const only = ids === undefined ? undefined : ids.filter(id => UUID_RE.test(id)).map(id => id.toLowerCase());
  if (only !== undefined && only.length === 0) return [];
  const idCond = only === undefined ? undefined : inArray(notes.id, only);
  const cols = { id: notes.id, title: notes.title, slug: notes.slug, groupId: notes.groupId, ownerHandle: users.handle };
  const owned = await db.select(cols).from(notes).leftJoin(users, eq(users.id, notes.ownerId)).where(and(eq(notes.ownerId, userId), isNull(notes.deletedAt), idCond));
  const shared = await db.select(cols).from(notes).leftJoin(users, eq(users.id, notes.ownerId))
    .innerJoin(noteShares, and(eq(noteShares.noteId, notes.id), eq(noteShares.userId, userId)))
    .where(and(ne(notes.ownerId, userId), isNull(notes.groupId), isNull(notes.deletedAt), idCond));
  const grouped = await db.select(cols).from(notes).leftJoin(users, eq(users.id, notes.ownerId))
    .innerJoin(groupMembers, and(eq(groupMembers.groupId, notes.groupId), eq(groupMembers.userId, userId)))
    .innerJoin(groupRoles, and(eq(groupRoles.id, groupMembers.roleId), eq(groupRoles.canRead, true)))
    .where(and(isNull(notes.deletedAt), idCond));
  const byId = new Map<string, VisibleNoteTarget>();
  for (const t of [...owned, ...shared, ...grouped]) if (!byId.has(t.id)) byId.set(t.id, t);
  return [...byId.values()];
}

export async function visibleNoteTitles(db: Db, userId: string): Promise<WikilinkTarget[]> {
  return (await visibleNoteTargets(db, userId)).map(({ id, title }) => ({ id, title }));
}

export async function visibleTitlesByIds(db: Db, userId: string, ids: readonly string[]): Promise<WikilinkTarget[]> {
  return (await visibleNoteTargets(db, userId, ids)).map(({ id, title }) => ({ id, title }));
}
