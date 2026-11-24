// Not a site-wide directory (that would let any logged-in user enumerate every email): only people the caller already knows. Fellow group members (their emails are already visible via
// GET /api/groups/:id/members; drop this branch if that is withdrawn) and people the caller shared their own non-trashed notes with. Deliberately excludes people who shared notes with me
// (the UI shows only their handle, not email), self and disabled accounts (which can still be added or shared with by typing the full email). Queried live, no cache. Session-only: token scopes don't cover people lookup, and Bearer would give a leaked token an email-harvesting route.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql } from "drizzle-orm";
import {
  USER_SUGGEST_MAX_QUERY, USER_SUGGEST_MAX_RESULTS, USER_SUGGEST_MIN_QUERY, type UserSuggestResponse, type UserSuggestionDto,
} from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { escapeLike } from "../db/like.js";
import { knownUserIdsSql } from "../knowledge/members.js";
import { readAvatarRefs } from "../avatars/read.js";
import { sendError } from "../http/errors.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";

const suggestQuerySchema = z
  .object({
    q: z
      .string()
      .transform(s => s.trim())
      .pipe(z.string().min(USER_SUGGEST_MIN_QUERY, "The query is too short.").max(USER_SUGGEST_MAX_QUERY, "The query is too long.")),
  })
  .strict();

export interface UsersRouteDeps {
  db: Db;
  limiters: { userSuggest: FixedWindowLimiter };
}

export function usersRoutes(deps: UsersRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get("/api/users/suggest", { preHandler: app.authenticate }, async (request, reply) => {
      const parsed = suggestQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");
      const me = request.user!.id;
      if (!deps.limiters.userSuggest.consume(me)) return sendError(reply, 429, "too_many_requests", "Too many requests. Wait a moment and try again.");

      const escaped = escapeLike(parsed.data.q);
      const contains = `%${escaped}%`;
      const prefix = `${escaped}%`;
      // lower() on both sides so JS and PG case rules can't disagree.
      const res = await deps.db.execute<{ id: string; email: string; display_name: string }>(sql`
        with known as (${knownUserIdsSql(me)})
        select u.id, u.email, u.display_name
          from known k
          join users u on u.id = k.id
         where u.id <> ${me}
           and u.disabled_at is null
           and (lower(u.email) like lower(${contains}) escape '\\'
                or lower(u.display_name) like lower(${contains}) escape '\\')
         order by case when lower(u.email) like lower(${prefix}) escape '\\'
                         or lower(u.display_name) like lower(${prefix}) escape '\\' then 0 else 1 end,
                  u.display_name, u.id
         limit ${USER_SUGGEST_MAX_RESULTS}
      `);
      const avatars = await readAvatarRefs(deps.db, res.rows.map(r => r.id));
      const users = res.rows.map((r): UserSuggestionDto => ({ userId: r.id, email: r.email, displayName: r.display_name, avatar: avatars.get(r.id) ?? null }));
      const dto: UserSuggestResponse = { users };
      return dto;
    });
  };
}
