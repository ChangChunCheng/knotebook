import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutlineBlockLike } from "./headings";
import { OUTLINE_RECOMPUTE_MS, useOutlineHeadings, type OutlineEditorLike } from "./use-outline-headings";

const heading = (id: string, text: string): OutlineBlockLike => ({
  id,
  type: "heading",
  props: { level: 2 },
  content: [{ type: "text", text }],
});

function makeEditor(initial: OutlineBlockLike[]) {
  let doc = initial;
  const listeners = new Set<() => void>();
  const unsubscribe = vi.fn();
  const state = { reads: 0 };
  const editor: OutlineEditorLike = {
    get document() {
      state.reads += 1;
      return doc;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        unsubscribe();
        listeners.delete(listener);
      };
    },
  };
  return {
    editor,
    state,
    unsubscribe,
    listeners,
    setDoc(next: OutlineBlockLike[]) {
      doc = next;
    },
    fire() {
      for (const l of [...listeners]) l();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useOutlineHeadings", () => {
  it("computes the initial list on mount; null editor gives an empty list and no subscription", () => {
    const f = makeEditor([heading("a", "Alice")]);
    const { result } = renderHook(() => useOutlineHeadings(f.editor));
    expect(result.current).toEqual([{ id: "a", level: 2, text: "Alice" }]);
    expect(f.state.reads).toBe(1);

    const none = renderHook(() => useOutlineHeadings(null));
    expect(none.result.current).toEqual([]);
  });

  it("does not read the document while typing; recomputes once after the quiet period", () => {
    const f = makeEditor([heading("a", "Alice")]);
    const { result } = renderHook(() => useOutlineHeadings(f.editor));
    const before = f.state.reads;
    f.setDoc([heading("a", "Alice"), heading("b", "Bob")]);

    // Changes keep arriving every 29 ms; no pause reaches the delay, so nothing is read.
    for (let i = 0; i < 9; i++) {
      act(() => {
        f.fire();
        vi.advanceTimersByTime(29);
      });
    }
    expect(f.state.reads).toBe(before);
    expect(result.current).toHaveLength(1);

    // The last change restarts the delay: still nothing just before it elapses...
    act(() => {
      f.fire();
      vi.advanceTimersByTime(OUTLINE_RECOMPUTE_MS - 1);
    });
    expect(f.state.reads).toBe(before);
    expect(result.current).toHaveLength(1);

    // ...and exactly one read once the full delay has passed since that change.
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(f.state.reads).toBe(before + 1);
    expect(result.current.map((x) => x.text)).toEqual(["Alice", "Bob"]);
  });

  it("keeps the same array and skips re-rendering when the headings did not change", () => {
    const f = makeEditor([heading("a", "Alice")]);
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useOutlineHeadings(f.editor);
    });
    const first = result.current;
    const rendersBefore = renders;

    // Equal content in a brand-new array of brand-new blocks.
    f.setDoc([heading("a", "Alice")]);
    act(() => {
      f.fire();
      vi.advanceTimersByTime(OUTLINE_RECOMPUTE_MS);
    });
    expect(result.current).toBe(first);
    expect(renders).toBe(rendersBefore);
  });

  it("unsubscribes and clears the pending timer on unmount", () => {
    const f = makeEditor([heading("a", "Alice")]);
    const { unmount } = renderHook(() => useOutlineHeadings(f.editor));
    act(() => {
      f.fire();
    });
    const reads = f.state.reads;
    unmount();
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(OUTLINE_RECOMPUTE_MS * 3);
    expect(f.state.reads).toBe(reads);
  });

  it("switches subscription when the editor changes", () => {
    const a = makeEditor([heading("a", "Alice")]);
    const b = makeEditor([heading("b", "Bob")]);
    const { result, rerender } = renderHook(({ ed }) => useOutlineHeadings(ed), {
      initialProps: { ed: a.editor as OutlineEditorLike },
    });
    a.fire();
    const readsA = a.state.reads;
    rerender({ ed: b.editor });
    expect(a.unsubscribe).toHaveBeenCalledTimes(1);
    expect(b.listeners.size).toBe(1);
    expect(result.current.map((x) => x.text)).toEqual(["Bob"]);

    // A change queued on A before the swap must not fire afterwards.
    expect(a.listeners.size).toBe(0);
    act(() => {
      vi.advanceTimersByTime(OUTLINE_RECOMPUTE_MS * 2);
    });
    expect(a.state.reads).toBe(readsA);
    expect(result.current.map((x) => x.text)).toEqual(["Bob"]);

    b.setDoc([heading("b", "Bob"), heading("c", "Carol")]);
    act(() => {
      b.fire();
      vi.advanceTimersByTime(OUTLINE_RECOMPUTE_MS);
    });
    expect(result.current.map((x) => x.text)).toEqual(["Bob", "Carol"]);
  });
});
