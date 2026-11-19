/**
 * #175: the two group-deletion transactions: `transferGroupInTx` (move notes to a built-in admin) and `deleteGroupWithNotesInTx`
 * (delete with notes). Roles and members go via FK CASCADE. Takes only `tx`, plain data and the test hook (no `Db`, no `deps`);
 * the delete-all gate (`beforeNoteDeleted`), post-commit file deletion and kicking connections happen in the route.
 *
 * Lock order (global: groups → structure locks → folder rows → note rows → quota lock):
 * - transfer: `lockGroup` (groups FOR UPDATE) → structure locks of the group and the recipient's personal space (by key) → group notes
 *   FOR UPDATE (**ascending id**, same as trash move/restore/permanent delete and `deleteNotesInTx`; #181) → the recipient's quota lock →
 *   INSERT the new top-level folder, `UPDATE folders`, re-home each note.
 *   Writing folders after the note locks is a deliberate deviation: a group folder's FOR UPDATE is only taken by folder deletion, which first needs
 *   groups KEY SHARE (blocked by `lockGroup`); structure writes in the recipient's space (create, rename, move, rebuild from path) first take the recipient's structure lock.
 * - delete-all: `lockGroup` → group structure lock → group notes FOR UPDATE (by id) → `deleteNotesInTx` → `DELETE groups` (group folders CASCADE);
 *   no quota lock.
 * Every transaction touching group-space folders takes groups KEY SHARE first, which conflicts with `lockGroup`; creates/moves/copies into the group
 * that arrive after the lock get 23503 on commit or find the group gone → 404.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { folders, groupMembers, groupRoles, groups, notes, uploads } from "../../db/schema.js";
import { normalizeFolderNameLoose } from "../../folders/names.js";
import { lockFolderSpacesInTx } from "../../folders/tx/lock.js";
import { createSystemTopFolderInTx } from "../../folders/tx/system-top.js";
import { TxAbort } from "../../http/tx-abort.js";
import { groupNotePath } from "../../notes/redirects.js";
import { deleteNotesInTx } from "../../notes/tx/delete-notes.js";
import { recordRedirectsInTx } from "../../notes/tx/redirects.js";
import { resetNoteVersionsInTx } from "../../notes/tx/versions.js";
import { writeSlugInTx } from "../../notes/tx/write-slug.js";
import { sumUploadSizeSql } from "../../storage/space.js";
import { assertSpaceRoomInTx } from "../../storage/tx/quota.js";
import { GROUP_NOT_FOUND_MESSAGE, NOT_ADMIN_MESSAGE, lockGroup } from "../queries.js";
import type { GroupTestHook } from "../test-hook.js";

export interface TransferGroupInput {
  groupId: string;
  /** Already passed `UUID_RE` and lowercased (the route does this before the transaction). */
  transferTo: string;
  /** User who triggered the deletion (`created_by` of the new top-level folder). */
  by: string;
  /** Name of the new top-level folder when the normalized group name is empty (the route picks it from `Accept-Language`). */
  fallbackFolderName: string;
  /** Wait limit (ms) for structure and space locks. */
  lockTimeoutMs: number;
}

export interface GroupDeletionResult {
  /** Notes locked and handled in the transaction by the group predicate (transfer: moved out; delete-all: deleted). */
  noteIds: string[];
  /** All members, read with `tx` **before** `DELETE groups` cascades. */
  memberIds: string[];
}

/**
 * Moves all group notes to `transferTo` as personal notes, then deletes the group. Steps:
 * - `lockGroup` (nonexistent → 404); `transferTo` must be a member with builtin='admin' (checked after the lock), else 409 `not_admin`
 * - read all members (before CASCADE); structure locks of the group and of `transferTo`'s personal space (before locking group notes)
 * - group notes FOR UPDATE (by id); processing order is then sorted in JS by created_at, id so the smaller `-N` suffix on a name clash is deterministic
 * - storage quota: attachment total → `transferTo`'s personal-space lock and check (before `writeSlugInTx`; if it doesn't fit → StorageQuotaExceeded, nothing written)
 * - version history: reset via `resetNoteVersionsInTx({ groupId })`, one pass by group predicate, before group_id changes
 * - folders: if the group has folders, or the trash holds root-level notes with a path snapshot → create a new top-level folder in `transferTo`'s
 *   personal root (group name, loosely normalized, with suffix); if the group has folders → **one** `UPDATE folders` re-homes the whole tree to
 *   `transferTo` and hangs the group's root folders under the new top level (the same-space trigger checks the whole tree at statement end)
 * - per note, `writeSlugInTx` (scope = `transferTo`'s personal space, base = old slug): the same UPDATE changes ownership, clears prev and handles the placement,
 *   and clears public_token/public_slug (like move.ts; the result is an unshared personal note; the publicLink limiter isn't charged);
 *   slug_is_custom and updated_at are untouched
 * - `recordRedirectsInTx`: writes `/g/<g>/<old slug>` for the current slug only
 * - `DELETE groups` (roles and members CASCADE; folders no longer belong to the group)
 */
export async function transferGroupInTx(tx: Tx, input: TransferGroupInput, hook?: GroupTestHook): Promise<GroupDeletionResult> {
  if (!(await lockGroup(tx, input.groupId))) throw new TxAbort(404, "not_found", GROUP_NOT_FOUND_MESSAGE);
  const [target] = await tx
    .select({ builtin: groupRoles.builtin })
    .from(groupMembers)
    .innerJoin(groupRoles, eq(groupRoles.id, groupMembers.roleId))
    .where(and(eq(groupMembers.groupId, input.groupId), eq(groupMembers.userId, input.transferTo)))
    .limit(1);
  if (target?.builtin !== "admin") throw new TxAbort(409, "not_admin", NOT_ADMIN_MESSAGE);
  await hook?.("group-delete-locked", { groupId: input.groupId });

  const members = await tx.select({ userId: groupMembers.userId }).from(groupMembers).where(eq(groupMembers.groupId, input.groupId));
  await lockFolderSpacesInTx(tx, [{ kind: "group", groupId: input.groupId }, { kind: "personal", ownerId: input.transferTo }], {
    lockTimeoutMs: input.lockTimeoutMs, ...(hook ? { hook } : {}), hookCtx: { groupId: input.groupId },
  });
  // Lock order is by id (see the header); the processing order is sorted separately in JS by created_at, id. created_at is taken as a microsecond integer (JS Date has only millisecond precision and would misorder within the same millisecond).
  const locked = await tx
    .select({
      id: notes.id,
      slug: notes.slug,
      createdUs: sql<string>`(extract(epoch from ${notes.createdAt}) * 1000000)::bigint`,
      folderId: notes.folderId,
      // "In the trash with a snapshot": a stale snapshot left on a live note (restored by older code during a rollback) doesn't count; such notes follow the normal root-level rule.
      trashedWithPath: sql<boolean>`${notes.trashFolderPath} is not null and ${notes.deletedAt} is not null`,
    })
    .from(notes)
    .where(eq(notes.groupId, input.groupId))
    .orderBy(asc(notes.id))
    .for("update");
  const rows = locked
    .map(r => ({ ...r, us: BigInt(r.createdUs) }))
    .sort((x, y) => (x.us < y.us ? -1 : x.us > y.us ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

  // Storage quota: all group notes are FOR UPDATE, so incoming = the sum of their attachments (including notes that joined the group after the gates opened).
  // The recipient's personal-space lock is taken **before** the first writeSlugInTx (pinned by `storage-quota-race.test.ts`). On rejection nothing is written.
  // SUM by group predicate (the rows are all locked, so it's the same set); not `inArray(…, ids)`: one bind parameter per note would exceed
  // the protocol limit (65535) for a big group and 500.
  const [sumRow] = await tx
    .select({ incoming: sumUploadSizeSql() })
    .from(uploads)
    .innerJoin(notes, eq(notes.id, uploads.noteId))
    .where(eq(notes.groupId, input.groupId));
  await assertSpaceRoomInTx(tx, { kind: "user", id: input.transferTo }, sumRow?.incoming ?? 0, {
    lockTimeoutMs: input.lockTimeoutMs, hook, hookCtx: { groupId: input.groupId },
  });

  // Version history: cleared by group predicate in one pass **before** group_id changes (rows are all FOR UPDATE; no ANY($ids)).
  await resetNoteVersionsInTx(tx, { groupId: input.groupId });

  // Create the new top level only if there are folders, or trashed notes that will be rebuilt from their path snapshot.
  const [anyFolder] = await tx.select({ id: folders.id }).from(folders).where(eq(folders.groupId, input.groupId)).limit(1);
  const groupHasFolders = anyFolder !== undefined;
  let top: { id: string; name: string } | null = null;
  if (groupHasFolders || rows.some(r => r.folderId === null && r.trashedWithPath)) {
    const [g] = await tx.select({ name: groups.name }).from(groups).where(eq(groups.id, input.groupId));
    const baseName = normalizeFolderNameLoose(g!.name, input.fallbackFolderName);
    top = await createSystemTopFolderInTx(tx, { ownerId: input.transferTo, baseName, by: input.by });
  }
  // One statement for the whole tree: the parent/child same-space trigger is AFTER ROW and checks at statement end; separate statements would see mixed spaces midway.
  if (top !== null && groupHasFolders) {
    await tx
      .update(folders)
      .set({ kind: "personal", ownerId: input.transferTo, groupId: null, parentId: sql`coalesce(${folders.parentId}, ${top.id}::uuid)` })
      .where(eq(folders.groupId, input.groupId));
  }

  for (const row of rows) {
    // Three kinds of rows: in a folder → keep (the folder already moved to the recipient's space); root-level without snapshot → new top level;
    // root-level with snapshot (original folder deleted) → folder_id stays NULL and the snapshot is prefixed with the name **actually written** for the new top level (suffix included), so restore rebuilds the original path under it.
    const place = row.folderId !== null || top === null
      ? {}
      : row.trashedWithPath
        ? { trashFolderPath: sql`jsonb_build_array(${top.name}::text) || ${notes.trashFolderPath}` }
        : { folderId: top.id };
    await writeSlugInTx(
      tx,
      { ownerId: input.transferTo },
      { base: row.slug },
      async slug => {
        await tx
          .update(notes)
          .set({ groupId: null, ownerId: input.transferTo, slug, prevSlug: null, publicToken: null, publicSlug: null, ...place })
          .where(eq(notes.id, row.id));
      },
      { excludeNoteId: row.id, beforeWrite: slug => hook?.("group-transfer-slug-candidate", { noteId: row.id, groupId: input.groupId, slug }) },
    );
    await recordRedirectsInTx(tx, [groupNotePath(input.groupId, row.slug)], row.id);
  }

  await tx.delete(groups).where(eq(groups.id, input.groupId));
  return { noteIds: rows.map(r => r.id), memberIds: members.map(m => m.userId) };
}

/**
 * Deletes the group together with its notes. **The route opens the gates (`beforeNoteDeleted`, which borrow connections) before the transaction**;
 * this function doesn't touch gates.
 * Steps: `lockGroup` (nonexistent → 404) → group structure lock (same position as in transfer) → L = group notes FOR UPDATE (by group predicate, not by the
 * gated list: notes that entered the group after the gates are in L too, an accepted cost) → read members (before CASCADE) → `deleteNotesInTx(L)`
 * (same as permanent delete / expiry purge; L includes trashed group notes) → `DELETE groups` (group folders CASCADE).
 * `deleteNotesInTx` also takes FOR UPDATE on L first (a re-lock in the same transaction, no wait; #188), so delete-all × upload is guarded by either lock and
 * removing the FOR UPDATE here would pass the current integration tests. It stays because "lock whatever the group predicate reaches" defines delete-all and
 * shouldn't depend on today's premise that no path can move a note out of a group without `lockGroup`.
 */
export async function deleteGroupWithNotesInTx(
  tx: Tx,
  input: { groupId: string; lockTimeoutMs: number },
  hook?: GroupTestHook,
): Promise<GroupDeletionResult & { uploadIds: string[] }> {
  if (!(await lockGroup(tx, input.groupId))) throw new TxAbort(404, "not_found", GROUP_NOT_FOUND_MESSAGE);
  await hook?.("group-delete-locked", { groupId: input.groupId });
  await lockFolderSpacesInTx(tx, [{ kind: "group", groupId: input.groupId }], {
    lockTimeoutMs: input.lockTimeoutMs, ...(hook ? { hook } : {}), hookCtx: { groupId: input.groupId },
  });
  const rows = await tx.select({ id: notes.id }).from(notes).where(eq(notes.groupId, input.groupId)).orderBy(asc(notes.id)).for("update");
  const members = await tx.select({ userId: groupMembers.userId }).from(groupMembers).where(eq(groupMembers.groupId, input.groupId));
  const noteIds = rows.map(r => r.id);
  const uploadIds = await deleteNotesInTx(tx, noteIds);
  await tx.delete(groups).where(eq(groups.id, input.groupId));
  return { noteIds, memberIds: members.map(m => m.userId), uploadIds };
}
