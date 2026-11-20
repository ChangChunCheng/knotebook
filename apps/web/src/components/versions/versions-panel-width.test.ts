import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VERSIONS_PANEL_WIDTH_DEFAULT,
  VERSIONS_PANEL_WIDTH_MAX,
  VERSIONS_PANEL_WIDTH_MIN,
  VERSIONS_PANEL_WIDTH_STEP,
  VERSIONS_PANEL_WIDTH_STORAGE_KEY,
  clampVersionsPanelWidth,
  readVersionsPanelWidth,
  writeVersionsPanelWidth,
} from "./versions-panel-width";

const KEY = "versions.panelWidth";

describe("versions panel width utilities", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.removeItem(KEY);
  });

  it("constants: default 320, range 240-560, step 16, and its own key (not shared with sidebar.width)", () => {
    expect(VERSIONS_PANEL_WIDTH_DEFAULT).toBe(320);
    expect(VERSIONS_PANEL_WIDTH_MIN).toBe(240);
    expect(VERSIONS_PANEL_WIDTH_MAX).toBe(560);
    expect(VERSIONS_PANEL_WIDTH_STEP).toBe(16);
    expect(VERSIONS_PANEL_WIDTH_STORAGE_KEY).toBe(KEY);
  });

  it.each([
    [100, 240],
    [240, 240],
    [300.4, 300],
    [300.6, 301],
    [560, 560],
    [9999, 560],
  ])("clamp(%d) -> %d", (input, expected) => {
    expect(clampVersionsPanelWidth(input)).toBe(expected);
  });

  it.each([
    [null, 320],
    ["abc", 320],
    ["", 320],
    ["239", 320],
    ["561", 320],
    ["300.5", 320],
    ["240", 240],
    ["560", 560],
    ["400", 400],
  ])("reading %j -> %d", (raw, expected) => {
    if (raw !== null) window.localStorage.setItem(KEY, raw);
    expect(readVersionsPanelWidth()).toBe(expected);
  });

  it("read throws -> default", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readVersionsPanelWidth()).toBe(320);
  });

  it("write: a non-default value is stored as a string; the default removes the key; a write error does not leak out", () => {
    writeVersionsPanelWidth(400);
    expect(window.localStorage.getItem(KEY)).toBe("400");
    writeVersionsPanelWidth(320);
    expect(window.localStorage.getItem(KEY)).toBeNull();

    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => writeVersionsPanelWidth(400)).not.toThrow();
  });
});
