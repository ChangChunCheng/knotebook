import { afterEach, describe, expect, it, vi } from "vitest";
import { isMacPlatform } from "@/lib/platform";

afterEach(() => vi.unstubAllGlobals());

describe("isMacPlatform", () => {
  it("MacIntel -> true", () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    expect(isMacPlatform()).toBe(true);
  });
  it.each(["Win32", "Linux x86_64"])("%s -> false", (platform) => {
    vi.stubGlobal("navigator", { platform });
    expect(isMacPlatform()).toBe(false);
  });
  it("no platform field -> false and does not throw", () => {
    vi.stubGlobal("navigator", {});
    expect(isMacPlatform()).toBe(false);
  });
  it("iPhone -> false (only Mac counts; iOS with an external keyboard shows Ctrl)", () => {
    vi.stubGlobal("navigator", { platform: "iPhone" });
    expect(isMacPlatform()).toBe(false);
  });
});
