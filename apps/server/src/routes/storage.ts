// Group space is visible to any member (including non-member site admins), same authorization as routes/groups.ts: groupAccess null → the single 404. Whether usage numbers appear in error details is decided separately (canViewSpaceUsage).
// Single-statement reads, no transaction.
import type { FastifyInstance } from "fastify";
import type { GroupStorageUsageDto, StorageUsageDto } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { GROUP_NOT_FOUND_MESSAGE, groupAccess } from "../groups/queries.js";
import { sendError } from "../http/errors.js";
import type { StorageSpace } from "../storage/space.js";
import { readGroupUsageByMember, readSpaceContentUsage, readSpaceUsage, readSpaceUsageByKind } from "../storage/usage.js";

export function storageRoutes(deps: { db: Db }) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get("/api/storage", { preHandler: app.authenticate }, async (request, reply) => {
      const space: StorageSpace = { kind: "user", id: request.user!.id };
      const usage = await readSpaceUsage(deps.db, space);
      if (!usage) return sendError(reply, 404, "not_found", "Your account no longer exists.");
      const [byKind, content] = await Promise.all([readSpaceUsageByKind(deps.db, space), readSpaceContentUsage(deps.db, space)]);
      const dto: StorageUsageDto = { usedBytes: usage.usedBytes, quotaBytes: usage.quotaBytes, planName: usage.planName, byKind, content };
      return dto;
    });

    app.get("/api/groups/:id/storage", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const access = await groupAccess(deps.db, id, request.user!);
      if (!access) return sendError(reply, 404, "not_found", GROUP_NOT_FOUND_MESSAGE);
      const space: StorageSpace = { kind: "group", id: id.toLowerCase() };
      const usage = await readSpaceUsage(deps.db, space);
      if (!usage) return sendError(reply, 404, "not_found", GROUP_NOT_FOUND_MESSAGE);
      const [byKind, byMember, content] = await Promise.all([readSpaceUsageByKind(deps.db, space), readGroupUsageByMember(deps.db, space.id), readSpaceContentUsage(deps.db, space)]);
      const dto: GroupStorageUsageDto = { usedBytes: usage.usedBytes, quotaBytes: usage.quotaBytes, planName: usage.planName, byKind, byMember, content };
      return dto;
    });
  };
}
