import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutlineHeading } from "./headings";
import { measureHeadingTop, pickActiveHeading, useActiveHeading } from "./active-heading";

describe("pickActiveHeading", () => {
  const e = (id: string, top: number | null) => ({ id, top });
  it("returns the first heading while all are below the threshold", () => {
    expect(pickActiveHeading([e("a", 100), e("b", 300)], 10)).toBe("a");
  });
  it("returns the last heading already scrolled past", () => {
    expect(pickActiveHeading([e("a", -300), e("b", -20), e("c", 400)], 10)).toBe("b");
  });
  it("counts top === threshold as scrolled past", () => {
    expect(pickActiveHeading([e("a", -50), e("b", 10)], 10)).toBe("b");
  });
  it("skips collapsed headings so the position stays on the containing toggle", () => {
    expect(pickActiveHeading([e("a", 0), e("b", null), e("c", 900)], 10)).toBe("a");
  });
  it("returns the first heading when none can be measured", () => {
    expect(pickActiveHeading([e("a", null), e("b", null)], 10)).toBe("a");
  });
  it("returns null for an empty list", () => {
    expect(pickActiveHeading([], 10)).toBeNull();
  });
  it("re-picks from the new list when the previous active id is gone", () => {
    expect(pickActiveHeading([e("a", -100), e("b", -50), e("c", 500)], 10)).toBe("b");
    expect(pickActiveHeading([e("a", -100), e("c", 500)], 10)).toBe("a");
  });
});

describe("measureHeadingTop", () => {
  it("is null for a missing element", () => {
    expect(measureHeadingTop(null)).toBeNull();
  });
  it("is null when the element is not laid out", () => {
    const el = document.createElement("div");
    el.getClientRects = () => [] as unknown as DOMRectList;
    expect(measureHeadingTop(el)).toBeNull();
  });
  it("reads the bounding rect top", () => {
    const el = document.createElement("div");
    el.getClientRects = () => [{}] as unknown as DOMRectList;
    el.getBoundingClientRect = () => ({ top: 42 }) as DOMRect;
    expect(measureHeadingTop(el)).toBe(42);
  });
});

describe("useActiveHeading", () => {
  let queue: Map<number, FrameRequestCallback>;
  let nextId: number;
  const flush = () => {
    const q = [...queue.values()];
    queue.clear();
    act(() => q.forEach((cb) => cb(0)));
  };
  beforeEach(() => {
    queue = new Map();
    nextId = 1;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      const id = nextId++;
      queue.set(id, cb);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      queue.delete(id);
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const headings: OutlineHeading[] = [
    { id: "h1", level: 1, text: "Alice" },
    { id: "h2", level: 2, text: "Bob" },
    { id: "h3", level: 2, text: "Carol" },
  ];
  const tops: Record<string, number> = { h1: -200, h2: -5, h3: 400 };

  function setup(opts: { enabled?: boolean; windowTarget?: boolean } = {}) {
    const root = document.createElement("div");
    const reads: Record<string, number> = { h1: 0, h2: 0, h3: 0 };
    for (const h of headings) {
      const el = document.createElement("div");
      el.className = "bn-block-outer";
      el.dataset.id = h.id;
      el.getClientRects = () => [{}] as unknown as DOMRectList;
      el.getBoundingClientRect = () => {
        reads[h.id]++;
        return { top: tops[h.id] } as DOMRect;
      };
      root.appendChild(el);
    }
    const scroller = document.createElement("div");
    const target: HTMLElement | Window = opts.windowTarget ? window : scroller;
    let latest: ReturnType<typeof useActiveHeading> | null = null;
    function Host() {
      latest = useActiveHeading({ headings, root, scrollTarget: target, topEdge: () => 0, enabled: opts.enabled ?? true });
      return null;
    }
    const view = render(<Host />);
    return { target, reads, view, get: () => latest?.activeId ?? null, api: () => latest! };
  }

  it("measures each heading once per frame however many scroll events arrive", () => {
    const { target, reads, get } = setup();
    flush(); // initial measurement
    for (const k of Object.keys(reads)) reads[k] = 0;
    act(() => {
      target.dispatchEvent(new Event("scroll"));
      target.dispatchEvent(new Event("scroll"));
      target.dispatchEvent(new Event("scroll"));
    });
    flush();
    expect(reads).toEqual({ h1: 1, h2: 1, h3: 1 });
    expect(get()).toBe("h2");
  });

  it("works with window as the scroll target", () => {
    const { target, get } = setup({ windowTarget: true });
    act(() => {
      target.dispatchEvent(new Event("scroll"));
    });
    flush();
    expect(get()).toBe("h2");
  });

  it("re-measures when the content resizes without a scroll", () => {
    const observers: { cb: () => void; disconnect: ReturnType<typeof vi.fn> }[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        disconnect = vi.fn();
        constructor(cb: () => void) {
          observers.push({ cb, disconnect: this.disconnect });
        }
        observe() {}
      },
    );
    const { reads, view } = setup();
    flush();
    for (const k of Object.keys(reads)) reads[k] = 0;
    expect(observers).toHaveLength(1);
    act(() => observers[0].cb());
    flush();
    expect(reads).toEqual({ h1: 1, h2: 1, h3: 1 });
    view.unmount();
    expect(observers[0].disconnect).toHaveBeenCalled();
  });

  it("keeps a jumped heading active until the reader scrolls by hand", () => {
    const { target, get, api, reads } = setup();
    flush();
    expect(get()).toBe("h2");
    act(() => api().markJumped("h3"));
    expect(get()).toBe("h3");
    // The jump's own programmatic scroll arrives as scroll events and must not clear the pin.
    act(() => {
      target.dispatchEvent(new Event("scroll"));
    });
    flush();
    expect(get()).toBe("h3");
    for (const k of Object.keys(reads)) reads[k] = 0;
    act(() => {
      target.dispatchEvent(new Event("wheel"));
    });
    flush();
    expect(get()).toBe("h2");
  });

  it("releaseJump clears the pin so the next scroll re-measures", () => {
    const { target, get, api } = setup();
    flush();
    act(() => api().markJumped("h3"));
    act(() => api().releaseJump());
    expect(get()).toBe("h3");
    act(() => {
      target.dispatchEvent(new Event("scroll"));
    });
    flush();
    expect(get()).toBe("h2");
  });

  it("releases the pin on a pointer press in the scrolling area", () => {
    const { target, get, api } = setup();
    flush();
    act(() => api().markJumped("h3"));
    expect(get()).toBe("h3");
    act(() => {
      target.dispatchEvent(new Event("pointerdown"));
    });
    flush();
    expect(get()).toBe("h2");
  });

  it("keeps the pin for scroll keys another control already handled", () => {
    const { get, api } = setup();
    flush();
    act(() => api().markJumped("h3"));
    act(() => {
      const e = new KeyboardEvent("keydown", { key: "ArrowDown", cancelable: true });
      e.preventDefault();
      window.dispatchEvent(e);
    });
    flush();
    expect(get()).toBe("h3");
  });

  it("releases the pin on scroll keys but not on other keys", () => {
    const { get, api } = setup();
    flush();
    act(() => api().markJumped("h3"));
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    });
    flush();
    expect(get()).toBe("h3");
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown" }));
    });
    flush();
    expect(get()).toBe("h2");
  });

  it("attaches no listeners when disabled", () => {
    const spy = vi.spyOn(window, "addEventListener");
    const { get } = setup({ enabled: false, windowTarget: true });
    expect(spy.mock.calls.filter(([t]) => t === "scroll" || t === "resize")).toHaveLength(0);
    expect(queue.size).toBe(0);
    expect(get()).toBeNull();
    spy.mockRestore();
  });

  it("removes listeners and cancels a pending frame on unmount", () => {
    const { target, view, reads } = setup();
    const removeSpy = vi.spyOn(target, "removeEventListener");
    act(() => {
      target.dispatchEvent(new Event("scroll"));
    });
    expect(queue.size).toBeGreaterThan(0);
    view.unmount();
    expect(removeSpy.mock.calls.map(([t]) => t)).toContain("scroll");
    expect(queue.size).toBe(0);
    expect(reads.h1).toBe(0);
  });
});
