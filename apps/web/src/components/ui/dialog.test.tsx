import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clickOutside, settle } from "@/test/outside-click";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog";

type ContentProps = React.ComponentProps<typeof DialogContent>;

/** Controlled Dialog: unmounts its content when closed; `onOpenChange` only records the state Radix asks for; `probe` simulates an element outside the dialog. */
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
  it("default (not passed): clicking outside closes it (baseline: proves Radix really handles this way of triggering the event in jsdom)", async () => {
    render(<Harness />);
    expect(dialogEl()).not.toBeNull();
    await clickOutside();
    expect(dialogEl()).toBeNull();
  });

  it("dismissOnOutside={false}: the same outside click does not close it and the typed input stays (the baseline case shows the event does close the dialog)", async () => {
    render(<Harness dismissOnOutside={false} />);
    const field = screen.getByLabelText("field");
    fireEvent.change(field, { target: { value: "keep me" } });
    await clickOutside();
    expect(dialogEl()).not.toBeNull();
    expect(screen.getByLabelText("field")).toHaveValue("keep me");
  });

  it("dismissOnOutside={false}: Esc still closes", async () => {
    render(<Harness dismissOnOutside={false} />);
    await settle();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(dialogEl()).toBeNull());
  });

  it("dismissOnOutside={false}: the top-right X still closes", async () => {
    render(<Harness dismissOnOutside={false} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(dialogEl()).toBeNull());
  });

  it("the caller's onInteractOutside is still called (with the guard on or off)", async () => {
    for (const dismissOnOutside of [true, false]) {
      const onInteractOutside = vi.fn();
      const { unmount } = render(<Harness dismissOnOutside={dismissOnOutside} onInteractOutside={onInteractOutside} />);
      await clickOutside();
      expect(onInteractOutside).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it("the caller's own preventDefault still works by default (dismissOnOutside not passed)", async () => {
    render(<Harness onInteractOutside={(e) => e.preventDefault()} />);
    await clickOutside();
    expect(dialogEl()).not.toBeNull();
  });

  it("the caller's onPointerDownOutside is still called (alongside the guard)", async () => {
    const onPointerDownOutside = vi.fn();
    render(<Harness dismissOnOutside={false} onPointerDownOutside={onPointerDownOutside} />);
    await clickOutside();
    expect(onPointerDownOutside).toHaveBeenCalledTimes(1);
    expect(dialogEl()).not.toBeNull();
  });
});

describe("DialogContent size (#247)", () => {
  it("default size: one built-in Close (baseline for unchanged behavior)", async () => {
    render(<Harness />);
    await settle();
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(1);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).not.toHaveClass("grid-cols-[minmax(0,1fr)]");
    expect(dialog).not.toHaveClass("grid-rows-[minmax(0,1fr)]");
  });

  it("built-in Close: 16px visually, with the hit area extended to 44 on coarse pointers (14px outward on each side via after)", async () => {
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

  it('size="panel": does not render the built-in Close (ManagementShell places its own)', async () => {
    render(<Harness size="panel" />);
    await settle();
    expect(screen.queryAllByRole("button", { name: "Close" })).toHaveLength(0);
  });

  it('size="panel": transparent frame, narrow-window width and height plus the md: clamp', async () => {
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
    // twMerge must override base's bg-popover / shadow-lg / w-full.
    expect(dialog).not.toHaveClass("bg-popover");
    expect(dialog).not.toHaveClass("shadow-lg");
    expect(dialog).not.toHaveClass("w-full");
  });

  it('size="panel": on a phone it is a bottom-anchored, nearly full-height sheet (full width, no offset, rounded top, a gap above, follows the keyboard); height no longer uses vh', async () => {
    render(<Harness size="panel" />);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveClass(
      "max-sm:inset-x-0",
      "max-sm:top-auto",
      "max-sm:bottom-(--kb-inset,0px)",
      "max-sm:h-[calc(var(--kb-visible-h,100dvh)_-_max(1.75rem,env(safe-area-inset-top)_+_0.5rem))]",
      "max-sm:w-full",
      "max-sm:max-w-none",
      "max-sm:translate-x-0",
      "max-sm:translate-y-0",
      "max-sm:rounded-t-xl",
      "max-sm:rounded-b-none",
      "max-sm:shadow-lg",
      "kb-sheet",
    );
    expect(dialog.className).not.toMatch(/max-sm:rounded-t-2xl/);
    expect(dialog.className).not.toMatch(/max-sm:inset-0|max-sm:h-dvh|max-sm:rounded-none/);
    // iOS Safari's vh is the height with the toolbar collapsed: height classes always use dvh (width's vw is unaffected).
    expect(dialog.className).not.toMatch(/\d+vh\b/);
  });
});

describe("DialogContent container draws no focus ring", () => {
  // When Radix puts focus on Content itself (focused programmatically, or as the fallback when nothing is tabbable), Chrome's default :focus-visible outline would ring the whole panel;
  // the shared base suppresses it, and every size needs that.
  it.each(["default", "panel"] as const)("size=%s: Content has outline-none", (size) => {
    render(<Harness size={size} />);
    expect(screen.getByRole("dialog")).toHaveClass("outline-none");
  });

  it("size not passed (default): Content has outline-none", () => {
    render(<Harness />);
    expect(screen.getByRole("dialog")).toHaveClass("outline-none");
  });
});

describe("DialogContent phone bottom sheet", () => {
  it("default size: on phones anchored to the bottom, scrollable, rounded top, bottom safe area; enter/exit use kb-sheet", () => {
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

  it("a className max-w override does not narrow the sheet on phones (max-sm:max-w-none coexists with max-w-lg)", () => {
    render(<Harness className="max-w-lg" />);
    expect(screen.getByRole("dialog")).toHaveClass("max-w-lg", "max-sm:max-w-none");
  });

  it('the size="panel" sheet omits the classes of the default size (height cap, padding): it is nearly full height with a fixed height', () => {
    render(<Harness size="panel" />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.className).not.toMatch(/max-sm:max-h-|max-sm:pb-\[max\(1\.5rem/);
  });

  it("the sheet's backdrop fades out on phones (both default and panel)", () => {
    render(<Harness />);
    expect(document.querySelector(".kb-sheet-overlay")).not.toBeNull();
    cleanup();
    render(<Harness size="panel" />);
    expect(document.querySelector(".kb-sheet-overlay")).not.toBeNull();
  });

  describe("on-screen keyboard", () => {
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

    it("--kb-inset and --kb-visible-h follow the visual viewport: 0 and the full window height with no keyboard, changing when it rises; removed on pinch zoom", () => {
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

    it.each([0, 200, 344])("layout viewport 844, visual height 500, offsetTop %i (including panned to the end with keyboard height 0): the sheet top is not above the visual viewport top and its bottom edge sits on the visual viewport bottom", (offsetTop) => {
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

    it("a style passed by the caller reaches the content element and coexists with the dynamically written variables", () => {
      viewport.height = 500;
      render(<Harness style={{ color: "rgb(1, 2, 3)" }} />);
      const dialog = screen.getByRole("dialog");
      expect(dialog.style.color).toBe("rgb(1, 2, 3)");
      expect(dialog.style.getPropertyValue("--kb-visible-h")).toBe("500px");
    });

    it.each([0, 200, 344])("iOS panning the visual viewport (offsetTop %i): the sheet top is never above the visual viewport top", (offsetTop) => {
      viewport.height = 500;
      viewport.offsetTop = offsetTop;
      render(<Harness />);
      const style = screen.getByRole("dialog").style;
      const inset = parseFloat(style.getPropertyValue("--kb-inset"));
      const visible = parseFloat(style.getPropertyValue("--kb-visible-h"));
      expect(visible).toBe(500);
      // Layout viewport height 1000: sheet bottom = 1000 - inset, height cap = 0.9 x visible.
      const sheetTop = 1000 - inset - 0.9 * visible;
      expect(sheetTop).toBeGreaterThanOrEqual(offsetTop);
    });

    it("subscribes only while open: a closed dialog has no visualViewport listener, an open one has it, and it is removed on unmount", () => {
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

    it('size="panel" also follows the keyboard (a phone panel is a bottom sheet too)', () => {
      viewport.height = 500;
      render(<Harness size="panel" />);
      expect(screen.getByRole("dialog").style.getPropertyValue("--kb-inset")).toBe("500px");
      expect(screen.getByRole("dialog").style.getPropertyValue("--kb-visible-h")).toBe("500px");
      expect(viewport.listeners).toBe(2);
    });
  });
});
