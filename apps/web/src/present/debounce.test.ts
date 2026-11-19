import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDebouncer, UPDATE_DEBOUNCE_MS, UPDATE_MAX_WAIT_MS } from "./debounce";

describe("createDebouncer (trailing 500 ms + maxWait 2 s)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("constants: 500 / 2000", () => {
    expect(UPDATE_DEBOUNCE_MS).toBe(500);
    expect(UPDATE_MAX_WAIT_MS).toBe(2000);
  });

  it("5 calls within 100 ms -> runs 500 ms after the last, exactly once", () => {
    const fn = vi.fn();
    const debouncer = createDebouncer(fn);
    for (let i = 0; i < 5; i++) {
      debouncer.schedule();
      vi.advanceTimersByTime(20);
    }
    vi.advanceTimersByTime(UPDATE_DEBOUNCE_MS - 21);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("one call every 100 ms for 3 s -> runs at least once within 2 s (maxWait)", () => {
    const fn = vi.fn();
    const debouncer = createDebouncer(fn);
    for (let elapsed = 0; elapsed < 2000; elapsed += 100) {
      debouncer.schedule();
      vi.advanceTimersByTime(100);
    }
    expect(fn).toHaveBeenCalledTimes(1);
    for (let elapsed = 0; elapsed < 1000; elapsed += 100) {
      debouncer.schedule();
      vi.advanceTimersByTime(100);
    }
    vi.advanceTimersByTime(UPDATE_DEBOUNCE_MS);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("cancel resets the maxWait origin: scheduling after cancel past maxWait doesn't fire immediately, still waits the full 500 ms", () => {
    const fn = vi.fn();
    const debouncer = createDebouncer(fn);
    for (let elapsed = 0; elapsed < UPDATE_MAX_WAIT_MS - 100; elapsed += 100) {
      debouncer.schedule(); // Keep rescheduling: the first schedule's time stays at firstAt and the timer never expires
      vi.advanceTimersByTime(100);
    }
    expect(fn).not.toHaveBeenCalled();
    debouncer.cancel();
    vi.advanceTimersByTime(UPDATE_MAX_WAIT_MS); // More than maxWait since the first schedule
    debouncer.schedule();
    vi.advanceTimersByTime(1);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(UPDATE_DEBOUNCE_MS - 2);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("doesn't run after cancel", () => {
    const fn = vi.fn();
    const debouncer = createDebouncer(fn);
    debouncer.schedule();
    debouncer.cancel();
    vi.advanceTimersByTime(10_000);
    expect(fn).not.toHaveBeenCalled();
  });
});
