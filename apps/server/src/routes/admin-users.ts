import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, eq, sql } from "drizzle-orm";
import type { AvatarRef, SpaceStorageDto } from "@knotebook/shared";
import { sendError } from "../http/errors.js";
import type { Db } from "../db/index.js";
import { oneTimeLinks, storagePlans, users } from "../db/schema.js";
import { activeOneTimeLink } from "../auth/one-time-link.js";
import { disableUserInTx } from "../auth/tx/disable-user.js";
import type { UserGate } from "../auth/session.js";
import type { CollabHooks } from "../collab/hooks.js";
import { UUID_RE } from "../notes/service.js";
import { foreignKeyViolationConstraint } from "../db/pg-errors.js";
import { listSpaceUsage, readSpaceUsage } from "../storage/usage.js";
import { redactDbError } from "../lib/redact-db-error.js";
import { TxAbort } from "../http/tx-abort.js";
import type { AdminTestHook } from "../auth/admin-test-hook.js";
import { demoteSiteAdminInTx } from "../auth/tx/admin-demote.js";
import { readAvatarRefs } from "../avatars/read.js";

const assignPlanSchema = z.object({ planId: z.string() }).strict();

export interface AdminUsersRouteDeps {
  db: Db;
  gate: UserGate;
  collabHooks: CollabHooks;
  adminTestHook?: AdminTestHook;
}

interface AdminUserDto {
  id: string;
  email: string;
  handle: string;
  displayName: string;
  isAdmin: boolean;
  disabledAt: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  /** Updated at most once a minute per user (#267). */
  lastActiveAt: string | null;
  storage: SpaceStorageDto;
  hasPassword: boolean;
  passwordResetExpiresAt: string | null;
  avatar: AvatarRef | null;
}

interface AdminUserRow {
  id: string;
  email: string;
  handle: string;
  displayName: string;
  isAdmin: boolean;
  disabledAt: Date | null;
  createdAt: Date;
  lastLoginAt: Date | null;
  lastActiveAt: Date | null;
  hasPassword: boolean;
  passwordResetExpiresAt: Date | null;
}

// Never select passwordHash/tokenVersion (`hasPassword` is a boolean computed in SQL): not fetching them closes every leak path.
function toAdminUserDto(row: AdminUserRow, storage: SpaceStorageDto, avatar: AvatarRef | null): AdminUserDto {
  return {
    id: row.id,
    email: row.email,
    handle: row.handle,
    displayName: row.displayName,
    isAdmin: row.isAdmin,
    disabledAt: row.disabledAt ? row.disabledAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
    lastActiveAt: row.lastActiveAt ? row.lastActiveAt.toISOString() : null,
    storage,
    hasPassword: row.hasPassword,
    passwordResetExpiresAt: row.passwordResetExpiresAt ? row.passwordResetExpiresAt.toISOString() : null,
    avatar,
  };
}

const adminUserColumns = {
  id: users.id,
  email: users.email,
  handle: users.handle,
  displayName: users.displayName,
  isAdmin: users.isAdmin,
  disabledAt: users.disabledAt,
  createdAt: users.createdAt,
  lastLoginAt: users.lastLoginAt,
  lastActiveAt: users.lastActiveAt,
  hasPassword: sql<boolean>`${users.passwordHash} is not null`,
  // ⚠ The `users.id` reference must stay inside the nested `and(…)`: drizzle 0.44 drops the table name from top-level column references in a single-table RETURNING,
  // which would resolve to one_time_links.id and silently give null. `.mapWith` is required for the raw pg string.
  passwordResetExpiresAt: sql`(select ${oneTimeLinks.expiresAt} from ${oneTimeLinks} where ${and(eq(oneTimeLinks.targetUserId, users.id), activeOneTimeLink("password_reset"))})`.mapWith(oneTimeLinks.expiresAt),
};

async function storageOfUser(db: Db, userId: string): Promise<SpaceStorageDto> {
  const usage = await readSpaceUsage(db, { kind: "user", id: userId });
  if (!usage) throw new Error(`storageOfUser: 找不到使用者 ${userId}`);
  return { planId: usage.planId, planName: usage.planName, usedBytes: usage.usedBytes, quotaBytes: usage.quotaBytes };
}

// A malformed :id gets the same 404 as an unknown user (pg throws on a bad uuid string, which would surface as a 500).
export function adminUsersRoutes(deps: AdminUsersRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get("/api/admin/users", { preHandler: app.requireAdmin }, async () => {
      // Secondary key id: createdAt isn't unique at millisecond precision.
      const usage = await listSpaceUsage(deps.db, "user");
      const rows = await deps.db
        .select({ ...adminUserColumns, planId: storagePlans.id, planName: storagePlans.name, quotaBytes: storagePlans.quotaBytes })
        .from(users)
        .innerJoin(storagePlans, eq(storagePlans.id, users.storagePlanId))
        .orderBy(asc(users.createdAt), asc(users.id));
      const avatars = await readAvatarRefs(deps.db, rows.map(r => r.id));
      return rows.map(r => toAdminUserDto(r, { planId: r.planId, planName: r.planName, usedBytes: usage.get(r.id) ?? 0, quotaBytes: r.quotaBytes }, avatars.get(r.id) ?? null));
    });

    app.post("/api/admin/users/:id/disable", { preHandler: app.requireAdmin }, async (request, reply) => {
      const { id: rawId } = request.params as { id: string };
      if (!UUID_RE.test(rawId)) {
        return sendError(reply, 404, "user_not_found", "No user with that id.");
      }
      // Lowercase: the self-lockout check `id === request.user!.id` is a plain string compare (the DB id is lowercase), so an uppercase own UUID would bypass cannot_disable_self.
      const id = rawId.toLowerCase();
      if (id === request.user!.id) {
        return sendError(reply, 400, "cannot_disable_self", "You can't disable your own account.");
      }

      const input = { id };
      let result: Awaited<ReturnType<typeof disableUserInTx>>;
      try {
        result = await deps.db.transaction(tx => disableUserInTx(tx, input));
      } catch (err) {
        if (err instanceof TxAbort) return sendError(reply, err.status, err.errCode, err.message);
        throw redactDbError(request.log, err, "停用帳號");
      }

      if (!result.disabled) {
        const [existing] = await deps.db.select({ id: users.id }).from(users).where(eq(users.id, id)).limit(1);
        if (!existing) {
          return sendError(reply, 404, "user_not_found", "No user with that id.");
        }
        // Already disabled: idempotent 204 without repeating invalidate/onUserRevoked.
        return reply.code(204).send();
      }

      deps.gate.invalidate(id);
      deps.collabHooks.onUserRevoked(id);
      if (result.revokedResetLinks > 0) {
        request.log.info({ userId: request.user!.id, targetUserId: id, revoked: result.revokedResetLinks }, "停用帳號時撤銷重設密碼連結");
      }

      return reply.code(204).send();
    });

    app.post("/api/admin/users/:id/enable", { preHandler: app.requireAdmin }, async (request, reply) => {
      const { id: rawId } = request.params as { id: string };
      if (!UUID_RE.test(rawId)) {
        return sendError(reply, 404, "user_not_found", "No user with that id.");
      }
      const id = rawId.toLowerCase();

      // tokenVersion stays as bumped at disable, so sessions issued before it remain invalid after enable.
      const [updated] = await deps.db.update(users).set({ disabledAt: null }).where(eq(users.id, id)).returning({ id: users.id });
      if (!updated) {
        return sendError(reply, 404, "user_not_found", "No user with that id.");
      }

      deps.gate.invalidate(id);

      return reply.code(204).send();
    });

    app.post("/api/admin/users/:id/promote", { preHandler: app.requireAdmin }, async (request, reply) => {
      const { id: rawId } = request.params as { id: string };
      if (!UUID_RE.test(rawId)) {
        return sendError(reply, 404, "user_not_found", "No user with that id.");
      }
      const id = rawId.toLowerCase();

      const [updated] = await deps.db.update(users).set({ isAdmin: true }).where(eq(users.id, id)).returning({ id: users.id });
      if (!updated) {
        return sendError(reply, 404, "user_not_found", "No user with that id.");
      }

      // Else the gate's cached isAdmin lingers for its 60 s TTL.
      deps.gate.invalidate(id);

      return reply.code(204).send();
    });

    app.post("/api/admin/users/:id/demote", { preHandler: app.requireAdmin }, async (request, reply) => {
      const { id: rawId } = request.params as { id: string };
      if (!UUID_RE.test(rawId)) {
        return sendError(reply, 404, "user_not_found", "No user with that id.");
      }
      const id = rawId.toLowerCase();
      if (id === request.user!.id) {
        return sendError(reply, 400, "cannot_demote_self", "You can't remove your own admin role.");
      }
      const input = { targetId: id };
      try {
        await deps.db.transaction(tx => demoteSiteAdminInTx(tx, input, deps.adminTestHook));
      } catch (err) {
        if (err instanceof TxAbort) return sendError(reply, err.status, err.errCode, err.message);
        throw err;
      }
      deps.gate.invalidate(id);
      return reply.code(204).send();
    });

    // Non-key UPDATE: takes no space lock and doesn't block uploads in progress; no check against current usage. Suspended users can be changed.
    app.patch("/api/admin/users/:id/storage-plan", { preHandler: app.requireAdmin }, async (request, reply) => {
      const { id: rawId } = request.params as { id: string };
      if (!UUID_RE.test(rawId)) return sendError(reply, 404, "user_not_found", "No user with that id.");
      const id = rawId.toLowerCase();
      const parsed = assignPlanSchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", "Invalid request body.");
      if (!UUID_RE.test(parsed.data.planId)) return sendError(reply, 404, "storage_plan_not_found", "No storage plan with that id.");
      let updated: AdminUserRow[];
      try {
        updated = await deps.db.update(users).set({ storagePlanId: parsed.data.planId.toLowerCase() }).where(eq(users.id, id)).returning(adminUserColumns);
      } catch (err) {
        if (foreignKeyViolationConstraint(err) === "users_storage_plan_fk") return sendError(reply, 404, "storage_plan_not_found", "No storage plan with that id.");
        throw err;
      }
      const [row] = updated;
      if (!row) return sendError(reply, 404, "user_not_found", "No user with that id.");
      return toAdminUserDto(row, await storageOfUser(deps.db, id), (await readAvatarRefs(deps.db, [id])).get(id) ?? null);
    });
  };
}
