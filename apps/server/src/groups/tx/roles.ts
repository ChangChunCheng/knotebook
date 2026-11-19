/**
 * #175: custom-role update and delete. Both start with `lockGroup`: the same groups row lock as group deletion and member changes, so deleting a role
 * and attaching someone to it are serialized and the later one sees the earlier result (role gone → 404 `role_not_found`; the member already attached →
 * moved to the built-in member role), never a 23503 on `group_members_role_fk`. Takes only `tx`, plain data and the test hook. Business rejections throw `TxAbort`.
 *
 * ⚠ Cross-file premise (`notes/tx/move.ts`): the move path reads membership and role flags holding only `FOR KEY SHARE` on the groups row.
 * That is correct only if every write that changes **existing membership** or the flags of **a role someone may already hold** first takes `lockGroup`
 * (groups `FOR UPDATE`, which conflicts with KEY SHARE; group deletion, member changes, role update/delete). `POST …/roles` only adds a role nobody holds yet
 * (attaching it goes through `lockGroup` in `addMemberInTx`/`setMemberRoleInTx`), changes nobody's effective permissions, and so doesn't lock.
 * If a path that deletes `users` is ever added (`group_members.user_id` is ON DELETE CASCADE), it must first `lockGroup` every group the user belongs to.
 * So `lockGroup` must stay the first step here; don't drop it to save a round trip or move it after reads. Guard: the "groups FOR KEY SHARE" case in
 * `test/groups-v2-roles-race.test.ts` (with another transaction holding KEY SHARE, `updateRoleInTx` and `deleteRoleInTx` must block).
 */
import { and, eq } from "drizzle-orm";
import type { GroupRoleDto, GroupRoleFlags } from "@knotebook/shared";
import type { Tx } from "../../db/tx.js";
import { groupMembers, groupRoles } from "../../db/schema.js";
import { TxAbort } from "../../http/tx-abort.js";
import {
  GROUP_NOT_FOUND_MESSAGE, builtinRoleId, groupNoteIdsQuery, lockGroup, roleByIdQuery, roleFlagValues, roleHolderIdsQuery,
  toGroupRoleDto,
} from "../queries.js";
import type { GroupTestHook } from "../test-hook.js";

const notFound = (): TxAbort => new TxAbort(404, "not_found", GROUP_NOT_FOUND_MESSAGE);
const roleNotFound = (): TxAbort => new TxAbort(404, "role_not_found", "No role with that id.");

/** Kick list after commit: all group notes × affected members. */
export interface RoleKick {
  noteIds: string[];
  userIds: string[];
}

/**
 * Updates a custom role's name and flags; the built-in member role may only change flags; the built-in admin always → 409. `name` is already normalized and
 * `permissions` already shape-checked (the route validates first). **Returns a kick list only if `read` or `edit` changed** (the other five flags only
 * affect REST authorization; unchanged values kick nobody).
 */
export async function updateRoleInTx(
  tx: Tx,
  input: { groupId: string; roleId: string; name: string | undefined; permissions: GroupRoleFlags | undefined },
  hook?: GroupTestHook,
): Promise<{ role: GroupRoleDto; kick: RoleKick | null }> {
  if (!(await lockGroup(tx, input.groupId))) throw notFound();
  const [before] = await roleByIdQuery(tx, input.groupId, input.roleId);
  if (!before) throw roleNotFound();
  if (before.builtin === "admin") throw new TxAbort(409, "builtin_role", "The built-in Admin role can't be changed.");
  if (before.builtin === "member" && input.name !== undefined) throw new TxAbort(409, "builtin_role", "The built-in Member role can't be renamed.");
  await hook?.("group-roles-checked", { groupId: input.groupId });
  await tx
    .update(groupRoles)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.permissions !== undefined ? roleFlagValues(input.permissions) : {}),
    })
    .where(and(eq(groupRoles.groupId, input.groupId), eq(groupRoles.id, input.roleId)));
  const [after] = await roleByIdQuery(tx, input.groupId, input.roleId);
  const readOrEditChanged = after!.canRead !== before.canRead || after!.canEdit !== before.canEdit;
  const kick = readOrEditChanged
    ? {
        noteIds: (await groupNoteIdsQuery(tx, input.groupId)).map(r => r.id),
        userIds: (await roleHolderIdsQuery(tx, input.groupId, input.roleId)).map(r => r.userId),
      }
    : null;
  return { role: toGroupRoleDto(after!)!, kick };
}

/**
 * Deletes a custom role. Members holding it are re-attached to the **built-in member** role in the same transaction before the role is deleted
 * (FK `group_members_role_fk` is NO ACTION; the reverse order gives 23503). Built-in roles → 409 (every group has exactly two).
 * Returns (all group notes, former holders); both empty if nobody held it.
 */
export async function deleteRoleInTx(
  tx: Tx,
  input: { groupId: string; roleId: string },
  hook?: GroupTestHook,
): Promise<RoleKick> {
  if (!(await lockGroup(tx, input.groupId))) throw notFound();
  const [role] = await roleByIdQuery(tx, input.groupId, input.roleId);
  if (!role) throw roleNotFound();
  if (role.builtin !== null) throw new TxAbort(409, "builtin_role", "Built-in roles can't be deleted.");
  await hook?.("group-roles-checked", { groupId: input.groupId });
  const memberRoleId = await builtinRoleId(tx, input.groupId, "member");
  const moved = await tx
    .update(groupMembers)
    .set({ roleId: memberRoleId })
    .where(and(eq(groupMembers.groupId, input.groupId), eq(groupMembers.roleId, input.roleId)))
    .returning({ userId: groupMembers.userId });
  await tx.delete(groupRoles).where(and(eq(groupRoles.groupId, input.groupId), eq(groupRoles.id, input.roleId)));
  if (moved.length === 0) return { noteIds: [], userIds: [] };
  return { noteIds: (await groupNoteIdsQuery(tx, input.groupId)).map(r => r.id), userIds: moved.map(m => m.userId) };
}
