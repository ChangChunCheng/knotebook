import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutlineHeading } from "./headings";
import { OUTLINE_BUBBLE_HIDE_MS, OutlineScrollBubble } from "./OutlineScrollBubble";

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

  it("positions by placement", () => {
    const view = setup().view;
    scroll();
    expect(bubble()!.parentElement!.className).toContain("fixed");
    expect(bubble()!.parentElement!.className).toContain("var(--kb-sticky-top");
    view.unmount();
    setup({ placement: "anchor" });
    scroll();
    expect(bubble()!.parentElement!.className).toContain("absolute");
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
