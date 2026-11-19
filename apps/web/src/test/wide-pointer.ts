import { vi } from "vitest";
import { WIDE_POINTER_QUERY } from "@/lib/wide-pointer";

/**
 * `vi.stubGlobal("matchMedia")`: `WIDE_POINTER_QUERY` -> `wide`; queries for which `others(query)` is true -> true; everything else false.
 * One set of change listeners per query; `setWide(next)` changes the value and synchronously notifies the `WIDE_POINTER_QUERY` listeners (callers wrap it in act themselves).
 * Callers restore with `afterEach(() => { vi.unstubAllGlobals(); })`.
 */
export function mockWidePointer(wide: boolean, others?: (query: string) => boolean): { setWide(next: boolean): void; listenerCount(): number } {
  let current = wide;
  const listeners = new Map<string, Set<() => void>>();
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
        return query === WIDE_POINTER_QUERY ? current : (others?.(query) ?? false);
      },
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: (_type: string, listener: () => void) => {
        set.add(listener);
      },
      removeEventListener: (_type: string, listener: () => void) => {
        set.delete(listener);
      },
      dispatchEvent: () => false,
    };
  });
  return {
    setWide(next: boolean) {
      current = next;
      for (const listener of [...listenersOf(WIDE_POINTER_QUERY)]) listener();
    },
    listenerCount() {
      return listenersOf(WIDE_POINTER_QUERY).size;
    },
  };
}
