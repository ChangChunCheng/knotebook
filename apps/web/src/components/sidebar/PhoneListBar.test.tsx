import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import { PhoneListBar } from "./PhoneListBar";

function renderBar(overrides: { query?: string } = {}) {
  const onQueryChange = vi.fn();
  const onOpen = vi.fn();
  const onClose = vi.fn();
  const searchRef = createRef<HTMLInputElement>();
  render(<PhoneListBar query={overrides.query ?? ""} onQueryChange={onQueryChange} searchRef={searchRef} onOpen={onOpen} onClose={onClose} />);
  return { onQueryChange, onOpen, onClose, searchRef };
}

describe("PhoneListBar (the search bar while the search layer is open)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("the search box is 44 high with 16px text (prevents iOS zoom), no Ctrl K badge, no New note", () => {
    renderBar();
    const input = screen.getByRole("textbox", { name: "Search notes" });
    expect(input).toHaveClass("h-11");
    expect(input).toHaveClass("text-base");
    expect(input.className).not.toContain("text-[13px]");
    expect(screen.queryByText("Ctrl K")).toBeNull();
    expect(screen.queryByRole("button", { name: "New note" })).toBeNull();
  });

  it("on the right is a 44-high Cancel: clicking clears the text, blurs the search box and closes the search layer", () => {
    const { onQueryChange, onClose, searchRef } = renderBar({ query: "alp" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel).toHaveClass("h-11");
    const input = screen.getByRole("textbox", { name: "Search notes" });
    input.focus();
    expect(searchRef.current).toBe(input);
    fireEvent.click(cancel);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onQueryChange).toHaveBeenCalledWith("");
    expect(input).not.toHaveFocus();
  });

  it("focus calls onOpen; blur does not close (tapping a result or dismissing the keyboard both blur)", () => {
    const { onOpen, onClose } = renderBar();
    const input = screen.getByRole("textbox", { name: "Search notes" });
    fireEvent.focus(input);
    expect(onOpen).toHaveBeenCalledTimes(1);
    fireEvent.blur(input);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("typing calls onQueryChange; Esc clears, blurs and closes the search layer", () => {
    const { onQueryChange, onClose } = renderBar({ query: "x" });
    const input = screen.getByRole("textbox", { name: "Search notes" });
    fireEvent.change(input, { target: { value: "xy" } });
    expect(onQueryChange).toHaveBeenLastCalledWith("xy");
    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onQueryChange).toHaveBeenLastCalledWith("");
    expect(input).not.toHaveFocus();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("row height 56 (padding 6 + 44 + 6) plus the bottom safe area", () => {
    const { searchRef } = renderBar();
    const bar = searchRef.current?.closest("[data-phone-list-bar]");
    expect(bar).not.toBeNull();
    expect(bar?.className).toContain("env(safe-area-inset-bottom)");
    expect(bar).toHaveClass("pt-1.5");
  });

  describe("keyboard open", () => {
    let viewport: EventTarget & { height: number; offsetTop: number; scale: number };
    let frames: Array<() => void>;

    function setKeyboard(inset: number) {
      viewport.height = 800 - inset;
      act(() => {
        viewport.dispatchEvent(new Event("resize"));
        frames.splice(0).forEach((run) => run());
      });
    }

    beforeEach(() => {
      viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0, scale: 1 });
      vi.stubGlobal("innerHeight", 800);
      frames = [];
      vi.stubGlobal("requestAnimationFrame", (cb: () => void) => frames.push(cb));
      Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true, writable: true });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true, writable: true });
    });

    function bar() {
      return document.querySelector<HTMLElement>("[data-phone-list-bar]")!;
    }

    it("keyboard closed: the bar is in the document flow (no margin-bottom), sticky pinned to the window bottom on phones; has Cancel and the safe area", () => {
      renderBar();
      expect(bar()).not.toHaveClass("fixed");
      expect(bar()).toHaveClass("max-sm:sticky", "max-sm:bottom-0");
      expect(bar().style.bottom).toBe("");
      expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
      expect(bar().className).toContain("env(safe-area-inset-bottom)");
    });

    it("keyboard up: the bar stays in the document flow, sticky bottom = keyboard height (against the top of the keyboard) with an equal margin-bottom (the last results can scroll above the bar); only the search box remains, no Cancel, no safe-area padding", () => {
      renderBar();
      setKeyboard(300);
      expect(bar()).not.toHaveClass("fixed");
      expect(bar()).toHaveClass("shrink-0");
      expect(bar().style.bottom).toBe("300px");
      expect(bar().style.marginBottom).toBe("300px");
      expect(screen.getByRole("textbox", { name: "Search notes" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
      expect(bar().className).not.toContain("env(safe-area-inset-bottom)");
    });

    it("a height difference within the threshold does not count as a keyboard: the bar stays as before", () => {
      renderBar();
      setKeyboard(60);
      expect(bar()).not.toHaveClass("fixed");
      expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    });

    it("keyboard dismissed: back to the document flow, Cancel returns", () => {
      renderBar();
      setKeyboard(300);
      setKeyboard(0);
      expect(bar().style.marginBottom).toBe("");
      expect(bar().style.bottom).toBe("");
      expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    });
  });
});
