// DELETE has no access check: it only touches the caller's row, so users can remove a note they just lost access to. Rows survive trash, unshare, removal from the group and role
// loss and return with their original add time; only removal or permanent delete (FK cascade) deletes them. The 404 sources are byte-identical so existence isn't leaked; 400/404
// before authorization don't charge. Single statements, no transaction.
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { FavoriteDto } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { addFavorite, listFavorites, removeFavorite } from "../favorites/queries.js";
import type { GroupTestHook } from "../groups/test-hook.js";
import { sendError } from "../http/errors.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import { resolveNoteAccess, UUID_RE } from "../notes/service.js";

export interface FavoritesRouteDeps {
  db: Db;
  limiters: { favorite: FixedWindowLimiter };
  groupTestHook?: GroupTestHook;
}

/** Body optional (web sends no Content-Type without one) but must be `{}`: extra fields give 400 so a client learns this server doesn't know them. */
const putBodySchema = z.object({}).strict();

export function favoritesRoutes(deps: FavoritesRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    const noteNotFound = (reply: FastifyReply): FastifyReply => sendError(reply, 404, "not_found", "No note with that id.");
    const tooManyRequests = (reply: FastifyReply): FastifyReply =>
      sendError(reply, 429, "too_many_requests", "Too many requests. Wait a moment and try again.");

    app.get("/api/favorites", { preHandler: app.authenticate }, async (request, reply) => {
      return reply.send((await listFavorites(deps.db, request.user!.id)) satisfies FavoriteDto[]);
    });

    app.put("/api/favorites/:id", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;
      if (!UUID_RE.test(id)) return noteNotFound(reply);
      // Only a missing body counts as `{}`; JSON null is a body.
      if (!putBodySchema.safeParse(request.body === undefined ? {} : request.body).success) {
        return sendError(reply, 400, "invalid_body", "Invalid request body.");
      }
      if ((await resolveNoteAccess(deps.db, userId, id)).role === "none") return noteNotFound(reply);
      if (!deps.limiters.favorite.consume(userId)) return tooManyRequests(reply);
      await deps.groupTestHook?.("favorite-authorized", { noteId: id });
      const out = await addFavorite(deps.db, { userId, noteId: id });
      if (out === "gone") return noteNotFound(reply);
      return reply.send(out satisfies FavoriteDto);
    });

    app.delete("/api/favorites/:id", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;
      if (!UUID_RE.test(id)) return noteNotFound(reply);
      if (!deps.limiters.favorite.consume(userId)) return tooManyRequests(reply);
      await removeFavorite(deps.db, { userId, noteId: id });
      return reply.code(204).send();
    });
  };
}
