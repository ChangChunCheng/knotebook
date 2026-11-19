import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRevealConfig, configMatches, htmlHasPrintClasses, LOCKED_CONFIG_KEYS } from "./reveal-config";

const handlers = { onEsc: vi.fn(), onF: vi.fn(), onO: vi.fn() };

describe("buildRevealConfig (key by key)", () => {
  it("locked values pinned verbatim", () => {
    const config = buildRevealConfig(handlers);
    expect(config).toMatchObject({
      embedded: true, disableLayout: true, hash: false, history: false, respondToHashChanges: false,
      postMessage: false, postMessageEvents: false, previewLinks: false, view: null, parallaxBackgroundImage: "",
      autoSlide: 0, pause: false, help: false, jumpToSlide: false, focusBodyOnPageVisibilityChange: false,
      controls: true, progress: true, overview: true,
      display: "block !important", transition: "none",
    });
    expect(Object.keys(config.keyboard as object).sort()).toEqual(["27", "70", "79"]);
    expect((config.keyboard as Record<number, unknown>)[27]).toBe(handlers.onEsc);
    expect((config.keyboard as Record<number, unknown>)[70]).toBe(handlers.onF);
    expect((config.keyboard as Record<number, unknown>)[79]).toBe(handlers.onO);
  });

  it("LOCKED_CONFIG_KEYS lists every locked key", () => {
    expect([...LOCKED_CONFIG_KEYS].sort()).toEqual(Object.keys(buildRevealConfig(handlers)).sort());
  });

  it.each([
    [{ altKey: true }, false], [{ ctrlKey: true }, false], [{ metaKey: true }, false], [{ shiftKey: true }, true], [{}, true],
  ])("keyboardCondition(%j) -> %s (Alt, Ctrl and Meta aren't handled, including Alt)", (init, expected) => {
    const condition = buildRevealConfig(handlers).keyboardCondition as (event: KeyboardEvent) => boolean;
    expect(condition(new KeyboardEvent("keydown", init))).toBe(expected);
  });
});

describe("configMatches (getConfig() key-by-key check)", () => {
  it("same config -> true", () => {
    const config = buildRevealConfig(handlers);
    expect(configMatches({ ...config, unrelated: 1 }, config)).toBe(true);
  });

  it.each(LOCKED_CONFIG_KEYS)("key %s changed -> false", (key) => {
    const config = buildRevealConfig(handlers);
    const tampered = { ...config, [key]: key === "keyboard" ? { ...(config.keyboard as object) } : "tampered" };
    expect(configMatches(tampered, config)).toBe(false);
  });
});

describe("htmlHasPrintClasses", () => {
  afterEach(() => document.documentElement.classList.remove("reveal-print", "print-pdf", "reveal-full-page"));
  it.each(["reveal-print", "print-pdf", "reveal-full-page"])("<html> has %s -> true", (cls) => {
    expect(htmlHasPrintClasses()).toBe(false);
    document.documentElement.classList.add(cls);
    expect(htmlHasPrintClasses()).toBe(true);
  });
});
