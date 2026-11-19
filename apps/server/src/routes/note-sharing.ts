import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { and, eq, isNull, sql } from "drizzle-orm";
import { normalizeEmail, NOTE_WIDTHS, type ShareDto } from "@knotebook/shared";
import { sendError } from "../http/errors.js";
import { TxAbort } from "../http/tx-abort.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import type { Db } from "../db/index.js";
import { noteShares, notes, users } from "../db/schema.js";
import { isForeignKeyViolation, uniqueViolationConstraint } from "../db/pg-errors.js";
import { readAvatarRefs } from "../avatars/read.js";
import type { CollabHooks } from "../collab/hooks.js";
import type { GroupTestHook } from "../groups/test-hook.js";
import { resolveNoteAccess, UUID_RE, type NoteAccess } from "../notes/service.js";
import { upsertShareInTx } from "../notes/tx/shares.js";
import { prepareSlugForPatch } from "../notes/slug.js";

const putShareBodySchema = z.object({ email: z.string().email(), role: z.enum(["viewer", "editor"]) });
const publicWidthBodySchema = z.object({ width: z.enum(NOTE_WIDTHS) }).strict();

export interface NoteSharingRouteDeps {
  db: Db;
  collabHooks: CollabHooks;
  limiters: { slugPatch: FixedWindowLimiter; publicLink: FixedWindowLimiter; publicWidth: FixedWindowLimiter };
  groupTestHook?: GroupTestHook;
  /** notesRoutes' helper, shared with PATCH. */
  ownershipChanged: (reply: FastifyReply, noteId: string) => Promise<FastifyReply>;
}

/** Register from notesRoutes on the same instance, so these routes share its encapsulation context. The 404-vs-403 access rule is documented on notesRoutes in notes.ts. */
export function noteSharingRoutes(deps: NoteSharingRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    const { ownershipChanged } = deps;

    // permissions.manageShares is owner-of-personal-note only; group notes are always 403 (#175).
    app.get("/api/notes/:id/shares", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;

      const access = await resolveNoteAccess(deps.db, userId, id);
      if (access.role === "none") {
        return sendError(reply, 404, "not_found", "No note with that id.");
      }
      if (!access.permissions.manageShares) {
        return sendError(reply, 403, "forbidden", "Only the note's owner can see who it's shared with.");
      }

      const rows = await deps.db
        .select({ userId: noteShares.userId, email: users.email, displayName: users.displayName, role: noteShares.role })
        .from(noteShares)
        .innerJoin(users, eq(users.id, noteShares.userId))
        .where(eq(noteShares.noteId, id))
        .orderBy(users.email);

      const avatars = await readAvatarRefs(deps.db, rows.map(r => r.userId));
      return rows.map((row): ShareDto => ({
        userId: row.userId, email: row.email, displayName: row.displayName, role: row.role as ShareDto["role"], avatar: avatars.get(row.userId) ?? null,
      }));
    });

    app.put("/api/notes/:id/shares", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;

      const parsed = putShareBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");
      }

      const access = await resolveNoteAccess(deps.db, userId, id);
      if (access.role === "none") {
        return sendError(reply, 404, "not_found", "No note with that id.");
      }
      if (!access.permissions.manageShares) {
        return sendError(reply, 403, "forbidden", "Only the note's owner can manage sharing.");
      }

      const [target] = await deps.db
        .select()
        .from(users)
        .where(sql`lower(${users.email}) = ${normalizeEmail(parsed.data.email)}`)
        .orderBy(users.createdAt, users.id)
        .limit(1);
      if (!target) {
        return sendError(reply, 404, "user_not_found", "No user with that email.");
      }
      if (target.id === userId) {
        return sendError(reply, 400, "cannot_share_with_self", "You can't share a note with yourself.");
      }

      await deps.groupTestHook?.("share-authorized", { noteId: id });
      try {
        await deps.db.transaction(tx => upsertShareInTx(tx, { noteId: id, targetUserId: target.id, role: parsed.data.role }, deps.groupTestHook));
      } catch (err) {
        if (err instanceof TxAbort) return sendError(reply, err.status, err.errCode, err.message);
        // An FK violation means the note or target user vanished after authorization: 404 without saying which. The catch is outside the transaction (an error inside leaves it aborted).
        if (isForeignKeyViolation(err)) {
          return sendError(reply, 404, "not_found", "No note with that id.");
        }
        throw err;
      }

      // Always called, without looking up the old role: a redundant call is a harmless re-handshake, but missing a downgrade would let a revoked user keep editing.
      deps.collabHooks.onShareChanged(id, target.id);

      const avatars = await readAvatarRefs(deps.db, [target.id]);
      const dto: ShareDto = { userId: target.id, email: target.email, displayName: target.displayName, role: parsed.data.role, avatar: avatars.get(target.id) ?? null };
      return dto;
    });

    app.delete("/api/notes/:id/shares/:userId", { preHandler: app.authenticate }, async (request, reply) => {
      const { id, userId: targetUserId } = request.params as { id: string; userId: string };
      const userId = request.user!.id;

      const access = await resolveNoteAccess(deps.db, userId, id);
      if (access.role === "none") {
        return sendError(reply, 404, "not_found", "No note with that id.");
      }
      if (!access.permissions.manageShares) {
        return sendError(reply, 403, "forbidden", "Only the note's owner can manage sharing.");
      }

      // A malformed :userId would make pg throw (500); same 404 as no share row.
      if (!UUID_RE.test(targetUserId)) {
        return sendError(reply, 404, "share_not_found", "This note isn't shared with that user.");
      }

      const [deleted] = await deps.db
        .delete(noteShares)
        .where(and(eq(noteShares.noteId, id), eq(noteShares.userId, targetUserId)))
        .returning();
      if (!deleted) {
        return sendError(reply, 404, "share_not_found", "This note isn't shared with that user.");
      }

      deps.collabHooks.onShareChanged(id, targetUserId);

      return reply.code(204).send();
    });

    /**
     * Three limiters side by side, on purpose: token PUT/DELETE = publicLink, consumed before authorization and before resolveRole's query like collab-token (key=userId, so strangers
     * guessing noteIds only drain their own; 403/404 count too); alias PUT/DELETE = slugPatch (shared with PATCH's slug branch, 10 per 10 min), authorize first then charge, malformed
     * bodies count (no zod pre-parse); width PUT = publicWidth, parse → authorize → charge (not publicLink: rapid width clicks would push an unpublish into 429).
     * Width needs no public link and isn't reset by unpublish, move or transfer.
     * None of these touch updated_at (sharing isn't a content change). GET/PUT token and alias responses carry the full {token, slug, width} because the web writes them straight into its cache; width PUT returns only {width}.
     * Token PUT regenerates every time (not idempotent, and PUT may be auto-retried per RFC 9110; client convention: GET first, PUT only if null): if an auto-retrying middleware
     * appears, split it into create-if-absent + rotate.
     */
    const resolvePublicLinkAccess = async (reply: FastifyReply, userId: string, noteId: string): Promise<NoteAccess | null> => {
      const access = await resolveNoteAccess(deps.db, userId, noteId);
      if (access.role === "none") {
        sendError(reply, 404, "not_found", "No note with that id.");
        return null;
      }
      if (!access.permissions.managePublicLink) {
        sendError(reply, 403, "forbidden", "You don't have permission to manage this note's public link.");
        return null;
      }
      return access;
    };

    app.get("/api/notes/:id/public-link", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!(await resolvePublicLinkAccess(reply, request.user!.id, id))) return reply;
      const [row] = await deps.db
        .select({ publicToken: notes.publicToken, publicSlug: notes.publicSlug, publicWidth: notes.publicWidth })
        .from(notes)
        .where(eq(notes.id, id))
        .limit(1);
      if (!row) return sendError(reply, 404, "not_found", "No note with that id.");
      return { token: row.publicToken, slug: row.publicSlug, width: row.publicWidth };
    });

    app.put("/api/notes/:id/public-link", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;
      if (!deps.limiters.publicLink.consume(userId)) {
        return sendError(reply, 429, "too_many_requests", "Too many requests. Wait a moment and try again.");
      }
      const access = await resolvePublicLinkAccess(reply, userId, id);
      if (!access) return reply;
      const token = randomBytes(32).toString("base64url");
      // An UPDATE miss means the note was deleted after the decision → 404 (not a 200 with a never-persisted token). The predicate carries the authorization-time ownership and
      // excludes trashed notes (else a public link could be opened inside the trash). Regeneration keeps alias and width.
      await deps.groupTestHook?.("public-link-authorized", { noteId: id });
      const updated = await deps.db
        .update(notes)
        .set({ publicToken: token })
        .where(and(eq(notes.id, id), sql`${notes.groupId} is not distinct from ${access.groupId}`, isNull(notes.deletedAt)))
        .returning({ id: notes.id, publicSlug: notes.publicSlug, publicWidth: notes.publicWidth });
      if (updated.length === 0) return ownershipChanged(reply, id);
      return { token, slug: updated[0].publicSlug, width: updated[0].publicWidth };
    });

    app.delete("/api/notes/:id/public-link", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;
      if (!deps.limiters.publicLink.consume(userId)) {
        return sendError(reply, 429, "too_many_requests", "Too many requests. Wait a moment and try again.");
      }
      if (!(await resolvePublicLinkAccess(reply, userId, id))) return reply;
      // Only a miss of the note itself is 404; a null token is an idempotent 204. The same UPDATE clears public_slug (a leftover alias would hold the unique index and revive on regeneration). A trashed note is a miss (404) and keeps token and alias, so the link returns on restore (#181).
      await deps.groupTestHook?.("public-link-authorized", { noteId: id });
      const cleared = await deps.db
        .update(notes)
        .set({ publicToken: null, publicSlug: null })
        .where(and(eq(notes.id, id), isNull(notes.deletedAt)))
        .returning({ id: notes.id });
      if (cleared.length === 0) return sendError(reply, 404, "not_found", "No note with that id.");
      return reply.code(204).send();
    });

    app.put("/api/notes/:id/public-width", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;
      const parsed = publicWidthBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) return sendError(reply, 400, "invalid_body", "Invalid request body: send only width, set to standard, wide or full.");
      const access = await resolvePublicLinkAccess(reply, userId, id);
      if (!access) return reply;
      if (!deps.limiters.publicWidth.consume(userId)) {
        return sendError(reply, 429, "too_many_requests", "Too many requests. Wait a moment and try again.");
      }
      await deps.groupTestHook?.("public-link-authorized", { noteId: id });
      const updated = await deps.db
        .update(notes)
        .set({ publicWidth: parsed.data.width })
        .where(and(eq(notes.id, id), sql`${notes.groupId} is not distinct from ${access.groupId}`, isNull(notes.deletedAt)))
        .returning({ publicWidth: notes.publicWidth });
      if (updated.length === 0) return ownershipChanged(reply, id);
      return { width: updated[0].publicWidth };
    });

    /** "Note is public" is not pre-read: the conditional UPDATE's `public_token IS NOT NULL` predicate closes the set-alias/unpublish TOCTOU. Rowcount 0 → 400 (not public, group note, ownership changed, or deleted
     * after authorization; the last deliberately isn't 404 like elsewhere: the window is tiny, 400 leaks nothing more, and telling them apart would need another read). */
    app.put("/api/notes/:id/public-link/slug", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;
      if (!(await resolvePublicLinkAccess(reply, userId, id))) return reply;
      if (!deps.limiters.slugPatch.consume(userId)) {
        return sendError(reply, 429, "too_many_requests", "Too many requests. Wait a moment and try again.");
      }
      const body = request.body as { slug?: unknown } | null;
      if (!body || typeof body.slug !== "string") {
        return sendError(reply, 400, "invalid_body", "slug must be a string.");
      }
      const result = prepareSlugForPatch(body.slug);
      if (!result.ok) {
        return sendError(reply, 400, "invalid_body", result.message);
      }
      // `owner_id = me` covers group notes without any race (a group member with managePublicLink on a published group note would otherwise hit notes_group_no_public_slug_chk
      // → 500) and both directions of ownership change after authorization; checking only group_id IS NULL would let a former member's alias land in a new owner's /p/ namespace.
      await deps.groupTestHook?.("public-link-authorized", { noteId: id });
      let updated;
      try {
        updated = await deps.db
          .update(notes)
          .set({ publicSlug: result.value })
          .where(and(eq(notes.id, id), sql`${notes.publicToken} is not null`, eq(notes.ownerId, userId), isNull(notes.deletedAt)))
          .returning({ publicToken: notes.publicToken, publicSlug: notes.publicSlug, publicWidth: notes.publicWidth });
      } catch (err) {
        if (uniqueViolationConstraint(err) === "notes_owner_public_slug_idx") {
          return sendError(reply, 409, "public_slug_taken", "Another of your notes already uses that public URL.");
        }
        throw err;
      }
      if (updated.length === 0) {
        return sendError(reply, 400, "invalid_body", "Can't set a public URL: the note has no public link, is a group note, or changed owner after you sent this.");
      }
      return { token: updated[0].publicToken, slug: updated[0].publicSlug, width: updated[0].publicWidth };
    });

    app.delete("/api/notes/:id/public-link/slug", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;
      if (!(await resolvePublicLinkAccess(reply, userId, id))) return reply;
      if (!deps.limiters.slugPatch.consume(userId)) {
        return sendError(reply, 429, "too_many_requests", "Too many requests. Wait a moment and try again.");
      }
      // DELETE is vacuous on rowcount 0 (204), unlike DELETE /public-link (404): each keeps its own convention (pinned by the public-link-authorized hook in trash-rereads.test.ts). Trashed notes keep the alias.
      await deps.groupTestHook?.("public-link-authorized", { noteId: id });
      await deps.db.update(notes).set({ publicSlug: null }).where(and(eq(notes.id, id), isNull(notes.deletedAt)));
      return reply.code(204).send();
    });
  };
}
