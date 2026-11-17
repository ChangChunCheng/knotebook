import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_HOVER_QUERY } from "@/lib/layout-tiers";
import { stubLayoutTier } from "@/test/layout-tier";
import type { OutlineHeading } from "./headings";
import { HeadingOutline, OUTLINE_CLOSE_DELAY_MS, OUTLINE_OPEN_DELAY_MS, type HeadingOutlineProps } from "./HeadingOutline";

const headings: OutlineHeading[] = [
  { id: "a", level: 1, text: "Alice" },
  { id: "b", level: 2, text: "Bob" },
  { id: "c", level: 3, text: "Carol" },
];
const placement = { railLeft: 1007.5, panelLeft: 828, pinnedPanelLeft: 832 };

let noHover = false;

function setup(over: Partial<HeadingOutlineProps> = {}) {
  const props: HeadingOutlineProps = {
    headings,
    activeId: "b",
    placement,
    maxHeight: 400,
    pinned: false,
    pinAvailable: true,
    onPinnedChange: vi.fn(),
    onJump: vi.fn(),
    ...over,
  };
  const view = render(<HeadingOutline {...props} />);
  return { props, view };
}

const rail = () => screen.getByTestId("outline-rail");
const panel = () => screen.queryByTestId("outline-panel");
const wrapper = () => rail().parentElement!;
const mouseEnter = (el: Element) => fireEvent.pointerEnter(el, { pointerType: "mouse" });
const mouseLeave = (el: Element) => fireEvent.pointerLeave(el, { pointerType: "mouse" });
const item = (id: string) => document.querySelector<HTMLButtonElement>(`[data-outline-item="${id}"]`)!;
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

beforeEach(() => {
  vi.useFakeTimers();
  noHover = false;
  stubLayoutTier("docked", (q) => q === NO_HOVER_QUERY && noHover);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("HeadingOutline hover", () => {
  it("opens after the open delay, closes after the close delay", () => {
    setup();
    expect(rail()).toHaveAttribute("aria-expanded", "false");
    mouseEnter(wrapper());
    advance(OUTLINE_OPEN_DELAY_MS - 1);
    expect(panel()).toBeNull();
    advance(1);
    expect(panel()).not.toBeNull();
    expect(rail()).toHaveAttribute("aria-expanded", "true");
    mouseLeave(wrapper());
    advance(OUTLINE_CLOSE_DELAY_MS - 1);
    expect(panel()).not.toBeNull();
    advance(1);
    expect(panel()).toBeNull();
    expect(rail()).toHaveAttribute("aria-expanded", "false");
  });

  it("stays open when the pointer comes back during the close delay", () => {
    setup();
    mouseEnter(wrapper());
    advance(OUTLINE_OPEN_DELAY_MS);
    mouseLeave(wrapper());
    advance(100);
    mouseEnter(wrapper());
    advance(1000);
    expect(panel()).not.toBeNull();
  });

  it("does not open when the pointer leaves before the open delay", () => {
    setup();
    mouseEnter(wrapper());
    advance(100);
    mouseLeave(wrapper());
    advance(1000);
    expect(panel()).toBeNull();
  });

  it("ignores touch pointers entering", () => {
    setup();
    fireEvent.pointerEnter(wrapper(), { pointerType: "touch" });
    advance(1000);
    expect(panel()).toBeNull();
  });
});

describe("HeadingOutline without hover", () => {
  beforeEach(() => {
    noHover = true;
  });

  it("toggles on rail taps", () => {
    setup();
    fireEvent.click(rail());
    expect(panel()).not.toBeNull();
    fireEvent.click(rail());
    expect(panel()).toBeNull();
  });

  it("closes on a press outside but not inside the panel", () => {
    setup();
    fireEvent.click(rail());
    fireEvent.pointerDown(panel()!);
    expect(panel()).not.toBeNull();
    fireEvent.pointerDown(document.body);
    expect(panel()).toBeNull();
  });

  it("shows a close button that closes the panel and focuses the rail; hover devices have none", () => {
    setup();
    fireEvent.click(rail());
    fireEvent.click(screen.getByRole("button", { name: "Close outline" }));
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(rail());
  });

  it("moves focus into the panel on a keyboard open", () => {
    setup();
    fireEvent.click(rail());
    expect(document.activeElement).toBe(item("b"));
  });

  it("does not open on hover", () => {
    setup();
    mouseEnter(wrapper());
    advance(1000);
    expect(panel()).toBeNull();
  });
});

describe("HeadingOutline closing", () => {
  it("closes a hover-opened panel on a press outside", () => {
    setup();
    mouseEnter(wrapper());
    advance(OUTLINE_OPEN_DELAY_MS);
    fireEvent.pointerDown(panel()!);
    expect(panel()).not.toBeNull();
    fireEvent.pointerDown(document.body);
    expect(panel()).toBeNull();
  });

  it("closes when focus leaves the outline but not when it moves inside", () => {
    setup();
    fireEvent.click(rail());
    fireEvent.blur(item("b"), { relatedTarget: item("c") });
    expect(panel()).not.toBeNull();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    fireEvent.blur(item("b"), { relatedTarget: outside });
    expect(panel()).toBeNull();
    outside.remove();
  });

  it("moves focus to the rail when the close timer unmounts a panel that holds focus", () => {
    setup();
    mouseEnter(wrapper());
    advance(OUTLINE_OPEN_DELAY_MS);
    item("c").focus();
    mouseLeave(wrapper());
    advance(OUTLINE_CLOSE_DELAY_MS);
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(rail());
  });

  it("leaves focus alone when an unpin happens automatically with nothing focused", () => {
    const props: HeadingOutlineProps = { headings, activeId: "b", placement, maxHeight: 400, pinned: true, pinAvailable: true, onPinnedChange: vi.fn(), onJump: vi.fn() };
    const view = render(<HeadingOutline {...props} />);
    expect(document.activeElement).toBe(document.body);
    view.rerender(<HeadingOutline {...props} pinned={false} />);
    expect(document.activeElement).toBe(document.body);
  });

  it("moves focus to the rail after the unpin button is pressed, even if the press did not focus it", () => {
    const props: HeadingOutlineProps = { headings, activeId: "b", placement, maxHeight: 400, pinned: true, pinAvailable: true, onPinnedChange: vi.fn(), onJump: vi.fn() };
    const view = render(<HeadingOutline {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Unpin outline" }));
    view.rerender(<HeadingOutline {...props} pinned={false} />);
    expect(document.activeElement).toBe(rail());
  });

  it("moves focus to the rail after unpinning", () => {
    const props: HeadingOutlineProps = { headings, activeId: "b", placement, maxHeight: 400, pinned: true, pinAvailable: true, onPinnedChange: vi.fn(), onJump: vi.fn() };
    const view = render(<HeadingOutline {...props} />);
    screen.getByRole("button", { name: "Unpin outline" }).focus();
    view.rerender(<HeadingOutline {...props} pinned={false} />);
    expect(document.activeElement).toBe(rail());
  });
});

describe("HeadingOutline touch targets", () => {
  it("makes the close and pin buttons 44px under a coarse pointer", () => {
    noHover = true;
    setup();
    fireEvent.click(rail());
    for (const name of ["Close outline", "Pin outline"]) {
      expect(screen.getByRole("button", { name })).toHaveClass("pointer-coarse:h-11", "pointer-coarse:w-11");
    }
  });
});

describe("HeadingOutline close button", () => {
  it("is absent with hover and when pinned", () => {
    setup();
    fireEvent.click(rail());
    expect(screen.queryByRole("button", { name: "Close outline" })).toBeNull();
  });
});

describe("HeadingOutline keyboard", () => {
  it("opens from the rail with focus on the current section; Esc closes and returns focus to the rail", () => {
    setup();
    rail().focus();
    fireEvent.click(rail()); // detail 0: what Enter or Space on a button produces
    expect(panel()).not.toBeNull();
    expect(document.activeElement).toBe(item("b"));
    fireEvent.keyDown(item("b"), { key: "Escape" });
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(rail());
  });
});

describe("HeadingOutline selection", () => {
  it("jumps once, closes the panel and moves focus to the rail", () => {
    const { props } = setup();
    mouseEnter(wrapper());
    advance(OUTLINE_OPEN_DELAY_MS);
    fireEvent.click(item("c"));
    expect(props.onJump).toHaveBeenCalledTimes(1);
    expect(props.onJump).toHaveBeenCalledWith("c");
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(rail());
  });
});

describe("HeadingOutline pin", () => {
  it("shows no pin button when pinning is unavailable", () => {
    setup({ pinAvailable: false });
    fireEvent.click(rail());
    expect(screen.queryByRole("button", { name: "Pin outline" })).toBeNull();
  });

  it("shows an unpressed pin button that pins", () => {
    const { props } = setup();
    fireEvent.click(rail());
    const pin = screen.getByRole("button", { name: "Pin outline" });
    expect(pin).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(pin);
    expect(props.onPinnedChange).toHaveBeenCalledWith(true);
  });

  it("renders only the always-open panel when pinned, and keeps it open after a selection", () => {
    const { props } = setup({ pinned: true });
    expect(screen.queryByTestId("outline-rail")).toBeNull();
    expect(panel()).not.toBeNull();
    const unpin = screen.getByRole("button", { name: "Unpin outline" });
    expect(unpin).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(item("c"));
    expect(props.onJump).toHaveBeenCalledWith("c");
    expect(panel()).not.toBeNull();
    expect(document.activeElement).toBe(item("c"));
    fireEvent.click(unpin);
    expect(props.onPinnedChange).toHaveBeenCalledWith(false);
  });

  it("does not close a pinned panel on outside presses or Esc", () => {
    noHover = true;
    setup({ pinned: true });
    fireEvent.pointerDown(document.body);
    fireEvent.keyDown(item("b"), { key: "Escape" });
    expect(panel()).not.toBeNull();
  });
});

describe("HeadingOutline geometry", () => {
  it("places the rail, the floating panel and the pinned panel", () => {
    const { view } = setup({ maxHeight: 321 });
    expect(rail().style.left).toBe("1007.5px");
    expect(rail().style.maxHeight).toBe("321px");
    mouseEnter(wrapper());
    advance(OUTLINE_OPEN_DELAY_MS);
    expect(panel()!.style.left).toBe("828px");
    expect(panel()!.style.maxHeight).toBe("321px");
    expect(panel()!.style.width).toBe("240px");
    view.rerender(<HeadingOutline {...({ headings, activeId: "b", placement, maxHeight: 321, pinned: true, pinAvailable: true, onPinnedChange: vi.fn(), onJump: vi.fn() } satisfies HeadingOutlineProps)} />);
    expect(panel()!.style.left).toBe("832px");
    expect(panel()!.style.maxHeight).toBe("321px");
  });

  it("draws one line per heading with level, and one active line", () => {
    setup();
    const lines = [...rail().querySelectorAll("span")];
    expect(lines.map((l) => l.dataset.level)).toEqual(["1", "2", "3"]);
    expect(lines.map((l) => l.style.width)).toEqual(["20px", "14px", "8px"]);
    expect(lines.filter((l) => l.hasAttribute("data-active"))).toHaveLength(1);
    expect(lines[1]).toHaveAttribute("data-active");
    expect(lines[1]).toHaveClass("bg-brand");
    expect(lines[0]).not.toHaveClass("bg-brand");
  });

  it("scrolls the rail and keeps the current line visible when there are too many headings", () => {
    const many: OutlineHeading[] = Array.from({ length: 30 }, (_, i) => ({ id: `h${i + 1}`, level: 2, text: `Heading ${i + 1}` }));
    const spy = vi.fn();
    Element.prototype.scrollIntoView = spy;
    try {
      setup({ headings: many, activeId: "h25", maxHeight: 100 });
      expect(rail()).toHaveClass("overflow-y-auto");
      const lines = [...rail().querySelectorAll("span")];
      expect(lines).toHaveLength(30);
      expect(spy.mock.contexts).toContain(lines[24]);
    } finally {
      // @ts-expect-error restore the jsdom default (no implementation)
      delete Element.prototype.scrollIntoView;
    }
  });

  it("does not scroll the rail when every line fits", () => {
    setup();
    expect(rail()).not.toHaveClass("overflow-y-auto");
  });
});

describe("HeadingOutline rail hit area", () => {
  it("keeps a minimum hit height (larger under a coarse pointer) with the lines from the top", () => {
    setup({ headings: [headings[0]!] });
    expect(rail()).toHaveClass("min-h-6", "pointer-coarse:min-h-11", "justify-start", "flex-col");
  });
});

describe("HeadingOutline Esc on the rail", () => {
  it("closes a hover-opened panel when focus is on the rail", () => {
    setup();
    rail().focus();
    mouseEnter(wrapper());
    advance(OUTLINE_OPEN_DELAY_MS);
    expect(panel()).not.toBeNull();
    fireEvent.keyDown(rail(), { key: "Escape" });
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(rail());
  });

  it("does nothing when the panel is closed (Esc keeps reaching the page)", () => {
    const onPageKey = vi.fn();
    document.addEventListener("keydown", onPageKey);
    try {
      setup();
      fireEvent.keyDown(rail(), { key: "Escape" });
      expect(onPageKey).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener("keydown", onPageKey);
    }
  });
});

describe("HeadingOutline wheel forwarding", () => {
  /** Sets the list's scroll metrics; jsdom has no layout. */
  function scrollMetrics(el: HTMLElement, m: { top: number; client: number; height: number }) {
    Object.defineProperty(el, "scrollTop", { configurable: true, value: m.top });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: m.client });
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: m.height });
  }

  it("forwards a wheel over the rail without cancelling it", () => {
    const onForwardWheel = vi.fn();
    setup({ onForwardWheel });
    const notCancelled = fireEvent.wheel(rail(), { deltaY: 120, deltaMode: 0 });
    expect(onForwardWheel).toHaveBeenCalledWith(120, 0);
    expect(notCancelled).toBe(true);
  });

  it("ignores pinch-zoom wheels (ctrl) and wheels without vertical movement", () => {
    const onForwardWheel = vi.fn();
    setup({ onForwardWheel });
    fireEvent.wheel(rail(), { deltaY: 120, ctrlKey: true });
    fireEvent.wheel(rail(), { deltaX: 50, deltaY: 0 });
    expect(onForwardWheel).not.toHaveBeenCalled();
  });

  it("over a rail that scrolls itself, cancels the rail's own scrolling and forwards once", () => {
    const many: OutlineHeading[] = Array.from({ length: 30 }, (_, i) => ({ id: `h${i + 1}`, level: 2, text: `Heading ${i + 1}` }));
    const onForwardWheel = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
    try {
      setup({ headings: many, maxHeight: 100, onForwardWheel });
      expect(rail()).toHaveClass("overflow-y-auto");
      const notCancelled = fireEvent.wheel(rail().querySelector("span")!, { deltaY: 3, deltaMode: 1 });
      expect(notCancelled).toBe(false);
      expect(onForwardWheel).toHaveBeenCalledTimes(1);
      expect(onForwardWheel).toHaveBeenCalledWith(3, 1);
    } finally {
      // @ts-expect-error restore the jsdom default (no implementation)
      delete Element.prototype.scrollIntoView;
    }
  });

  it("over the panel, leaves the wheel to the list while it can scroll that way and forwards at its ends", () => {
    const onForwardWheel = vi.fn();
    setup({ onForwardWheel });
    mouseEnter(wrapper());
    advance(OUTLINE_OPEN_DELAY_MS);
    const list = panel()!.querySelector("ol")!;
    const target = item("b");

    scrollMetrics(list, { top: 0, client: 100, height: 300 });
    expect(fireEvent.wheel(target, { deltaY: 100 })).toBe(true);
    expect(onForwardWheel).not.toHaveBeenCalled();
    fireEvent.wheel(target, { deltaY: -100 });
    expect(onForwardWheel).toHaveBeenLastCalledWith(-100, 0);

    scrollMetrics(list, { top: 200, client: 100, height: 300 });
    onForwardWheel.mockClear();
    fireEvent.wheel(target, { deltaY: -100 });
    expect(onForwardWheel).not.toHaveBeenCalled();
    fireEvent.wheel(target, { deltaY: 100 });
    expect(onForwardWheel).toHaveBeenLastCalledWith(100, 0);

    // A list that fits never scrolls: every wheel goes to the note.
    scrollMetrics(list, { top: 0, client: 100, height: 100 });
    onForwardWheel.mockClear();
    fireEvent.wheel(target, { deltaY: 100 });
    fireEvent.wheel(target, { deltaY: -100 });
    expect(onForwardWheel).toHaveBeenCalledTimes(2);
  });

  it("does the same over a pinned panel", () => {
    const onForwardWheel = vi.fn();
    setup({ pinned: true, onForwardWheel });
    const list = panel()!.querySelector("ol")!;
    scrollMetrics(list, { top: 0, client: 100, height: 100 });
    fireEvent.wheel(item("a"), { deltaY: 40 });
    expect(onForwardWheel).toHaveBeenCalledWith(40, 0);
  });
});
