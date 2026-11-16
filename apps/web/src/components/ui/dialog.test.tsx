import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clickOutside, settle } from "@/test/outside-click";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog";

type ContentProps = React.ComponentProps<typeof DialogContent>;

/** 受控 Dialog：關閉時卸載內容，`onOpenChange` 只記錄 Radix 要求的狀態；`probe` 用來模擬「對話框外的元素」。 */
function Harness(props: ContentProps) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button">outside-probe</button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent {...props}>
          <DialogTitle>T</DialogTitle>
          <DialogDescription>D</DialogDescription>
          <input aria-label="field" defaultValue="" />
        </DialogContent>
      </Dialog>
    </>
  );
}

const dialogEl = () => screen.queryByRole("dialog");

describe("DialogContent dismissOnOutside", () => {
  it("預設（未傳）：點外面 → 關閉（基準：證明這個 jsdom 觸發方式 Radix 真的處理）", async () => {
    render(<Harness />);
    expect(dialogEl()).not.toBeNull();
    await clickOutside();
    expect(dialogEl()).toBeNull();
  });

  it("dismissOnOutside={false}：同樣的點外面操作 → 不關閉、輸入內容仍在（基準案證明事件確實會讓對話框關）", async () => {
    render(<Harness dismissOnOutside={false} />);
    const field = screen.getByLabelText("field");
    fireEvent.change(field, { target: { value: "keep me" } });
    await clickOutside();
    expect(dialogEl()).not.toBeNull();
    expect(screen.getByLabelText("field")).toHaveValue("keep me");
  });

  it("dismissOnOutside={false}：Esc 照常關閉", async () => {
    render(<Harness dismissOnOutside={false} />);
    await settle();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(dialogEl()).toBeNull());
  });

  it("dismissOnOutside={false}：右上 X 照常關閉", async () => {
    render(<Harness dismissOnOutside={false} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(dialogEl()).toBeNull());
  });

  it("呼叫端的 onInteractOutside 仍被呼叫（守衛開／關兩種都是）", async () => {
    for (const dismissOnOutside of [true, false]) {
      const onInteractOutside = vi.fn();
      const { unmount } = render(<Harness dismissOnOutside={dismissOnOutside} onInteractOutside={onInteractOutside} />);
      await clickOutside();
      expect(onInteractOutside).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it("呼叫端自己的 preventDefault 在預設（dismissOnOutside 未傳）下仍有效", async () => {
    render(<Harness onInteractOutside={(e) => e.preventDefault()} />);
    await clickOutside();
    expect(dialogEl()).not.toBeNull();
  });

  it("呼叫端的 onPointerDownOutside 仍被呼叫（與守衛並存）", async () => {
    const onPointerDownOutside = vi.fn();
    render(<Harness dismissOnOutside={false} onPointerDownOutside={onPointerDownOutside} />);
    await clickOutside();
    expect(onPointerDownOutside).toHaveBeenCalledTimes(1);
    expect(dialogEl()).not.toBeNull();
  });
});

describe("DialogContent size（#247）", () => {
  it("預設 size：恰一顆內建 Close（行為零變的基準）", async () => {
    render(<Harness />);
    await settle();
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(1);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).not.toHaveClass("grid-cols-[minmax(0,1fr)]");
    expect(dialog).not.toHaveClass("grid-rows-[minmax(0,1fr)]");
  });

  it("內建 Close：視覺 16px，粗指標下點擊範圍擴到 44（after 向外各 14px）", async () => {
    render(<Harness />);
    await settle();
    const close = screen.getByRole("button", { name: "Close" });
    for (const token of [
      "absolute",
      "pointer-coarse:after:absolute",
      "pointer-coarse:after:-inset-3.5",
      "pointer-coarse:after:content-['']",
    ]) {
      expect(close).toHaveClass(token);
    }
  });

  it('size="panel"：不渲染內建 Close（由 ManagementShell 自己放一顆）', async () => {
    render(<Harness size="panel" />);
    await settle();
    expect(screen.queryAllByRole("button", { name: "Close" })).toHaveLength(0);
  });

  it('size="panel"：透明外框、窄視窗寬高＋md: clamp', async () => {
    render(<Harness size="panel" />);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveClass(
      "p-0",
      "bg-transparent",
      "border-0",
      "shadow-none",
      "overflow-visible",
      "w-[96vw]",
      "h-[92dvh]",
      "max-w-[calc(100vw-2*max(2vw,env(safe-area-inset-left),env(safe-area-inset-right)))]",
      "md:w-[clamp(min(56rem,96vw),92vw,85rem)]",
      "md:h-[clamp(min(42rem,92dvh),88dvh,56rem)]",
      "grid-cols-[minmax(0,1fr)]",
      "grid-rows-[minmax(0,1fr)]",
    );
    // twMerge 要把 base 的 bg-popover／shadow-lg／w-full 蓋掉
    expect(dialog).not.toHaveClass("bg-popover");
    expect(dialog).not.toHaveClass("shadow-lg");
    expect(dialog).not.toHaveClass("w-full");
  });

  it('size="panel"：手機是整頁（inset-0、h-dvh、滿寬、不位移、不圓角）；高度不再用 vh', async () => {
    render(<Harness size="panel" />);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveClass("max-sm:inset-0", "max-sm:h-dvh", "max-sm:w-full", "max-sm:max-w-none", "max-sm:translate-x-0", "max-sm:translate-y-0", "max-sm:rounded-none");
    // iOS Safari 的 vh 是工具列收起時的高度：高度類一律 dvh（寬度的 vw 不受影響）。
    expect(dialog.className).not.toMatch(/\d+vh\b/);
  });
});

describe("DialogContent 容器不畫焦點環", () => {
  // Radix 把焦點放在 Content 本身（程式聚焦或沒有可 tab 元素的後備）時，Chrome 預設 :focus-visible outline 會圈住整個面板；
  // 統一在共用基底擋掉，各 size 都要有。
  it.each(["default", "panel"] as const)("size=%s：Content 有 outline-none", (size) => {
    render(<Harness size={size} />);
    expect(screen.getByRole("dialog")).toHaveClass("outline-none");
  });

  it("未傳 size（預設）：Content 有 outline-none", () => {
    render(<Harness />);
    expect(screen.getByRole("dialog")).toHaveClass("outline-none");
  });
});

describe("DialogContent 手機底部 sheet", () => {
  it("預設 size：手機貼底、可捲、上圓角、底部留 safe area；進出場用 kb-sheet", () => {
    render(<Harness />);
    expect(screen.getByRole("dialog")).toHaveClass(
      "max-sm:inset-x-0",
      "max-sm:bottom-(--kb-inset,0px)",
      "max-sm:top-auto",
      "max-sm:translate-x-0",
      "max-sm:translate-y-0",
      "max-sm:max-h-[calc(var(--kb-visible-h,100dvh)*0.9)]",
      "max-sm:transition-none",
      "max-sm:overflow-y-auto",
      "max-sm:rounded-t-xl",
      "max-sm:rounded-b-none",
      "max-sm:pb-[max(1.5rem,env(safe-area-inset-bottom))]",
      "kb-sheet",
    );
  });

  it("className 的 max-w 覆寫在手機不讓 sheet 縮窄（max-sm:max-w-none 與 max-w-lg 並存）", () => {
    render(<Harness className="max-w-lg" />);
    expect(screen.getByRole("dialog")).toHaveClass("max-w-lg", "max-sm:max-w-none");
  });

  it('size="panel"：沒有任何 sheet class', () => {
    render(<Harness size="panel" />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.className).not.toMatch(/kb-sheet|max-sm:bottom|max-sm:top-auto|max-sm:rounded-t/);
  });

  it("sheet 的背景遮罩手機有淡出（panel 沒有）", () => {
    render(<Harness />);
    expect(document.querySelector(".kb-sheet-overlay")).not.toBeNull();
    cleanup();
    render(<Harness size="panel" />);
    expect(document.querySelector(".kb-sheet-overlay")).toBeNull();
  });

  describe("螢幕鍵盤", () => {
    class FakeViewport extends EventTarget {
      height = 800;
      offsetTop = 0;
      scale = 1;
      listeners = 0;
      addEventListener(type: string, cb: EventListenerOrEventListenerObject | null, opts?: boolean | AddEventListenerOptions) {
        this.listeners += 1;
        super.addEventListener(type, cb, opts);
      }
      removeEventListener(type: string, cb: EventListenerOrEventListenerObject | null, opts?: boolean | EventListenerOptions) {
        this.listeners -= 1;
        super.removeEventListener(type, cb, opts);
      }
    }
    const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
    let viewport: FakeViewport;
    let frames: Array<() => void> = [];
    const flushFrames = () => {
      const pending = frames;
      frames = [];
      act(() => pending.forEach((run) => run()));
    };
    beforeEach(() => {
      viewport = new FakeViewport();
      Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true, writable: true });
      vi.stubGlobal("innerHeight", 1000);
      frames = [];
      vi.stubGlobal("requestAnimationFrame", (cb: () => void) => frames.push(cb));
      vi.stubGlobal("cancelAnimationFrame", vi.fn());
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      if (original) Object.defineProperty(window, "visualViewport", original);
      else delete (window as { visualViewport?: unknown }).visualViewport;
    });

    it("--kb-inset 與 --kb-visible-h 跟著視覺視窗：沒有鍵盤時是 0 與整個視窗高，升起後變動；雙指放大時移除", () => {
      viewport.height = 1000;
      render(<Harness />);
      const dialog = screen.getByRole("dialog");
      expect(dialog.style.getPropertyValue("--kb-inset")).toBe("0px");
      expect(dialog.style.getPropertyValue("--kb-visible-h")).toBe("1000px");
      viewport.height = 500;
      act(() => void viewport.dispatchEvent(new Event("resize")));
      flushFrames();
      expect(dialog.style.getPropertyValue("--kb-inset")).toBe("500px");
      expect(dialog.style.getPropertyValue("--kb-visible-h")).toBe("500px");
      viewport.height = 1000;
      act(() => void viewport.dispatchEvent(new Event("resize")));
      flushFrames();
      expect(dialog.style.getPropertyValue("--kb-inset")).toBe("0px");
      expect(dialog.style.getPropertyValue("--kb-visible-h")).toBe("1000px");
      viewport.scale = 2;
      act(() => void viewport.dispatchEvent(new Event("resize")));
      flushFrames();
      expect(dialog.style.getPropertyValue("--kb-inset")).toBe("");
      expect(dialog.style.getPropertyValue("--kb-visible-h")).toBe("");
    });

    it.each([0, 200, 344])("版面視窗 844、視覺高 500、offsetTop %i（含平移到底、鍵盤高度為 0）：sheet 頂端不高過視覺視窗頂端、底邊貼視覺視窗底邊", (offsetTop) => {
      vi.stubGlobal("innerHeight", 844);
      viewport.height = 500;
      viewport.offsetTop = offsetTop;
      render(<Harness />);
      const style = screen.getByRole("dialog").style;
      const inset = parseFloat(style.getPropertyValue("--kb-inset"));
      const visible = parseFloat(style.getPropertyValue("--kb-visible-h"));
      expect(visible).toBe(500);
      const sheetBottom = 844 - inset;
      expect(sheetBottom).toBe(offsetTop + 500);
      expect(sheetBottom - 0.9 * visible).toBeGreaterThanOrEqual(offsetTop);
    });

    it("呼叫端傳的 style 到得了內容元素，與動態寫入的變數並存", () => {
      viewport.height = 500;
      render(<Harness style={{ color: "rgb(1, 2, 3)" }} />);
      const dialog = screen.getByRole("dialog");
      expect(dialog.style.color).toBe("rgb(1, 2, 3)");
      expect(dialog.style.getPropertyValue("--kb-visible-h")).toBe("500px");
    });

    it.each([0, 200, 344])("iOS 平移視覺視窗（offsetTop %i）：sheet 頂端不會高過視覺視窗頂端", (offsetTop) => {
      viewport.height = 500;
      viewport.offsetTop = offsetTop;
      render(<Harness />);
      const style = screen.getByRole("dialog").style;
      const inset = parseFloat(style.getPropertyValue("--kb-inset"));
      const visible = parseFloat(style.getPropertyValue("--kb-visible-h"));
      expect(visible).toBe(500);
      // 版面視窗高 1000：sheet 底＝1000 - inset，高度上限＝0.9 × visible。
      const sheetTop = 1000 - inset - 0.9 * visible;
      expect(sheetTop).toBeGreaterThanOrEqual(offsetTop);
    });

    it("只在開著時訂閱：關閉的對話框不掛 visualViewport 監聽，開著的有、卸載後移除", () => {
      const { rerender, unmount } = render(
        <Dialog open={false}>
          <DialogContent>
            <DialogTitle>T</DialogTitle>
            <DialogDescription>D</DialogDescription>
          </DialogContent>
        </Dialog>,
      );
      expect(viewport.listeners).toBe(0);
      rerender(
        <Dialog open>
          <DialogContent>
            <DialogTitle>T</DialogTitle>
            <DialogDescription>D</DialogDescription>
          </DialogContent>
        </Dialog>,
      );
      expect(viewport.listeners).toBe(2);
      unmount();
      expect(viewport.listeners).toBe(0);
    });

    it('size="panel"：鍵盤升起也不設變數、不訂閱', () => {
      viewport.height = 500;
      render(<Harness size="panel" />);
      expect(screen.getByRole("dialog").style.getPropertyValue("--kb-inset")).toBe("");
      expect(viewport.listeners).toBe(0);
    });
  });
});
