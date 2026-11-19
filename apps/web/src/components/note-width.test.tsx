import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { getNoteWidth, setNoteWidth, subscribeNoteWidth, useNoteWidth } from "./note-width";

/** #297: in-site width - the module-level Map is the truth within one tab, localStorage is written best-effort, and the `storage` event syncs other tabs. */
describe("note-width (per-note width in the site)", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("read: a missing key, a bad value or standard gives standard; wide/full are returned as stored; getItem throwing gives standard", () => {
    // Each sub-case uses its own id: the Map caches the first value read, so reusing an id would let later sub-cases read the previous one.
    expect(getNoteWidth("n1-missing")).toBe("standard");
    localStorage.setItem("note.width.n1-bogus", "bogus");
    expect(getNoteWidth("n1-bogus")).toBe("standard");
    localStorage.setItem("note.width.n1-standard", "standard");
    expect(getNoteWidth("n1-standard")).toBe("standard");
    localStorage.setItem("note.width.n1-wide", "wide");
    expect(getNoteWidth("n1-wide")).toBe("wide");
    localStorage.setItem("note.width.n1-full", "full");
    expect(getNoteWidth("n1-full")).toBe("full");
    localStorage.setItem("note.width.n1-blocked", "full");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(getNoteWidth("n1-blocked")).toBe("standard");
  });

  it("write: wide/full write the string; standard removes the key", () => {
    setNoteWidth("n2", "wide");
    expect(localStorage.getItem("note.width.n2")).toBe("wide");
    setNoteWidth("n2", "full");
    expect(localStorage.getItem("note.width.n2")).toBe("full");
    setNoteWidth("n2", "standard");
    expect(localStorage.getItem("note.width.n2")).toBeNull();
  });

  it("storage blocked: choosing wide still takes effect (the Map is updated first, then written best-effort)", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { result } = renderHook(() => useNoteWidth("n3"));
    act(() => result.current[1]("wide"));
    expect(result.current[0]).toBe("wide");
    expect(getNoteWidth("n3")).toBe("wide");
  });

  it("per note: setting A to full leaves B standard; changing the value through setNoteWidth re-renders the hook", () => {
    const a = renderHook(() => useNoteWidth("n4-a"));
    const b = renderHook(() => useNoteWidth("n4-b"));
    act(() => setNoteWidth("n4-a", "full"));
    expect(a.result.current[0]).toBe("full");
    expect(b.result.current[0]).toBe("standard");
  });

  it("storage event: updates and notifies only that note; newValue null gives standard; key null clears everything and notifies all; other keys are ignored", () => {
    const fa = vi.fn();
    const fb = vi.fn();
    const ua = subscribeNoteWidth("n5-a", fa);
    const ub = subscribeNoteWidth("n5-b", fb);
    try {
      window.dispatchEvent(new StorageEvent("storage", { key: "note.width.n5-a", newValue: "full" }));
      expect(getNoteWidth("n5-a")).toBe("full");
      expect(fa).toHaveBeenCalledTimes(1);
      expect(fb).not.toHaveBeenCalled();

      window.dispatchEvent(new StorageEvent("storage", { key: "note.width.n5-a", newValue: null }));
      expect(getNoteWidth("n5-a")).toBe("standard");

      // Another tab's localStorage.clear(): storage is shared, so it is empty here too and the event carries only key null.
      setNoteWidth("n5-a", "wide");
      setNoteWidth("n5-b", "wide");
      fa.mockClear();
      fb.mockClear();
      localStorage.clear();
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
      expect(getNoteWidth("n5-a")).toBe("standard");
      expect(getNoteWidth("n5-b")).toBe("standard");
      expect(fa).toHaveBeenCalled();
      expect(fb).toHaveBeenCalled();

      fa.mockClear();
      fb.mockClear();
      window.dispatchEvent(new StorageEvent("storage", { key: "sidebar.width", newValue: "300" }));
      expect(fa).not.toHaveBeenCalled();
      expect(fb).not.toHaveBeenCalled();
    } finally {
      ua();
      ub();
    }
  });

  it("useNoteWidth(null) gives standard; the setter writes no key", () => {
    const { result } = renderHook(() => useNoteWidth(null));
    expect(result.current[0]).toBe("standard");
    act(() => result.current[1]("full"));
    expect(result.current[0]).toBe("standard");
    expect(localStorage.length).toBe(0);
  });

  it("an uppercase id is lowercased for the key", () => {
    setNoteWidth("ABC", "full");
    expect(localStorage.getItem("note.width.abc")).toBe("full");
    expect(getNoteWidth("abc")).toBe("full");
  });

  it("when the last subscriber leaves the Map is cleared: a value another tab wrote while nobody was listening is seeded again from localStorage on resubscribe", () => {
    const un = subscribeNoteWidth("n9", vi.fn());
    try {
      setNoteWidth("n9", "full");
    } finally {
      un();
    }
    // Another tab writes while there is no listener (a setItem in the same window fires no storage event, which simulates "not received").
    localStorage.setItem("note.width.n9", "wide");
    const un2 = subscribeNoteWidth("n9", vi.fn());
    try {
      expect(getNoteWidth("n9")).toBe("wide");
    } finally {
      un2();
    }
  });

  it("sets X to wide", () => {
    setNoteWidth("n8", "wide");
    expect(getNoteWidth("n8")).toBe("wide");
  });

  it("X is standard again in the next case (setup.ts's afterEach resets the module Map)", () => {
    expect(getNoteWidth("n8")).toBe("standard");
  });
});
