/**
 * List, search layer and notes share one document scroll on phones, so each screen's position is
 * remembered separately. The same note under a changed URL (canonicalization after a title
 * change) does not move.
 */
export type PhoneScreen = { kind: "list" } | { kind: "search" } | { kind: "note"; path: string };

export interface PhoneScrollMemory {
  list: number;
  note: number;
  underSearch: { path: string; y: number } | null;
}

export function createPhoneScrollMemory(): PhoneScrollMemory {
  return { list: 0, note: 0, underSearch: null };
}

export function phoneScreenKey(screen: PhoneScreen | null): string {
  if (screen === null) return "";
  return screen.kind === "note" ? `note:${screen.path}` : screen.kind;
}

export function rememberPhoneScroll(memory: PhoneScrollMemory, screen: PhoneScreen, y: number): void {
  if (screen.kind === "list") memory.list = y;
  else if (screen.kind === "note") memory.note = y;
}

/** null = do not move. `canonicalFrom`: the old URL this entry was canonicalized from. */
export function enterPhoneScreen(memory: PhoneScrollMemory, prev: PhoneScreen | null, next: PhoneScreen, canonicalFrom: string | null): number | null {
  const sameNoteAs = (path: string) => next.kind === "note" && (next.path === path || canonicalFrom === path);
  if (prev === null) {
    if (next.kind === "search") memory.underSearch = null;
    return null;
  }
  switch (next.kind) {
    case "list":
      return prev.kind === "list" ? null : memory.list;
    case "search":
      if (prev.kind === "search") return null;
      memory.underSearch = prev.kind === "note" ? { path: prev.path, y: memory.note } : null;
      return 0;
    case "note": {
      if (prev.kind === "note") return sameNoteAs(prev.path) ? null : 0;
      const under = prev.kind === "search" ? memory.underSearch : null;
      memory.underSearch = null;
      return under !== null && sameNoteAs(under.path) ? under.y : 0;
    }
  }
}
