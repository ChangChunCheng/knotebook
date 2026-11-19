/** The member role's flags match migration 0012. */
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
