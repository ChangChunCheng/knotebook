import { vi } from "vitest";
import { OUTLINE_COMPACT_QUERY, OVERLAY_QUERY, PHONE_QUERY } from "@/lib/layout-tiers";

/**
 * `"phone"` < 640; `"compact"` 640-767 (floating tier, but the title outline already uses the phone shape); `"overlay"` 768-1279; `"docked"` >= 1280.
 * Phone and compact both satisfy `OVERLAY_QUERY`.
 */
export type LayoutTier = "phone" | "compact" | "overlay" | "docked";

export function tierMatches(tier: LayoutTier, query: string): boolean {
  if (query === PHONE_QUERY) return tier === "phone";
  if (query === OVERLAY_QUERY) return tier !== "docked";
  if (query === OUTLINE_COMPACT_QUERY) return tier === "phone" || tier === "compact";
  return false;
}

/** Same boundaries as CSS `sm` (640) and `xl` (1280). */
export function tierForWidth(widthPx: number): LayoutTier {
  if (widthPx < 640) return "phone";
  if (widthPx < 768) return "compact";
  if (widthPx < 1280) return "overlay";
  return "docked";
}

/**
 * `vi.stubGlobal("matchMedia")`: `PHONE_QUERY` / `OVERLAY_QUERY` hold per `tier`; queries for which `others(query)` is true -> true; everything else false.
 * One set of change listeners per query; `setLayoutTier(next)` changes the tier and notifies only queries whose result flipped, calling listeners with `{ matches, media }`
 * (like a real browser; callers wrap in act themselves).
 * Callers restore with `afterEach(() => { vi.unstubAllGlobals(); })`.
 */
export function stubLayoutTier(
  tier: LayoutTier,
  others?: (query: string) => boolean,
): { setLayoutTier(next: LayoutTier): void; listenerCount(query: string): number } {
  let current = tier;
  type ChangeEvent = { matches: boolean; media: string };
  type Listener = (event: ChangeEvent) => void;
  const listeners = new Map<string, Set<Listener>>();
  const listenersOf = (query: string) => {
    let set = listeners.get(query);
    if (set === undefined) {
      set = new Set();
      listeners.set(query, set);
    }
    return set;
  };
  vi.stubGlobal("matchMedia", (query: string) => {
    const set = listenersOf(query);
    return {
      get matches() {
        return query === PHONE_QUERY || query === OVERLAY_QUERY || query === OUTLINE_COMPACT_QUERY ? tierMatches(current, query) : (others?.(query) ?? false);
      },
      media: query,
      onchange: null,
      addListener: (listener: Listener) => {
        set.add(listener);
      },
      removeListener: (listener: Listener) => {
        set.delete(listener);
      },
      addEventListener: (_type: string, listener: Listener) => {
        set.add(listener);
      },
      removeEventListener: (_type: string, listener: Listener) => {
        set.delete(listener);
      },
      dispatchEvent: () => false,
    };
  });
  return {
    setLayoutTier(next: LayoutTier) {
      const previous = current;
      current = next;
      for (const query of [PHONE_QUERY, OVERLAY_QUERY, OUTLINE_COMPACT_QUERY]) {
        const before = tierMatches(previous, query);
        const after = tierMatches(next, query);
        if (before === after) continue;
        for (const listener of [...listenersOf(query)]) listener({ matches: after, media: query });
      }
    },
    listenerCount(query: string) {
      return listenersOf(query).size;
    },
  };
}
