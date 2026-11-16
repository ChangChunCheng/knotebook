import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import { PhoneListFabs } from "./PhoneListFabs";

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

  it("兩顆 56px 圓形鈕，各有可及名稱；點了分別呼叫 onSearch／onCreateNote", () => {
    const { onSearch, onCreateNote } = renderFabs();
    const search = screen.getByRole("button", { name: "Search notes" });
    const create = screen.getByRole("button", { name: "New note" });
    for (const fab of [search, create]) expect(fab).toHaveClass("h-14", "w-14", "rounded-full", "fixed", "shadow-lg");
    fireEvent.click(search);
    fireEvent.click(create);
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onCreateNote).toHaveBeenCalledTimes(1);
  });

  it("兩顆同款毛玻璃：半透明卡片底（不支援模糊時退回近乎不透明）＋背景模糊＋細框＋陰影；New note 只靠圖示的 brand 色強調、不是實心底", () => {
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

  it("New note 的圖示是筆（pen-line），Search 是放大鏡；圖示都 aria-hidden", () => {
    renderFabs();
    const create = screen.getByRole("button", { name: "New note" });
    expect(create.querySelector("svg")).toHaveAttribute("data-icon", "pen-line");
    expect(create.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("button", { name: "Search notes" }).querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("Search 在左下、New note 在右下；都貼 16px 加 safe area", () => {
    renderFabs();
    const search = screen.getByRole("button", { name: "Search notes" });
    const create = screen.getByRole("button", { name: "New note" });
    expect(search).toHaveClass("left-[calc(1rem+env(safe-area-inset-left))]", "bottom-[calc(1rem+env(safe-area-inset-bottom))]");
    expect(create).toHaveClass("right-[calc(1rem+env(safe-area-inset-right))]", "bottom-[calc(1rem+env(safe-area-inset-bottom))]");
    expect(search.className).not.toContain("right-[");
    expect(create.className).not.toContain("left-[");
  });

  it("建立中：New note 停用、Search 照常", () => {
    renderFabs({ newNotePending: true });
    expect(screen.getByRole("button", { name: "New note" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Search notes" })).toBeEnabled();
  });

  it("showNewNote 為 false（垃圾桶）：只剩 Search", () => {
    renderFabs({ showNewNote: false });
    expect(screen.queryByRole("button", { name: "New note" })).toBeNull();
    expect(screen.getByRole("button", { name: "Search notes" })).toBeInTheDocument();
  });

  describe("螢幕鍵盤", () => {
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

    it("鍵盤升起：兩顆都不渲染；收起後回來", () => {
      renderFabs();
      setKeyboard(300);
      expect(screen.queryByRole("button", { name: "Search notes" })).toBeNull();
      expect(screen.queryByRole("button", { name: "New note" })).toBeNull();
      setKeyboard(0);
      expect(screen.getByRole("button", { name: "Search notes" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument();
    });

    it("高度差在門檻以內：不算鍵盤，照舊顯示", () => {
      renderFabs();
      setKeyboard(60);
      expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument();
    });
  });
});
