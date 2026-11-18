import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutlineHeading } from "./headings";
import { OUTLINE_BUBBLE_HIDE_MS, OUTLINE_BUBBLE_INPUT_QUIET_MS, OutlineScrollBubble } from "./OutlineScrollBubble";

const headings: OutlineHeading[] = [
  { id: "h1", level: 1, text: "" },
  { id: "h-install", level: 2, text: "Install" },
  { id: "h-usage", level: 2, text: "Usage" },
  { id: "h-api", level: 1, text: "API" },
  { id: "h-faq", level: 2, text: "FAQ" },
];

let box: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  box = document.createElement("div");
  document.body.appendChild(box);
});
afterEach(() => {
  vi.useRealTimers();
  box.remove();
});

function setup(over: Partial<React.ComponentProps<typeof OutlineScrollBubble>> = {}) {
  const onOpen = vi.fn();
  const view = render(
    <OutlineScrollBubble
      headings={headings}
      activeId="h-install"
      scrollTarget={box}
      placement="page"
      onOpen={onOpen}
      {...over}
    />,
  );
  return { onOpen, view };
}
const scroll = (el: HTMLElement | Window = box) => act(() => void el.dispatchEvent(new Event("scroll")));
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
const bubble = () => screen.queryByRole("button", { hidden: true });

describe("OutlineScrollBubble", () => {
  it("is not rendered before any scrolling", () => {
    setup();
    expect(bubble()).toBeNull();
  });

  it("appears on scroll showing the current section and its index", () => {
    setup();
    scroll();
    expect(bubble()).toHaveTextContent("Install · 2/5");
    expect(bubble()).toHaveAttribute("aria-label", "Open heading outline: Install · 2/5");
  });

  it("shows the placeholder for an empty title and falls back to the first entry without a current id", () => {
    setup({ activeId: null });
    scroll();
    expect(bubble()).toHaveTextContent("(Untitled heading) · 1/5");
  });

  it("disappears from the tree 1500 ms after the last scroll", () => {
    expect(OUTLINE_BUBBLE_HIDE_MS).toBe(1500);
    setup();
    scroll();
    advance(1499);
    expect(bubble()).not.toBeNull();
    advance(1);
    expect(bubble()).toBeNull();
  });

  it("restarts the timer on every scroll", () => {
    setup();
    scroll();
    advance(1000);
    scroll();
    advance(1000);
    expect(bubble()).not.toBeNull();
    advance(500);
    expect(bubble()).toBeNull();
  });

  it("stays mounted while it has focus and restarts the 1500 ms on blur", () => {
    setup();
    scroll();
    act(() => bubble()!.focus());
    advance(5000);
    expect(bubble()).not.toBeNull();
    scroll();
    advance(5000);
    expect(bubble()).not.toBeNull();
    act(() => bubble()!.blur());
    advance(1499);
    expect(bubble()).not.toBeNull();
    advance(1);
    expect(bubble()).toBeNull();
  });

  it("prevents the default of pointer and mouse presses so the editor keeps focus", () => {
    setup();
    scroll();
    expect(fireEvent.pointerDown(bubble()!)).toBe(false);
    expect(fireEvent.mouseDown(bubble()!)).toBe(false);
  });

  it("calls onOpen on click", () => {
    const { onOpen } = setup();
    scroll();
    fireEvent.click(bubble()!);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("hands itself over as the focus-return target only when it had focus (keyboard), not on a touch tap", () => {
    const { onOpen } = setup();
    scroll();
    // A tap: pointer down is prevented, so the chip never takes focus.
    fireEvent.pointerDown(bubble()!);
    fireEvent.click(bubble()!);
    expect(onOpen).toHaveBeenLastCalledWith(null);
    act(() => bubble()!.focus());
    fireEvent.click(bubble()!);
    expect(onOpen).toHaveBeenLastCalledWith(bubble());
  });

  it("does not count down while held; letting go starts the 1500 ms again", () => {
    const { onOpen, view } = setup();
    scroll();
    view.rerender(<OutlineScrollBubble headings={headings} activeId="h-install" scrollTarget={box} placement="page" hold onOpen={onOpen} />);
    advance(5000);
    expect(bubble()).not.toBeNull();
    view.rerender(<OutlineScrollBubble headings={headings} activeId="h-install" scrollTarget={box} placement="page" hold={false} onOpen={onOpen} />);
    advance(1499);
    expect(bubble()).not.toBeNull();
    advance(1);
    expect(bubble()).toBeNull();
  });

  it("works with window as the scroll target", () => {
    setup({ scrollTarget: window });
    scroll(window as unknown as HTMLElement);
    expect(bubble()).not.toBeNull();
  });

  it("does not render without a scroll target or headings", () => {
    const view = render(
      <OutlineScrollBubble headings={headings} activeId={null} scrollTarget={null} placement="page" onOpen={() => {}} />,
    );
    scroll(window as unknown as HTMLElement);
    expect(view.container).toBeEmptyDOMElement();
    view.unmount();
    setup({ headings: [] });
    scroll();
    expect(bubble()).toBeNull();
  });

  describe("track", () => {
    const track = () => screen.getByTestId("outline-bubble-track");
    const fractionOf = () => bubble()!.parentElement!.style.getPropertyValue("--outline-bubble-fraction");
    const stub = (name: string, value: number) => Object.defineProperty(box, name, { configurable: true, value });
    const setScroll = (top: number) => stub("scrollTop", top);
    beforeEach(() => {
      stub("scrollHeight", 1600);
      stub("clientHeight", 600);
    });
    afterEach(() => vi.unstubAllGlobals());

    it("sits on the track at the scroll fraction: top, middle, bottom", () => {
      setup();
      setScroll(0);
      scroll();
      expect(fractionOf()).toBe("0");
      setScroll(500);
      scroll();
      expect(fractionOf()).toBe("0.5");
      setScroll(1000);
      scroll();
      expect(fractionOf()).toBe("1");
    });

    it("page: the track runs from under the sticky header to above the bottom reserve", () => {
      setup({ bottomReserve: 72 });
      scroll();
      expect(track().className).toContain("fixed");
      expect(track().className).toContain("var(--kb-sticky-top");
      expect(track().style.getPropertyValue("--outline-track-reserve")).toBe("72px");
    });

    it("page with the edit toolbar up: the reserve is toolbar plus keyboard", () => {
      vi.stubGlobal("visualViewport", { height: 424, offsetTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} });
      setup({ editToolbarHeight: 60, bottomReserve: 72 });
      scroll();
      expect(track().style.getPropertyValue("--outline-track-reserve")).toBe("404px");
    });

    it("anchor: the track fills the scroll container's height minus the gaps and the reserve, clear of its scrollbar", () => {
      stub("offsetWidth", 400);
      stub("clientWidth", 385);
      setup({ placement: "anchor", bottomReserve: 66 });
      scroll();
      expect(track().className).toContain("absolute");
      expect(track().style.height).toBe("518px");
      expect(track().style.getPropertyValue("--outline-track-gutter")).toBe("15px");
      // The track lets the pointer through; the chip itself must take taps.
      expect(bubble()!.parentElement!).toHaveClass("pointer-events-auto");
    });

    it("moves straight to the new scroll position: the chip's positioned box carries no transition or animation", () => {
      setup();
      scroll();
      expect(bubble()!.parentElement!.className).not.toMatch(/\b(transition|duration-|animate-|fade-)/);
    });

    it("a track shorter than the chip hides the chip instead of letting it hang over what is below; it shows again once the track is tall enough", () => {
      let trackHeight = 20;
      let resized: (() => void) | null = null;
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(cb: () => void) {
            resized = cb;
          }
          observe() {}
          disconnect() {}
        },
      );
      const rects = vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
      const boxes = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        return { top: 0, height: this.dataset.testid === "outline-bubble-track" ? trackHeight : 36 } as DOMRect;
      });
      try {
        setup();
        scroll();
        const chipBox = () => bubble()!.parentElement!;
        expect(chipBox()).toHaveClass("invisible");
        trackHeight = 36;
        act(() => resized!());
        expect(chipBox()).not.toHaveClass("invisible");
      } finally {
        rects.mockRestore();
        boxes.mockRestore();
      }
    });

    it("anchor: only the part of the keyboard that overlaps the scroll container shortens the track", () => {
      stub("offsetWidth", 400);
      stub("clientWidth", 400);
      vi.stubGlobal("innerHeight", 768);
      vi.stubGlobal("visualViewport", { height: 468, offsetTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} });
      vi.spyOn(box, "getBoundingClientRect").mockReturnValue({ bottom: 668 } as DOMRect);
      setup({ placement: "anchor", bottomReserve: 66 });
      scroll();
      // Keyboard 300, the container ends 100 above the window's bottom: 200 overlap.
      expect(track().style.height).toBe("384px");
    });
  });

  describe("scrolls caused by typing in the editor", () => {
    let editor: HTMLDivElement;
    let now = 10_000;
    beforeEach(() => {
      editor = document.createElement("div");
      editor.append(document.createElement("p"));
      document.body.appendChild(editor);
      now = 10_000;
      vi.spyOn(performance, "now").mockImplementation(() => now);
    });
    afterEach(() => {
      vi.mocked(performance.now).mockRestore();
      editor.remove();
    });

    it.each(["keydown", "beforeinput", "input", "paste", "focusin"])("a scroll within 300 ms of %s inside the editor does not show it; later ones do", (type) => {
      expect(OUTLINE_BUBBLE_INPUT_QUIET_MS).toBe(300);
      setup({ inputRoot: editor });
      act(() => void editor.firstElementChild!.dispatchEvent(new Event(type, { bubbles: true })));
      now += 299;
      scroll();
      expect(bubble()).toBeNull();
      now += 1;
      scroll();
      expect(bubble()).not.toBeNull();
    });

    it("a typing scroll while the bubble is up does not keep it up (the 1500 ms are not restarted)", () => {
      setup({ inputRoot: editor });
      scroll();
      advance(1000);
      act(() => void editor.dispatchEvent(new Event("keydown", { bubbles: true })));
      scroll();
      advance(500);
      expect(bubble()).toBeNull();
    });

    it("typing outside the editor does not hold it back", () => {
      setup({ inputRoot: editor });
      act(() => void document.body.dispatchEvent(new Event("keydown", { bubbles: true })));
      scroll();
      expect(bubble()).not.toBeNull();
    });

    it("without an editor every scroll shows it", () => {
      setup();
      act(() => void editor.dispatchEvent(new Event("keydown", { bubbles: true })));
      scroll();
      expect(bubble()).not.toBeNull();
    });

    it("stops listening to the editor on unmount", () => {
      const spy = vi.spyOn(editor, "removeEventListener");
      const { view } = setup({ inputRoot: editor });
      view.unmount();
      for (const type of ["keydown", "beforeinput", "input", "paste", "focusin"]) expect(spy).toHaveBeenCalledWith(type, expect.any(Function), { capture: true });
    });

    describe("visual viewport resizes (the keyboard opening or closing)", () => {
      let viewport: EventTarget;
      beforeEach(() => {
        viewport = new EventTarget();
        vi.stubGlobal("visualViewport", viewport);
      });
      afterEach(() => vi.unstubAllGlobals());

      it("count as input while focus is inside the editor", () => {
        const field = document.createElement("textarea");
        editor.append(field);
        setup({ inputRoot: editor });
        act(() => field.focus());
        now += 1000;
        act(() => void viewport.dispatchEvent(new Event("resize")));
        now += 299;
        scroll();
        expect(bubble()).toBeNull();
        now += 1;
        scroll();
        expect(bubble()).not.toBeNull();
      });

      it("do not while focus is elsewhere", () => {
        const outside = document.createElement("input");
        document.body.appendChild(outside);
        setup({ inputRoot: editor });
        act(() => outside.focus());
        act(() => void viewport.dispatchEvent(new Event("resize")));
        scroll();
        expect(bubble()).not.toBeNull();
        outside.remove();
      });

      it("stops listening on unmount", () => {
        const spy = vi.spyOn(viewport, "removeEventListener");
        const { view } = setup({ inputRoot: editor });
        view.unmount();
        expect(spy).toHaveBeenCalledWith("resize", expect.any(Function));
      });
    });
  });

  it("stops listening and clears its timer on unmount", () => {
    const { view } = setup();
    scroll();
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    scroll();
    expect(vi.getTimerCount()).toBe(0);
  });
});
