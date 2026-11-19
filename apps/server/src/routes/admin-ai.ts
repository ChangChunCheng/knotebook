import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import {
  BUILTIN_ACTION_IDS,
  INSTRUCT_ACTION_ID,
  aiActionKind,
  type AdminAiActionDto,
  type AdminAiModelDto,
  type AdminAiProviderDto,
} from "@knotebook/shared";
import { sendError } from "../http/errors.js";
import type { Db } from "../db/index.js";
import type { AppConfig } from "../config.js";
import { aiActions, aiModels, aiProviders } from "../db/schema.js";
import { AiKeyDecryptError, decryptApiKey, encryptApiKey, type EncryptedApiKey } from "../ai/crypto.js";
import type { AiRuntime } from "../ai/runtime.js";
import { isForeignKeyViolation, isUniqueViolation } from "../db/pg-errors.js";
import { UUID_RE } from "../notes/service.js";
import { safeTarget } from "../lib/safe-target.js";
import { redactDbError } from "../lib/redact-db-error.js";
import { fetchErrorSummary, urlHasCredentials } from "../lib/fetch-error-summary.js";

export interface AdminAiRouteDeps {
  db: Db;
  config: AppConfig;
  runtime: AiRuntime;
}


const providerTypeEnum = z.enum(["openai_compatible", "anthropic"]);

// No credentials in the base URL (user:pass@host, and also user@host): Node fetch rejects them anyway and baseUrl is plaintext (DB, GET, logs); use the
// API key field. Checked via URL username/password, not string matching.
const BASE_URL_CREDENTIALS_CODE = "base_url_has_credentials" as const;
const baseUrlSchema = z
  .string()
  .url()
  .refine(
    (value) => {
      // zod still runs refine after `.url()` fails, and `new URL` throws with `input` (including the password) that the global handler would log; let parse failures through.
      try {
        const u = new URL(value);
        return u.username === "" && u.password === "";
      } catch {
        return true;
      }
    },
    { message: "The base URL can't contain a username or password. Put credentials in the API key field.", params: { code: BASE_URL_CREDENTIALS_CODE } },
  );

function providerBodyError(error: z.ZodError): { code: "invalid_body" | typeof BASE_URL_CREDENTIALS_CODE; message: string } {
  const issue = error.issues[0];
  const hasCredentials = (issue as { params?: { code?: string } } | undefined)?.params?.code === BASE_URL_CREDENTIALS_CODE;
  return { code: hasCredentials ? BASE_URL_CREDENTIALS_CODE : "invalid_body", message: issue?.message ?? "Invalid request body." };
}

const createProviderSchema = z.object({
  name: z.string().min(1),
  type: providerTypeEnum,
  baseUrl: baseUrlSchema,
  apiKey: z.string().min(1).optional(),
});

const patchProviderSchema = z.object({
  name: z.string().min(1).optional(),
  type: providerTypeEnum.optional(),
  baseUrl: baseUrlSchema.optional(),
  apiKey: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});

// `hasKey` is computed in SQL so the ciphertext never enters Node memory (stronger than omitting it at serialization). No response may contain api_key_encrypted/ct/iv/tag/keyId.
const providerListColumns = {
  id: aiProviders.id,
  name: aiProviders.name,
  type: aiProviders.type,
  baseUrl: aiProviders.baseUrl,
  enabled: aiProviders.enabled,
  createdAt: aiProviders.createdAt,
  hasKey: sql<boolean>`${aiProviders.apiKeyEncrypted} is not null`,
};

interface ProviderListRow {
  id: string;
  name: string;
  type: string;
  baseUrl: string;
  enabled: boolean;
  createdAt: Date;
  hasKey: boolean;
}

function toProviderDto(row: ProviderListRow, runtime: AiRuntime): AdminAiProviderDto {
  return {
    id: row.id,
    name: row.name,
    type: row.type as "openai_compatible" | "anthropic",
    baseUrl: row.baseUrl,
    enabled: row.enabled,
    hasKey: row.hasKey,
    degraded: runtime.degraded.has(row.id),
    createdAt: row.createdAt.toISOString(),
  };
}


const createModelSchema = z.object({
  providerId: z.string().uuid(),
  modelId: z.string().min(1),
  displayName: z.string().min(1),
  purpose: z.literal("chat").optional(),
  isDefault: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

const patchModelSchema = z.object({
  providerId: z.string().uuid().optional(),
  modelId: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  purpose: z.literal("chat").optional(),
  isDefault: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

type AiModelRow = typeof aiModels.$inferSelect;

function toModelDto(row: AiModelRow): AdminAiModelDto {
  return {
    id: row.id,
    providerId: row.providerId,
    modelId: row.modelId,
    displayName: row.displayName,
    purpose: "chat",
    isDefault: row.isDefault,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
  };
}


const actionApplyModeEnum = z.enum(["direct", "preview"]);
const userTemplateSchema = z.string().min(1).refine(v => v.includes("{{text}}"), "userTemplate must contain the {{text}} placeholder.");

const createActionSchema = z.object({
  name: z.string().min(1),
  systemPrompt: z.string().min(1),
  userTemplate: userTemplateSchema,
  modelId: z.string().uuid().nullable().optional(),
  applyMode: actionApplyModeEnum,
  sortOrder: z.number().int().optional(),
  enabled: z.boolean().optional(),
});

const patchActionSchema = z.object({
  name: z.string().min(1).optional(),
  systemPrompt: z.string().min(1).optional(),
  userTemplate: userTemplateSchema.optional(),
  modelId: z.string().uuid().nullable().optional(),
  applyMode: actionApplyModeEnum.optional(),
  sortOrder: z.number().int().optional(),
  enabled: z.boolean().optional(),
});

type AiActionRow = typeof aiActions.$inferSelect;

function toActionDto(row: AiActionRow): AdminAiActionDto {
  return {
    id: row.id,
    name: row.name,
    systemPrompt: row.systemPrompt,
    userTemplate: row.userTemplate,
    modelId: row.modelId,
    applyMode: row.applyMode as "direct" | "preview",
    sortOrder: row.sortOrder,
    enabled: row.enabled,
    builtin: BUILTIN_ACTION_IDS.includes(row.id),
    kind: aiActionKind(row.id),
  };
}

export function adminAiRoutes(deps: AdminAiRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {

    app.get("/api/admin/ai/providers", { preHandler: app.requireAdmin }, async () => {
      const rows = await deps.db.select(providerListColumns).from(aiProviders).orderBy(asc(aiProviders.createdAt), asc(aiProviders.id));
      return { providers: rows.map(r => toProviderDto(r, deps.runtime)) };
    });

    app.post("/api/admin/ai/providers", { preHandler: app.requireAdmin }, async (request, reply) => {
      const parsed = createProviderSchema.safeParse(request.body);
      if (!parsed.success) {
        const failure = providerBodyError(parsed.error);
        return sendError(reply, 400, failure.code, failure.message);
      }
      const { name, type, baseUrl, apiKey } = parsed.data;

      // Generated here: the ciphertext AAD binds providerId (#14), so the id must exist before encryption.
      const id = randomUUID();
      const apiKeyEncrypted = apiKey !== undefined ? encryptApiKey(deps.config.appSecret, apiKey, id) : null;
      // DrizzleQueryError puts the SQL params (ciphertext, base_url with user:pass@) in its message, so always redact; there are no recognised errors here (ai_providers has no unique key or FK, and the zod enum pre-empts the type CHECK).
      const [row] = await deps.db
        .insert(aiProviders)
        .values({ id, name, type, baseUrl, apiKeyEncrypted })
        .returning(providerListColumns)
        .catch((err: unknown) => {
          throw redactDbError(request.log, err, "建立 AI provider");
        });
      return reply.code(201).send(toProviderDto(row, deps.runtime));
    });

    app.patch("/api/admin/ai/providers/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
      const { id: rawId } = request.params as { id: string };
      if (!UUID_RE.test(rawId)) return sendError(reply, 404, "not_found", "No AI provider with that id.");
      const id = rawId.toLowerCase();

      const parsed = patchProviderSchema.safeParse(request.body);
      if (!parsed.success) {
        const failure = providerBodyError(parsed.error);
        return sendError(reply, 400, failure.code, failure.message);
      }
      const { name, type, baseUrl, apiKey, enabled } = parsed.data;

      // Only for the log's `from`: non-transactional, so it can be stale under races (`to` and `hasKeyAfter` are reliable). The key-clearing decision is made DB-side below.
      // Deliberately doesn't select the ciphertext (same guard as providerListColumns).
      const [existing] = await deps.db
        .select({ baseUrl: aiProviders.baseUrl })
        .from(aiProviders)
        .where(eq(aiProviders.id, id))
        .limit(1);
      if (!existing) return sendError(reply, 404, "not_found", "No AI provider with that id.");

      const values: PgUpdateSetSource<typeof aiProviders> = {};
      if (name !== undefined) values.name = name;
      if (type !== undefined) values.type = type;
      if (baseUrl !== undefined) values.baseUrl = baseUrl;
      if (enabled !== undefined) values.enabled = enabled;

      let newEncrypted: EncryptedApiKey | undefined;
      if (apiKey !== undefined) {
        newEncrypted = encryptApiKey(deps.config.appSecret, apiKey, id);
        values.apiKeyEncrypted = newEncrypted;
      }

      /**
       * #46: changing baseUrl clears the stored key unless the same PATCH sets a new one. baseUrl has no allowlist, so otherwise any admin could edit baseUrl and press
       * Test to send the decrypted key to their own host (`/test` and AI calls send it as Authorization/x-api-key) with no DB or APP_SECRET access, bypassing "keys
       * can't be read back". Clearing the key is the cheapest cut that restricts no host (intranet Ollama keeps working). Not complete protection (an admin can still
       * re-point and wait for another admin to re-enter the key), but it leaves traces (key gone, URL changed, the log line below). Residual risk: docs/known-limitations.md.
       */
      if (baseUrl !== undefined && apiKey === undefined) {
        // Compared DB-side in the same UPDATE: a Node-side SELECT-then-compare is a TOCTOU (an attacker's no-op PATCH could read the old URL between a victim's
        // restore and key re-entry, leaving the attacker's URL with the victim's key). UPDATE locks the row and SET sees the old value, so nothing slips in;
        // the same expression keeps the key on rename-only edits (the form always sends baseUrl).
        values.apiKeyEncrypted = sql`case when ${aiProviders.baseUrl} is distinct from ${baseUrl} then null::jsonb else ${aiProviders.apiKeyEncrypted} end`;
      }

      // drizzle 0.44 `.set({})` throws synchronously ("No values to set") and would escape as a bare 500; reject with 400 first.
      if (Object.keys(values).length === 0) {
        return sendError(reply, 400, "invalid_body", "Invalid request body: send at least one field.");
      }

      const [row] = await deps.db
        .update(aiProviders)
        .set(values)
        .where(eq(aiProviders.id, id))
        .returning(providerListColumns)
        .catch((err: unknown) => {
          throw redactDbError(request.log, err, "修改 AI provider");
        });
      if (!row) return sendError(reply, 404, "not_found", "No AI provider with that id.");

      // Logged whenever baseUrl is given: conditioning on `existing` (a non-transactional read) can log nothing under the no-op-PATCH race, the one trace the docs rely on. Provider edits are admin-only and infrequent, so the noise is acceptable.
      if (baseUrl !== undefined) {
        // "written", not "changed": the UI sends baseUrl on every edit. Records row.hasKey (a DB fact) rather than "key cleared", which would be inferred from the racy read.
        request.log.info(
          {
            providerId: id,
            userId: request.user!.id,
            from: safeTarget(existing.baseUrl),
            to: safeTarget(baseUrl),
            hasKeyAfter: row.hasKey,
          },
          "AI provider 的 base URL 被寫入"
        );
      }

      if (newEncrypted !== undefined) {
        try {
          decryptApiKey(deps.config.appSecret, newEncrypted, id);
          deps.runtime.degraded.delete(id);
        } catch {
          // stay degraded
        }
      }

      // With no key it can't be "ciphertext undecryptable": clear degraded, else key-less providers (self-hosted Ollama) stay stuck on 503 (#17).
      // Judged by row.hasKey (DB result), not the racy non-transactional read.
      if (!row.hasKey) {
        deps.runtime.degraded.delete(id);
      }

      return reply.send(toProviderDto(row, deps.runtime));
    });

    app.delete("/api/admin/ai/providers/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
      const { id: rawId } = request.params as { id: string };
      if (!UUID_RE.test(rawId)) return sendError(reply, 404, "not_found", "No AI provider with that id.");
      const id = rawId.toLowerCase();

      // FK cascade: models are deleted and actions.modelId is set NULL.
      const [deleted] = await deps.db.delete(aiProviders).where(eq(aiProviders.id, id)).returning({ id: aiProviders.id });
      if (!deleted) return sendError(reply, 404, "not_found", "No AI provider with that id.");
      // Re-entering the key via PATCH is the only other way to clear a degraded entry.
      deps.runtime.degraded.delete(id);
      return reply.code(204).send();
    });

    app.post("/api/admin/ai/providers/:id/test", { preHandler: app.requireAdmin }, async (request, reply) => {
      const { id: rawId } = request.params as { id: string };
      if (!UUID_RE.test(rawId)) return sendError(reply, 404, "not_found", "No AI provider with that id.");
      const id = rawId.toLowerCase();

      // The one place that selects the ciphertext: the test needs the plaintext key. It never appears in a response.
      const [row] = await deps.db.select().from(aiProviders).where(eq(aiProviders.id, id)).limit(1);
      if (!row) return sendError(reply, 404, "not_found", "No AI provider with that id.");

      if (deps.runtime.degraded.has(id)) {
        return sendError(reply, 503, "provider_unavailable", "This provider's API key can't be read. Enter the API key again in the admin settings.");
      }

      let apiKey: string | undefined;
      if (row.apiKeyEncrypted !== null) {
        try {
          apiKey = decryptApiKey(deps.config.appSecret, row.apiKeyEncrypted, id);
        } catch (err) {
          if (!(err instanceof AiKeyDecryptError)) throw err;
          deps.runtime.degraded.add(id);
          return sendError(reply, 503, "provider_unavailable", "This provider's API key can't be read. Enter the API key again in the admin settings.");
        }
      }

      const url = row.type === "anthropic" ? `${row.baseUrl}/v1/models` : `${row.baseUrl}/models`;
      try {
        const headers: Record<string, string> =
          row.type === "anthropic"
            ? { "anthropic-version": "2023-06-01", ...(apiKey !== undefined ? { "x-api-key": apiKey } : {}) }
            : apiKey !== undefined
              ? { authorization: `Bearer ${apiKey}` }
              : {};
        // redirect: "manual": undici strips only Authorization/Cookie on cross-origin redirects, but auth here is x-api-key or a hand-built Bearer header, so a 302 would forward the key to a third party. 3xx falls into !res.ok → 502.
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000), redirect: "manual" });
        if (!res.ok) {
          // Logged only (may hold key fragments), cut to 2 KiB so a hostile upstream can't flood the log.
          const bodyText = await res.text();
          const truncatedBody = bodyText.length > 2048 ? `${bodyText.slice(0, 2048)}...(truncated)` : bodyText;
          request.log.warn({ providerId: id, status: res.status, body: truncatedBody }, "AI provider 測試連線失敗（上游非 2xx）");
          return sendError(reply, 502, "upstream_error", "The AI provider returned an error.");
        }
        return reply.send({ ok: true });
      } catch (err) {
        // Don't log err: fetch's TypeError for a base_url with user:pass@ contains the full URL with the password. Log only diagnostic fields without the URL.
        request.log.warn(
          { providerId: id, target: safeTarget(url), urlHasCredentials: urlHasCredentials(url), ...fetchErrorSummary(err) },
          "AI provider 測試連線失敗（逾時或網路錯誤）"
        );
        return sendError(reply, 502, "upstream_error", "Couldn't reach the AI provider, or it timed out.");
      }
    });


    app.get("/api/admin/ai/models", { preHandler: app.requireAdmin }, async () => {
      const rows = await deps.db.select().from(aiModels).orderBy(asc(aiModels.createdAt), asc(aiModels.id));
      return { models: rows.map(toModelDto) };
    });

    app.post("/api/admin/ai/models", { preHandler: app.requireAdmin }, async (request, reply) => {
      const parsed = createModelSchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");
      const { providerId, modelId, displayName, isDefault, enabled } = parsed.data;

      try {
        const row = await deps.db.transaction(async tx => {
          // is_default uniqueness has no DB constraint; this transaction guarantees it.
          if (isDefault) {
            await tx.update(aiModels).set({ isDefault: false }).where(eq(aiModels.purpose, "chat"));
          }
          const [inserted] = await tx
            .insert(aiModels)
            .values({ providerId, modelId, displayName, purpose: "chat", isDefault: isDefault ?? false, enabled: enabled ?? true })
            .returning();
          return inserted;
        });
        return reply.code(201).send(toModelDto(row));
      } catch (err) {
        if (isUniqueViolation(err)) return sendError(reply, 409, "model_taken", "This provider already has that model.");
        if (isForeignKeyViolation(err)) return sendError(reply, 400, "invalid_body", "The given provider doesn't exist.");
        throw redactDbError(request.log, err, "建立 AI model");
      }
    });

    app.patch("/api/admin/ai/models/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
      const { id: rawId } = request.params as { id: string };
      if (!UUID_RE.test(rawId)) return sendError(reply, 404, "not_found", "No AI model with that id.");
      const id = rawId.toLowerCase();

      const parsed = patchModelSchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");
      const { providerId, modelId, displayName, isDefault, enabled } = parsed.data;

      const values: Partial<typeof aiModels.$inferInsert> = {};
      if (providerId !== undefined) values.providerId = providerId;
      if (modelId !== undefined) values.modelId = modelId;
      if (displayName !== undefined) values.displayName = displayName;
      if (enabled !== undefined) values.enabled = enabled;
      if (isDefault !== undefined) values.isDefault = isDefault;

      if (Object.keys(values).length === 0) {
        return sendError(reply, 400, "invalid_body", "Invalid request body: send at least one field.");
      }

      try {
        const row = await deps.db.transaction(async tx => {
          // Update the target first and unset the others only after it matched: unsetting first let a PATCH on a nonexistent id clear the site-wide default and then 404
          // (an empty returning() doesn't roll back). Safe inside one READ COMMITTED transaction: no other transaction can see two defaults.
          const [updated] = await tx.update(aiModels).set(values).where(eq(aiModels.id, id)).returning();
          if (!updated) return null;
          if (isDefault === true) {
            await tx.update(aiModels).set({ isDefault: false }).where(and(eq(aiModels.purpose, "chat"), ne(aiModels.id, id)));
          }
          return updated;
        });
        if (!row) return sendError(reply, 404, "not_found", "No AI model with that id.");
        return reply.send(toModelDto(row));
      } catch (err) {
        if (isUniqueViolation(err)) return sendError(reply, 409, "model_taken", "This provider already has that model.");
        if (isForeignKeyViolation(err)) return sendError(reply, 400, "invalid_body", "The given provider doesn't exist.");
        throw redactDbError(request.log, err, "修改 AI model");
      }
    });

    app.delete("/api/admin/ai/models/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
      const { id: rawId } = request.params as { id: string };
      if (!UUID_RE.test(rawId)) return sendError(reply, 404, "not_found", "No AI model with that id.");
      const id = rawId.toLowerCase();

      const [deleted] = await deps.db.delete(aiModels).where(eq(aiModels.id, id)).returning({ id: aiModels.id });
      if (!deleted) return sendError(reply, 404, "not_found", "No AI model with that id.");
      return reply.code(204).send();
    });


    app.get("/api/admin/ai/actions", { preHandler: app.requireAdmin }, async () => {
      const rows = await deps.db.select().from(aiActions).orderBy(asc(aiActions.sortOrder), asc(aiActions.id));
      return { actions: rows.map(toActionDto) };
    });

    app.post("/api/admin/ai/actions", { preHandler: app.requireAdmin }, async (request, reply) => {
      const parsed = createActionSchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");
      const { name, systemPrompt, userTemplate, modelId, applyMode, sortOrder, enabled } = parsed.data;

      try {
        const [row] = await deps.db
          .insert(aiActions)
          .values({
            name,
            systemPrompt,
            userTemplate,
            modelId: modelId ?? null,
            applyMode,
            sortOrder: sortOrder ?? 0,
            enabled: enabled ?? true,
          })
          .returning();
        return reply.code(201).send(toActionDto(row));
      } catch (err) {
        if (isForeignKeyViolation(err)) return sendError(reply, 400, "invalid_body", "The given model doesn't exist.");
        throw redactDbError(request.log, err, "建立 AI 動作");
      }
    });

    app.patch("/api/admin/ai/actions/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
      const { id: rawId } = request.params as { id: string };
      if (!UUID_RE.test(rawId)) return sendError(reply, 404, "not_found", "No AI action with that id.");
      // A second line behind http/uuid-params.ts, which already lowercases UUID path params (so switching to rawId fails no test; that's not a guard gap).
      const id = rawId.toLowerCase();

      const parsed = patchActionSchema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");
      const { name, systemPrompt, userTemplate, modelId, applyMode, sortOrder, enabled } = parsed.data;

      // #263: Instruct also needs {{instruction}} ({{focus}} optional).
      if (id === INSTRUCT_ACTION_ID) {
        if (applyMode === "direct") return sendError(reply, 400, "instruct_preview_only", "Instruct actions can only be applied after a preview.");
        if (userTemplate !== undefined && !userTemplate.includes("{{instruction}}")) {
          return sendError(reply, 400, "invalid_body", "userTemplate must contain the {{instruction}} placeholder.");
        }
      }

      const values: Partial<typeof aiActions.$inferInsert> = {};
      if (name !== undefined) values.name = name;
      if (systemPrompt !== undefined) values.systemPrompt = systemPrompt;
      if (userTemplate !== undefined) values.userTemplate = userTemplate;
      if (modelId !== undefined) values.modelId = modelId;
      if (applyMode !== undefined) values.applyMode = applyMode;
      if (sortOrder !== undefined) values.sortOrder = sortOrder;
      if (enabled !== undefined) values.enabled = enabled;

      if (Object.keys(values).length === 0) {
        return sendError(reply, 400, "invalid_body", "Invalid request body: send at least one field.");
      }

      try {
        const [row] = await deps.db.update(aiActions).set(values).where(eq(aiActions.id, id)).returning();
        if (!row) return sendError(reply, 404, "not_found", "No AI action with that id.");
        return reply.send(toActionDto(row));
      } catch (err) {
        if (isForeignKeyViolation(err)) return sendError(reply, 400, "invalid_body", "The given model doesn't exist.");
        throw redactDbError(request.log, err, "修改 AI 動作");
      }
    });

    app.delete("/api/admin/ai/actions/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
      const { id: rawId } = request.params as { id: string };
      if (!UUID_RE.test(rawId)) return sendError(reply, 404, "not_found", "No AI action with that id.");
      const id = rawId.toLowerCase();

      // Server half of the built-in protection (the UI hides the button too); refuses even ids absent from the DB.
      if (BUILTIN_ACTION_IDS.includes(id)) {
        return sendError(reply, 400, "builtin_action", "Built-in actions can't be deleted.");
      }

      const [deleted] = await deps.db.delete(aiActions).where(eq(aiActions.id, id)).returning({ id: aiActions.id });
      if (!deleted) return sendError(reply, 404, "not_found", "No AI action with that id.");
      return reply.code(204).send();
    });
  };
}
