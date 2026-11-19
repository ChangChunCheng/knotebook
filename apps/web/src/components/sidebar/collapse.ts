import { useCallback, useSyncExternalStore } from "react";

/**
 * Shared by the static card, drawer and select tree (select-all and Shift ranges need to know which groups are collapsed).
 * The in-memory overlay is checked first: in Safari private mode or with a full quota `getItem` works but `setItem` throws, so reading localStorage first would revert every toggle and the group could never collapse.
 * Only failed writes enter the overlay (session-only); a successful write removes the key.
 */

/** localStorage key prefix: `sidebar.collapsed.group:<id>` / `sidebar.collapsed.folder:<id>`; value "1" = collapsed, missing key = expanded. */
export const COLLAPSE_STORAGE_PREFIX = "sidebar.collapsed.";
export type SidebarSectionKey = `group:${string}` | `folder:${string}`;

const overlay = new Map<SidebarSectionKey, boolean>();
const listeners = new Set<() => void>();
let version = 0;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isCollapsed(key: SidebarSectionKey): boolean {
  const cached = overlay.get(key);
  if (cached !== undefined) return cached;
  try {
    return window.localStorage.getItem(COLLAPSE_STORAGE_PREFIX + key) === "1";
  } catch {
    return false;
  }
}

export function setCollapsed(key: SidebarSectionKey, collapsed: boolean): void {
  try {
    if (collapsed) window.localStorage.setItem(COLLAPSE_STORAGE_PREFIX + key, "1");
    else window.localStorage.removeItem(COLLAPSE_STORAGE_PREFIX + key);
    overlay.delete(key);
  } catch {
    overlay.set(key, collapsed);
  }
  version += 1;
  for (const listener of [...listeners]) listener();
}

export function useCollapsed(key: SidebarSectionKey): [expanded: boolean, toggle: () => void] {
  const collapsed = useSyncExternalStore(subscribe, () => isCollapsed(key));
  const toggle = useCallback(() => setCollapsed(key, !isCollapsed(key)), [key]);
  return [!collapsed, toggle];
}

export function useCollapseVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}

/** @internal tests only: clear overlay and version. */
export function __resetCollapseForTests(): void {
  overlay.clear();
  version = 0;
}
