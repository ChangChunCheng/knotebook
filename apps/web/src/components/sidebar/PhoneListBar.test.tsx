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

describe("PhoneListBar（搜尋層開著時的搜尋列）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("搜尋框 44 高、16px 字級（防 iOS 放大），沒有 Ctrl K 徽章，沒有 New note", () => {
    renderBar();
    const input = screen.getByRole("textbox", { name: "Search notes" });
    expect(input).toHaveClass("h-11");
    expect(input).toHaveClass("text-base");
    expect(input.className).not.toContain("text-[13px]");
    expect(screen.queryByText("Ctrl K")).toBeNull();
    expect(screen.queryByRole("button", { name: "New note" })).toBeNull();
  });

  it("右側是 44 高的 Cancel：點了清空字、讓搜尋框失焦並關搜尋層", () => {
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

  it("聚焦呼叫 onOpen；失焦不關（點結果、收鍵盤都會失焦）", () => {
    const { onOpen, onClose } = renderBar();
    const input = screen.getByRole("textbox", { name: "Search notes" });
    fireEvent.focus(input);
    expect(onOpen).toHaveBeenCalledTimes(1);
    fireEvent.blur(input);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("打字呼叫 onQueryChange；Esc 清空、失焦並關搜尋層", () => {
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

  it("列高 56（內距 6＋44＋6）加底部 safe area", () => {
    const { searchRef } = renderBar();
    const bar = searchRef.current?.closest("[data-phone-list-bar]");
    expect(bar).not.toBeNull();
    expect(bar?.className).toContain("env(safe-area-inset-bottom)");
    expect(bar).toHaveClass("pt-1.5");
  });

  describe("鍵盤開著", () => {
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

    it("鍵盤收著：列在文件流裡（沒有 margin-bottom），有 Cancel 與 safe area", () => {
      renderBar();
      expect(bar()).not.toHaveClass("fixed");
      expect(bar().style.bottom).toBe("");
      expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
      expect(bar().className).toContain("env(safe-area-inset-bottom)");
    });

    it("鍵盤升起：列仍在文件流裡、margin-bottom＝鍵盤高（結果區跟著縮短），只留搜尋框，沒有 Cancel、沒有 safe area 內距", () => {
      renderBar();
      setKeyboard(300);
      expect(bar()).not.toHaveClass("fixed");
      expect(bar()).toHaveClass("shrink-0");
      expect(bar().style.marginBottom).toBe("300px");
      expect(screen.getByRole("textbox", { name: "Search notes" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
      expect(bar().className).not.toContain("env(safe-area-inset-bottom)");
    });

    it("高度差在門檻以內：不算鍵盤，列照舊", () => {
      renderBar();
      setKeyboard(60);
      expect(bar()).not.toHaveClass("fixed");
      expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    });

    it("鍵盤收起：回到文件流、Cancel 回來", () => {
      renderBar();
      setKeyboard(300);
      setKeyboard(0);
      expect(bar().style.marginBottom).toBe("");
      expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    });
  });
});
