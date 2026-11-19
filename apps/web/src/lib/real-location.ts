import { createContext, useCallback, useContext } from "react";
import { UNSAFE_NavigationContext, type Location, type NavigationType } from "react-router";

/**
 * The browser's real router location (#179). The main tree's `<Routes location={state?.backgroundLocation ?? location}>`
 * overrides `useLocation()`, so a background page (NotePage) cannot see the real `/settings/*` URL or its state; its
 * URL-canonicalizing effect needs them to leave the URL alone while a modal is open (switching to the note URL would close it).
 * Also carries the real `navigationType`: a `<Routes>` with a `location` prop reports **"POP"** to its subtree.
 * `null` outside `AppRoutes` = no background override.
 */
export const RealLocationContext = createContext<{ location: Location; navigationType: NavigationType } | null>(
  null,
);

export function useRealLocation(): Location | null {
  return useContext(RealLocationContext)?.location ?? null;
}

export function useRealNavigationType(): NavigationType | null {
  return useContext(RealLocationContext)?.navigationType ?? null;
}

/**
 * Reads the history's location key right now, not the one this render received: `BrowserRouter` / `MemoryRouter` wrap
 * location updates in `startTransition`, so after `navigate()` history has switched entries while the router's location
 * still lags. A non-transition re-render in that gap would see the old location, and `navigate(…, { replace: true })`
 * would replace the entry just navigated to (401 redirect, another note clicked). Callers compare with their rendered
 * `location.key`; unequal = a navigation is in flight.
 * Uses `UNSAFE_NavigationContext` (the `navigator` type exposes no `location`); undefined for other routers = "cannot tell"; callers proceed as usual.
 */
export function useHistoryLocationKey(): () => string | undefined {
  const { navigator } = useContext(UNSAFE_NavigationContext);
  return useCallback(() => (navigator as { location?: { key?: string } }).location?.key, [navigator]);
}

type HistorySnapshot = Pick<Location, "key" | "pathname" | "state"> & { action: NavigationType | undefined };

export function useHistoryLocation(): () => HistorySnapshot | undefined {
  const { navigator } = useContext(UNSAFE_NavigationContext);
  return useCallback(() => {
    const history = navigator as { location?: Pick<Location, "key" | "pathname" | "state">; action?: NavigationType };
    return history.location ? { ...history.location, action: history.action } : undefined;
  }, [navigator]);
}

const CANONICALIZED_FROM_KEY = "knotebookCanonicalizedFrom";

/**
 * Marks a canonical same-note URL change so AppShell's "pathname changed → close the drawer" effect (router navigation
 * since #179) does not treat it as a page change. Keeps the existing state.
 */
export function withCanonicalizedFrom(state: unknown, fromPathname: string): Record<string, unknown> {
  const base = typeof state === "object" && state !== null ? (state as Record<string, unknown>) : {};
  return { ...base, [CANONICALIZED_FROM_KEY]: fromPathname };
}

export function canonicalizedFrom(state: unknown): string | undefined {
  if (typeof state !== "object" || state === null) return undefined;
  const value = (state as Record<string, unknown>)[CANONICALIZED_FROM_KEY];
  return typeof value === "string" ? value : undefined;
}
