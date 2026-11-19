import { and, eq } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { groupMembers, groupRoles, users } from "../../db/schema.js";
import { TxAbort } from "../../http/tx-abort.js";
import { GROUP_NOT_FOUND_MESSAGE, builtinRoleId, countAdmins, groupNoteIdsQuery, lockGroup, roleInGroup } from "../queries.js";
import type { GroupTestHook } from "../test-hook.js";

const notFound = (): TxAbort => new TxAbort(404, "not_found", GROUP_NOT_FOUND_MESSAGE);
const roleNotFound = (): TxAbort => new TxAbort(404, "role_not_found", "No role with that id.");
const lastAdmin = (): TxAbort => new TxAbort(409, "last_admin", "The group needs at least one admin.");

export async function addMemberInTx(
  tx: Tx,
  input: { groupId: string; targetUserId: string; roleId: string | null },
  hook?: GroupTestHook,
): Promise<{ roleId: string; builtin: string | null }> {
  if (!(await lockGroup(tx, input.groupId))) throw notFound();
  const role =
    input.roleId === null
      ? { id: await builtinRoleId(tx, input.groupId, "member"), builtin: "member" }
      : await roleInGroup(tx, input.groupId, input.roleId);
  if (!role) throw roleNotFound();
  await hook?.("group-members-checked", { groupId: input.groupId });
  const inserted = await tx
    .insert(groupMembers)
    .values({ groupId: input.groupId, userId: input.targetUserId, roleId: role.id })
    .onConflictDoNothing()
    .returning({ userId: groupMembers.userId });
  if (inserted.length === 0) throw new TxAbort(409, "already_member", "That user is already a member of this group.");
  return { roleId: role.id, builtin: role.builtin };
}

/** No privilege-escalation guard by design (granting/revoking built-in admin, including oneself); the only hard limit is the last built-in admin. */
export async function setMemberRoleInTx(
  tx: Tx,
  input: { groupId: string; targetUserId: string; roleId: string },
  hook?: GroupTestHook,
): Promise<{ member: { email: string; displayName: string; roleId: string; builtin: string | null }; noteIds: string[] | null }> {
  if (!(await lockGroup(tx, input.groupId))) throw notFound();
  const next = await roleInGroup(tx, input.groupId, input.roleId);
  if (!next) throw roleNotFound();
  const [current] = await tx
    .select({ roleId: groupMembers.roleId, builtin: groupRoles.builtin, email: users.email, displayName: users.displayName })
    .from(groupMembers)
    .innerJoin(groupRoles, eq(groupRoles.id, groupMembers.roleId))
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(and(eq(groupMembers.groupId, input.groupId), eq(groupMembers.userId, input.targetUserId)));
  if (!current) throw notFound();
  const member = { email: current.email, displayName: current.displayName, roleId: next.id, builtin: next.builtin };
  // noteIds: null = role unchanged, nobody is kicked.
  if (current.roleId === next.id) return { member, noteIds: null };
  if (current.builtin === "admin" && next.builtin !== "admin" && (await countAdmins(tx, input.groupId)) <= 1) throw lastAdmin();
  await hook?.("group-members-checked", { groupId: input.groupId });
  await tx
    .update(groupMembers)
    .set({ roleId: next.id })
    .where(and(eq(groupMembers.groupId, input.groupId), eq(groupMembers.userId, input.targetUserId)));
  return { member, noteIds: (await groupNoteIdsQuery(tx, input.groupId)).map(r => r.id) };
}

export async function removeMemberInTx(
  tx: Tx,
  input: { groupId: string; targetUserId: string },
  hook?: GroupTestHook,
): Promise<string[]> {
  if (!(await lockGroup(tx, input.groupId))) throw notFound();
  const [row] = await tx
    .select({ builtin: groupRoles.builtin })
    .from(groupMembers)
    .innerJoin(groupRoles, eq(groupRoles.id, groupMembers.roleId))
    .where(and(eq(groupMembers.groupId, input.groupId), eq(groupMembers.userId, input.targetUserId)));
  if (!row) throw notFound();
  if (row.builtin === "admin" && (await countAdmins(tx, input.groupId)) <= 1) throw lastAdmin();
  await hook?.("group-members-checked", { groupId: input.groupId });
  await tx.delete(groupMembers).where(and(eq(groupMembers.groupId, input.groupId), eq(groupMembers.userId, input.targetUserId)));
  return (await groupNoteIdsQuery(tx, input.groupId)).map(r => r.id);
}
