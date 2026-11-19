/**
 * #175: creates a group. One transaction creates the group, the two built-in roles (admin: all seven flags; member: read/create/edit,
 * the same flags as migration 0012) and attaches the creator as admin. Takes only `tx` and plain data.
 */
import type { Tx } from "../../db/tx.js";
import { groupMembers, groupRoles, groups } from "../../db/schema.js";

export async function createGroupInTx(tx: Tx, input: { name: string; userId: string }) {
  const [group] = await tx.insert(groups).values({ name: input.name, createdBy: input.userId }).returning();
  const [admin] = await tx
    .insert(groupRoles)
    .values({
      groupId: group!.id,
      builtin: "admin",
      canRead: true,
      canCreate: true,
      canEdit: true,
      canDelete: true,
      canManagePublicLink: true,
      canManageMembers: true,
      canManageGroup: true,
    })
    .returning();
  await tx.insert(groupRoles).values({ groupId: group!.id, builtin: "member", canRead: true, canCreate: true, canEdit: true });
  await tx.insert(groupMembers).values({ groupId: group!.id, userId: input.userId, roleId: admin!.id });
  return { group: group!, adminRole: admin! };
}
