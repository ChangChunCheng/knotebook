// Session-only, like /api/users/suggest: token scopes don't cover people lookup.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { KNOWLEDGE_MEMBERS_LOOKUP_MAX, type KnowledgeMembersDto } from "@knotebook/shared";
import { sendInvalidBody } from "../auth/admin-provider-input.js";
import type { Db } from "../db/index.js";
import { sendError } from "../http/errors.js";
import { knowledgeMemberUsers, resolveKnowledgeMemberTokens } from "../knowledge/members.js";
import { UUID_RE, resolveNoteAccess } from "../notes/service.js";

const KNOWLEDGE_MEMBERS_NOT_FOUND_MESSAGE = "No note with that id.";

// Bounds only what is parsed; a value that can't be a handle or a user id is simply not found.
const bodySchema = z
  .object({
    noteId: z.string().regex(UUID_RE),
    tokens: z.array(z.string().max(200)).max(KNOWLEDGE_MEMBERS_LOOKUP_MAX).optional(),
    ids: z.array(z.string().max(200)).max(KNOWLEDGE_MEMBERS_LOOKUP_MAX).optional(),
  })
  .strict();

export interface KnowledgeMembersRouteDeps {
  db: Db;
}

export function knowledgeMembersRoutes(deps: KnowledgeMembersRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.post("/api/knowledge/members", { preHandler: app.authenticate }, async (request, reply) => {
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) return sendInvalidBody(reply, parsed.error);
      const userId = request.user!.id;
      const access = await resolveNoteAccess(deps.db, userId, parsed.data.noteId.toLowerCase());
      if (access.role === "none") return sendError(reply, 404, "not_found", KNOWLEDGE_MEMBERS_NOT_FOUND_MESSAGE);
      const tokens = [...new Set((parsed.data.tokens ?? []).map(t => t.toLowerCase()))];
      const ids = parsed.data.ids ?? [];
      const [idOf, users] = await Promise.all([resolveKnowledgeMemberTokens(deps.db, userId, tokens), knowledgeMemberUsers(deps.db, ids)]);
      const dto: KnowledgeMembersDto = {
        byId: [...users.entries()].map(([id, u]) => ({ id, handle: u.handle, displayName: u.displayName })),
        byToken: tokens.flatMap(token => {
          const id = idOf.get(token);
          return id === undefined ? [] : [{ token, id }];
        }),
      };
      return reply.send(dto);
    });
  };
}
