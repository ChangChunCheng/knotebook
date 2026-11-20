import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { KEYBOARD_OPEN_THRESHOLD_PX, isKeyboardOpen, readKeyboardInset, useKeyboardInset } from "./visual-viewport";

class FakeViewport extends EventTarget {
  height = 800;
  offsetTop = 0;
  scale = 1;
  listeners = 0;
  addEventListener(type: string, cb: EventListenerOrEventListenerObject | null, opts?: boolean | AddEventListenerOptions) {
    this.listeners += 1;
    super.addEventListener(type, cb, opts);
  }
  removeEventListener(type: string, cb: EventListenerOrEventListenerObject | null, opts?: boolean | EventListenerOptions) {
    this.listeners -= 1;
    super.removeEventListener(type, cb, opts);
  }
}

let viewport: FakeViewport;
let frames: Array<() => void>;

function setViewport(value: FakeViewport | undefined) {
  Object.defineProperty(window, "visualViewport", { value, configurable: true, writable: true });
}

function flushFrames() {
  const pending = frames;
  frames = [];
  act(() => pending.forEach((run) => run()));
}

describe("keyboard inset", () => {
  beforeEach(() => {
    viewport = new FakeViewport();
    frames = [];
    vi.stubGlobal("innerHeight", 800);
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    setViewport(viewport);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setViewport(undefined);
  });

  it("no visualViewport: 0", () => {
    setViewport(undefined);
    expect(readKeyboardInset()).toBe(0);
    const { result } = renderHook(() => useKeyboardInset());
    expect(result.current).toBe(0);
  });

  it("innerHeight 800, visual height 500, offsetTop 0: 300", () => {
    viewport.height = 500;
    expect(readKeyboardInset()).toBe(300);
  });

  it("offsetTop 50: 250 (subtracted when the page is pushed up)", () => {
    viewport.height = 500;
    viewport.offsetTop = 50;
    expect(readKeyboardInset()).toBe(250);
  });

  it("negative values clamp to 0", () => {
    viewport.height = 900;
    expect(readKeyboardInset()).toBe(0);
  });

  it("isKeyboardOpen: within the threshold does not count, beyond it does", () => {
    expect(isKeyboardOpen(0)).toBe(false);
    expect(isKeyboardOpen(KEYBOARD_OPEN_THRESHOLD_PX)).toBe(false);
    expect(isKeyboardOpen(KEYBOARD_OPEN_THRESHOLD_PX + 1)).toBe(true);
  });

  it("reads the current value on mount; re-renders on the next frame after resize", () => {
    viewport.height = 600;
    const { result } = renderHook(() => useKeyboardInset());
    expect(result.current).toBe(200);
    viewport.height = 500;
    act(() => void viewport.dispatchEvent(new Event("resize")));
    expect(result.current).toBe(200);
    flushFrames();
    expect(result.current).toBe(300);
  });

  it("scroll events also update (offsetTop changes)", () => {
    viewport.height = 500;
    const { result } = renderHook(() => useKeyboardInset());
    expect(result.current).toBe(300);
    viewport.offsetTop = 100;
    act(() => void viewport.dispatchEvent(new Event("scroll")));
    flushFrames();
    expect(result.current).toBe(200);
  });

  it("multiple events in the same frame queue one rAF", () => {
    renderHook(() => useKeyboardInset());
    act(() => {
      viewport.dispatchEvent(new Event("resize"));
      viewport.dispatchEvent(new Event("scroll"));
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(frames).toHaveLength(1);
  });

  it("on unmount removes both listeners and cancels the pending rAF", () => {
    const { unmount } = renderHook(() => useKeyboardInset());
    expect(viewport.listeners).toBe(2);
    act(() => void viewport.dispatchEvent(new Event("resize")));
    unmount();
    expect(viewport.listeners).toBe(0);
    expect(window.cancelAnimationFrame).toHaveBeenCalledTimes(1);
    // The pending frame id is frames.push's return value (1).
    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(1);
  });

  it("on unmount with no pending frame: cancelAnimationFrame is not called", () => {
    const { unmount } = renderHook(() => useKeyboardInset());
    unmount();
    expect(window.cancelAnimationFrame).not.toHaveBeenCalled();
  });

  it("while zoomed (scale is not 1): the visual viewport shrinking is not the keyboard, returns 0", () => {
    viewport.height = 500;
    viewport.scale = 2;
    expect(readKeyboardInset()).toBe(0);
    viewport.scale = 1.005;
    expect(readKeyboardInset()).toBe(300);
  });
});
