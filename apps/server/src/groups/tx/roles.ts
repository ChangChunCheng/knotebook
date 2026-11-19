/**
 * `lockGroup` must stay the first step: `notes/tx/move.ts` reads membership and role flags holding only `FOR KEY SHARE` on the groups row, which is safe
 * only if every write that changes existing membership or the flags of a role someone may hold takes `lockGroup` first. It also serializes role delete
 * against attaching a member, avoiding 23503 on `group_members_role_fk`. `POST …/roles` adds a role nobody holds yet and doesn't lock. A future path that
 * deletes `users` (`group_members.user_id` CASCADEs) must `lockGroup` each of the user's groups first. Attaching a role requires `lockGroup` via `addMemberInTx`/`setMemberRoleInTx`.
 * Serialization: the later transaction sees the result (role gone → 404 `role_not_found`; member already attached → moved to the built-in member role).
 * Guard: the "groups FOR KEY SHARE" case in `test/groups-v2-roles-race.test.ts` (with another transaction holding KEY SHARE, update and delete must block).
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

export interface RoleKick {
  noteIds: string[];
  userIds: string[];
}

/** Built-in member: flags only (renaming → 409); built-in admin: always 409. `name`/`permissions` are validated by the route first. Kick list only if `read` or `edit` changed; the other flags only affect REST authorization. */
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

/** Holders move to the built-in member role first: FK `group_members_role_fk` is NO ACTION, so the reverse order gives 23503. Built-in roles → 409 (each group has exactly two). Returns (all group notes, previous holders), both empty if nobody held it. */
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
