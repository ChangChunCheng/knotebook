import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import {
  MAX_LINK_TARGETS,
  normalizeEmail,
  normalizeHandle,
  normalizeSlug,
  NOTE_WIDTHS,
  PALETTE_COLORS,
  type BacklinkDto,
  type ErrorCode,
  type NoteContentDto,
  type NoteDto,
  type NoteEditDto,
  type NoteEditResultDto,
  type NoteSectionDto,
  type ShareDto,
} from "@knotebook/shared";
import { WRITE_BODY_LIMIT } from "../http/body-limits.js";
import { sendError, sendInTrash, sendNoteTooLarge, sendStorageQuotaExceeded } from "../http/errors.js";
import { NOTE_WRITE_TOO_COMPLEX_MESSAGE, sendDocReadError, sendParserBusy, TOO_COMPLEX_MESSAGE } from "../http/parse-errors.js";
import type { ParseDetail } from "../notes/editing/markdown.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { readAvatarRefs } from "../avatars/read.js";
import type { SiteLimits } from "../site-limits/store.js";
import { groups, notePlacements, noteShares, notes, users } from "../db/schema.js";
import type { GroupTestHook } from "../groups/test-hook.js";
import { TxAbort } from "../http/tx-abort.js";
import type { CollabHooks } from "../collab/hooks.js";
import type { CollabServer } from "../collab/server.js";
import type { VersionService } from "../collab/versions.js";
import type { EditingRuntime } from "../notes/editing/runtime.js";
import { loadLastEdited, readNoteContent } from "../notes/editing/read.js";
import { listEdits } from "../notes/editing/revert.js";
import { presenceIdentity, presenceTargetForRead, type PresenceRegistry } from "../notes/editing/presence.js";
import { accessFromListRow, editor, visibleNoteBranches } from "../notes/list-query.js";
import { loadNoteFields, noteFieldsSelection, noteSizeBytesSql, placementJoinOn, toNoteDto, viewerFolderIdFor, type NoteFields } from "../notes/note-dto.js";
import { createBodySchema, editBodySchema, SEC, updateBodySchema } from "../notes/schemas.js";
import { renameNoteTitle } from "../notes/rename-note.js";
import { loadCreateTarget } from "../notes/create-target.js";
import { type NoteWriteService } from "../notes/editing/write-service.js";
import { insertNoteWithAutoSlug, type NoteCreateHooks } from "../notes/create.js";
import { currentAgentLabel } from "../auth/agent-label.js";
import {
  groupNotePermissions,
  OWNER_PERMISSIONS,
  resolveNoteAccess,
  resolveRole,
  resolveTrashedNoteAccess,
  roleFromGroupFlags,
  UUID_RE,
  type NoteAccess,
} from "../notes/service.js";
import { upsertShareInTx } from "../notes/tx/shares.js";
import { trashNote } from "../trash/service.js";
import { moveNoteToGroup } from "../notes/move-note.js";
import { copyNote } from "../notes/copy-note.js";
import type { SearchIndexHooks } from "../notes/tx/search-index.js";
import { patchSlugInTx, type SlugPatchTestHook, type SlugWriteScope } from "../notes/tx/patch-slug.js";
import { groupNotePath, userNotePath } from "../notes/redirects.js";
import { resolveNotePath, type PathRowSource } from "../notes/resolve-path.js";
import {
  deriveUniqueAutoSlug,
  fallbackAutoSlug,
  isSlugUniqueViolation,
  // Shared with notes/create.ts: both retry loops must use the same 5.
  MAX_AUTO_SLUG_RETRIES,
  prepareSlugForPatch,
  resolveNoteIdFromRef,
  type SlugScope,
} from "../notes/slug.js";
import { fetchBacklinks, normalizeLinkTargets, writeNoteLinks, type WriteNoteLinksHooks } from "../notes/links.js";
import { schemaVersionFromBody, signCollabToken } from "../collab/token.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import { isForeignKeyViolation, isNoteFolderSpaceViolation, isRetryableTxError, uniqueViolationConstraint } from "../db/pg-errors.js";
import { FOLDER_NOT_FOUND_MESSAGE, NOTE_FOLDER_CROSS_SPACE_MESSAGE, NOTE_FOLDER_ROLE_FORBIDDEN_MESSAGE } from "../folders/messages.js";
import { resolveFolderAccess, type FolderAccess } from "../folders/queries.js";
import { newNoteFolderConsistent } from "../folders/space.js";
import { StorageQuotaExceeded } from "../storage/tx/quota.js";
import { precheckDetail, quotaErrorDetail } from "../storage/usage.js";


const putShareBodySchema = z.object({ email: z.string().email(), role: z.enum(["viewer", "editor"]) });
// A non-UUID id is 404 from the route, byte-identical to a nonexistent one.
const moveBodySchema = z.object({ groupId: z.string(), folderId: z.string().optional() }).strict();
const copyBodySchema = z.object({ groupId: z.string().optional(), folderId: z.string().optional() }).strict();
const publicWidthBodySchema = z.object({ width: z.enum(NOTE_WIDTHS) }).strict();

// `.max(MAX_LINK_TARGETS * 2)` is only a coarse performance gate before uuid validation; the real limit is in normalizeLinkTargets (after dedup and self-link removal).
const linksBodySchema = z.object({ link_target_ids: z.array(z.string().uuid()).max(MAX_LINK_TARGETS * 2) });

const contentQuerySchema = z.object({ section: SEC.optional() }).strict();

/**
 * Non-retryable errors → null (caller rethrows). With a folder, a vanished group necessarily means the folder left that space (a transfer in flight lets the INSERT pass the trigger,
 * then fails on notes_group_id_groups_id_fk after commit), so it must be folder_not_found; don't narrow to KF001/notes_folder_fk.
 * 40P01: the INSERT is outside a transaction and RI triggers take groups/folders KEY SHARE in name order; after a pg_dump restore that cycles with delete-group (pinned by folders-race-ops).
 */
function sendCreateInsertFailure(reply: FastifyReply, err: unknown, withFolder: boolean): FastifyReply | null {
  if (isRetryableTxError(err)) return sendError(reply, 409, "server_busy", "The server is busy. Try again in a moment.");
  if (withFolder && (isNoteFolderSpaceViolation(err) || isForeignKeyViolation(err))) return sendError(reply, 404, "folder_not_found", FOLDER_NOT_FOUND_MESSAGE);
  if (isForeignKeyViolation(err)) return sendError(reply, 404, "group_not_found", "No group with that id.");
  return null;
}

const UNSUPPORTED_COLOR_MESSAGE = `That markdown uses a color this editor cannot show, so nothing was written. Use one of: ${PALETTE_COLORS.join(", ")}, or a hex color written #rgb or #rrggbb, such as #ff6600.`;
// Same trigger conditions as MCP `writeFailureMessage`.
const UNSUPPORTED_COLUMNS_MESSAGE =
  "That markdown has layout or editor-internal HTML this editor cannot store, so nothing was written. Write side-by-side columns exactly as GET /api/notes/:id/content returns them: <div data-kb-columns style=\"display:flex;gap:16px\"> holding 2 to 4 <div data-kb-column style=\"flex:N\"> columns, N from 0.1 to 10 with at most two decimal places, with a blank line after each column's opening tag and another before its </div>, at the top level of the markdown, not nested inside a list, a quote or anything else. Other <div> elements cannot use display:flex or display:grid, and no element can carry data-node-type.";
const UNSUPPORTED_SIZE_MESSAGE =
  "An image width or table column width in that markdown is not in a form this editor can store, so nothing was written. Write sizes exactly as GET /api/notes/:id/content returns them, as whole numbers of pixels from 32 to 4000: an image's width on the <img> inside a <figure> that is outside any table, the <img> carrying only alt (optional), src and width, in that order, and a table's column widths as colwidth on its first row's cells, one comma-separated value for each column a cell spans, left empty for a column with no width.";
export function parseErrorMessage(code: ErrorCode, fallback: string, detail?: ParseDetail): string {
  if (code === "unsupported_block" && detail === "too_complex") return TOO_COMPLEX_MESSAGE;
  if (code === "unsupported_color") return UNSUPPORTED_COLOR_MESSAGE;
  if (code === "unsupported_columns") return UNSUPPORTED_COLUMNS_MESSAGE;
  if (code === "unsupported_size") return UNSUPPORTED_SIZE_MESSAGE;
  return fallback;
}


export interface NotesRouteDeps {
  db: Db;
  collabHooks: CollabHooks;
  config: AppConfig;
  siteLimits: SiteLimits;
  collab?: CollabServer;
  editing?: EditingRuntime;
  limiters: { collabToken: FixedWindowLimiter; slugPatch: FixedWindowLimiter; publicLink: FixedWindowLimiter; publicWidth: FixedWindowLimiter; contentRead: FixedWindowLimiter; edit: FixedWindowLimiter; upload: FixedWindowLimiter };
  /** The single NoteWriteQueue; MCP gets the same object so writes serialize. */
  writes: NoteWriteService;
  versions: VersionService;
  presence?: PresenceRegistry;
  linkSyncTestHooks?: WriteNoteLinksHooks;
  /** Test hook: called after each probe round, before the UPDATE; lets tests insert a colliding slug to drive the retry path. */
  slugUpdateTestHook?: (candidate: string) => void | Promise<void>;
  slugPatchTestHook?: SlugPatchTestHook;
  /** Same as slugUpdateTestHook for the create path. ⚠ Wired only at the default-mode insert and the in-transaction (savepoint) copy loop: POST /api/notes without content, copy (REST and MCP), MCP create_note without content; createWithContent shares the first loop. */
  noteCreateHooks?: NoteCreateHooks;
  groupTestHook?: GroupTestHook;
  searchIndexHooks?: SearchIndexHooks;
  /** Handed to trash/service.ts, which deletes files after a permanent delete commits. */
  uploadsDir: string;
  storageLockTimeoutMs: number;
}

/** No access ('none': nonexistent or not shared) is always 404 so existence doesn't leak; 403 only when found but the role is insufficient. PATCH with a slug key needs changeSlug, with title also edit (#186). */
export function notesRoutes(deps: NotesRouteDeps) {
  // The write queue is shared with MCP (one instance from buildApp); separate instances wouldn't serialize.
  return async function register(app: FastifyInstance): Promise<void> {
    // Routes using authenticateAny accept Bearer; collab-token deliberately takes none (#136 once missed one).
    app.post("/api/notes", { preHandler: app.authenticateAny("notes:write") }, async (request, reply) => {
      const parsed = createBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");
      }
      const userId = request.user!.id;

      // For the group branch the create-flag check is outside the transaction (a flag revocation racing with creation isn't guaranteed).
      let target: { scope: SlugScope; access: Pick<NoteAccess, "role" | "permissions">; ownerHandle: string | null; groupName: string | null };
      const groupId = parsed.data.groupId;
      let folder: FolderAccess | null = null;
      if (parsed.data.folderId !== undefined) {
        folder = await resolveFolderAccess(deps.db, userId, parsed.data.folderId);
        if (folder === null) return sendError(reply, 404, "folder_not_found", FOLDER_NOT_FOUND_MESSAGE);
        const space = folder.space;
        const consistent = newNoteFolderConsistent(space, groupId);
        if (!consistent) return sendError(reply, 400, "folder_cross_space", NOTE_FOLDER_CROSS_SPACE_MESSAGE);
      }
      const folderId = folder === null ? null : folder.folder.id;
      if (groupId !== undefined) {
        const m = await loadCreateTarget(deps.db, userId, groupId);
        // A non-member site admin gets no exemption: note flags look at the role only.
        if (!m) return sendError(reply, 404, "group_not_found", "No group with that id.");
        if (!m.canCreate) return sendError(reply, 403, "forbidden", "Your role in this group can't create notes.");
        if (folderId !== null && !m.canEdit) return sendError(reply, 403, "forbidden", NOTE_FOLDER_ROLE_FORBIDDEN_MESSAGE);
        await deps.groupTestHook?.("membership-checked", { groupId });
        // No "create ⇒ edit" implication since migration 0013, so a create-only role gets viewer.
        target = { scope: { groupId }, access: { role: roleFromGroupFlags(m), permissions: groupNotePermissions(m) }, ownerHandle: null, groupName: m.name };
      } else {
        target = { scope: { ownerId: userId }, access: { role: "owner", permissions: OWNER_PERMISSIONS }, ownerHandle: request.user!.handle, groupName: null };
      }

      if (parsed.data.content !== undefined) {
        if (!deps.writes.available) return sendError(reply, 400, "invalid_body", "This deployment cannot create a note with content. Send the request again without content.");
        // Before any mount.
        if (!deps.limiters.edit.consume(userId)) return sendError(reply, 429, "too_many_requests", "Too many writes. Wait a moment and try again.");
        let out;
        try {
          out = await deps.writes.createWithContent(request.log, {
            userId,
            userHandle: request.user!.handle,
            tokenId: request.tokenId ?? null,
            title: parsed.data.title,
            content: parsed.data.content,
            scope: target.scope,
            folderId,
          });
        } catch (err) {
          const sent = sendCreateInsertFailure(reply, err, folderId !== null);
          if (sent) return sent;
          throw err;
        }
        if (!out.ok) {
          if (out.kind === "parse") return sendError(reply, 400, out.code, parseErrorMessage(out.code, "Couldn't parse the content.", out.detail));
          if (out.kind === "parser_busy") return sendParserBusy(reply);
          if (out.kind === "too_large") return sendNoteTooLarge(reply, out.limitBytes);
          // The timeout answer here is deliberately 500, not 503 (docs/ai-editing.md); the service already deleted the row.
          return sendError(reply, 500, "internal", "Couldn't create the note.");
        }
        const note = out.inserted;
        // Re-read: the insert's returning predates the disconnect that stamped lastEdited. If the row vanished meanwhile, fall back to the insert's returning rather than 500
        // (the content was written; a retry would create a second note), and don't assemble the stamp here (its update only warns, so the value could lie).
        const fresh = await loadNoteWithOwner(note.id, userId);
        return reply
          .code(201)
          .send(toNoteDto(fresh ?? { ...note, ownerHandle: target.ownerHandle, editorHandle: null, groupName: target.groupName, viewerFolderId: note.folderId }, target.access));
      }

      // `title` absent is left out of values so the DB default and untitled-<uuid8> apply (single source: schema.ts).
      let created;
      try {
        created = await insertNoteWithAutoSlug(deps.db, { scope: target.scope, folderId }, parsed.data.title, deps.noteCreateHooks);
      } catch (err) {
        // A personal create without a folder can't hit an FK (nothing in src/ hard-deletes users).
        const sent = sendCreateInsertFailure(reply, err, folderId !== null);
        if (sent) return sent;
        throw err;
      }

      // editorHandle is null: no content, so last_edited_* still hold the insert defaults.
      return reply
        .code(201)
        .send(toNoteDto({ ...created, ownerHandle: target.ownerHandle, editorHandle: null, groupName: target.groupName, viewerFolderId: created.folderId }, target.access));
    });

    app.get("/api/notes", { preHandler: app.authenticateAny("notes:read") }, async request => {
      const userId = request.user!.id;

      // UNION ALL instead of one query with `owner_id=$u OR note_shares.user_id=$u`: an OR across an outer join forces a full notes scan, while each branch uses its own index.
      // The shared branch excludes owner_id = userId: nothing at the DB level stops a self-share row (cannot_share_with_self is only an application check), which would return the note twice with the wrong role.
      // Both branches join users so the select shapes match for unionAll. `sizeBytes` is added here only; MCP lists don't pay for the subqueries.
      const { owned: ownedSelect, shared: sharedSelect, grouped: groupedSelect } = visibleNoteBranches(deps.db, userId, {
        extra: { sizeBytes: noteSizeBytesSql() },
      });

      // Secondary key id: updatedAt isn't unique, and an unstable order would duplicate or skip rows under future keyset pagination.
      const rows = await unionAll(ownedSelect, sharedSelect, groupedSelect).orderBy(desc(notes.updatedAt), desc(notes.id));

      return rows.map((row): NoteDto => toNoteDto(row, accessFromListRow(row)));
    });

    // ⚠ Must not be called inside a transaction (recognized as a helper by test/unit/s14-structure.test.ts).
    function loadNoteWithOwner(noteId: string, viewerId: string): Promise<NoteFields | undefined> {
      return loadNoteFields(deps.db, noteId, viewerId);
    }

    const noteNotFound = (reply: FastifyReply): FastifyReply => sendError(reply, 404, "not_found", "No note with that id.");

    /** `:ref` isn't in LOWERCASED_PARAMS, so noteId is lowercased here. */
    const notFoundOrInTrash = async (reply: FastifyReply, userId: string, noteId: string): Promise<FastifyReply> =>
      (await resolveTrashedNoteAccess(deps.db, userId, noteId)) ? sendInTrash(reply, noteId.toLowerCase()) : noteNotFound(reply);

    /** A trashed note counts as "row gone" (404, not 409). */
    const ownershipChanged = async (reply: FastifyReply, noteId: string): Promise<FastifyReply> => {
      const [row] = await deps.db.select({ id: notes.id }).from(notes).where(and(eq(notes.id, noteId), isNull(notes.deletedAt))).limit(1);
      return row ? sendError(reply, 409, "conflict", "The note's owner or group changed. Reload and try again.") : noteNotFound(reply);
    };

    /** Re-reads and re-authorizes once if group_id changed between authorization and the fetch. */
    async function authorizeRow(reply: FastifyReply, userId: string, note: NoteFields): Promise<NoteDto | FastifyReply> {
      let row = note;
      let access = await resolveNoteAccess(deps.db, userId, row.id);
      if (access.role !== "none" && access.groupId !== row.groupId) {
        const fresh = await loadNoteWithOwner(row.id, userId);
        if (!fresh) return noteNotFound(reply);
        row = fresh;
        access = await resolveNoteAccess(deps.db, userId, row.id);
        if (access.groupId !== row.groupId) return noteNotFound(reply);
      }
      if (access.role === "none") return notFoundOrInTrash(reply, userId, row.id);
      return toNoteDto(row, access);
    }

    function selectNotesWhere(cond: SQL, viewerId: string) {
      return deps.db
        .select(noteFieldsSelection(viewerId))
        .from(notes)
        .leftJoin(users, eq(users.id, notes.ownerId))
        .leftJoin(editor, eq(editor.id, notes.lastEditedBy))
        .leftJoin(groups, eq(groups.id, notes.groupId))
        .leftJoin(notePlacements, placementJoinOn(viewerId))
        .where(cond);
    }

    function pathRowsFor(viewerId: string): PathRowSource<NoteFields> {
      return {
        where: (cond, limit) => selectNotesWhere(cond, viewerId).limit(limit),
        byId: noteId => loadNoteWithOwner(noteId, viewerId),
      };
    }
    async function resolvePath(scopeCond: SQL, slug: string, redirectKey: string, viewerId: string): Promise<NoteFields | undefined> {
      return resolveNotePath(deps.db, pathRowsFor(viewerId), scopeCond, slug, redirectKey);
    }

    // 0 or >1 prev_slug hits → 404 (the same owner's notes can release a name in turn); every 404 exit goes through noteNotFound with an identical body. Same toNoteDto as GET /:id: the web seeds its cache from it.
    app.get("/api/notes/by-path/:handle/:slug", { preHandler: app.authenticate }, async (request, reply) => {
      const params = request.params as { handle: string; slug: string };
      const handle = normalizeHandle(params.handle);
      const slugParam = normalizeSlug(params.slug);
      const note = await resolvePath(eq(users.handle, handle), slugParam, userNotePath(handle, slugParam), request.user!.id);
      if (!note) return noteNotFound(reply);
      await deps.groupTestHook?.("path-resolved", { noteId: note.id });
      return authorizeRow(reply, request.user!.id, note);
    });

    // A separate prefix: `g` is a legal handle, and mixing static and parameter segments under by-path needs find-my-way backtracking.
    app.get("/api/notes/by-group-path/:groupId/:slug", { preHandler: app.authenticate }, async (request, reply) => {
      const params = request.params as { groupId: string; slug: string };
      if (!UUID_RE.test(params.groupId)) return noteNotFound(reply);
      const groupId = params.groupId.toLowerCase();
      const slugParam = normalizeSlug(params.slug);
      const note = await resolvePath(eq(notes.groupId, groupId), slugParam, groupNotePath(groupId, slugParam), request.user!.id);
      if (!note) return noteNotFound(reply);
      await deps.groupTestHook?.("path-resolved", { noteId: note.id });
      return authorizeRow(reply, request.user!.id, note);
    });

    // Renamed from GET /api/notes/:id: registering GET twice at one path throws in fastify.
    app.get("/api/notes/:ref", { preHandler: app.authenticateAny("notes:read") }, async (request, reply) => {
      const { ref } = request.params as { ref: string };
      const userId = request.user!.id;

      const noteId = await resolveNoteIdFromRef(deps.db, ref);
      if (!noteId) return noteNotFound(reply);
      const first = await resolveNoteAccess(deps.db, userId, noteId);
      if (first.role === "none") return notFoundOrInTrash(reply, userId, noteId);
      await deps.groupTestHook?.("ref-authorized", { noteId });
      const note = await loadNoteWithOwner(noteId, userId);
      if (!note) return noteNotFound(reply);
      if (first.groupId === note.groupId) return toNoteDto(note, first);
      return authorizeRow(reply, userId, note);
    });

    // Without a live-doc source "read the latest content" has no meaning, so the route isn't registered (404) rather than answering halfway.
    if (deps.collab && deps.editing) {
      const collab = deps.collab;
      const editing = deps.editing;
      /**
       * Read-only, zero side effects: loadNoteDoc only forks the live doc or decodes the DB snapshot, never opens a direct connection (exception: #387 remembers shown link text in memory).
       * ⚠ Authorization is complete here: like the direct connection of the AI write path, this path doesn't go through collab's onAuthenticate.
       * The limiter comes after the role check so "none" 404s don't consume (see CONTENT_READ_LIMIT).
       */
      app.get("/api/notes/:id/content", { preHandler: app.authenticateAny("notes:read") }, async (request, reply) => {
        const { id } = request.params as { id: string };
        // Redundant with resolveRole's guard; kept so "no invalid uuid reaches SQL" doesn't rest on another module's private choice.
        if (!UUID_RE.test(id)) return sendError(reply, 404, "not_found", "No note with that id.");
        const q = contentQuerySchema.safeParse(request.query ?? {});
        if (!q.success) return sendError(reply, 400, "invalid_body", "Invalid query parameters.");
        const userId = request.user!.id;
        const role = await resolveRole(deps.db, userId, id);
        if (role === "none") return sendError(reply, 404, "not_found", "No note with that id.");
        if (!deps.limiters.contentRead.consume(userId)) return sendError(reply, 429, "too_many_requests", "Too many reads. Wait a moment and try again.");
        // Only token readers show presence (a cookie read is the user's own browser). Removing the request.tokenId guard is blocked by tsc (TS2345); note-presence.test.ts only guards the outcome (no extra awareness client for cookie readers).
        if (request.tokenId) {
          const label = await currentAgentLabel(deps.db, request.tokenId);
          if (label) {
            deps.presence?.touch(id, request.tokenId, presenceIdentity(request.user!.handle, label), presenceTargetForRead(q.data.section));
          }
        }
        let result: Awaited<ReturnType<typeof readNoteContent>>;
        try {
          result = await readNoteContent({ db: deps.db, collab, shownLinks: deps.writes.shownLinks }, editing, id, request.user!.id, q.data.section);
        } catch (err) {
          const sent = sendDocReadError(reply, err);
          if (sent) return sent;
          throw err;
        }
        if (result === "section_not_found") return sendError(reply, 404, "section_not_found", "No section with that id.");
        // `satisfies` pins read.ts's result to the shared DTO so shape drift fails at compile time.
        const body = { ...result, lastEdited: await loadLastEdited(deps.db, id) } satisfies NoteContentDto | NoteSectionDto;
        return reply.send(body);
      });

      /** The limiter comes after the role check (404/403 don't consume) but before any mount or direct connection: a 429 must leave nothing written. bodyLimit 413 → content_too_large; the same number as MD's .max(262_144) but in bytes, so over-long markdown hits it before zod's 400. */
      app.post("/api/notes/:id/edits", { preHandler: app.authenticateAny("notes:write"), bodyLimit: WRITE_BODY_LIMIT }, async (request, reply) => {
        const { id } = request.params as { id: string };
        if (!UUID_RE.test(id)) return sendError(reply, 404, "not_found", "No note with that id.");
        const parsed = editBodySchema.safeParse(request.body ?? {});
        if (!parsed.success) return sendError(reply, 400, "invalid_body", "Invalid request body.");
        const userId = request.user!.id;
        const role = await resolveRole(deps.db, userId, id);
        if (role === "none") return sendError(reply, 404, "not_found", "No note with that id.");
        if (role === "viewer") return sendError(reply, 403, "forbidden", "You don't have edit access to this note.");
        if (!deps.limiters.edit.consume(userId)) return sendError(reply, 429, "too_many_requests", "Too many writes. Wait a moment and try again.");
        const out = await deps.writes.applyToNote(request.log, {
          noteId: id,
          userId,
          userHandle: request.user!.handle,
          tokenId: request.tokenId ?? null,
          op: parsed.data.op,
          sectionId: "section_id" in parsed.data ? parsed.data.section_id : undefined,
          markdown: "markdown" in parsed.data ? parsed.data.markdown : undefined,
          ifMatch: "if_match" in parsed.data ? parsed.data.if_match : undefined,
        });
        if (!out.ok) {
          if (out.kind === "busy") return sendError(reply, 503, "server_busy", "The note is being written right now. Try again in a moment.");
          if (out.kind === "parser_busy") return sendParserBusy(reply);
          if (out.kind === "too_large") return sendNoteTooLarge(reply, out.limitBytes);
          if (out.kind === "gone") return sendError(reply, 404, "not_found", "No note with that id.");
          if (out.code === "fingerprint_mismatch") {
            // Without a section "section_not_found" can't happen, but the sentinel is in the return union; unnarrowed, spreading a string would send {0:"s",1:"e",…}.
            let current: Awaited<ReturnType<typeof readNoteContent>>;
            try {
              current = await readNoteContent({ db: deps.db, collab, shownLinks: deps.writes.shownLinks }, editing, id, request.user!.id);
            } catch (err) {
              const sent = sendDocReadError(reply, err);
              if (sent) return sent;
              throw err;
            }
            if (current === "section_not_found") throw new Error("readNoteContent 未帶 section 卻回哨兵值");
            const body = { ...current, lastEdited: await loadLastEdited(deps.db, id) } satisfies NoteContentDto | NoteSectionDto;
            return reply.code(409).send({ error: { code: "fingerprint_mismatch", message: "The content changed since you read it, so nothing was written. The response's current field has the content as it is now." }, current: body });
          }
          if (out.code === "too_complex") return sendError(reply, 500, "too_complex", NOTE_WRITE_TOO_COMPLEX_MESSAGE);
          return sendError(reply, out.code === "section_not_found" ? 404 : 400, out.code, parseErrorMessage(out.code, "Couldn't apply the edit.", out.detail));
        }
        const result = out.result;
        return reply.code(201).send({ editId: result.editId, fingerprint: result.fingerprint, outline: result.outline, unboundWikilinks: result.unboundWikilinks } satisfies NoteEditResultDto);
      });

      /** Read path: never opens a direct connection or reloads an unloaded document. */
      app.get("/api/notes/:id/edits", { preHandler: app.authenticateAny("notes:read") }, async (request, reply) => {
        const { id } = request.params as { id: string };
        if (!UUID_RE.test(id)) return sendError(reply, 404, "not_found", "No note with that id.");
        const userId = request.user!.id;
        const role = await resolveRole(deps.db, userId, id);
        if (role === "none") return sendError(reply, 404, "not_found", "No note with that id.");
        if (!deps.limiters.contentRead.consume(userId)) return sendError(reply, 429, "too_many_requests", "Too many reads. Wait a moment and try again.");
        // Deliberately no presence touch: viewing history shouldn't refresh the AI's presence.
        const edits = await listEdits({ db: deps.db, collab }, id) satisfies NoteEditDto[];
        return reply.send({ edits });
      });

      /** No body, so the input check is on editId: a non-uuid is 404 before SQL (pg's cast error would be a 500). Uses the same queue as the /edits write. */
      app.post("/api/notes/:id/edits/:editId/revert", { preHandler: app.authenticateAny("notes:write") }, async (request, reply) => {
        const { id, editId } = request.params as { id: string; editId: string };
        if (!UUID_RE.test(id)) return sendError(reply, 404, "not_found", "No note with that id.");
        if (!UUID_RE.test(editId)) return sendError(reply, 404, "not_found", "No edit with that id.");
        const userId = request.user!.id;
        const role = await resolveRole(deps.db, userId, id);
        if (role === "none") return sendError(reply, 404, "not_found", "No note with that id.");
        if (role === "viewer") return sendError(reply, 403, "forbidden", "You don't have edit access to this note.");
        if (!deps.limiters.edit.consume(userId)) return sendError(reply, 429, "too_many_requests", "Too many writes. Wait a moment and try again.");
        const out = await deps.writes.revert(request.log, { noteId: id, editId, userId, userHandle: request.user!.handle, tokenId: request.tokenId ?? null });
        if (!out.ok) {
          if (out.kind === "busy") return sendError(reply, 503, "server_busy", "The note is being written right now. Try again in a moment.");
          if (out.kind === "parser_busy") return sendParserBusy(reply);
          if (out.kind === "too_large") return sendNoteTooLarge(reply, out.limitBytes);
          if (out.kind === "gone") return sendError(reply, 404, "not_found", "No note with that id.");
          if (out.code === "stale") {
            // Without a section "section_not_found" can't happen, but the sentinel is in the return union; unnarrowed, spreading a string would send {0:"s",1:"e",…}.
            let current: Awaited<ReturnType<typeof readNoteContent>>;
            try {
              current = await readNoteContent({ db: deps.db, collab, shownLinks: deps.writes.shownLinks }, editing, id, request.user!.id);
            } catch (err) {
              const sent = sendDocReadError(reply, err);
              if (sent) return sent;
              throw err;
            }
            if (current === "section_not_found") throw new Error("readNoteContent 未帶 section 卻回哨兵值");
            const body = { ...current, lastEdited: await loadLastEdited(deps.db, id) } satisfies NoteContentDto | NoteSectionDto;
            return reply.code(409).send({ error: { code: "stale", message: "The note changed after this edit, so it can't be reverted. The response's current field has the content as it is now." }, current: body });
          }
          if (out.code === "already_reverted") return sendError(reply, 409, "already_reverted", "This edit has already been reverted.");
          if (out.code === "too_complex") return sendError(reply, 500, "too_complex", NOTE_WRITE_TOO_COMPLEX_MESSAGE);
          return sendError(reply, 404, "not_found", "No edit with that id.");
        }
        const result = out.result;
        return reply.code(201).send({ editId: result.editId, fingerprint: result.fingerprint, outline: result.outline });
      });
    }

    // ⚠ A closure over deps.db: must not be called inside a transaction. A group note has no owner → null.
    async function ownerHandleOf(ownerId: string | null): Promise<string | null> {
      if (ownerId === null) return null;
      const [row] = await deps.db.select({ handle: users.handle }).from(users).where(eq(users.id, ownerId)).limit(1);
      if (!row) throw new Error(`notes.owner_id ${ownerId} 查無對應 users 列（FK 不變量被打破）`);
      return row.handle;
    }

    async function editorHandleOf(editorId: string | null): Promise<string | null> {
      if (!editorId) return null;
      const [row] = await deps.db.select({ handle: users.handle }).from(users).where(eq(users.id, editorId)).limit(1);
      return row?.handle ?? null;
    }

    async function groupNameOf(groupId: string | null): Promise<string | null> {
      if (!groupId) return null;
      const [row] = await deps.db.select({ name: groups.name }).from(groups).where(eq(groups.id, groupId)).limit(1);
      return row?.name ?? null;
    }

    /** Always outside the transaction (closures over deps.db). */
    async function respondPatched(updated: typeof notes.$inferSelect, access: NoteAccess, viewerId: string): Promise<NoteDto> {
      return toNoteDto(
        {
          ...updated,
          ownerHandle: await ownerHandleOf(updated.ownerId),
          editorHandle: await editorHandleOf(updated.lastEditedBy),
          groupName: await groupNameOf(updated.groupId),
          // updated.folderId is the owner's; a share-holding editor needs their own placement.
          viewerFolderId: await viewerFolderIdFor(deps.db, updated, viewerId),
        },
        access,
      );
    }

    /**
     * PATCH matrix (statement shapes are a docs-as-spec obligation: change docs/api.md with them). A `slug` key needs permissions.changeSlug and rejects the whole request; `title` also needs permissions.edit (#186).
     * Uniqueness is decided by the unique index, never a pre-check; reading this row's title/slug_is_custom and probing the scope are not pre-checks in that sense. prev_slug records only custom changes.
     * 1. {slug: string}: charges slugPatch before validation (success or failure), no pre-read/probe, UPDATE in patchSlugInTx; 23505 on either slug index → 409 slug_taken (by constraint name).
     * 2. {title}: rename-note.ts; recomputes the auto slug only if slug_is_custom is false; doesn't charge slugPatch (title edits are core; retries are bounded at 5×20 probes + 6 UPDATEs).
     * 3. {title, slug: null}: back to auto from the new title (no pre-read); charges slugPatch.
     * 4. {slug: null}: back to auto from the current title (one pre-read); charges slugPatch.
     * Auto collisions never 409: re-probe and retry up to MAX_AUTO_SLUG_RETRIES, then untitled-<uuid8>; each round is a fresh patchSlugInTx (a 23505 aborts only that round). title and slug go in one UPDATE so a conflict rolls back both.
     * patchSlugInTx takes the handle from request.user (memory) because a transaction must not borrow a pool connection.
     */
    app.patch("/api/notes/:id", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;

      const parsed = updateBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");
      }
      const { title, slug } = parsed.data;
      const hasSlug = slug !== undefined;

      const access = await resolveNoteAccess(deps.db, userId, id);
      if (access.role === "none") return noteNotFound(reply);
      if (hasSlug && !access.permissions.changeSlug) return sendError(reply, 403, "forbidden", "You don't have permission to change this note's URL slug.");
      // Someone holding only changeSlug must not change the title through the slug door.
      if (title !== undefined && !access.permissions.edit) return sendError(reply, 403, "forbidden", "You don't have edit access to this note.");

      const slugScope: SlugScope = access.groupId !== null ? { groupId: access.groupId } : { ownerId: access.ownerId! };
      const txScope: SlugWriteScope =
        access.groupId !== null ? { kind: "group", groupId: access.groupId } : { kind: "personal", ownerId: access.ownerId! };
      // Personal scope means the owner here, so request.user.handle (memory; a concurrent handle change has a very narrow window, accepted).
      const redirectHandle = txScope.kind === "personal" ? request.user!.handle : null;
      const runT1 = (set: { title?: string; slug: string; slugIsCustom: boolean }) =>
        deps.db.transaction(tx => patchSlugInTx(tx, { noteId: id, scope: txScope, set, redirectHandle }, deps.slugPatchTestHook));

      if (hasSlug && slug !== null) {
        if (!deps.limiters.slugPatch.consume(userId)) return sendError(reply, 429, "too_many_requests", "Too many requests. Wait a moment and try again.");
        const result = prepareSlugForPatch(slug);
        if (!result.ok) return sendError(reply, 400, "invalid_body", result.message);
        await deps.slugPatchTestHook?.("authorized", { noteId: id });
        let updated;
        try {
          updated = await runT1({ ...(title !== undefined ? { title } : {}), slug: result.value, slugIsCustom: true });
        } catch (err) {
          // 23505s other than the two slug indexes aren't guessed as 409.
          if (isSlugUniqueViolation(err)) return sendError(reply, 409, "slug_taken", "That URL slug is already in use.");
          throw err;
        }
        // Deleted (404) or ownership changed (409) since authorization.
        if (!updated) return ownershipChanged(reply, id);
        return respondPatched(updated, access, userId);
      }

      if (!hasSlug) {
        const out = await renameNoteTitle(deps.db, { noteId: id, access, title: title! }, deps.slugUpdateTestHook);
        if (out.kind === "gone") return noteNotFound(reply);
        if (out.kind === "ownership_changed") return sendError(reply, 409, "conflict", "The note's owner or group changed. Reload and try again.");
        // Unreachable: PATCH passes no expectTitleFingerprint (web title edits are last-write-wins).
        if (out.kind === "title_changed") throw new Error("PATCH title: renameNoteTitle returned title_changed (PATCH must not pass expectTitleFingerprint)");
        return respondPatched(out.row, access, userId);
      }

      if (!deps.limiters.slugPatch.consume(userId)) return sendError(reply, 429, "too_many_requests", "Too many requests. Wait a moment and try again.");

      let effectiveTitle = title ?? "";
      if (title === undefined) {
        // notes-slug.test.ts recognizes this pre-read by its column set.
        const [row] = await deps.db.select({ title: notes.title, slugIsCustom: notes.slugIsCustom }).from(notes).where(eq(notes.id, id)).limit(1);
        if (!row) return noteNotFound(reply);
        effectiveTitle = row.title;
      }
      await deps.slugPatchTestHook?.("authorized", { noteId: id });

      let updated;
      for (let attempt = 1; ; attempt++) {
        let auto: string;
        if (attempt > MAX_AUTO_SLUG_RETRIES) auto = fallbackAutoSlug();
        else auto = await deriveUniqueAutoSlug(deps.db, slugScope, id, effectiveTitle);
        await deps.slugUpdateTestHook?.(auto);
        try {
          // A 23505 aborts only this round's transaction, so no savepoint is needed.
          updated = await runT1({ ...(title !== undefined ? { title } : {}), slug: auto, slugIsCustom: false });
          if (!updated) return ownershipChanged(reply, id);
          break;
        } catch (err) {
          if (isSlugUniqueViolation(err) && attempt <= MAX_AUTO_SLUG_RETRIES) continue;
          throw err;
        }
      }
      if (!updated) return ownershipChanged(reply, id);
      return respondPatched(updated, access, userId);
    });

    /** Body is the complete target set (not a diff). linkSyncGate ok:false (note not in memory or submitter not connected) → 409 not_loaded with nothing written (no fallback; the client retries). writeNoteLinks handles the FK race and 40001/40P01 → busy. */
    app.post("/api/notes/:id/links", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;

      const parsed = linksBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");
      }

      const role = await resolveRole(deps.db, userId, id);
      if (role === "none") {
        return sendError(reply, 404, "not_found", "No note with that id.");
      }
      if (role === "viewer") {
        return sendError(reply, 403, "forbidden", "You don't have edit access to this note.");
      }

      const normalized = normalizeLinkTargets(id, parsed.data.link_target_ids);
      if (!normalized.ok) {
        return sendError(reply, 400, "invalid_body", "Too many link targets.");
      }

      const gate = deps.collabHooks.linkSyncGate(id, userId);
      if (!gate.ok) {
        return sendError(reply, 409, "not_loaded", "Link updates need the note open in the editor: it isn't loaded on the server, or you have no open editor connection to it. Open the note and try again.");
      }

      try {
        const outcome = await writeNoteLinks(
          deps.db,
          { sourceNoteId: id, userId, targetIds: normalized.targets, clock: gate.clock },
          deps.linkSyncTestHooks
        );
        if (outcome === "busy") {
          return sendError(reply, 409, "server_busy", "The server is busy. Try again in a moment.");
        }
      } catch (err) {
        request.log.error(err);
        return sendError(reply, 500, "internal", "Internal server error.");
      }

      return reply.code(204).send();
    });

    /** resolveRole only authorizes the queried note; each source note's visibility is filtered inside fetchBacklinks so existence and titles of notes without access don't leak. */
    app.get("/api/notes/:id/backlinks", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;

      const role = await resolveRole(deps.db, userId, id);
      if (role === "none") {
        return sendError(reply, 404, "not_found", "No note with that id.");
      }

      const backlinks: BacklinkDto[] = await fetchBacklinks(deps.db, id, userId);
      return { backlinks };
    });

    /** Membership and can_create are checked only inside the transaction after KEY SHARE on the group row; every failure (including deleted while waiting) is the same 404 group_not_found. */
    app.post("/api/notes/:id/move", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;
      const parsed = moveBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");

      const out = await moveNoteToGroup(
        { db: deps.db, collabHooks: deps.collabHooks, versions: deps.versions, storageLockTimeoutMs: deps.storageLockTimeoutMs, groupTestHook: deps.groupTestHook },
        {
          noteId: id, userId, userHandle: request.user!.handle, groupId: parsed.data.groupId,
          ...(parsed.data.folderId !== undefined ? { folderId: parsed.data.folderId.toLowerCase() } : {}),
        },
      );
      switch (out.kind) {
        case "not_found":
          return noteNotFound(reply);
        case "forbidden":
          return sendError(reply, 403, "forbidden", "Only the note's owner can move it into a group.");
        case "group_not_found":
          return sendError(reply, 404, "group_not_found", "No group with that id.");
        case "aborted":
          if (out.err instanceof StorageQuotaExceeded) return sendStorageQuotaExceeded(reply, await quotaErrorDetail(deps.db, request.user!, out.err));
          return sendError(reply, out.err.status, out.err.errCode, out.err.message);
        case "busy":
          return sendError(reply, 409, "server_busy", "The server is busy. Try again in a moment.");
        case "moved": {
          const fresh = await loadNoteWithOwner(id, userId);
          if (!fresh) return noteNotFound(reply);
          return authorizeRow(reply, userId, fresh);
        }
      }
    });

    /** The group target is checked twice: loadCreateTarget is only a quick 404, real authorization is re-verified in copyNoteInTx under the group KEY SHARE (lock order in notes/tx/copy.ts). The snapshot is read before the transaction (loadNoteDoc borrows a connection). */
    app.post("/api/notes/:id/copy", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;
      const parsed = copyBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");
      const out = await copyNote(
        {
          db: deps.db, collab: deps.collab, log: request.log, uploadsDir: deps.uploadsDir, storageLockTimeoutMs: deps.storageLockTimeoutMs,
          limiters: { edit: deps.limiters.edit, upload: deps.limiters.upload }, noteMaxBytes: deps.siteLimits.get("noteMaxBytes"),
          groupTestHook: deps.groupTestHook, noteCreateHooks: deps.noteCreateHooks, searchIndexHooks: deps.searchIndexHooks,
        },
        {
          sourceId: id, userId, groupId: parsed.data.groupId,
          ...(parsed.data.folderId !== undefined ? { folderId: parsed.data.folderId.toLowerCase() } : {}),
        },
      );
      switch (out.kind) {
        case "not_found":
        case "fk_personal":
          return noteNotFound(reply);
        case "group_not_found":
          return sendError(reply, 404, "group_not_found", "No group with that id.");
        case "edit_rate_limited":
          return sendError(reply, 429, "too_many_requests", "Too many writes. Wait a moment and try again.");
        case "space_full":
          return sendStorageQuotaExceeded(reply, await precheckDetail(deps.db, request.user!, out.space, out.usage));
        case "upload_rate_limited":
          return sendError(reply, 429, "too_many_requests", "Too many requests. Wait a moment and try again.");
        case "aborted":
          if (out.err instanceof StorageQuotaExceeded) return sendStorageQuotaExceeded(reply, await quotaErrorDetail(deps.db, request.user!, out.err));
          return sendError(reply, out.err.status, out.err.errCode, out.err.message);
        case "busy":
          return sendError(reply, 409, "server_busy", "The server is busy. Try again in a moment.");
        case "too_large":
          return sendNoteTooLarge(reply, out.limitBytes);
        case "copied": {
          // The group name can be stale: a rename is a single UPDATE that doesn't conflict with KEY SHARE.
          const { note: createdNote, target } = out;
          const dto = target === null
            ? toNoteDto({ ...createdNote, ownerHandle: request.user!.handle, editorHandle: null, groupName: null, viewerFolderId: createdNote.folderId }, { role: "owner", permissions: OWNER_PERMISSIONS })
            : toNoteDto({ ...createdNote, ownerHandle: null, editorHandle: null, groupName: target.name, viewerFolderId: createdNote.folderId }, { role: roleFromGroupFlags(target), permissions: groupNotePermissions(target) });
          return reply.code(201).send(dto);
        }
      }
    });

    app.delete("/api/notes/:id", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;

      const access = await resolveNoteAccess(deps.db, userId, id);
      if (access.role === "none") {
        return sendError(reply, 404, "not_found", "No note with that id.");
      }
      if (!access.permissions.delete) {
        return sendError(reply, 403, "forbidden", "You don't have permission to delete this note.");
      }

      // No attachment files are deleted and no child tables touched: only a permanent delete does that.
      const out = await trashNote(
        { db: deps.db, collabHooks: deps.collabHooks, uploadsDir: deps.uploadsDir, storageLockTimeoutMs: deps.storageLockTimeoutMs, groupTestHook: deps.groupTestHook },
        { noteId: id, by: userId },
      );
      if (out === "forbidden") return sendError(reply, 403, "forbidden", "You don't have permission to delete this note.");
      if (out === "not_found") return sendError(reply, 404, "not_found", "No note with that id.");

      return reply.code(204).send();
    });

    /**
     * Deliberately not "none → 404": a session without access still gets 200 and a role:'none' token, so this endpoint can't be used to probe permissions; Hocuspocus onAuthenticate refuses the token.
     * The body repeats the role because the client doesn't decode the JWT.
     * The limiter key is userId, not per note (#24): per-note would multiply an attacker's quota by the note count, and IP would make offices behind a shared egress drag each other down.
     * 60/min is enough: a call happens only on connect/reconnect/revalidation, and revalidation is per (note, user). FixedWindowLimiter counts rejected calls too, so stuck tabs restart with
     * TOKEN_RESTART_DELAYS_MS (issue #39). Switching accounts is stopped in account provisioning, not here.
     */
    app.post("/api/notes/:id/collab-token", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;

      if (!deps.limiters.collabToken.consume(userId)) {
        return sendError(reply, 429, "too_many_requests", "Too many requests. Wait a moment and try again.");
      }

      const role = await resolveRole(deps.db, userId, id);
      const token = await signCollabToken(deps.config.appSecret, {
        noteId: id,
        userId,
        role,
        tv: request.sessionTv!,
        sid: request.sessionId!,
        sv: schemaVersionFromBody(request.body),
      });

      return { token, role };
    });

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
     * Three limiters side by side, on purpose: token PUT/DELETE = publicLink, consumed before authorization like collab-token (key=userId, so strangers guessing noteIds only drain their own);
     * alias PUT/DELETE = slugPatch, authorize first then charge, malformed bodies count (no zod pre-parse); width PUT = publicWidth, parse → authorize → charge.
     * None of these touch updated_at (sharing isn't a content change). GET/PUT token and alias responses carry the full {token, slug, width} because the web writes them straight into its cache; width PUT returns only {width}.
     * Token PUT regenerates every time (not idempotent; client convention: GET first, PUT only if null): revisit if an auto-retrying middleware appears.
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
      // Only a miss of the note itself is 404; a null token is an idempotent 204. The same UPDATE clears public_slug (a leftover alias would hold the unique index and revive on regeneration). Trashed notes keep token and alias.
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

    /** "Note is public" is not pre-read: the conditional UPDATE's `public_token IS NOT NULL` predicate closes the set-alias/unpublish TOCTOU. Rowcount 0 → 400 (not public, group note, or ownership changed). */
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
      // `owner_id = me` covers group notes (no public URL: notes_group_no_public_slug_chk) and both directions of ownership change after authorization; checking only group_id IS NULL
      // would let a former member's alias land in a new owner's /p/ namespace.
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
