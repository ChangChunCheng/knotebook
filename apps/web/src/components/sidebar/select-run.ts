import { useCallback, useSyncExternalStore } from "react";
import type { SidebarTabActions } from "@/lib/sidebar-tab";

/**
 * One per `SidebarTabProvider`, keyed by its stable actions object (the one owning the session counter) and read by every `SelectActionBar`: a bar mounted later (drawer reopened, Done→Select) also shows "processing" with disabled buttons, so a second round can't start (no duplicate copies).
 * Not keyed by session: a new session from Done→Select wouldn't find the old round and the buttons would become clickable. Whether to apply the result is decided by the caller comparing sessions.
 * Import only through the SelectLazy chain and tests (inside the lazy chunk, zero first-bundle cost).
 */

export interface SelectRun {
  progress: { done: number; total: number };
}

const runs = new WeakMap<SidebarTabActions, SelectRun>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSelectRun(owner: SidebarTabActions): SelectRun | null {
  const getSnapshot = useCallback(() => runs.get(owner) ?? null, [owner]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function beginSelectRun(owner: SidebarTabActions, total: number): boolean {
  if (runs.has(owner)) return false;
  runs.set(owner, { progress: { done: 0, total } });
  emit();
  return true;
}

export function updateSelectRun(owner: SidebarTabActions, done: number): void {
  const run = runs.get(owner);
  if (!run) return;
  runs.set(owner, { progress: { done, total: run.progress.total } });
  emit();
}

export function endSelectRun(owner: SidebarTabActions): void {
  if (runs.delete(owner)) emit();
}
