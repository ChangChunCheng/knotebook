import { afterEach, describe, expect, it, vi } from "vitest";
import { backTarget, historyIdx, readListIdx, recordListIdx } from "./phone-nav";

function stubHistoryState(state: unknown) {
  Object.defineProperty(window.history, "state", { configurable: true, get: () => state });
}

afterEach(() => {
  delete (window.history as unknown as Record<string, unknown>).state;
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("backTarget", () => {
  it.each([
    ["list index missing -> replace the current entry", { listIdx: null, currentIdx: 5 }, { kind: "replace" }],
    ["current index missing -> replace", { listIdx: 2, currentIdx: null }, { kind: "replace" }],
    ["list index equals current -> replace (the same entry cannot be gone back to)", { listIdx: 5, currentIdx: 5 }, { kind: "replace" }],
    ["list index above current -> replace (stale record)", { listIdx: 7, currentIdx: 5 }, { kind: "replace" }],
    ["list index below current -> go back by delta", { listIdx: 2, currentIdx: 5 }, { kind: "go", delta: -3 }],
    ["one entry apart -> go back one", { listIdx: 4, currentIdx: 5 }, { kind: "go", delta: -1 }],
    ["list at entry 0 -> go back to the start", { listIdx: 0, currentIdx: 1 }, { kind: "go", delta: -1 }],
  ])("%s", (_name, input, expected) => {
    expect(backTarget(input)).toEqual(expected);
  });
});

describe("historyIdx", () => {
  it("reads history.state.idx", () => {
    stubHistoryState({ usr: null, key: "k", idx: 4 });
    expect(historyIdx()).toBe(4);
  });
  it("state null or idx not a number -> null", () => {
    stubHistoryState(null);
    expect(historyIdx()).toBeNull();
    stubHistoryState({ idx: "3" });
    expect(historyIdx()).toBeNull();
  });
});

describe("recordListIdx / readListIdx", () => {
  it("records the current index and reads it back", () => {
    stubHistoryState({ idx: 3 });
    recordListIdx();
    expect(readListIdx()).toBe(3);
  });

  it("does not overwrite the old record when the current index cannot be read", () => {
    stubHistoryState({ idx: 3 });
    recordListIdx();
    stubHistoryState(null);
    recordListIdx();
    expect(readListIdx()).toBe(3);
  });

  it("no record, or content not an integer -> null", () => {
    expect(readListIdx()).toBeNull();
    sessionStorage.setItem("nav.listIdx", "abc");
    expect(readListIdx()).toBeNull();
    sessionStorage.setItem("nav.listIdx", "1.5");
    expect(readListIdx()).toBeNull();
  });

  it("sessionStorage read/write throwing -> readListIdx returns null, recordListIdx does not throw", () => {
    stubHistoryState({ idx: 3 });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => recordListIdx()).not.toThrow();
    expect(readListIdx()).toBeNull();
  });
});
