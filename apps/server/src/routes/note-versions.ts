import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import {
  VERSION_LIST_LIMIT_DEFAULT, VERSION_LIST_LIMIT_MAX, normalizeVersionName,
  type ApplyVersionBody, type ApplyVersionResultDto, type AvatarRef, type VersionBaseRefDto, type VersionCurrentDto, type VersionDto, type VersionKind, type VersionListDto,
  type SavedVersionDto, type VersionSnapshotDto,
} from "@knotebook/shared";
import type { VersionCurrentCore, VersionService } from "../collab/versions.js";
import { readAvatarRefs } from "../avatars/read.js";
import type { Db } from "../db/index.js";
import { noteVersions, notes, users } from "../db/schema.js";
import { sendError, sendNoteTooLarge } from "../http/errors.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import type { NoteWriteService } from "../notes/editing/write-service.js";
import { resolveRole, UUID_RE } from "../notes/service.js";
import type { NoteVersionRow } from "../notes/tx/versions.js";

export interface NoteVersionsRouteDeps {
  db: Db;
  versions: VersionService;
  writes: NoteWriteService;
  limiters: { edit: FixedWindowLimiter };
}

const NOTE_NOT_FOUND = "No note with that id.";
const VERSION_NOT_FOUND = "No version with that number.";
const INVALID_BODY = "Invalid request body.";
const INVALID_NAME = "Version names can be at most 120 characters and can't contain characters that can't be stored.";
const INT4_MAX = 2147483647;
const SEQ_RE = /^[1-9]\d{0,9}$/;
const LIMIT_RE = /^[1-9]\d{0,2}$/;

export function parseSeq(raw: string): number | null {
  if (!SEQ_RE.test(raw)) return null;
  const n = Number(raw);
  return n <= INT4_MAX ? n : null;
}

const listQuerySchema = z.object({ before: z.string().optional(), limit: z.string().optional(), kind: z.enum(["manual", "auto"]).optional() }).strict();
const saveBodySchema = z.object({ name: z.string().optional() }).strict();
const renameBodySchema = z.object({ name: z.string().nullable() }).strict();
const applyBodySchema = z.object({ versionId: z.string().regex(UUID_RE), discardUnsaved: z.boolean() }).strict() satisfies z.ZodType<ApplyVersionBody>;

function baseRefOf(baseSeq: number | null, id: string | null, names: Map<string, string | null>): VersionBaseRefDto | null {
  if (baseSeq === null) return null;
  if (id === null || !names.has(id)) return { id, name: null, deleted: true };
  return { id, name: names.get(id) ?? null, deleted: false };
}

async function versionNames(db: Db, noteId: string, ids: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (ids.length === 0) return out;
  const found = await db
    .select({ id: noteVersions.id, name: noteVersions.name })
    .from(noteVersions)
    .where(and(eq(noteVersions.noteId, noteId), inArray(noteVersions.id, ids)));
  for (const v of found) out.set(v.id, v.name);
  return out;
}

function toVersionDto(r: NoteVersionRow, handles: Map<string, string>, avatars: Map<string, AvatarRef>, names: Map<string, string | null>): VersionDto {
  return {
    id: r.id,
    seq: r.seq,
    kind: r.kind as VersionKind,
    name: r.name,
    editors: r.editors.map(e => ({ handle: handles.get(e.user_id) ?? "", agentLabel: e.agent_label, avatar: avatars.get(e.user_id) ?? null })),
    baseSeq: r.baseSeq,
    base: baseRefOf(r.baseSeq, r.baseVersionId, names),
    createdAt: r.createdAt.toISOString(),
  };
}

export async function toVersionDtos(db: Db, noteId: string, rows: NoteVersionRow[]): Promise<VersionDto[]> {
  const ids = [...new Set(rows.flatMap(r => r.editors.map(e => e.user_id)))].filter(id => UUID_RE.test(id));
  const handles = new Map<string, string>();
  if (ids.length > 0) {
    for (const u of await db.select({ id: users.id, handle: users.handle }).from(users).where(inArray(users.id, ids))) handles.set(u.id, u.handle);
  }
  const avatars = await readAvatarRefs(db, ids);
  const names = new Map<string, string | null>(rows.map(r => [r.id, r.name]));
  const missing = [...new Set(rows.flatMap(r => (r.baseSeq !== null && r.baseVersionId !== null && !names.has(r.baseVersionId) ? [r.baseVersionId] : [])))];
  for (const [id, name] of await versionNames(db, noteId, missing)) names.set(id, name);
  return rows.map(r => toVersionDto(r, handles, avatars, names));
}

export async function withCurrentBase(db: Db, noteId: string, current: VersionCurrentCore): Promise<VersionCurrentDto> {
  if (current.baseSeq === null) return { ...current, base: null };
  const [n] = await db.select({ id: notes.versionBaseVersionId }).from(notes).where(eq(notes.id, noteId)).limit(1);
  const id = n?.id ?? null;
  const names = await versionNames(db, noteId, id === null ? [] : [id]);
  return { ...current, base: baseRefOf(current.baseSeq, id, names) };
}

export function noteVersionsRoutes(deps: NoteVersionsRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    async function canEdit(reply: FastifyReply, userId: string, noteId: string): Promise<boolean> {
      const role = await resolveRole(deps.db, userId, noteId);
      if (role === "none") {
        sendError(reply, 404, "not_found", NOTE_NOT_FOUND);
        return false;
      }
      if (role === "viewer") {
        sendError(reply, 403, "forbidden", "You don't have edit access to this note.");
        return false;
      }
      return true;
    }
    const noteIdOf = (raw: string): string | null => (UUID_RE.test(raw) ? raw.toLowerCase() : null);
    const tooMany = (reply: FastifyReply) => sendError(reply, 429, "too_many_requests", "Too many writes. Wait a moment and try again.");

    app.get("/api/notes/:id/versions", { preHandler: app.authenticate }, async (request, reply) => {
      const id = noteIdOf((request.params as { id: string }).id);
      if (id === null) return sendError(reply, 404, "not_found", NOTE_NOT_FOUND);
      const q = listQuerySchema.safeParse(request.query ?? {});
      if (!q.success) return sendError(reply, 400, "invalid_body", INVALID_BODY);
      const before = q.data.before === undefined ? null : parseSeq(q.data.before);
      if (q.data.before !== undefined && before === null) return sendError(reply, 400, "invalid_body", INVALID_BODY);
      const limit = q.data.limit === undefined ? VERSION_LIST_LIMIT_DEFAULT : LIMIT_RE.test(q.data.limit) ? Number(q.data.limit) : 0;
      if (limit < 1 || limit > VERSION_LIST_LIMIT_MAX) return sendError(reply, 400, "invalid_body", INVALID_BODY);
      if (!(await canEdit(reply, request.user!.id, id))) return reply;
      const rows = await deps.db
        .select()
        .from(noteVersions)
        .where(and(
          eq(noteVersions.noteId, id),
          before === null ? undefined : lt(noteVersions.seq, before),
          q.data.kind === undefined ? undefined : eq(noteVersions.kind, q.data.kind),
        ))
        .orderBy(desc(noteVersions.seq))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const current = await deps.versions.currentOf(id);
      if (current === null) return sendError(reply, 404, "not_found", NOTE_NOT_FOUND);
      const body: VersionListDto = { versions: await toVersionDtos(deps.db, id, page), current: await withCurrentBase(deps.db, id, current), nextBefore: rows.length > limit ? page[page.length - 1]!.seq : null };
      return reply.send(body);
    });

    app.get("/api/notes/:id/versions/:seq", { preHandler: app.authenticate }, async (request, reply) => {
      const params = request.params as { id: string; seq: string };
      const id = noteIdOf(params.id);
      if (id === null) return sendError(reply, 404, "not_found", NOTE_NOT_FOUND);
      const seq = parseSeq(params.seq);
      if (seq === null) return sendError(reply, 404, "not_found", VERSION_NOT_FOUND);
      if (!(await canEdit(reply, request.user!.id, id))) return reply;
      const [row] = await deps.db
        .select({ id: noteVersions.id, seq: noteVersions.seq, ydoc: noteVersions.ydoc })
        .from(noteVersions)
        .where(and(eq(noteVersions.noteId, id), eq(noteVersions.seq, seq)))
        .limit(1);
      if (!row) return sendError(reply, 404, "not_found", VERSION_NOT_FOUND);
      // Moving clears versions, so one seq can mean different content; the web keys its cache by id.
      reply.header("cache-control", "private, no-store");
      return reply.send({ id: row.id, seq: row.seq, ydoc: Buffer.from(row.ydoc).toString("base64") } satisfies VersionSnapshotDto);
    });

    app.post("/api/notes/:id/versions", { preHandler: app.authenticate }, async (request, reply) => {
      const id = noteIdOf((request.params as { id: string }).id);
      if (id === null) return sendError(reply, 404, "not_found", NOTE_NOT_FOUND);
      const parsed = saveBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) return sendError(reply, 400, "invalid_body", INVALID_BODY);
      const name = normalizeVersionName(parsed.data.name ?? null);
      if (!name.ok) return sendError(reply, 400, "invalid_body", INVALID_NAME);
      const userId = request.user!.id;
      if (!(await canEdit(reply, userId, id))) return reply;
      // Version writes share the edit limiter.
      if (!deps.limiters.edit.consume(userId)) return tooMany(reply);
      const out = await deps.writes.saveVersion(request.log, { noteId: id, userId, name: name.name });
      if (!out.ok) {
        return out.kind === "note-deleted"
          ? sendError(reply, 404, "not_found", NOTE_NOT_FOUND)
          : sendError(reply, 503, "server_busy", "The note is being written right now. Try again in a moment.");
      }
      const [dto] = await toVersionDtos(deps.db, id, [out.row]);
      return reply.code(201).send({ ...dto!, upgraded: out.upgraded } satisfies SavedVersionDto);
    });

    if (deps.writes.available) {
      app.post("/api/notes/:id/versions/:seq/apply", { preHandler: app.authenticate }, async (request, reply) => {
        const params = request.params as { id: string; seq: string };
        const id = noteIdOf(params.id);
        if (id === null) return sendError(reply, 404, "not_found", NOTE_NOT_FOUND);
        const seq = parseSeq(params.seq);
        if (seq === null) return sendError(reply, 404, "not_found", VERSION_NOT_FOUND);
        const parsed = applyBodySchema.safeParse(request.body ?? {});
        if (!parsed.success) return sendError(reply, 400, "invalid_body", INVALID_BODY);
        const userId = request.user!.id;
        if (!(await canEdit(reply, userId, id))) return reply;
        if (!deps.limiters.edit.consume(userId)) return tooMany(reply);
        const out = await deps.writes.applyVersion(request.log, {
          noteId: id, seq, versionId: parsed.data.versionId.toLowerCase(), userId, discardUnsaved: parsed.data.discardUnsaved,
        });
        if (!out.ok) {
          if (out.kind === "busy") return sendError(reply, 503, "server_busy", "The note is being written right now. Try again in a moment.");
          if (out.kind === "gone") return sendError(reply, 404, "not_found", NOTE_NOT_FOUND);
          if (out.kind === "too_large") return sendNoteTooLarge(reply, out.limitBytes);
          if (out.code === "not_found") return sendError(reply, 404, "not_found", VERSION_NOT_FOUND);
          if (out.code === "version_mismatch") return sendError(reply, 409, "version_mismatch", "That version no longer exists or has been replaced. Reload and try again.");
          return sendError(reply, 409, "version_unsaved_changes", "The note has changes that aren't in any saved version.");
        }
        const current = await deps.versions.currentOf(id);
        if (current === null) return sendError(reply, 404, "not_found", NOTE_NOT_FOUND);
        return reply.send({ current: await withCurrentBase(deps.db, id, current) } satisfies ApplyVersionResultDto);
      });
    }

    app.patch("/api/notes/:id/versions/:seq", { preHandler: app.authenticate }, async (request, reply) => {
      const params = request.params as { id: string; seq: string };
      const id = noteIdOf(params.id);
      if (id === null) return sendError(reply, 404, "not_found", NOTE_NOT_FOUND);
      const seq = parseSeq(params.seq);
      if (seq === null) return sendError(reply, 404, "not_found", VERSION_NOT_FOUND);
      const parsed = renameBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) return sendError(reply, 400, "invalid_body", INVALID_BODY);
      const name = normalizeVersionName(parsed.data.name);
      if (!name.ok) return sendError(reply, 400, "invalid_body", INVALID_NAME);
      const userId = request.user!.id;
      if (!(await canEdit(reply, userId, id))) return reply;
      if (!deps.limiters.edit.consume(userId)) return tooMany(reply);
      // Naming an automatic version converts it to manual (kept permanently).
      const [row] = await deps.db
        .update(noteVersions)
        .set({ name: name.name, kind: "manual" })
        .where(and(eq(noteVersions.noteId, id), eq(noteVersions.seq, seq)))
        .returning();
      if (!row) return sendError(reply, 404, "not_found", VERSION_NOT_FOUND);
      const [dto] = await toVersionDtos(deps.db, id, [row]);
      return reply.send(dto! satisfies VersionDto);
    });

    app.delete("/api/notes/:id/versions/:seq", { preHandler: app.authenticate }, async (request, reply) => {
      const params = request.params as { id: string; seq: string };
      const id = noteIdOf(params.id);
      if (id === null) return sendError(reply, 404, "not_found", NOTE_NOT_FOUND);
      const seq = parseSeq(params.seq);
      if (seq === null) return sendError(reply, 404, "not_found", VERSION_NOT_FOUND);
      const userId = request.user!.id;
      if (!(await canEdit(reply, userId, id))) return reply;
      if (!deps.limiters.edit.consume(userId)) return tooMany(reply);
      // Known limitation: under READ COMMITTED the DELETE and setVersionBase's EXISTS see separate snapshots, so version_base_seq (no FK) can end up dangling; narrow window, the only consequence is a dangling current.baseSeq.
      const gone = await deps.db
        .delete(noteVersions)
        .where(and(
          eq(noteVersions.noteId, id),
          eq(noteVersions.seq, seq),
          sql`note_versions.seq is distinct from (select notes.version_base_seq from notes where notes.id = ${id})`,
        ))
        .returning({ id: noteVersions.id });
      if (gone.length === 1) return reply.code(204).send();
      const [still] = await deps.db
        .select({ id: noteVersions.id })
        .from(noteVersions)
        .where(and(eq(noteVersions.noteId, id), eq(noteVersions.seq, seq)))
        .limit(1);
      return still
        ? sendError(reply, 409, "version_is_base", "This version is the base of the current content, so it can't be deleted.")
        : sendError(reply, 404, "not_found", VERSION_NOT_FOUND);
    });
  };
}
