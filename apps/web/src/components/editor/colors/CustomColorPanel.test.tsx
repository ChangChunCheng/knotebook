import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useComponentsContext } from "@blocknote/react";
import i18n from "@/i18n";
import { resetCustomColorsForTest } from "@/lib/custom-colors";
import { RECENT_COLORS_KEY, readRecentColors, resetRecentColorsForTest } from "@/lib/recent-colors";
import { createTestEditor } from "@/test/ai-host";
import {
  declaredContentWidth,
  layoutHostTrigger,
  menuNode,
  openHostMenu,
  renderColorMenuHost,
  settle,
  waitForMenuShown,
} from "@/test/color-menu-host";
import { applyColor } from "./apply-color";
import { ColorMenuBody, useColorMenu } from "./ColorMenuBody";
import { KeepOpenMenuItem } from "./KeepOpenMenuItem";

// Wraps the original and still writes through, only making calls visible to the test (ESM named exports cannot be spied on directly).
vi.mock("./apply-color", async (orig) => {
  const m = await orig<typeof import("./apply-color")>();
  return { ...m, applyColor: vi.fn(m.applyColor) };
});

const applyMock = vi.mocked(applyColor);

beforeEach(async () => {
  localStorage.clear();
  resetRecentColorsForTest();
  applyMock.mockClear();
  await i18n.changeLanguage("en");
});
afterEach(() => {
  resetCustomColorsForTest();
  vi.unstubAllGlobals();
});

/** Only `(pointer: fine)` is reported according to `fine`; every other query never matches. */
function stubPointer(fine: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: fine && query === "(pointer: fine)",
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

function TestItems() {
  const Components = useComponentsContext()!;
  const menu = useColorMenu()!;
  return (
    <>
      <KeepOpenMenuItem
        data-test="t-custom"
        data-kb-color-return="t-custom"
        onClick={(e) =>
          menu.openPanel({
            section: "text",
            target: { kind: "inline" },
            current: "default",
            byKeyboard: e.detail === 0,
            returnTo: "t-custom",
          })
        }
      >
        Custom…
      </KeepOpenMenuItem>
      <Components.Generic.Menu.Item data-test="t-other">other item</Components.Generic.Menu.Item>
    </>
  );
}

function mount() {
  const editor = createTestEditor([{ id: "p1", type: "paragraph", content: "hello" }]);
  const view = renderColorMenuHost(
    editor,
    <ColorMenuBody>
      <TestItems />
    </ColorMenuBody>,
  );
  return { editor, ...view };
}

const trigger = () => screen.getByTestId("host-trigger");
const customItem = () => document.querySelector<HTMLElement>('[data-kb-color-return="t-custom"]')!;
const panel = () => document.querySelector<HTMLElement>(".kb-color-panel");
const hexInput = () => screen.getByRole("textbox", { name: "Hex color", hidden: true }) as HTMLInputElement;
const button = (name: string) => screen.getByRole("button", { name, hidden: true }) as HTMLButtonElement;

/** Opens the menu and clicks "Custom..."; waits for the panel. `detail` 0 means keyboard activation. */
async function openPanel(detail = 0) {
  await openHostMenu();
  fireEvent.click(customItem(), { detail });
  await waitFor(() => expect(panel()).not.toBeNull());
}

/** Waits for the lazy react-colorful to mount; returns the two sliders (saturation square, hue). */
async function sliders() {
  return waitFor(() => {
    const s = screen.getAllByRole("slider", { hidden: true });
    expect(s).toHaveLength(2);
    return s;
  });
}

function typeHex(value: string) {
  fireEvent.change(hexInput(), { target: { value } });
}

describe("CustomColorPanel / ColorMenuBody", () => {
  it("opening the panel: the menu stays open, the panel replaces the item list, focus is inside the panel", async () => {
    mount();
    await openPanel();
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(menuNode()).not.toBeNull();
    expect(screen.queryByText("other item")).toBeNull();
    expect(customItem()).toBeNull();
    expect(panel()!.contains(document.activeElement)).toBe(true);
    await settle();
    expect(menuNode()).not.toBeNull();
    expect(panel()!.contains(document.activeElement)).toBe(true);
  });

  it("typing F60 and pressing Enter applies #ff6600, closes the menu and records it in recent colors", async () => {
    const { editor } = mount();
    await openPanel();
    typeHex("F60");
    fireEvent.keyDown(hexInput(), { key: "Enter" });
    expect(applyMock).toHaveBeenCalledTimes(1);
    expect(applyMock).toHaveBeenCalledWith(editor, "text", { kind: "inline" }, "#ff6600");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(menuNode()).toBeNull());
    expect(readRecentColors()[0]).toBe("#ff6600");
  });

  it("Enter while an IME is composing does not apply and the menu stays open", async () => {
    mount();
    await openPanel();
    typeHex("#ff6600");
    fireEvent.keyDown(hexInput(), { key: "Enter", isComposing: true });
    expect(applyMock).not.toHaveBeenCalled();
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(readRecentColors()).toEqual([]);
    fireEvent.keyDown(hexInput(), { key: "Enter" });
    expect(applyMock).toHaveBeenCalledTimes(1);
  });

  it("invalid #ff66: aria-invalid, a hint is shown, Apply is disabled", async () => {
    mount();
    await openPanel();
    typeHex("#ff66");
    expect(hexInput()).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Enter a color as #rgb or #rrggbb")).toBeInTheDocument();
    expect(button("Apply")).toBeDisabled();
    fireEvent.keyDown(hexInput(), { key: "Enter" });
    expect(applyMock).not.toHaveBeenCalled();
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
  });

  it("ArrowDown in the hex field is not preventDefault-ed and focus stays in the field", async () => {
    mount();
    await openPanel();
    const input = hexInput();
    input.focus();
    expect(fireEvent.keyDown(input, { key: "ArrowDown" })).toBe(true);
    expect(fireEvent.keyDown(input, { key: "ArrowUp" })).toBe(true);
    expect(document.activeElement).toBe(input);
  });

  it("clicking the 3rd recent color applies it, closes the menu and moves it to the front", async () => {
    localStorage.setItem(RECENT_COLORS_KEY, JSON.stringify(["#111111", "#222222", "#333333"]));
    const { editor } = mount();
    await openPanel();
    fireEvent.click(button("#333333"));
    expect(applyMock).toHaveBeenCalledTimes(1);
    expect(applyMock).toHaveBeenCalledWith(editor, "text", { kind: "inline" }, "#333333");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(menuNode()).toBeNull());
    expect(readRecentColors()).toEqual(["#333333", "#111111", "#222222"]);
  });

  it("Tab wraps: with recent colors the last stop is the 3rd swatch", async () => {
    localStorage.setItem(RECENT_COLORS_KEY, JSON.stringify(["#111111", "#222222", "#333333"]));
    mount();
    const restore = layoutHostTrigger();
    try {
      await openPanel();
      await waitForMenuShown();
      await sliders();
      const last = button("#333333");
      const back = button("Back");
      last.focus();
      expect(fireEvent.keyDown(last, { key: "Tab" })).toBe(false);
      expect(document.activeElement).toBe(back);
      expect(trigger()).toHaveAttribute("aria-expanded", "true");
      back.focus();
      expect(fireEvent.keyDown(back, { key: "Tab", shiftKey: true })).toBe(false);
      expect(document.activeElement).toBe(last);
      await settle();
      expect(menuNode()).not.toBeNull();
    } finally {
      restore();
    }
  });

  it("Tab wraps: with no recent colors the last stop is Apply", async () => {
    mount();
    const restore = layoutHostTrigger();
    try {
      await openPanel();
      await waitForMenuShown();
      await sliders();
      typeHex("#ff6600");
      const apply = button("Apply");
      const back = button("Back");
      expect(apply).toBeEnabled();
      expect(screen.queryAllByRole("button", { name: /^#/, hidden: true })).toHaveLength(0);
      apply.focus();
      expect(fireEvent.keyDown(apply, { key: "Tab" })).toBe(false);
      expect(document.activeElement).toBe(back);
      expect(trigger()).toHaveAttribute("aria-expanded", "true");
      back.focus();
      expect(fireEvent.keyDown(back, { key: "Tab", shiftKey: true })).toBe(false);
      expect(document.activeElement).toBe(apply);
    } finally {
      restore();
    }
  });

  /** Sends a key on the hex field; returns the key the document keydown listener received. */
  async function keysReachingDocument(key: string) {
    mount();
    await openPanel();
    const spy = vi.fn();
    document.addEventListener("keydown", spy);
    try {
      const input = hexInput();
      input.focus();
      fireEvent.keyDown(input, { key });
      return spy.mock.calls.map((c) => (c[0] as KeyboardEvent).key);
    } finally {
      document.removeEventListener("keydown", spy);
    }
  }

  it("Tab in the hex field reaches the document", async () => {
    expect(await keysReachingDocument("Tab")).toEqual(["Tab"]);
  });

  it("Escape in the hex field reaches the document", async () => {
    expect(await keysReachingDocument("Escape")).toEqual(["Escape"]);
  });

  it("ArrowDown in the hex field does not reach the document", async () => {
    expect(await keysReachingDocument("ArrowDown")).toEqual([]);
  });

  const sliderLabels = async () => (await sliders()).map((s) => s.getAttribute("aria-label"));

  it("the two sliders' aria-labels are i18n strings and survive a re-render", async () => {
    mount();
    await openPanel();
    expect(await sliderLabels()).toEqual(["Saturation and brightness", "Hue"]);

    // change the hex so HexColorPicker re-renders with the new color prop
    typeHex("#ff6600");
    typeHex("#00ff00");
    expect(await sliderLabels()).toEqual(["Saturation and brightness", "Hue"]);
    // Adjusting hue by keyboard: only react-colorful's internal state changes and the outer component may not re-render (same path as dragging)
    const [, hue] = await sliders();
    // react-colorful only looks at which/keyCode
    fireEvent.keyDown(hue!, { key: "ArrowRight", keyCode: 39, which: 39 });
    await waitFor(() => expect(hexInput().value).not.toBe("#00ff00"));
    expect(await sliderLabels()).toEqual(["Saturation and brightness", "Hue"]);
  });

  it("after switching to zh-TW the sliders' aria-labels follow", async () => {
    mount();
    await openPanel();
    expect(await sliderLabels()).toEqual(["Saturation and brightness", "Hue"]);
    await act(() => i18n.changeLanguage("zh-TW"));
    expect(await sliderLabels()).toEqual(["飽和度與亮度", "色相"]);
  });

  it("(pointer: fine) focuses the hex field", async () => {
    stubPointer(true);
    mount();
    await openPanel(1);
    expect(document.activeElement).toBe(hexInput());
  });

  it("(pointer: coarse) opened by click: focus is on the panel root", async () => {
    stubPointer(false);
    mount();
    await openPanel(1);
    expect(document.activeElement).toBe(panel());
    await settle();
    expect(document.activeElement).toBe(panel());
  });

  it("(pointer: coarse) opened by keyboard (detail 0) focuses the hex field", async () => {
    stubPointer(false);
    mount();
    await openPanel(0);
    expect(document.activeElement).toBe(hexInput());
  });

  it("Back returns to the item list with focus on \"Custom...\"; closing and reopening still shows the item list", async () => {
    mount();
    await openPanel();
    fireEvent.click(button("Back"));
    await waitFor(() => expect(customItem()).not.toBeNull());
    expect(panel()).toBeNull();
    expect(screen.getByText("other item")).toBeInTheDocument();
    expect(document.activeElement).toBe(customItem());
    expect(trigger()).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(customItem());
    await waitFor(() => expect(panel()).not.toBeNull());
    fireEvent.click(trigger());
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(menuNode()).toBeNull());
    await openHostMenu();
    expect(customItem()).not.toBeNull();
    expect(panel()).toBeNull();
  });

  it("Back, Apply and the recent color swatches are all in the Tab order", async () => {
    localStorage.setItem(RECENT_COLORS_KEY, JSON.stringify(["#111111", "#222222"]));
    mount();
    await openPanel();
    for (const name of ["Back", "Apply", "#111111", "#222222"]) {
      expect(button(name).tabIndex, name).not.toBe(-1);
    }
  });

  it("entering a valid hex only updates the preview and the square without writing; Enter writes once", async () => {
    const { editor } = mount();
    await openPanel();
    const [saturation] = await sliders();
    const before = JSON.stringify(editor.document);
    const valueTextBefore = saturation!.getAttribute("aria-valuetext");

    typeHex("#ff6600");
    const preview = panel()!.querySelector("[data-text-color]");
    expect(preview).toHaveAttribute("data-text-color", "#ff6600");
    expect(preview).toHaveTextContent("Aa");
    expect(JSON.stringify(editor.document)).toBe(before);
    expect(applyMock).not.toHaveBeenCalled();
    expect(readRecentColors()).not.toContain("#ff6600");
    await waitFor(() => expect(saturation!.getAttribute("aria-valuetext")).not.toBe(valueTextBefore));
    expect(saturation!.getAttribute("aria-valuetext")).toBe("Saturation 100%, Brightness 100%");

    fireEvent.keyDown(hexInput(), { key: "Enter" });
    expect(applyMock).toHaveBeenCalledTimes(1);
  });

  it("the panel's content width fits react-colorful's width without causing a horizontal scrollbar", async () => {
    mount();
    await openPanel();
    await sliders();
    const picker = panel()!.querySelector(".react-colorful")!;
    const pickerWidth = parseFloat(getComputedStyle(picker).width);
    expect(pickerWidth).toBe(200);
    expect(declaredContentWidth(panel()!)).toBeGreaterThanOrEqual(pickerWidth);
  });
});
