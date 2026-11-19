import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { SidebarTabActions } from "@/lib/sidebar-tab";
import { beginSelectRun, endSelectRun, updateSelectRun, useSelectRun } from "./select-run";

// Provider-level store for in-progress batches (#181). The store is module-level, so each test creates a fresh owner to keep a failure from carrying into the next test.

function owner(): SidebarTabActions {
  return {
    showTab: () => {},
    updateSelection: () => {},
    endSelectionIfActive: () => false,
    getSelectionSession: () => null,
    getTab: () => "myNotes",
  };
}

describe("select-run", () => {
  it("same owner: first begin is true, second is false; begin works again after end", () => {
    const a = owner();
    expect(beginSelectRun(a, 2)).toBe(true);
    expect(beginSelectRun(a, 2)).toBe(false);
    endSelectRun(a);
    expect(beginSelectRun(a, 1)).toBe(true);
    endSelectRun(a);
  });

  it("two owners do not affect each other", () => {
    const a = owner();
    const b = owner();
    expect(beginSelectRun(a, 2)).toBe(true);
    expect(beginSelectRun(b, 3)).toBe(true);
    const ra = renderHook(() => useSelectRun(a));
    const rb = renderHook(() => useSelectRun(b));
    act(() => endSelectRun(a));
    expect(ra.result.current).toBeNull();
    expect(rb.result.current).toEqual({ progress: { done: 0, total: 3 } });
    act(() => endSelectRun(b));
  });

  it("two readers re-render together after update and read the same progress; both return null after end", () => {
    const a = owner();
    const first = renderHook(() => useSelectRun(a));
    const second = renderHook(() => useSelectRun(a));
    expect(first.result.current).toBeNull();
    act(() => {
      beginSelectRun(a, 3);
    });
    act(() => updateSelectRun(a, 2));
    expect(first.result.current).toEqual({ progress: { done: 2, total: 3 } });
    expect(second.result.current).toBe(first.result.current);
    act(() => endSelectRun(a));
    expect(first.result.current).toBeNull();
    expect(second.result.current).toBeNull();
  });

  it("after begin, progress is { done: 0, total }", () => {
    const a = owner();
    const view = renderHook(() => useSelectRun(a));
    act(() => {
      beginSelectRun(a, 3);
    });
    expect(view.result.current).toEqual({ progress: { done: 0, total: 3 } });
    act(() => endSelectRun(a));
  });
});
