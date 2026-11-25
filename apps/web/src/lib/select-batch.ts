import type { QueryClient } from "@tanstack/react-query";
import type { FavoriteDto, NoteDto } from "@knotebook/shared";
import { api, ApiFail } from "@/api/client";
import { FAVORITES_QUERY_KEY } from "@/api/favorites";
import { deleteFolderRequest, invalidateFolderRelated, isFolderNotFound, moveFolderRequest, placeNoteRequest } from "@/api/folders";
import { applyMovedNote, refetchAfterFailure } from "@/api/note-move";
import type { DestTarget } from "@/components/sidebar/destination-level";
import type { SelectionTarget } from "@/components/sidebar/select-model";
import type { SelectionNode } from "@/lib/sidebar-selection";

/**
 * Batch execution for select mode in the ordinary tabs (#181). Import only from the SelectLazy chain and tests.
 * - No mutation hook: a batch must finish even if the action bar or drawer unmounts midway.
 * - Sequential, reusing the single-note endpoints' transactions, permissions and capacity checks; this is also what makes
 *   stopping and reporting "how many are done" possible.
 * - Skip 403 and 404 `not_found`; stop on everything else (see `classifyBatchError`). A move's 409 `conflict` is a narrow
 *   race, so stopping is safe.
 * - Copy consumes the edit limiter (default 30/min, admin-adjustable down to 3; notes with attachments also consume the
 *   upload limiter): a large copy stops with 429.
 * - Cache invalidation is in `finally`: if a hook throws the batch rejects, and what was already sent still needs reconciling.
 */

/** 404 `folder_not_found`: skipped with `folderGone: "skip"` (folder delete: already gone), otherwise stop (the chosen destination is gone). */
export function classifyBatchError(err: unknown, opts: { folderGone?: "skip" | "stop" } = {}): "skip" | "stop" {
  if (isFolderNotFound(err)) return opts.folderGone === "skip" ? "skip" : "stop";
  if (err instanceof ApiFail && (err.status === 403 || (err.status === 404 && err.code === "not_found"))) return "skip";
  return "stop";
}

export interface BatchOutcome<R> {
  done: R[];
  /** Counts only skips the server returned (client-excluded ones are added by the caller). */
  skipped: number;
  skippedDetail: Array<{ node: SelectionNode; err: unknown }>;
  stopped: { cause: unknown; remaining: SelectionNode[] } | null;
}

type BatchHooks = { onProgress?: (processed: number, total: number) => void };

/** Hooks must not throw: the whole batch would reject with no outcome (neither the completed count nor "Undo"). */
export async function runSequential<T, R>(
  items: readonly T[],
  nodeOf: (item: T) => SelectionNode,
  run: (item: T) => Promise<R>,
  hooks: {
    beforeEach?: (item: T) => void;
    afterFailure?: (item: T, err: unknown, kind: "skip" | "stop") => void;
    onProgress?: (processed: number, total: number) => void;
    classify?: (err: unknown, item: T) => "skip" | "stop";
  } = {},
): Promise<BatchOutcome<R>> {
  const classify = hooks.classify ?? ((err: unknown) => classifyBatchError(err));
  const done: R[] = [];
  const skippedDetail: Array<{ node: SelectionNode; err: unknown }> = [];
  for (const [index, item] of items.entries()) {
    hooks.beforeEach?.(item);
    try {
      done.push(await run(item));
    } catch (err) {
      const kind = classify(err, item);
      hooks.afterFailure?.(item, err, kind);
      if (kind === "stop") {
        return { done, skipped: skippedDetail.length, skippedDetail, stopped: { cause: err, remaining: items.slice(index).map(nodeOf) } };
      }
      skippedDetail.push({ node: nodeOf(item), err });
    }
    hooks.onProgress?.(index + 1, items.length);
  }
  return { done, skipped: skippedDetail.length, skippedDetail, stopped: null };
}

const noteNode = (note: NoteDto): SelectionNode => ({ kind: "note", id: note.id });
const notePath = (id: string): string => `/api/notes/${encodeURIComponent(id)}`;

export async function moveNotesInOrder(
  notes: readonly NoteDto[],
  body: { groupId: string; folderId?: string; keepHistory: boolean },
  deps: { queryClient: QueryClient } & BatchHooks,
): Promise<BatchOutcome<NoteDto>> {
  const { queryClient } = deps;
  const payload = JSON.stringify(body);
  try {
    return await runSequential(
      notes,
      noteNode,
      async (note) => {
        const moved = await api<NoteDto>(`${notePath(note.id)}/move`, { method: "POST", body: payload });
        applyMovedNote(queryClient, note.id, moved);
        return moved;
      },
      {
        afterFailure: (note) => {
          void refetchAfterFailure(queryClient, note.id);
        },
        onProgress: deps.onProgress,
      },
    );
  } finally {
    void queryClient.invalidateQueries({ queryKey: ["groups"] });
    void queryClient.invalidateQueries({ queryKey: ["folders"] });
  }
}

type CopyBody = { groupId?: string; folderId?: string };

/** Personal root → `{}`: the root never carries folderId (`null` gets a 400). */
function placeCopyBody(target: Extract<DestTarget, { kind: "place" }>): CopyBody {
  const body: CopyBody = {};
  if (target.space.kind === "group") body.groupId = target.space.groupId;
  if (target.folder !== null) body.folderId = target.folder.id;
  return body;
}

function makeCopyBody(note: NoteDto): CopyBody {
  const body: CopyBody = {};
  if (note.groupId !== null) body.groupId = note.groupId;
  if (note.folderId !== null) body.folderId = note.folderId;
  return body;
}

/** makeCopy: on 404 `folder_not_found` (original folder gone) a note is resent once without folderId; an explicit target stops instead. */
export async function copyNotesInOrder(
  notes: readonly NoteDto[],
  target: DestTarget,
  deps: { queryClient: QueryClient } & BatchHooks,
): Promise<BatchOutcome<NoteDto>> {
  const { queryClient } = deps;
  const post = (note: NoteDto, body: CopyBody) => api<NoteDto>(`${notePath(note.id)}/copy`, { method: "POST", body: JSON.stringify(body) });
  try {
    return await runSequential(
      notes,
      noteNode,
      async (note) => {
        let copy: NoteDto;
        if (target.kind === "place") copy = await post(note, placeCopyBody(target));
        else {
          const body = makeCopyBody(note);
          try {
            copy = await post(note, body);
          } catch (err) {
            if (body.folderId === undefined || !isFolderNotFound(err)) throw err;
            copy = await post(note, body.groupId === undefined ? {} : { groupId: body.groupId });
          }
        }
        queryClient.setQueryData(["note", copy.id], copy);
        return copy;
      },
      { onProgress: deps.onProgress },
    );
  } finally {
    void queryClient.invalidateQueries({ queryKey: ["notes"] });
    void queryClient.invalidateQueries({ queryKey: ["folders"] });
  }
}

export type PlacedItem = { kind: "note"; id: string; from: string | null } | { kind: "folder"; id: string; from: string | null };

const targetNode = (target: SelectionTarget): SelectionNode =>
  target.kind === "note" ? { kind: "note", id: target.note.id } : { kind: "folder", id: target.folder.id };
const placedNode = (item: PlacedItem): SelectionNode => ({ kind: item.kind, id: item.id });

async function placeOne(queryClient: QueryClient, kind: "note" | "folder", id: string, folderId: string | null): Promise<void> {
  if (kind === "folder") {
    await moveFolderRequest(id, folderId);
    return;
  }
  const placed = await placeNoteRequest(id, folderId);
  queryClient.setQueryData(["note", placed.id], placed);
}

export async function placeTargetsInOrder(
  items: readonly SelectionTarget[],
  folderId: string | null,
  deps: { queryClient: QueryClient } & BatchHooks,
): Promise<BatchOutcome<PlacedItem>> {
  const { queryClient } = deps;
  try {
    return await runSequential(
      items,
      targetNode,
      async (target): Promise<PlacedItem> => {
        if (target.kind === "folder") {
          await placeOne(queryClient, "folder", target.folder.id, folderId);
          return { kind: "folder", id: target.folder.id, from: target.folder.parentId };
        }
        await placeOne(queryClient, "note", target.note.id, folderId);
        return { kind: "note", id: target.note.id, from: target.note.folderId };
      },
      { onProgress: deps.onProgress },
    );
  } finally {
    invalidateFolderRelated(queryClient, { trash: items.some((target) => target.kind === "folder") });
  }
}

export async function undoPlacements(items: readonly PlacedItem[], deps: { queryClient: QueryClient }): Promise<BatchOutcome<PlacedItem>> {
  const { queryClient } = deps;
  try {
    return await runSequential(items, placedNode, async (item) => {
      await placeOne(queryClient, item.kind, item.id, item.from);
      return item;
    });
  } finally {
    invalidateFolderRelated(queryClient, { trash: items.some((item) => item.kind === "folder") });
  }
}

export async function deleteTargetsInOrder(
  items: readonly SelectionTarget[],
  deps: {
    queryClient: QueryClient;
    beforeEach?: (t: SelectionTarget) => void;
    afterFailure?: (t: SelectionTarget, err: unknown, kind: "skip" | "stop") => void;
  } & BatchHooks,
): Promise<BatchOutcome<{ target: SelectionTarget; trashedNoteIds: string[] }>> {
  const { queryClient } = deps;
  const ordered = [...items.filter((target) => target.kind === "folder"), ...items.filter((target) => target.kind === "note")];
  const trashedIds: string[] = [];
  try {
    return await runSequential(
      ordered,
      targetNode,
      async (target) => {
        let trashedNoteIds: string[];
        if (target.kind === "folder") trashedNoteIds = (await deleteFolderRequest(target.folder.id)).trashedNoteIds;
        else {
          await api<void>(notePath(target.note.id), { method: "DELETE" });
          trashedNoteIds = [target.note.id];
        }
        trashedIds.push(...trashedNoteIds);
        return { target, trashedNoteIds };
      },
      {
        beforeEach: deps.beforeEach,
        afterFailure: deps.afterFailure,
        onProgress: deps.onProgress,
        classify: (err, target) => (target.kind === "folder" ? classifyBatchError(err, { folderGone: "skip" }) : classifyBatchError(err)),
      },
    );
  } finally {
    invalidateFolderRelated(queryClient, { trash: true });
    void queryClient.invalidateQueries({ queryKey: ["backlinks"] });
    for (const id of trashedIds) void queryClient.invalidateQueries({ queryKey: ["note", id] });
  }
}

export async function unfavoriteInOrder(
  noteIds: readonly string[],
  deps: { queryClient: QueryClient } & BatchHooks,
): Promise<BatchOutcome<string>> {
  const { queryClient } = deps;
  try {
    return await runSequential(
      noteIds,
      (id): SelectionNode => ({ kind: "note", id }),
      async (id) => {
        await api<void>(`/api/favorites/${encodeURIComponent(id)}`, { method: "DELETE" });
        queryClient.setQueryData<FavoriteDto[]>(FAVORITES_QUERY_KEY, (old) => old?.filter((favorite) => favorite.noteId !== id));
        return id;
      },
      { onProgress: deps.onProgress },
    );
  } finally {
    void queryClient.invalidateQueries({ queryKey: FAVORITES_QUERY_KEY });
  }
}
