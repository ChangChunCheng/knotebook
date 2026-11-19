import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useDebounced } from "./useDebounced";

describe("useDebounced", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("initial value applies immediately; after changing, still the old value at 299 ms and the new one at 300 ms", () => {
    const { result, rerender } = renderHook(({ v }) => useDebounced(v, 300), { initialProps: { v: "a" } });
    expect(result.current).toBe("a");
    rerender({ v: "ab" });
    act(() => vi.advanceTimersByTime(299));
    expect(result.current).toBe("a");
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe("ab");
  });

  it("consecutive changes take effect 300 ms after the last one", () => {
    const { result, rerender } = renderHook(({ v }) => useDebounced(v, 300), { initialProps: { v: "a" } });
    rerender({ v: "ab" });
    act(() => vi.advanceTimersByTime(200));
    rerender({ v: "abc" });
    act(() => vi.advanceTimersByTime(200));
    expect(result.current).toBe("a");
    act(() => vi.advanceTimersByTime(100));
    expect(result.current).toBe("abc");
  });
});
