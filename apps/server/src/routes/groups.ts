// A malformed :id/:userId, a nonexistent group and a non-member (unless site admin) give the same 404 (GROUP_NOT_FOUND_MESSAGE, byte-identical); 403 only for members lacking the flag.
// Each manage flag = role flag OR site admin (member or not). Authorization is decided before body validation.
// A body roleId or :roleId that isn't a UUID or isn't this group's → 404 role_not_found (not the group not_found); the body roleId's UUID check comes after the 403 and
// body-shape validation (:roleId's after the 403, before the body), "not this group's" is decided inside the transaction. Built-in role restrictions → 409 builtin_role.
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { asc, eq, sql } from "drizzle-orm";
import {
  GROUP_ROLE_FLAGS, isReservedRoleName, normalizeEmail, type AvatarRef, type BuiltinGroupRole, type GroupMemberDto, type GroupRoleDto, type GroupRoleFlag,
} from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { readAvatarRefs } from "../avatars/read.js";
import { groupMembers, groupRoles, groups, users } from "../db/schema.js";
import { foreignKeyViolationConstraint, isForeignKeyViolation, isRetryableTxError, notNullViolationColumn, uniqueViolationConstraint } from "../db/pg-errors.js";
import { sendInvalidBody } from "../auth/admin-provider-input.js";
import { SITE_SETTINGS_MISSING_MESSAGE } from "../auth/tx/admin-site-settings.js";
import type { CollabHooks } from "../collab/hooks.js";
import type { VersionService } from "../collab/versions.js";
import type { GroupTestHook } from "../groups/test-hook.js";
import { sendError, sendStorageQuotaExceeded } from "../http/errors.js";
import { TxAbort } from "../http/tx-abort.js";
import { UUID_RE } from "../notes/service.js";
import {
  GROUP_NOT_FOUND_MESSAGE, NOT_ADMIN_MESSAGE, groupAccess, groupNoteIdsQuery, groupWithMyRoleQuery, listMyGroupsQuery, listRolesQuery, roleFlagValues,
  toGroupDto, toGroupRoleDto, validateGroupName, validateRoleName,
} from "../groups/queries.js";
import { fallbackGroupFolderName } from "../folders/names.js";
import { createGroupInTx } from "../groups/tx/create-group.js";
import { deleteGroupWithNotesInTx, transferGroupInTx } from "../groups/tx/delete-group.js";
import { addMemberInTx, removeMemberInTx, setMemberRoleInTx } from "../groups/tx/members.js";
import { deleteRoleInTx, updateRoleInTx } from "../groups/tx/roles.js";
import { StorageQuotaExceeded } from "../storage/tx/quota.js";
import { quotaErrorDetail } from "../storage/usage.js";
import { deleteUploadFiles } from "../uploads/service.js";

const nameBodySchema = z.object({ name: z.string() }).strict();
const groupPatchBodySchema = z
  .object({ name: z.string().optional(), autoVersions: z.boolean().optional() })
  .strict()
  .refine(b => b.name !== undefined || b.autoVersions !== undefined, { message: "Invalid request body: send at least one field." });
const addMemberBodySchema = z.object({ email: z.string().email(), roleId: z.string().optional() }).strict();
const memberRoleBodySchema = z.object({ roleId: z.string() }).strict();
// `.strict()`: a body with `read` (always true) is a 400, not silently ignored.
const roleFlagsSchema = z
  .object(Object.fromEntries(GROUP_ROLE_FLAGS.map(flag => [flag, z.boolean()])) as Record<GroupRoleFlag, z.ZodBoolean>)
  .strict();
const createRoleBodySchema = z.object({ name: z.string(), permissions: roleFlagsSchema }).strict();
const patchRoleBodySchema = z
  .object({ name: z.string().optional(), permissions: roleFlagsSchema.optional() })
  .strict()
  .refine(b => b.name !== undefined || b.permissions !== undefined, { message: "Invalid request body: send at least one of name and permissions." });
// `.strict()`: extra keys (e.g. transferTo with delete) are 400.
const deleteGroupBodySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("transfer"), transferTo: z.string() }).strict(),
  z.object({ mode: z.literal("delete") }).strict(),
]);

export interface GroupsRouteDeps {
  db: Db;
  collabHooks: CollabHooks;
  groupTestHook?: GroupTestHook;
  uploadsDir: string;
  storageLockTimeoutMs: number;
  versions: VersionService;
}

function toMemberDto(row: { userId: string; email: string; displayName: string; roleId: string; builtin: string | null }, avatar: AvatarRef | null): GroupMemberDto {
  return { userId: row.userId, email: row.email, displayName: row.displayName, roleId: row.roleId, builtin: (row.builtin ?? null) as BuiltinGroupRole | null, avatar };
}

export function groupsRoutes(deps: GroupsRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    const notFound = (reply: FastifyReply): FastifyReply => sendError(reply, 404, "not_found", GROUP_NOT_FOUND_MESSAGE);
    const forbidden = (reply: FastifyReply): FastifyReply => sendError(reply, 403, "forbidden", "Your role in this group can't do this.");
    const roleNotFound = (reply: FastifyReply): FastifyReply => sendError(reply, 404, "role_not_found", "No role with that id.");
    const invalidName = (reply: FastifyReply): FastifyReply => sendError(reply, 400, "invalid_name", "Group names must be 1 to 80 characters.");
    const replyTxAbort = (reply: FastifyReply, err: unknown): FastifyReply | null =>
      err instanceof TxAbort ? sendError(reply, err.status, err.errCode, err.message) : null;
    const invalidRoleName = (reply: FastifyReply): FastifyReply => sendError(reply, 400, "invalid_name", "Role names must be 1 to 40 characters.");
    const roleNameTaken = (reply: FastifyReply): FastifyReply => sendError(reply, 409, "role_name_taken", "This group already has a role with that name, or the name is reserved for a built-in role.");
    // Same message as the transferGroupInTx abort: a non-UUID is indistinguishable from "not the built-in admin".
    const notAdmin = (reply: FastifyReply): FastifyReply => sendError(reply, 409, "not_admin", NOT_ADMIN_MESSAGE);
    const serverBusy = (reply: FastifyReply): FastifyReply => sendError(reply, 409, "server_busy", "The server is busy. Try again in a moment.");
    const groupNotEmpty = (reply: FastifyReply): FastifyReply => sendError(reply, 409, "group_not_empty", "The group still has notes, so it can't be deleted.");

    app.get("/api/groups", { preHandler: app.authenticate }, async request => {
      const rows = await listMyGroupsQuery(deps.db, request.user!.id);
      return rows.map(row => toGroupDto(row, request.user!.isAdmin));
    });

    app.post("/api/groups", { preHandler: app.authenticate }, async (request, reply) => {
      const parsed = nameBodySchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");
      const name = validateGroupName(parsed.data.name);
      if (name === null) return invalidName(reply);
      const userId = request.user!.id;
      let created;
      try {
        created = await deps.db.transaction(tx => createGroupInTx(tx, { name, userId }));
      } catch (err) {
        // Default plan changed P→Q and P deleted mid-INSERT → 23503; a retry reads Q.
        if (foreignKeyViolationConstraint(err) === "groups_storage_plan_fk") return serverBusy(reply);
        if (notNullViolationColumn(err) === "storage_plan_id") {
          request.log.error({ table: "site_settings" }, SITE_SETTINGS_MISSING_MESSAGE);
          return sendError(reply, 500, "internal", "Internal server error.");
        }
        throw err;
      }
      const { group } = created;
      const [row] = await groupWithMyRoleQuery(deps.db, group.id, userId);
      return reply.code(201).send(toGroupDto(row!, request.user!.isAdmin));
    });

    app.patch("/api/groups/:id", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const access = await groupAccess(deps.db, id, request.user!);
      if (!access) return notFound(reply);
      if (!access.manageGroup) return forbidden(reply);
      const parsed = groupPatchBodySchema.safeParse(request.body);
      if (!parsed.success) return sendInvalidBody(reply, parsed.error);
      let name: string | undefined;
      if (parsed.data.name !== undefined) {
        const validated = validateGroupName(parsed.data.name);
        if (validated === null) return invalidName(reply);
        name = validated;
      }
      const set = { ...(name !== undefined ? { name } : {}), ...(parsed.data.autoVersions !== undefined ? { autoVersions: parsed.data.autoVersions } : {}) };
      const updated = await deps.db.update(groups).set(set).where(eq(groups.id, id)).returning({ id: groups.id });
      if (updated.length === 0) return notFound(reply);
      const [row] = await groupWithMyRoleQuery(deps.db, id, request.user!.id);
      if (!row) return notFound(reply);
      return toGroupDto(row, request.user!.isAdmin);
    });

    // The delete-all gate (beforeNoteDeleted borrows connections) opens before the transaction; notes moved into the group after the gate are deleted without it, and after commit
    // onGroupAccessChanged closes their online users as revoked within 5 s.
    // 23503 → group_not_empty is defense in depth (creates/moves after lockGroup block on the FK KEY SHARE). 40P01/40001/55P03 (space or folder-structure lock timeout) → server_busy:
    // writing links × deleting a group can still cycle (writeLinksInTx locks the source row, then the target FK KEY SHARE, against the group notes' FOR UPDATE); transfers to one
    // transferTo queue on the receiver's structure lock, taken before the note lock. Transfer can also give 409 storage_quota_exceeded (the receiver's personal space can't fit
    // the notes; used/quota numbers only for the receiver and site admins).
    app.delete("/api/groups/:id", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const access = await groupAccess(deps.db, id, request.user!);
      if (!access) return notFound(reply);
      if (!access.manageGroup) return forbidden(reply);
      const parsed = deleteGroupBodySchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");
      // groupAccess accepts uppercase UUIDs; lowercase so the inputs match the DB's ids.
      const groupId = id.toLowerCase();

      if (parsed.data.mode === "transfer") {
        // A non-UUID must not reach PG (22P02 → 500).
        if (!UUID_RE.test(parsed.data.transferTo)) return notAdmin(reply);
        const input = {
          groupId,
          // Lowercase: filtered with `!==` against the DB's lowercase member ids.
          transferTo: parsed.data.transferTo.toLowerCase(),
          by: request.user!.id,
          // Accept-Language: the server has no UI-language field.
          fallbackFolderName: fallbackGroupFolderName(request.headers["accept-language"]),
          lockTimeoutMs: deps.storageLockTimeoutMs,
        };
        let out;
        try {
          out = await deps.db.transaction(tx => transferGroupInTx(tx, input, deps.groupTestHook));
        } catch (err) {
          if (err instanceof StorageQuotaExceeded) return sendStorageQuotaExceeded(reply, await quotaErrorDetail(deps.db, request.user!, err));
          const sent = replyTxAbort(reply, err);
          if (sent) return sent;
          if (isForeignKeyViolation(err)) return groupNotEmpty(reply);
          if (isRetryableTxError(err)) return serverBusy(reply);
          throw err;
        }
        if (out.noteIds.length > 0) {
          deps.versions.relocated(out.noteIds);
          deps.collabHooks.onGroupAccessChanged(out.noteIds, out.memberIds.filter(u => u !== input.transferTo));
          deps.collabHooks.onGroupAccessChanged(out.noteIds, [input.transferTo]);
        }
        return reply.code(204).send();
      }

      const p0 = (await groupNoteIdsQuery(deps.db, groupId)).map(r => r.id);
      // allSettled: release every opened gate even if one rejects.
      const settled = await Promise.allSettled(p0.map(noteId => deps.collabHooks.beforeNoteDeleted(noteId)));
      const gates = settled.flatMap(s => (s.status === "fulfilled" ? [s.value] : []));
      const releaseAll = (): void => {
        for (const g of gates) g.release();
      };
      const rejected = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
      if (rejected) {
        releaseAll();
        throw rejected.reason;
      }
      const input = { groupId, lockTimeoutMs: deps.storageLockTimeoutMs };
      let out;
      try {
        // Inside try so a throwing hook still releases.
        await deps.groupTestHook?.("group-delete-gated", { groupId });
        out = await deps.db.transaction(tx => deleteGroupWithNotesInTx(tx, input, deps.groupTestHook));
      } catch (err) {
        releaseAll();
        const sent = replyTxAbort(reply, err);
        if (sent) return sent;
        if (isForeignKeyViolation(err)) return groupNotEmpty(reply);
        if (isRetryableTxError(err)) return serverBusy(reply);
        throw err;
      }
      await deleteUploadFiles(deps.uploadsDir, out.uploadIds, request.log);
      const gated = new Set(p0);
      const late = out.noteIds.filter(n => !gated.has(n));
      if (late.length > 0 && out.memberIds.length > 0) deps.collabHooks.onGroupAccessChanged(late, out.memberIds);
      return reply.code(204).send();
    });

    app.get("/api/groups/:id/roles", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const access = await groupAccess(deps.db, id, request.user!);
      if (!access) return notFound(reply);
      const rows = await listRolesQuery(deps.db, id);
      return rows.map(row => toGroupRoleDto(row)!);
    });

    app.post("/api/groups/:id/roles", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const access = await groupAccess(deps.db, id, request.user!);
      if (!access) return notFound(reply);
      if (!access.manageGroup) return forbidden(reply);
      const parsed = createRoleBodySchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");
      const name = validateRoleName(parsed.data.name);
      if (name === null) return invalidRoleName(reply);
      if (isReservedRoleName(name)) return roleNameTaken(reply);
      let inserted: Array<{ id: string }>;
      try {
        inserted = await deps.db
          .insert(groupRoles)
          .values({ groupId: id, name, ...roleFlagValues(parsed.data.permissions) })
          .returning({ id: groupRoles.id });
      } catch (err) {
        if (uniqueViolationConstraint(err) === "group_roles_name_idx") return roleNameTaken(reply);
        // Group deleted after authorization (the FK KEY SHARE waits for its commit) → same as nonexistent. No test covers this interleaving.
        if (isForeignKeyViolation(err)) return notFound(reply);
        throw err;
      }
      return reply.code(201).send({
        id: inserted[0]!.id,
        builtin: null,
        name,
        permissions: { read: true, ...parsed.data.permissions },
        memberCount: 0,
      } satisfies GroupRoleDto);
    });

    // The name is normalized before the transaction (callback arguments must contain no calls). Kicks only when read/edit changed and someone holds the role.
    app.patch("/api/groups/:id/roles/:roleId", { preHandler: app.authenticate }, async (request, reply) => {
      const { id, roleId } = request.params as { id: string; roleId: string };
      const access = await groupAccess(deps.db, id, request.user!);
      if (!access) return notFound(reply);
      if (!access.manageGroup) return forbidden(reply);
      if (!UUID_RE.test(roleId)) return roleNotFound(reply);
      const parsed = patchRoleBodySchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");
      const permissions = parsed.data.permissions;
      let name: string | undefined;
      if (parsed.data.name !== undefined) {
        const validated = validateRoleName(parsed.data.name);
        if (validated === null) return invalidRoleName(reply);
        if (isReservedRoleName(validated)) return roleNameTaken(reply);
        name = validated;
      }
      let out;
      try {
        out = await deps.db.transaction(tx => updateRoleInTx(tx, { groupId: id, roleId, name, permissions }, deps.groupTestHook));
      } catch (err) {
        const sent = replyTxAbort(reply, err);
        if (sent) return sent;
        if (uniqueViolationConstraint(err) === "group_roles_name_idx") return roleNameTaken(reply);
        throw err;
      }
      if (out.kick !== null && out.kick.userIds.length > 0) deps.collabHooks.onGroupAccessChanged(out.kick.noteIds, out.kick.userIds);
      return out.role;
    });

    app.delete("/api/groups/:id/roles/:roleId", { preHandler: app.authenticate }, async (request, reply) => {
      const { id, roleId } = request.params as { id: string; roleId: string };
      const access = await groupAccess(deps.db, id, request.user!);
      if (!access) return notFound(reply);
      if (!access.manageGroup) return forbidden(reply);
      if (!UUID_RE.test(roleId)) return roleNotFound(reply);
      let kick;
      try {
        kick = await deps.db.transaction(tx => deleteRoleInTx(tx, { groupId: id, roleId }, deps.groupTestHook));
      } catch (err) {
        const sent = replyTxAbort(reply, err);
        if (sent) return sent;
        throw err;
      }
      if (kick.userIds.length > 0) deps.collabHooks.onGroupAccessChanged(kick.noteIds, kick.userIds);
      return reply.code(204).send();
    });

    // routes/users.ts suggestions assume group members see each other's email; change both together.
    app.get("/api/groups/:id/members", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const access = await groupAccess(deps.db, id, request.user!);
      if (!access) return notFound(reply);
      const rows = await deps.db
        .select({ userId: users.id, email: users.email, displayName: users.displayName, roleId: groupMembers.roleId, builtin: groupRoles.builtin })
        .from(groupMembers)
        .innerJoin(users, eq(users.id, groupMembers.userId))
        .innerJoin(groupRoles, eq(groupRoles.id, groupMembers.roleId))
        .where(eq(groupMembers.groupId, id))
        .orderBy(sql`case when ${groupRoles.builtin} = 'admin' then 0 else 1 end`, asc(users.displayName), asc(users.id));
      const avatars = await readAvatarRefs(deps.db, rows.map(r => r.userId));
      return rows.map(r => toMemberDto(r, avatars.get(r.userId) ?? null));
    });

    app.put("/api/groups/:id/members", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const access = await groupAccess(deps.db, id, request.user!);
      if (!access) return notFound(reply);
      if (!access.manageMembers) return forbidden(reply);
      const parsed = addMemberBodySchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");
      const roleId = parsed.data.roleId ?? null;
      if (roleId !== null && !UUID_RE.test(roleId)) return roleNotFound(reply);
      const [target] = await deps.db
        .select({ id: users.id, email: users.email, displayName: users.displayName })
        .from(users)
        .where(sql`lower(${users.email}) = ${normalizeEmail(parsed.data.email)}`)
        .orderBy(users.createdAt, users.id)
        .limit(1);
      if (!target) return sendError(reply, 404, "user_not_found", "No user with that email.");
      let role;
      try {
        role = await deps.db.transaction(tx => addMemberInTx(tx, { groupId: id, targetUserId: target.id, roleId }, deps.groupTestHook));
      } catch (err) {
        const sent = replyTxAbort(reply, err);
        if (sent) return sent;
        throw err;
      }
      const avatars = await readAvatarRefs(deps.db, [target.id]);
      return toMemberDto({ userId: target.id, email: target.email, displayName: target.displayName, roleId: role.roleId, builtin: role.builtin }, avatars.get(target.id) ?? null);
    });

    // No escalation guard on purpose: a holder of the manage-members flag may assign any role. A role change re-verifies that user on all group notes (up or down);
    // an unchanged role kicks nobody.
    app.patch("/api/groups/:id/members/:userId", { preHandler: app.authenticate }, async (request, reply) => {
      const { id, userId: targetId } = request.params as { id: string; userId: string };
      const access = await groupAccess(deps.db, id, request.user!);
      if (!access) return notFound(reply);
      if (!UUID_RE.test(targetId)) return notFound(reply);
      if (!access.manageMembers) return forbidden(reply);
      const parsed = memberRoleBodySchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");
      if (!UUID_RE.test(parsed.data.roleId)) return roleNotFound(reply);
      let out;
      try {
        out = await deps.db.transaction(tx =>
          setMemberRoleInTx(tx, { groupId: id, targetUserId: targetId, roleId: parsed.data.roleId }, deps.groupTestHook));
      } catch (err) {
        const sent = replyTxAbort(reply, err);
        if (sent) return sent;
        throw err;
      }
      if (out.noteIds !== null) deps.collabHooks.onGroupAccessChanged(out.noteIds, [targetId]);
      const avatars = await readAvatarRefs(deps.db, [targetId]);
      return toMemberDto({ userId: targetId, ...out.member }, avatars.get(targetId) ?? null);
    });

    app.delete("/api/groups/:id/members/:userId", { preHandler: app.authenticate }, async (request, reply) => {
      const { id, userId: targetId } = request.params as { id: string; userId: string };
      const access = await groupAccess(deps.db, id, request.user!);
      if (!access) return notFound(reply);
      if (!UUID_RE.test(targetId)) return notFound(reply);
      if (targetId !== request.user!.id && !access.manageMembers) return forbidden(reply);
      let noteIds: string[];
      try {
        noteIds = await deps.db.transaction(tx => removeMemberInTx(tx, { groupId: id, targetUserId: targetId }, deps.groupTestHook));
      } catch (err) {
        const sent = replyTxAbort(reply, err);
        if (sent) return sent;
        throw err;
      }
      deps.collabHooks.onGroupAccessChanged(noteIds, [targetId]);
      return reply.code(204).send();
    });
  };
}
