import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OUTLINE_PINNED_STORAGE_KEY, readOutlinePinned, useOutlinePinned, writeOutlinePinned } from "./outline-pin";

describe("outline pin preference", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("uses one site-wide key", () => {
    expect(OUTLINE_PINNED_STORAGE_KEY).toBe("outline.pinned");
  });

  it("is not pinned by default", () => {
    expect(readOutlinePinned()).toBe(false);
  });

  it("stores pinning as \"1\" and removes the key when unpinned", () => {
    writeOutlinePinned(true);
    expect(localStorage.getItem("outline.pinned")).toBe("1");
    expect(readOutlinePinned()).toBe(true);

    writeOutlinePinned(false);
    expect(localStorage.getItem("outline.pinned")).toBeNull();
    expect(readOutlinePinned()).toBe(false);
  });

  it("treats any value other than \"1\" as not pinned", () => {
    localStorage.setItem("outline.pinned", "yes");
    expect(readOutlinePinned()).toBe(false);
    localStorage.setItem("outline.pinned", "");
    expect(readOutlinePinned()).toBe(false);
  });

  it("reads as not pinned when storage throws", () => {
    localStorage.setItem("outline.pinned", "1");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readOutlinePinned()).toBe(false);
  });

  it("swallows write errors", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => writeOutlinePinned(true)).not.toThrow();
    expect(() => writeOutlinePinned(false)).not.toThrow();
  });

  it("starts the hook from the stored preference and persists changes", () => {
    localStorage.setItem("outline.pinned", "1");
    const { result } = renderHook(() => useOutlinePinned());
    expect(result.current[0]).toBe(true);

    act(() => result.current[1](false));
    expect(result.current[0]).toBe(false);
    expect(localStorage.getItem("outline.pinned")).toBeNull();

    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
    expect(localStorage.getItem("outline.pinned")).toBe("1");
  });

  it("keeps the pin in state when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { result } = renderHook(() => useOutlinePinned());
    expect(result.current[0]).toBe(false);

    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
  });
});
