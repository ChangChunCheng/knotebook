import { afterEach, describe, expect, it, vi } from "vitest";
import { readScrollMetrics, scrollFraction, trackBottomReserve } from "./bubble-track";

describe("bubble-track", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("scrollFraction is top over max, clamped, and 0 when nothing scrolls", () => {
    expect(scrollFraction({ top: 0, max: 1000 })).toBe(0);
    expect(scrollFraction({ top: 500, max: 1000 })).toBe(0.5);
    expect(scrollFraction({ top: 1200, max: 1000 })).toBe(1);
    expect(scrollFraction({ top: -5, max: 1000 })).toBe(0);
    expect(scrollFraction({ top: 10, max: 0 })).toBe(0);
  });

  it("readScrollMetrics reads the window or an element", () => {
    vi.stubGlobal("scrollY", 300);
    vi.stubGlobal("innerHeight", 800);
    vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(2800);
    expect(readScrollMetrics(window)).toEqual({ top: 300, max: 2000 });
    const el = document.createElement("div");
    Object.defineProperty(el, "scrollTop", { value: 40 });
    Object.defineProperty(el, "scrollHeight", { value: 500 });
    Object.defineProperty(el, "clientHeight", { value: 600 });
    expect(readScrollMetrics(el)).toEqual({ top: 40, max: 0 });
  });

  it("trackBottomReserve keeps the bottom clear of the keyboard, toolbar, colour panel or caller's reserve", () => {
    const base = { keyboardInset: 0, colorPanelHeight: 0, editToolbarHeight: 0, bottomReserve: 0, containerBottomGap: 0 };
    expect(trackBottomReserve({ ...base, placement: "anchor", bottomReserve: 66, keyboardInset: 300 })).toBe(300);
    expect(trackBottomReserve({ ...base, placement: "anchor", bottomReserve: 66, keyboardInset: 300, containerBottomGap: 100 })).toBe(200);
    expect(trackBottomReserve({ ...base, placement: "anchor", bottomReserve: 66, keyboardInset: 300, containerBottomGap: 300 })).toBe(66);
    expect(trackBottomReserve({ ...base, placement: "anchor", bottomReserve: 66, keyboardInset: 300, containerBottomGap: 500 })).toBe(66);
    expect(trackBottomReserve({ ...base, placement: "anchor", keyboardInset: 300, containerBottomGap: 500 })).toBe(0);
    expect(trackBottomReserve({ ...base, placement: "page", bottomReserve: 72 })).toBe(72);
    expect(trackBottomReserve({ ...base, placement: "page", bottomReserve: 72, keyboardInset: 300 })).toBe(300);
    expect(trackBottomReserve({ ...base, placement: "page", editToolbarHeight: 60, keyboardInset: 300 })).toBe(360);
    expect(trackBottomReserve({ ...base, placement: "page", editToolbarHeight: 60, colorPanelHeight: 280 })).toBe(340);
    expect(trackBottomReserve({ ...base, placement: "page", editToolbarHeight: 60 })).toBe(60);
    // Typing a colour code: the panel sits on the keyboard and the toolbar on the panel.
    expect(trackBottomReserve({ ...base, placement: "page", editToolbarHeight: 60, keyboardInset: 300, colorPanelHeight: 200 })).toBe(560);
  });
});
