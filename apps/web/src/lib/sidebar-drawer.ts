import { createContext, useCallback, useContext } from "react";

export interface SidebarDrawerState {
  setOpen: (open: boolean) => void;
}

/**
 * Starts null with a throwing hook on purpose: screens without context (like `AppErrorFallback`) must not mount
 * `SidebarDrawerButton`; fail loudly in development. Lives here, not in `AppShell.tsx`, to avoid an
 * AppShell→NoteList→NoteMenu→AppShell cycle (the sidebar row's ⋮ also closes the drawer).
 */
export const SidebarDrawerContext = createContext<SidebarDrawerState | null>(null);

export function useSidebarDrawer(): SidebarDrawerState {
  const ctx = useContext(SidebarDrawerContext);
  if (!ctx) throw new Error("SidebarDrawerButton must be rendered inside AppShell");
  return ctx;
}

/** Not the throwing `useSidebarDrawer`: its fail-loud behavior is meant only for the sidebar button. */
export function useCloseSidebarDrawer(): () => void {
  const ctx = useContext(SidebarDrawerContext);
  return useCallback(() => ctx?.setOpen(false), [ctx]);
}
