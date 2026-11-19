import type { QueryClient } from "@tanstack/react-query";
import type { FolderDto, FolderSpaceDto, NoteDto } from "@knotebook/shared";
import { fetchFolders, FOLDERS_QUERY_KEY } from "@/api/folders";
import { setCollapsed } from "./collapse";

/**
 * First-bundle module: no string-bundle import and no `tree.ts` import (module dependencies stay one-way). `GET /api/folders` returns everything unordered; the client assembles by `parentId`.
 * Fallback: a `parentId` not in the list, or in another space → root folder; a cycle (the server prevents it, bad data only) is cut at its entry point so its folders and notes stay visible.
 * Tree, path rows and expand chain all use the same `parentOf`; traversals also guard with `visited`.
 */

export const FOLDER_COLLATOR = new Intl.Collator("zh-Hant", { numeric: true, sensitivity: "base" });

export type FolderSpaceKey = "personal" | "shared" | `group:${string}`;

export function spaceKeyOf(space: FolderSpaceDto): FolderSpaceKey {
  return space.kind === "group" ? `group:${space.groupId}` : space.kind;
}

export interface FolderIndex {
  readonly byId: ReadonlyMap<string, FolderDto>;
  children(space: FolderSpaceKey, parentId: string | null): readonly FolderDto[];
  /** Parent after fallback and cycle cutting (null = root level; an id missing from the index also returns null). */
  parentOf(folderId: string): string | null;
}

const NO_FOLDERS: readonly FolderDto[] = [];

function effectiveParentId(byId: ReadonlyMap<string, FolderDto>, folder: FolderDto): string | null {
  if (folder.parentId === null) return null;
  const parent = byId.get(folder.parentId);
  return parent !== undefined && spaceKeyOf(parent.space) === spaceKeyOf(folder.space) ? parent.id : null;
}

export function indexFolders(folders: readonly FolderDto[]): FolderIndex {
  const byId = new Map<string, FolderDto>(folders.map((folder) => [folder.id, folder]));
  const parents = new Map<string, string | null>();
  for (const folder of byId.values()) parents.set(folder.id, effectiveParentId(byId, folder));
  for (const folder of byId.values()) {
    const seen = new Set<string>();
    let id: string | null = folder.id;
    while (id !== null && !seen.has(id)) {
      seen.add(id);
      id = parents.get(id) ?? null;
    }
    if (id !== null) parents.set(id, null);
  }
  const buckets = new Map<FolderSpaceKey, Map<string | null, FolderDto[]>>();
  for (const folder of folders) {
    const space = spaceKeyOf(folder.space);
    let bySpace = buckets.get(space);
    if (bySpace === undefined) {
      bySpace = new Map();
      buckets.set(space, bySpace);
    }
    const parentId = parents.get(folder.id) ?? null;
    const list = bySpace.get(parentId);
    if (list === undefined) bySpace.set(parentId, [folder]);
    else list.push(folder);
  }
  for (const bySpace of buckets.values()) {
    for (const list of bySpace.values()) list.sort((a, b) => FOLDER_COLLATOR.compare(a.name, b.name));
  }
  return {
    byId,
    children: (space, parentId) => buckets.get(space)?.get(parentId) ?? NO_FOLDERS,
    parentOf: (folderId) => parents.get(folderId) ?? null,
  };
}

export const EMPTY_FOLDER_INDEX: FolderIndex = indexFolders([]);

export function folderPath(index: FolderIndex, folderId: string): string[] | null {
  if (!index.byId.has(folderId)) return null;
  const names: string[] = [];
  const visited = new Set<string>();
  let current = index.byId.get(folderId);
  while (current !== undefined) {
    if (visited.has(current.id)) break;
    visited.add(current.id);
    names.push(current.name);
    const parentId = index.parentOf(current.id);
    current = parentId === null ? undefined : index.byId.get(parentId);
  }
  return names.reverse();
}

export function subtreeFolderIds(index: FolderIndex, folderId: string): string[] {
  const out: string[] = [];
  const visited = new Set<string>();
  const walk = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    out.push(id);
    const folder = index.byId.get(id);
    if (folder === undefined) return;
    for (const child of index.children(spaceKeyOf(folder.space), id)) walk(child.id);
  };
  walk(folderId);
  return out;
}

/** Notes in a different space than the folder count as root (as in the tree), so they're excluded. `spaceOf` comes from the caller (`noteSpaceKey` of `tree.ts`; this module doesn't import it). */
export function liveNotesUnder(
  index: FolderIndex,
  folderId: string,
  notes: readonly NoteDto[],
  spaceOf: (note: NoteDto) => FolderSpaceKey,
): NoteDto[] {
  const ids = new Set(subtreeFolderIds(index, folderId));
  return notes.filter((note) => {
    if (note.folderId === null || !ids.has(note.folderId)) return false;
    const folder = index.byId.get(note.folderId);
    return folder !== undefined && spaceKeyOf(folder.space) === spaceOf(note);
  });
}

export function expandFolderChain(index: FolderIndex, folderId: string): void {
  const visited = new Set<string>();
  let id: string | null = folderId;
  while (id !== null && !visited.has(id)) {
    visited.add(id);
    setCollapsed(`folder:${id}`, false);
    id = index.parentOf(id);
  }
}

/**
 * Always `fetchQuery` (staleTime 0): on the trash tab `["folders"]` has no observer, so `invalidateQueries` wouldn't refetch and the rebuilt folders wouldn't be cached.
 * Must run after `invalidateTrashRelated`: with an observer that already triggered a refetch, and this merges into the same request.
 * All errors (including cancellation) are swallowed: expanding is a side effect.
 */
export async function expandAfterRestore(queryClient: QueryClient, restored: readonly NoteDto[]): Promise<void> {
  try {
    const folderIds = restored.flatMap((note) => (note.folderId === null ? [] : [note.folderId]));
    if (folderIds.length === 0) return;
    const folders = await queryClient.fetchQuery({ queryKey: FOLDERS_QUERY_KEY, queryFn: fetchFolders, staleTime: 0 });
    const index = indexFolders(folders);
    for (const folderId of folderIds) expandFolderChain(index, folderId);
  } catch {
  }
}

/** Root-level folder = 1; unknown id = 0; stops at a cycle (defensive). */
export function folderDepth(index: FolderIndex, folderId: string): number {
  if (!index.byId.has(folderId)) return 0;
  const visited = new Set<string>();
  let depth = 0;
  let id: string | null = folderId;
  while (id !== null && !visited.has(id)) {
    visited.add(id);
    depth += 1;
    id = index.parentOf(id);
  }
  return depth;
}

/** Leaf = 1; unknown id = 1 (treated as a leaf); a cycle isn't recounted. */
export function subtreeHeight(index: FolderIndex, folderId: string): number {
  const visited = new Set<string>();
  const height = (id: string): number => {
    visited.add(id);
    const folder = index.byId.get(id);
    if (folder === undefined) return 1;
    let deepest = 0;
    for (const child of index.children(spaceKeyOf(folder.space), id)) {
      if (!visited.has(child.id)) deepest = Math.max(deepest, height(child.id));
    }
    return deepest + 1;
  };
  return height(folderId);
}

export function isInSubtree(index: FolderIndex, ancestorId: string, candidateId: string): boolean {
  const visited = new Set<string>();
  let id: string | null = candidateId;
  while (id !== null && !visited.has(id)) {
    if (id === ancestorId) return true;
    visited.add(id);
    id = index.parentOf(id);
  }
  return false;
}
