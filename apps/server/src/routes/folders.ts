// Body ids are lowercased here; the service layer validates the UUID shape (a non-UUID looks like a nonexistent id). No transaction here; they live in folders/service.ts.
// Writes charge the folder limiter in folders/service.ts, separate from the content edit limiter (FOLDER_LIMIT).
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { FolderDeleteResultDto, FolderListDto, FolderSpaceDto, NoteDto } from "@knotebook/shared";
import { sendError } from "../http/errors.js";
import { createFolder, deleteFolder, listFolders, placeNote, updateFolder, type FolderServiceDeps } from "../folders/service.js";

const spaceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("personal") }).strict(),
  z.object({ kind: z.literal("shared") }).strict(),
  z.object({ kind: z.literal("group"), groupId: z.string() }).strict(),
]);
const createBodySchema = z.union([
  z.object({ name: z.string(), parentId: z.string() }).strict(),
  z.object({ name: z.string(), space: spaceSchema }).strict(),
]);
const updateBodySchema = z
  .object({ name: z.string().optional(), parentId: z.string().nullable().optional() })
  .strict()
  .refine(b => b.name !== undefined || b.parentId !== undefined, "Invalid request body: send at least one field.");
const placeBodySchema = z.object({ folderId: z.string().nullable() }).strict();
const deleteBodySchema = z.object({ onlyIfEmpty: z.boolean().optional() }).strict();

export function foldersRoutes(deps: FolderServiceDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get("/api/folders", { preHandler: app.authenticateAny("notes:read") }, async request => {
      return { folders: await listFolders(deps.db, request.user!.id) } satisfies FolderListDto;
    });

    app.post("/api/folders", { preHandler: app.authenticate }, async (request, reply) => {
      const parsed = createBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");
      const body = parsed.data;
      let parent: { folderId: string } | { space: FolderSpaceDto };
      if ("parentId" in body) parent = { folderId: body.parentId.toLowerCase() };
      else if (body.space.kind === "group") parent = { space: { kind: "group", groupId: body.space.groupId.toLowerCase() } };
      else parent = { space: { kind: body.space.kind } };
      const out = await createFolder(deps, { by: request.user!.id, name: body.name, parent });
      if (out.kind === "error") return sendError(reply, out.status, out.code, out.message);
      return reply.code(201).send(out.folder);
    });

    app.patch("/api/folders/:id", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = updateBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");
      const { name, parentId } = parsed.data;
      const out = await updateFolder(deps, {
        by: request.user!.id,
        folderId: id,
        ...(name !== undefined ? { name } : {}),
        ...(parentId !== undefined ? { parentId: parentId === null ? null : parentId.toLowerCase() } : {}),
      });
      if (out.kind === "error") return sendError(reply, out.status, out.code, out.message);
      return out.folder;
    });

    app.delete("/api/folders/:id", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = deleteBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");
      const out = await deleteFolder(deps, { by: request.user!.id, folderId: id, onlyIfEmpty: parsed.data.onlyIfEmpty === true });
      if (out.kind === "error") return sendError(reply, out.status, out.code, out.message);
      return out.result satisfies FolderDeleteResultDto;
    });

    // Entry checks and error shapes live in folders/service.ts, hence not in routes/notes.ts.
    app.put("/api/notes/:id/folder", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = placeBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");
      const { folderId } = parsed.data;
      const out = await placeNote(deps, { by: request.user!.id, noteId: id, folderId: folderId === null ? null : folderId.toLowerCase() });
      if (out.kind === "error") return sendError(reply, out.status, out.code, out.message);
      return out.note satisfies NoteDto;
    });
  };
}
