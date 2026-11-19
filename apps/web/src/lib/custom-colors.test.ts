import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CUSTOM_COLORS_STYLE_ID,
  customColorSelectors,
  ensureCustomColor,
  installCustomColors,
  resetCustomColorsForTest,
} from "./custom-colors";

const styleEl = () => document.getElementById(CUSTOM_COLORS_STYLE_ID) as HTMLStyleElement | null;
const selectors = () => Array.from(styleEl()?.sheet?.cssRules ?? []).map((r) => (r as CSSStyleRule).selectorText);

afterEach(() => {
  vi.restoreAllMocks();
  resetCustomColorsForTest();
  document.body.innerHTML = "";
});

describe("customColorSelectors (#378)", () => {
  it("inline gets two rules, block gets three; inline does not include :has", () => {
    const inline = customColorSelectors("inline", "textColor", "#ff6600");
    expect(inline).toEqual([
      '[data-style-type="textColor"][data-value="#ff6600"]',
      '.kn-present [data-style-type="textColor"][data-value="#ff6600"]',
    ]);
    expect(inline.some((s) => s.includes(":has("))).toBe(false);
    expect(customColorSelectors("block", "backgroundColor", "#00ff00")).toEqual([
      '[data-background-color="#00ff00"]',
      '.bn-block:has(> .bn-block-content[data-background-color="#00ff00"])',
      '.kn-present [data-background-color="#00ff00"]',
    ]);
  });
});

describe("ensureCustomColor (#378)", () => {
  it("registering twice creates one style element and three rules", () => {
    ensureCustomColor("block", "textColor", "#ff6600");
    ensureCustomColor("block", "textColor", "#ff6600");
    expect(document.querySelectorAll(`#${CUSTOM_COLORS_STYLE_ID}`)).toHaveLength(1);
    expect(styleEl()!.sheet!.cssRules.length).toBe(3);
  });

  it("props outside the type produce no rule", () => {
    ensureCustomColor("block", 'x"], *, [data-x="' as never, "#ff6600");
    ensureCustomColor("inline", "color" as never, "#ff6600");
    expect(styleEl()?.sheet?.cssRules.length ?? 0).toBe(0);
  });

  // A value containing braces would be rejected by jsdom's insertRule on its own; this case only proves that no rule is left in the end.
  // The next case is what blocks injection (escaping the attribute selector within a single rule, without relying on the parser rejecting it).
  it("a value with braces leaves no rule (the parser would also reject it)", () => {
    ensureCustomColor("block", "textColor", '#ff6600"] , * { color: red } [');
    expect(styleEl()?.sheet?.cssRules.length ?? 0).toBe(0);
  });

  it.each(["#FF6600", "rgb(255, 102, 0)", "red;x:y", 'x"], *, [data-x="', "#f60"])(
    "a non-canonical value produces no rule: %s",
    (bad) => {
      ensureCustomColor("block", "textColor", bad);
      ensureCustomColor("inline", "backgroundColor", bad);
      expect(styleEl()?.sheet?.cssRules.length ?? 0).toBe(0);
    },
  );

  it("computed: :has lets child blocks inherit, inline background, text color inside slides", () => {
    document.body.innerHTML =
      '<div class="bn-block"><div class="bn-block-content" data-text-color="#ff6600"></div>' +
      '<div class="bn-block-group"><div class="bn-block"><p id="child">child</p></div></div></div>' +
      '<span id="inl" data-style-type="backgroundColor" data-value="#00ff00">x</span>' +
      '<div class="kn-present"><h2 id="pres" data-text-color="#0000ff">h</h2></div>';
    ensureCustomColor("block", "textColor", "#ff6600");
    ensureCustomColor("inline", "backgroundColor", "#00ff00");
    ensureCustomColor("block", "textColor", "#0000ff");
    expect(getComputedStyle(document.getElementById("child")!).color).toBe("rgb(255, 102, 0)");
    expect(getComputedStyle(document.getElementById("inl")!).backgroundColor).toBe("rgb(0, 255, 0)");
    expect(getComputedStyle(document.getElementById("pres")!).color).toBe("rgb(0, 0, 255)");
  });

  it("when the browser rejects the :has rule, the other rules are still registered and no exception is thrown", () => {
    const orig = CSSStyleSheet.prototype.insertRule;
    vi.spyOn(CSSStyleSheet.prototype, "insertRule").mockImplementation(function (this: CSSStyleSheet, rule: string, index?: number) {
      if (rule.includes(":has(")) throw new DOMException("bad", "SyntaxError");
      return orig.call(this, rule, index);
    });
    expect(() => ensureCustomColor("block", "textColor", "#ff6600")).not.toThrow();
    const sels = selectors();
    expect(sels).toContain('[data-text-color="#ff6600"]');
    expect(sels).toContain('.kn-present [data-text-color="#ff6600"]');
    expect(sels.some((s) => s.includes(":has("))).toBe(false);
  });
});

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
const OBSERVER_KEY = Symbol.for("knotebook.customColors.observer");

describe("installCustomColors (#378)", () => {
  it("color-code elements that exist before install are registered by a full scan on install", () => {
    document.body.innerHTML = '<span data-style-type="textColor" data-value="#ff6600">x</span>';
    installCustomColors();
    expect(selectors()).toContain('[data-style-type="textColor"][data-value="#ff6600"]');
  });

  it("a bare span attached directly to body after install is also registered (the element itself must be matched against the selector)", async () => {
    installCustomColors();
    const span = document.createElement("span");
    span.setAttribute("data-style-type", "textColor");
    span.setAttribute("data-value", "#ff6600");
    document.body.append(span);
    await flush();
    expect(selectors()).toContain('[data-style-type="textColor"][data-value="#ff6600"]');
  });

  it("a container attached after install with block-color descendants registers the block rules", async () => {
    installCustomColors();
    const div = document.createElement("div");
    div.innerHTML = '<p data-text-color="#00ff00"></p>';
    document.body.append(div);
    await flush();
    expect(selectors()).toContain('[data-text-color="#00ff00"]');
  });

  it("registers when an attribute becomes a color code; a non-color data-value is not registered", async () => {
    document.body.innerHTML =
      '<p id="p" data-background-color="red"></p><span id="l" data-style-type="link" data-value="#123456"></span>';
    installCustomColors();
    expect(styleEl()?.sheet?.cssRules.length ?? 0).toBe(0);
    document.getElementById("p")!.setAttribute("data-background-color", "#0000ff");
    document.getElementById("l")!.setAttribute("data-value", "#abcdef");
    await flush();
    const sels = selectors();
    expect(sels).toContain('[data-background-color="#0000ff"]');
    expect(sels.some((s) => s.includes("#123456") || s.includes("#abcdef"))).toBe(false);
  });

  it("a non-canonical attribute value is not registered", async () => {
    installCustomColors();
    const p = document.createElement("p");
    p.setAttribute("data-text-color", "#FF6600");
    document.body.append(p);
    await flush();
    expect(styleEl()?.sheet?.cssRules.length ?? 0).toBe(0);
  });

  it("installing twice leaves one style element, and reinstalling disconnects the old observer", () => {
    document.body.innerHTML = '<span data-style-type="textColor" data-value="#ff6600">x</span>';
    const spy = vi.spyOn(MutationObserver.prototype, "disconnect");
    installCustomColors();
    const first = (document as unknown as Record<symbol, unknown>)[OBSERVER_KEY];
    expect(first).toBeTruthy();
    spy.mockClear();
    installCustomColors();
    expect(spy).toHaveBeenCalledTimes(1);
    expect((document as unknown as Record<symbol, unknown>)[OBSERVER_KEY]).not.toBe(first);
    expect(document.querySelectorAll(`#${CUSTOM_COLORS_STYLE_ID}`)).toHaveLength(1);
  });
});
