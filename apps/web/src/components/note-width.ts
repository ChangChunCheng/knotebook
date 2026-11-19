import { useCallback, useSyncExternalStore } from "react";
import { NOTE_WIDTHS, type NoteWidth } from "@knotebook/shared";

/** Values `"wide"`/`"full"` under `note.width.<lowercase noteId>` (standard = no key). Module `values` Map is the source of truth, seeded from localStorage; storage events from other tabs update it. The `storage` listener and the Map are dropped when the last subscriber leaves, because changes are missed while unlistened and would show stale values. */
export const NOTE_WIDTH_STORAGE_PREFIX = "note.width.";

const values = new Map<string, NoteWidth>();
const listeners = new Map<string, Set<() => void>>();

export function toNoteWidth(value: unknown): NoteWidth {
  return (NOTE_WIDTHS as readonly unknown[]).includes(value) ? (value as NoteWidth) : "standard";
}

function keyOf(noteId: string): string {
  return noteId.toLowerCase();
}

function notify(id: string): void {
  for (const entry of [...(listeners.get(id) ?? [])]) entry();
}

function notifyAll(): void {
  for (const id of [...listeners.keys()]) notify(id);
}

function onStorage(event: StorageEvent): void {
  if (event.key === null) {
    values.clear();
    notifyAll();
    return;
  }
  if (!event.key.startsWith(NOTE_WIDTH_STORAGE_PREFIX)) return;
  const id = keyOf(event.key.slice(NOTE_WIDTH_STORAGE_PREFIX.length));
  values.set(id, toNoteWidth(event.newValue));
  notify(id);
}

export function getNoteWidth(noteId: string): NoteWidth {
  const id = keyOf(noteId);
  const cached = values.get(id);
  if (cached !== undefined) return cached;
  let width: NoteWidth;
  try {
    width = toNoteWidth(window.localStorage.getItem(NOTE_WIDTH_STORAGE_PREFIX + id));
  } catch {
    width = "standard";
  }
  values.set(id, width);
  return width;
}

export function setNoteWidth(noteId: string, width: NoteWidth): void {
  const id = keyOf(noteId);
  values.set(id, width);
  notify(id);
  try {
    if (width === "standard") window.localStorage.removeItem(NOTE_WIDTH_STORAGE_PREFIX + id);
    else window.localStorage.setItem(NOTE_WIDTH_STORAGE_PREFIX + id, width);
  } catch {
    // Unwritable storage: the width stays only in this tab's Map.
  }
}

export function subscribeNoteWidth(noteId: string, listener: () => void): () => void {
  const id = keyOf(noteId);
  // Fresh function per subscription so the same listener subscribed twice counts twice.
  const entry = () => listener();
  if (listeners.size === 0) window.addEventListener("storage", onStorage);
  let set = listeners.get(id);
  if (!set) {
    set = new Set();
    listeners.set(id, set);
  }
  set.add(entry);
  return () => {
    if (!listeners.get(id)?.delete(entry)) return;
    if (listeners.get(id)!.size === 0) listeners.delete(id);
    if (listeners.size === 0) {
      window.removeEventListener("storage", onStorage);
      values.clear();
    }
  };
}

const NOOP_UNSUBSCRIBE = () => {};

export function useNoteWidth(noteId: string | null): [NoteWidth, (width: NoteWidth) => void] {
  const subscribe = useCallback(
    (listener: () => void) => (noteId === null ? NOOP_UNSUBSCRIBE : subscribeNoteWidth(noteId, listener)),
    [noteId],
  );
  const width = useSyncExternalStore(subscribe, () => (noteId === null ? "standard" : getNoteWidth(noteId)));
  const setWidth = useCallback(
    (next: NoteWidth) => {
      if (noteId !== null) setNoteWidth(noteId, next);
    },
    [noteId],
  );
  return [width, setWidth];
}

export function resetNoteWidthsForTest(): void {
  values.clear();
  listeners.clear();
  window.removeEventListener("storage", onStorage);
}
