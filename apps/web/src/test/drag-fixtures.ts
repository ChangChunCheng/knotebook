import { vi, type Mock } from "vitest";
import { DRAG_POINTER_QUERY } from "@/components/sidebar/drag-zone";

/**
 * Test utilities for sidebar dragging. jsdom has no DataTransfer: pass this fake object with `fireEvent.dragStart / dragOver / drop / dragEnd(el, { dataTransfer })`.
 * `setData` pushes the type into `types` (no duplicate if already there), so later `dragOver` events on the same object after a handoff see the custom type.
 */
export interface FakeDataTransfer {
  types: string[];
  setData: Mock<(type: string, value: string) => void>;
  getData: Mock<(type: string) => string>;
  clearData: Mock<(type?: string) => void>;
  effectAllowed: DataTransfer["effectAllowed"];
  dropEffect: DataTransfer["dropEffect"];
  setDragImage?: Mock<(image: Element, x: number, y: number) => void>;
  items?: unknown[];
  files?: File[];
}

/**
 * `store: true`: `setData` / `getData` use a Map, `clearData` clears data and types, and it also carries `setDragImage` and empty `items` / `files`.
 * The core SideMenu's root-level dragstart must be able to read back the `blocknote/html` that the handle itself `setData`s before it sets `view.dragging`. Default behavior unchanged.
 */
export function createFakeDataTransfer(initialTypes: readonly string[] = [], opts: { store?: boolean } = {}): FakeDataTransfer {
  const types = [...initialTypes];
  if (!opts.store) {
    return {
      types,
      setData: vi.fn((type: string) => {
        if (!types.includes(type)) types.push(type);
      }),
      getData: vi.fn(() => ""),
      clearData: vi.fn(),
      effectAllowed: "uninitialized",
      dropEffect: "none",
    };
  }
  const data = new Map<string, string>();
  return {
    types,
    setData: vi.fn((type: string, value: string) => {
      data.set(type, value);
      if (!types.includes(type)) types.push(type);
    }),
    getData: vi.fn((type: string) => data.get(type) ?? ""),
    clearData: vi.fn((type?: string) => {
      for (const t of type === undefined ? [...data.keys()] : [type]) {
        data.delete(t);
        const i = types.indexOf(t);
        if (i >= 0) types.splice(i, 1);
      }
    }),
    effectAllowed: "uninitialized",
    dropEffect: "none",
    setDragImage: vi.fn(),
    items: [],
    files: [],
  };
}

/** Overrides `matchMedia`: only `DRAG_POINTER_QUERY` reports per `fine`, every other query never matches (same as `test/setup.ts`). Callers restore with `vi.unstubAllGlobals()`. */
export function mockFinePointer(fine: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: fine && query === DRAG_POINTER_QUERY,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}
