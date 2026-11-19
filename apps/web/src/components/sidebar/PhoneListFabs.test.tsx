import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import { PHONE_FAB_FOOTPRINT_PX, PhoneListFabs } from "./PhoneListFabs";

interface FabOverrides {
  showNewNote?: boolean;
  newNotePending?: boolean;
}

function renderFabs(overrides: FabOverrides = {}) {
  const onSearch = vi.fn();
  const onCreateNote = vi.fn();
  render(<PhoneListFabs onSearch={onSearch} showNewNote={overrides.showNewNote ?? true} onCreateNote={onCreateNote} newNotePending={overrides.newNotePending ?? false} />);
  return { onSearch, onCreateNote };
}

describe("PhoneListFabs", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("two 56px round buttons, each with an accessible name; clicking calls onSearch / onCreateNote respectively", () => {
    const { onSearch, onCreateNote } = renderFabs();
    const search = screen.getByRole("button", { name: "Search notes" });
    const create = screen.getByRole("button", { name: "New note" });
    for (const fab of [search, create]) expect(fab).toHaveClass("h-14", "w-14", "rounded-full", "fixed", "shadow-lg");
    fireEvent.click(search);
    fireEvent.click(create);
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onCreateNote).toHaveBeenCalledTimes(1);
  });

  it("both share the same frosted-glass style: a translucent card background (nearly opaque where blur is unsupported) + backdrop blur + thin border + shadow; New note is emphasized only by the brand color of its icon, not a solid background", () => {
    renderFabs();
    const search = screen.getByRole("button", { name: "Search notes" });
    const create = screen.getByRole("button", { name: "New note" });
    for (const fab of [search, create]) {
      expect(fab).toHaveClass("bg-card/95", "supports-[backdrop-filter]:bg-card/25", "supports-[backdrop-filter]:backdrop-blur-xs", "supports-[backdrop-filter]:backdrop-saturate-150", "border", "border-black/10", "dark:border-white/20", "shadow-lg");
      expect(fab.className).not.toMatch(/(^|\s)bg-brand/);
    }
    expect(create).toHaveClass("text-brand-on-soft");
    expect(search).toHaveClass("text-foreground");
  });

  it("the New note icon is a pen (pen-line), Search is a magnifier; icons are aria-hidden", () => {
    renderFabs();
    const create = screen.getByRole("button", { name: "New note" });
    expect(create.querySelector("svg")).toHaveAttribute("data-icon", "pen-line");
    expect(create.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("button", { name: "Search notes" }).querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("Search is at bottom left, New note at bottom right; both sit 16px from the edge plus the safe area", () => {
    renderFabs();
    const search = screen.getByRole("button", { name: "Search notes" });
    const create = screen.getByRole("button", { name: "New note" });
    expect(search).toHaveClass("left-[calc(1rem+env(safe-area-inset-left))]", "bottom-[calc(1rem+env(safe-area-inset-bottom))]");
    expect(create).toHaveClass("right-[calc(1rem+env(safe-area-inset-right))]", "bottom-[calc(1rem+env(safe-area-inset-bottom))]");
    expect(search.className).not.toContain("right-[");
    expect(create.className).not.toContain("left-[");
  });

  it("PHONE_FAB_FOOTPRINT_PX equals 16px from the bottom plus the 56px button height, and both buttons' classes are still bottom-[calc(1rem+...)] and h-14", () => {
    expect(PHONE_FAB_FOOTPRINT_PX).toBe(16 + 56);
    renderFabs();
    for (const name of ["Search notes", "New note"]) {
      expect(screen.getByRole("button", { name })).toHaveClass("bottom-[calc(1rem+env(safe-area-inset-bottom))]", "h-14");
    }
  });

  it("while creating: New note is disabled, Search as usual", () => {
    renderFabs({ newNotePending: true });
    expect(screen.getByRole("button", { name: "New note" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Search notes" })).toBeEnabled();
  });

  it("showNewNote false (trash): only Search remains", () => {
    renderFabs({ showNewNote: false });
    expect(screen.queryByRole("button", { name: "New note" })).toBeNull();
    expect(screen.getByRole("button", { name: "Search notes" })).toBeInTheDocument();
  });

  describe("on-screen keyboard", () => {
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

    it("keyboard up: neither button renders; they return after it is dismissed", () => {
      renderFabs();
      setKeyboard(300);
      expect(screen.queryByRole("button", { name: "Search notes" })).toBeNull();
      expect(screen.queryByRole("button", { name: "New note" })).toBeNull();
      setKeyboard(0);
      expect(screen.getByRole("button", { name: "Search notes" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument();
    });

    it("a height difference within the threshold does not count as a keyboard: still shown", () => {
      renderFabs();
      setKeyboard(60);
      expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument();
    });
  });
});
