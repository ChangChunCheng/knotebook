// No transactions in this file (enforced by test/unit/s14-structure.test.ts; to add one, extract an `*InTx` and list the file there).
// All routes requireAdmin; bodies are strict zod answered with the fixed "Invalid request body." (never zod's own text); a non-UUID id gets the endpoint's 404 code.
import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { asc, eq, sql } from "drizzle-orm";
import { STORAGE_PLAN_NAME_MAX, STORAGE_QUOTA_MAX_BYTES, type AdminGroupDto, type StoragePlanDto, type StoragePlansResponse } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { groupMembers, groups, siteSettings, storagePlans } from "../db/schema.js";
import { foreignKeyViolationConstraint, uniqueViolationConstraint } from "../db/pg-errors.js";
import { SITE_SETTINGS_MISSING_MESSAGE } from "../auth/tx/admin-site-settings.js";
import { sendError } from "../http/errors.js";
import { UUID_RE } from "../notes/service.js";
import { listSpaceUsage } from "../storage/usage.js";

export interface AdminStorageRouteDeps {
  db: Db;
}

const quotaSchema = z.number().int().min(0).max(STORAGE_QUOTA_MAX_BYTES).nullable();
const createSchema = z.object({ name: z.string(), quotaBytes: quotaSchema }).strict();
const patchSchema = z
  .object({ name: z.string().optional(), quotaBytes: quotaSchema.optional() })
  .strict()
  .refine(b => b.name !== undefined || b.quotaBytes !== undefined);
const defaultsSchema = z
  .object({ userPlanId: z.string().optional(), groupPlanId: z.string().optional() })
  .strict()
  .refine(b => b.userPlanId !== undefined || b.groupPlanId !== undefined);
const assignSchema = z.object({ planId: z.string() }).strict();

const UNSTORABLE = /[\0]|\p{Surrogate}/u;

/** Trimmed (incl. full-width spaces); length in code points (DB char_length), not `.length`; NUL and lone surrogates are rejected (PG can't store them: 22021). */
export function validatePlanName(raw: string): string | null {
  const name = raw.trim();
  if (UNSTORABLE.test(name)) return null;
  const n = [...name].length;
  return n >= 1 && n <= STORAGE_PLAN_NAME_MAX ? name : null;
}

/**
 * Outer columns in the correlated subquery are spelled storage_plans.id/quota_bytes: drizzle renders a single-table `${storagePlans.id}` as a bare "id", which `from users u` resolves to u.id (count always 0).
 * overQuotaCount counts users (whose used includes the avatar) and groups.
 */
function planRowsQuery(db: Db) {
  return db
    .select({
      id: storagePlans.id,
      name: storagePlans.name,
      quotaBytes: storagePlans.quotaBytes,
      createdAt: storagePlans.createdAt,
      updatedAt: storagePlans.updatedAt,
      userCount: sql<number>`(select count(*)::int from users u where u.storage_plan_id = storage_plans.id)`,
      groupCount: sql<number>`(select count(*)::int from groups g where g.storage_plan_id = storage_plans.id)`,
      overQuotaCount: sql<number>`(
        case when storage_plans.quota_bytes is null then 0 else
          (select count(*)::int from users u where u.storage_plan_id = storage_plans.id
             and (select coalesce(sum(up.size), 0) from uploads up join notes n on n.id = up.note_id where n.owner_id = u.id)
               + (select coalesce(sum(av.original_size + av.display_size), 0) from user_avatars av where av.user_id = u.id) > storage_plans.quota_bytes)
        + (select count(*)::int from groups g where g.storage_plan_id = storage_plans.id
             and (select coalesce(sum(up.size), 0) from uploads up join notes n on n.id = up.note_id where n.group_id = g.id) > storage_plans.quota_bytes)
        end)`,
    })
    .from(storagePlans);
}

type PlanRow = Awaited<ReturnType<ReturnType<typeof planRowsQuery>["execute"]>>[number];

function toPlanDto(r: PlanRow, defaults: { userPlanId: string; groupPlanId: string }): StoragePlanDto {
  return {
    id: r.id, name: r.name, quotaBytes: r.quotaBytes,
    userCount: r.userCount, groupCount: r.groupCount, overQuotaCount: r.overQuotaCount,
    isDefaultForUsers: r.id === defaults.userPlanId, isDefaultForGroups: r.id === defaults.groupPlanId,
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  };
}

async function readDefaults(db: Db): Promise<{ userPlanId: string; groupPlanId: string } | null> {
  const [row] = await db
    .select({ userPlanId: siteSettings.defaultUserStoragePlanId, groupPlanId: siteSettings.defaultGroupStoragePlanId })
    .from(siteSettings)
    .where(eq(siteSettings.singleton, true));
  return row ?? null;
}

export function adminStorageRoutes(deps: AdminStorageRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    const invalidBody = (reply: FastifyReply) => sendError(reply, 400, "invalid_body", "Invalid request body.");
    const invalidName = (reply: FastifyReply) => sendError(reply, 400, "invalid_name", "Plan names must be 1 to 40 characters.");
    const planNotFound = (reply: FastifyReply) => sendError(reply, 404, "storage_plan_not_found", "No storage plan with that id.");
    const nameTaken = (reply: FastifyReply) => sendError(reply, 409, "storage_plan_name_taken", "A plan with that name already exists.");
    const groupNotFound = (reply: FastifyReply) => sendError(reply, 404, "group_not_found", "No group with that id.");
    // Object first: captureLogs only captures that shape.
    const settingsMissing = (reply: FastifyReply, log: FastifyBaseLogger) => {
      log.error({ table: "site_settings" }, SITE_SETTINGS_MISSING_MESSAGE);
      return sendError(reply, 500, "internal", "Internal server error.");
    };
    const onePlan = async (id: string): Promise<StoragePlanDto | null> => {
      const defaults = await readDefaults(deps.db);
      const [row] = await planRowsQuery(deps.db).where(eq(storagePlans.id, id));
      return row ? toPlanDto(row, defaults ?? { userPlanId: "", groupPlanId: "" }) : null;
    };

    app.get("/api/admin/storage-plans", { preHandler: app.requireAdmin }, async (request, reply) => {
      const defaults = await readDefaults(deps.db);
      if (!defaults) return settingsMissing(reply, request.log);
      const rows = await planRowsQuery(deps.db).orderBy(sql`lower(${storagePlans.name})`, asc(storagePlans.id));
      const body: StoragePlansResponse = { plans: rows.map(r => toPlanDto(r, defaults)), defaults };
      return body;
    });

    app.post("/api/admin/storage-plans", { preHandler: app.requireAdmin }, async (request, reply) => {
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) return invalidBody(reply);
      const name = validatePlanName(parsed.data.name);
      if (name === null) return invalidName(reply);
      let id: string;
      try {
        const [row] = await deps.db.insert(storagePlans).values({ name, quotaBytes: parsed.data.quotaBytes }).returning({ id: storagePlans.id });
        id = row!.id;
      } catch (err) {
        if (uniqueViolationConstraint(err) === "storage_plans_name_lower_idx") return nameTaken(reply);
        throw err;
      }
      return reply.code(201).send(await onePlan(id));
    });

    app.patch("/api/admin/storage-plans/defaults", { preHandler: app.requireAdmin }, async (request, reply) => {
      const parsed = defaultsSchema.safeParse(request.body);
      if (!parsed.success) return invalidBody(reply);
      const set: { defaultUserStoragePlanId?: string; defaultGroupStoragePlanId?: string; updatedAt: ReturnType<typeof sql> } = { updatedAt: sql`now()` };
      for (const [key, col] of [["userPlanId", "defaultUserStoragePlanId"], ["groupPlanId", "defaultGroupStoragePlanId"]] as const) {
        const v = parsed.data[key];
        if (v === undefined) continue;
        if (!UUID_RE.test(v)) return planNotFound(reply);
        set[col] = v.toLowerCase();
      }
      let rows: Array<{ userPlanId: string; groupPlanId: string }>;
      try {
        rows = await deps.db.update(siteSettings).set(set).where(eq(siteSettings.singleton, true))
          .returning({ userPlanId: siteSettings.defaultUserStoragePlanId, groupPlanId: siteSettings.defaultGroupStoragePlanId });
      } catch (err) {
        const c = foreignKeyViolationConstraint(err);
        if (c === "site_settings_default_user_plan_fk" || c === "site_settings_default_group_plan_fk") return planNotFound(reply);
        throw err;
      }
      if (rows.length === 0) return settingsMissing(reply, request.log);
      return rows[0];
    });

    app.patch("/api/admin/storage-plans/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
      const { id: rawId } = request.params as { id: string };
      if (!UUID_RE.test(rawId)) return planNotFound(reply);
      const id = rawId.toLowerCase();
      const parsed = patchSchema.safeParse(request.body);
      if (!parsed.success) return invalidBody(reply);
      const set: { name?: string; quotaBytes?: number | null; updatedAt: ReturnType<typeof sql> } = { updatedAt: sql`now()` };
      if (parsed.data.name !== undefined) {
        const name = validatePlanName(parsed.data.name);
        if (name === null) return invalidName(reply);
        set.name = name;
      }
      if (parsed.data.quotaBytes !== undefined) set.quotaBytes = parsed.data.quotaBytes;
      let updated: Array<{ id: string }>;
      try {
        // Lowering below current usage is allowed (it deletes nothing, only blocks new additions); raising takes effect immediately (the next check reads it).
        updated = await deps.db.update(storagePlans).set(set).where(eq(storagePlans.id, id)).returning({ id: storagePlans.id });
      } catch (err) {
        if (uniqueViolationConstraint(err) === "storage_plans_name_lower_idx") return nameTaken(reply);
        throw err;
      }
      if (updated.length === 0) return planNotFound(reply);
      return onePlan(id);
    });

    app.delete("/api/admin/storage-plans/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
      const { id: rawId } = request.params as { id: string };
      if (!UUID_RE.test(rawId)) return planNotFound(reply);
      const id = rawId.toLowerCase();
      const isDefault = () => sendError(reply, 409, "storage_plan_is_default", "This is the default plan. Make another plan the default first.");
      let deleted: number;
      try {
        const res = await deps.db.execute(sql`
          delete from storage_plans where id = ${id}
            and id not in (select default_user_storage_plan_id from site_settings
                           union all select default_group_storage_plan_id from site_settings)
          returning id`);
        deleted = res.rows.length;
      } catch (err) {
        const c = foreignKeyViolationConstraint(err);
        if (c === "users_storage_plan_fk" || c === "groups_storage_plan_fk") return sendError(reply, 409, "storage_plan_in_use", "Users or groups still use this plan. Assign them another plan first.");
        // Concurrent with a default change: the subquery reads a snapshot, so the site_settings FK is what blocks it.
        if (c === "site_settings_default_user_plan_fk" || c === "site_settings_default_group_plan_fk") return isDefault();
        throw err;
      }
      if (deleted === 1) return reply.code(204).send();
      const [exists] = await deps.db.select({ id: storagePlans.id }).from(storagePlans).where(eq(storagePlans.id, id));
      return exists ? isDefault() : planNotFound(reply);
    });

    const groupDto = async (id?: string): Promise<AdminGroupDto[]> => {
      const usage = await listSpaceUsage(deps.db, "group");
      const base = deps.db
        .select({
          id: groups.id, name: groups.name, createdAt: groups.createdAt,
          memberCount: sql<number>`(select count(*)::int from ${groupMembers} gm where gm.group_id = ${groups.id})`,
          planId: storagePlans.id, planName: storagePlans.name, quotaBytes: storagePlans.quotaBytes,
        })
        .from(groups)
        .innerJoin(storagePlans, eq(storagePlans.id, groups.storagePlanId));
      const rows = id === undefined ? await base.orderBy(sql`lower(${groups.name})`, asc(groups.id)) : await base.where(eq(groups.id, id));
      return rows.map(r => ({
        id: r.id, name: r.name, createdAt: r.createdAt.toISOString(), memberCount: r.memberCount,
        storage: { planId: r.planId, planName: r.planName, usedBytes: usage.get(r.id) ?? 0, quotaBytes: r.quotaBytes },
      }));
    };

    app.get("/api/admin/groups", { preHandler: app.requireAdmin }, async () => groupDto());

    app.patch("/api/admin/groups/:id/storage-plan", { preHandler: app.requireAdmin }, async (request, reply) => {
      const { id: rawId } = request.params as { id: string };
      if (!UUID_RE.test(rawId)) return groupNotFound(reply);
      const id = rawId.toLowerCase();
      const parsed = assignSchema.safeParse(request.body);
      if (!parsed.success) return invalidBody(reply);
      if (!UUID_RE.test(parsed.data.planId)) return planNotFound(reply);
      let updated: Array<{ id: string }>;
      try {
        // Non-key UPDATE: takes no space lock and doesn't block uploads in progress; no check against current usage.
        updated = await deps.db.update(groups).set({ storagePlanId: parsed.data.planId.toLowerCase() }).where(eq(groups.id, id)).returning({ id: groups.id });
      } catch (err) {
        if (foreignKeyViolationConstraint(err) === "groups_storage_plan_fk") return planNotFound(reply);
        throw err;
      }
      if (updated.length === 0) return groupNotFound(reply);
      return (await groupDto(id))[0];
    });
  };
}
