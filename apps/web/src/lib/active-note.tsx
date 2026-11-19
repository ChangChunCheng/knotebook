import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

/**
 * Id of the currently open note. Not derivable from the URL: the slug follows the title and only
 * updates after save, and legacy `/notes/:ref` / prev_slug URLs are non-canonical.
 * NotePage's unmount clears only if current === its own id: on a page change the new page's set
 * can run before the old page's cleanup.
 */
interface ActiveNoteContextValue {
  activeNoteId: string | null;
  setActiveNoteId: (id: string | null) => void;
  clearActiveNoteId: (id: string) => void;
}

const ActiveNoteContext = createContext<ActiveNoteContextValue | null>(null);

export function ActiveNoteProvider({ children }: { children: ReactNode }) {
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const clearActiveNoteId = useCallback((id: string) => {
    setActiveNoteId((current) => (current === id ? null : current));
  }, []);
  const value = useMemo(
    () => ({ activeNoteId, setActiveNoteId, clearActiveNoteId }),
    [activeNoteId, clearActiveNoteId],
  );
  return <ActiveNoteContext.Provider value={value}>{children}</ActiveNoteContext.Provider>;
}

export function useActiveNote(): ActiveNoteContextValue {
  const value = useContext(ActiveNoteContext);
  if (!value) {
    throw new Error("useActiveNote 必須在 <ActiveNoteProvider> 內使用");
  }
  return value;
}
