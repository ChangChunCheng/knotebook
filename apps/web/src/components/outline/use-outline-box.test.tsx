import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOutlineBox } from "./use-outline-box";

let observers: Array<{ cb: () => void; disconnect: ReturnType<typeof vi.fn>; observed: Element[] }> = [];

beforeEach(() => {
  observers = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      entry: (typeof observers)[number];
      constructor(cb: () => void) {
        this.entry = { cb, disconnect: vi.fn(), observed: [] };
        observers.push(this.entry);
      }
      observe(el: Element) {
        this.entry.observed.push(el);
      }
      unobserve() {}
      disconnect() {
        this.entry.disconnect();
      }
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

function el(rect: { left: number; right: number }, size?: { w: number; h: number }): HTMLElement {
  const node = document.createElement("div");
  node.getBoundingClientRect = () => ({ ...rect, top: 0, bottom: 0, width: 0, height: 0, x: rect.left, y: 0, toJSON() {} }) as DOMRect;
  if (size) {
    Object.defineProperty(node, "clientWidth", { configurable: true, value: size.w });
    Object.defineProperty(node, "clientHeight", { configurable: true, value: size.h });
  }
  return node;
}

describe("useOutlineBox first line", () => {
  it("measures the first block's top relative to the container, independent of the current scroll", () => {
    const scroll = el({ left: 0, right: 1000 }, { w: 1000, h: 700 });
    scroll.getBoundingClientRect = () => ({ left: 0, right: 1000, top: 100 }) as DOMRect;
    const column = el({ left: 100, right: 800 });
    const block = document.createElement("div");
    block.className = "bn-block-content";
    column.appendChild(block);
    let scrolled = 0;
    Object.defineProperty(scroll, "scrollTop", { configurable: true, get: () => scrolled });
    // First block sits 60px under the container's top when scrolled to the top.
    block.getBoundingClientRect = () => ({ top: 100 + 60 - scrolled }) as DOMRect;
    const { result } = renderHook(() => useOutlineBox(scroll, column));
    expect(result.current?.firstLineTop).toBe(60);
    scrolled = 200;
    act(() => observers[0]!.cb());
    expect(result.current?.firstLineTop).toBe(60);
  });
});

describe("useOutlineBox", () => {
  it("reports the container's visible size", () => {
    const scroll = el({ left: 300, right: 1300 }, { w: 1000, h: 700 });
    const column = el({ left: 600, right: 1100 });
    const { result } = renderHook(() => useOutlineBox(scroll, column));
    expect(result.current).toEqual({ width: 1000, height: 700, firstLineTop: null });
  });

  it("follows resize notifications", () => {
    const scroll = el({ left: 0, right: 1000 }, { w: 1000, h: 700 });
    const column = el({ left: 100, right: 800 });
    const { result } = renderHook(() => useOutlineBox(scroll, column));
    expect(result.current?.width).toBe(1000);
    Object.defineProperty(scroll, "clientWidth", { configurable: true, value: 900 });
    act(() => observers[0]!.cb());
    expect(result.current?.width).toBe(900);
    Object.defineProperty(scroll, "clientHeight", { configurable: true, value: 500 });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current?.height).toBe(500);
  });

  it("keeps the same object when nothing changed", () => {
    const scroll = el({ left: 0, right: 1000 }, { w: 1000, h: 700 });
    const column = el({ left: 100, right: 800 });
    const { result } = renderHook(() => useOutlineBox(scroll, column));
    const first = result.current;
    act(() => observers[0]!.cb());
    expect(result.current).toBe(first);
  });

  it("is null while either element is missing", () => {
    const scroll = el({ left: 0, right: 1000 }, { w: 1000, h: 700 });
    const column = el({ left: 100, right: 800 });
    expect(renderHook(() => useOutlineBox(null, column)).result.current).toBeNull();
    expect(renderHook(() => useOutlineBox(scroll, null)).result.current).toBeNull();
  });

  it("observes both elements and disconnects on unmount", () => {
    const scroll = el({ left: 0, right: 1000 }, { w: 1000, h: 700 });
    const column = el({ left: 100, right: 800 });
    const { unmount } = renderHook(() => useOutlineBox(scroll, column));
    expect(observers[0]!.observed).toEqual([scroll, column]);
    unmount();
    expect(observers[0]!.disconnect).toHaveBeenCalled();
  });

  it("removes the window resize listener on unmount", () => {
    const scroll = el({ left: 0, right: 1000 }, { w: 1000, h: 700 });
    const column = el({ left: 100, right: 800 });
    const winSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderHook(() => useOutlineBox(scroll, column));
    unmount();
    expect(winSpy).toHaveBeenCalledWith("resize", expect.any(Function));
    winSpy.mockRestore();
  });

  it("goes back to null when an element becomes null after being set", () => {
    const scroll = el({ left: 0, right: 1000 }, { w: 1000, h: 700 });
    const column = el({ left: 100, right: 800 });
    const { result, rerender } = renderHook(({ c }: { c: HTMLElement | null }) => useOutlineBox(scroll, c), { initialProps: { c: column as HTMLElement | null } });
    expect(result.current).not.toBeNull();
    rerender({ c: null });
    expect(result.current).toBeNull();
  });
});
