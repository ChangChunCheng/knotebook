import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

/**
 * Sidebar search text (#93 / #369), kept at App level: `AppShell` remounts when leaving and re-entering its layout route
 * (re-login, change-password page), and the search box must keep its text so "clear search" can still remove the
 * persistent mark left by a search jump. Without a provider it falls back to local state.
 * The text belongs to one user: `claim(userId)` clears it if the owner changed, `release()` (logout) clears it.
 * The provider never touches the session (public pages must make zero fetches).
 */
interface SidebarQueryValue {
  query: string;
  setQuery: (q: string) => void;
  claim: (userId: string) => void;
  release: () => void;
}
const SidebarQueryContext = createContext<SidebarQueryValue | null>(null);

export function SidebarQueryProvider({ children }: { children: ReactNode }) {
  const [query, setQuery] = useState("");
  const ownerRef = useRef<string | null>(null);
  const claim = useCallback((userId: string) => {
    if (ownerRef.current !== null && ownerRef.current !== userId) setQuery("");
    ownerRef.current = userId;
  }, []);
  const release = useCallback(() => {
    ownerRef.current = null;
    setQuery("");
  }, []);
  const value = useMemo(() => ({ query, setQuery, claim, release }), [query, claim, release]);
  return <SidebarQueryContext.Provider value={value}>{children}</SidebarQueryContext.Provider>;
}

const noop = () => {};
export function useSidebarQuery(): SidebarQueryValue {
  const ctx = useContext(SidebarQueryContext);
  const [local, setLocal] = useState("");
  return ctx ?? { query: local, setQuery: setLocal, claim: noop, release: noop };
}
