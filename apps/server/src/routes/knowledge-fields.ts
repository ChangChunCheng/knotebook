import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { KNOWLEDGE_CUSTOM_FIELD_TYPES, type KnowledgeFieldKey, type KnowledgeFieldsDto, type SiteKnowledgeFieldsInput } from "@knotebook/shared";
import { sendInvalidBody } from "../auth/admin-provider-input.js";
import type { Db } from "../db/index.js";
import { sendError } from "../http/errors.js";
import { TxAbort } from "../http/tx-abort.js";
import { loadAdminKnowledgeFields, loadKnowledgeFieldView } from "../knowledge/fields/queries.js";
import { writeSiteKnowledgeFieldsInTx } from "../knowledge/fields/tx/write-site-fields.js";
import { KNOWLEDGE_FIELDS_NOT_FOUND_MESSAGE } from "../knowledge/messages.js";
import { resolveKnowledgeScope } from "../knowledge/scope.js";
import { noNul } from "../notes/schemas.js";
import { UUID_RE, resolveNoteAccess } from "../notes/service.js";

const viewQuerySchema = z
  .object({ note: z.string().regex(UUID_RE).optional(), group: z.string().regex(UUID_RE).optional() })
  .strict()
  .refine((q) => q.note === undefined || q.group === undefined);

// Bounds only the size of what is parsed; the real limits and their error codes are checked in the write.
const optionSchema = z.object({ key: z.string().max(200), name: z.string().max(1000).refine(noNul).nullable(), enabled: z.boolean() }).strict();
const fieldSchema = z
  .object({
    key: z.string().max(200),
    enabled: z.boolean(),
    name: z.string().max(1000).refine(noNul).nullable().optional(),
    type: z.enum(KNOWLEDGE_CUSTOM_FIELD_TYPES).optional(),
    options: z.array(optionSchema).max(500).optional(),
  })
  .strict();
const putSchema = z.object({ fields: z.array(fieldSchema).max(200) }).strict();

export interface KnowledgeFieldsRouteDeps {
  db: Db;
}

export function knowledgeFieldsRoutes(deps: KnowledgeFieldsRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    const notFound = (reply: FastifyReply): FastifyReply => sendError(reply, 404, "not_found", KNOWLEDGE_FIELDS_NOT_FOUND_MESSAGE);

    app.get("/api/knowledge/fields", { preHandler: app.authenticate }, async (request, reply) => {
      const query = viewQuerySchema.safeParse(request.query ?? {});
      if (!query.success) return notFound(reply);
      const userId = request.user!.id;
      let groupId: string | null = null;
      if (query.data.note !== undefined) {
        const access = await resolveNoteAccess(deps.db, userId, query.data.note.toLowerCase());
        if (access.role === "none") return notFound(reply);
        groupId = access.groupId;
      } else if (query.data.group !== undefined) {
        const scope = await resolveKnowledgeScope(deps.db, userId, { kind: "group", groupId: query.data.group });
        if (scope === null) return notFound(reply);
        groupId = query.data.group.toLowerCase();
      }
      const view = await loadKnowledgeFieldView(deps.db, { groupId });
      const dto: KnowledgeFieldsDto = { fields: view.fields };
      return reply.send(dto);
    });

    app.get("/api/admin/knowledge-fields", { preHandler: app.requireAdmin }, async (_request, reply) => reply.send(await loadAdminKnowledgeFields(deps.db)));

    app.put("/api/admin/knowledge-fields", { preHandler: app.requireAdmin }, async (request, reply) => {
      const parsed = putSchema.safeParse(request.body);
      if (!parsed.success) return sendInvalidBody(reply, parsed.error);
      const input: SiteKnowledgeFieldsInput = {
        fields: parsed.data.fields.map((f) => ({ ...f, key: f.key as KnowledgeFieldKey })),
      };
      try {
        return reply.send(await deps.db.transaction((tx) => writeSiteKnowledgeFieldsInTx(tx, input)));
      } catch (err) {
        if (err instanceof TxAbort) return sendError(reply, err.status, err.errCode, err.message);
        throw err;
      }
    });
  };
}
