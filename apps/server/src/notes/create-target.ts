// Single implementation of the membership + create-flag check (#175). Runs outside the transaction: copy rechecks inside it (`notes/tx/copy.ts`), so for copy this is only a fast 404 and the DTO must come from the in-transaction read. Returns undefined when the group doesn't exist or the caller isn't a member (callers answer the same 404 / `group_not_found`). `POST /api/notes {groupId}` and MCP `create_note` rely on this check alone: a create flag revoked between the check and the insert isn't caught; only copy rechecks inside its transaction.
// Not under `tx/` and writes nothing: `notes-slug.test.ts` requires no `.insert(notes)` here.
import { and, eq } from "drizzle-orm";
import type { DbOrTx } from "../db/tx.js";
import { groupMembers, groupRoles, groups } from "../db/schema.js";

export interface CreateTarget {
  name: string;
  canRead: boolean;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canManagePublicLink: boolean;
}

export async function loadCreateTarget(db: DbOrTx, userId: string, groupId: string): Promise<CreateTarget | undefined> {
  const [m] = await db
    .select({
      name: groups.name,
      canRead: groupRoles.canRead,
      canCreate: groupRoles.canCreate,
      canEdit: groupRoles.canEdit,
      canDelete: groupRoles.canDelete,
      canManagePublicLink: groupRoles.canManagePublicLink,
    })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .innerJoin(groupRoles, eq(groupRoles.id, groupMembers.roleId))
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)))
    .limit(1);
  return m;
}
