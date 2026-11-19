import { useSyncExternalStore } from "react";

/** Same structure as `collapse.ts`; the memory overlay is checked first: when `setItem` throws, the old stored value would otherwise override the sort just chosen. First-bundle module: no `tree.ts` import. */

export type FolderSort = "name" | "recent" | "size";

export const FOLDER_SORT_PREFIX = "sidebar.sort.folder:";
export const DEFAULT_FOLDER_SORT: FolderSort = "recent";

const overlay = new Map<string, FolderSort>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function isFolderSort(value: string | null): value is FolderSort {
  return value === "name" || value === "recent" || value === "size";
}

export function folderSortOf(folderId: string): FolderSort {
  const cached = overlay.get(folderId);
  if (cached !== undefined) return cached;
  try {
    const stored = window.localStorage.getItem(FOLDER_SORT_PREFIX + folderId);
    return isFolderSort(stored) ? stored : DEFAULT_FOLDER_SORT;
  } catch {
    return DEFAULT_FOLDER_SORT;
  }
}

/** A new query function on every write: callers use it as a `useMemo` dependency so the tree is rebuilt. */
let currentSortOf: (folderId: string) => FolderSort = (folderId) => folderSortOf(folderId);

export function setFolderSort(folderId: string, sort: FolderSort): void {
  try {
    window.localStorage.setItem(FOLDER_SORT_PREFIX + folderId, sort);
    overlay.delete(folderId);
  } catch {
    overlay.set(folderId, sort);
  }
  currentSortOf = (id) => folderSortOf(id);
  for (const listener of [...listeners]) listener();
}

export function useFolderSort(folderId: string): FolderSort {
  return useSyncExternalStore(subscribe, () => folderSortOf(folderId));
}

export function useFolderSortOf(): (folderId: string) => FolderSort {
  return useSyncExternalStore(subscribe, () => currentSortOf);
}

/** @internal tests only: clear the overlay and replace the query function. Listeners aren't cleared: components unsubscribe on unmount. */
export function __resetFolderSortForTests(): void {
  overlay.clear();
  currentSortOf = (folderId) => folderSortOf(folderId);
}
